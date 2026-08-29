#include <map>
#include <iostream>
#include <chrono>
#include <thread>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <atomic>
#include <memory>
#include <vector>
#include <algorithm>
#include <ctime>
#include <jack/ringbuffer.h>
#include <jack/midiport.h>
#include "audio/JackClient.h"
#include "plugins/Lv2Host.h"
#include "ipc/IpcClient.h"
#include "ipc/json.hpp"
#include "recorder/DiskWriter.h"
#include "recorder/MultitrackRecorder.h"
#include "playback/TimelinePlayer.h"
#include "timecode/Timecode.h"
#include "util/tsan_annotations.h"

using namespace aes67_deck;

// Fixed console topology (see engine/docs or the Patchbay Configuration
// panel for the rationale): 32 source-only input channels, a Master output,
// 8 Aux output buses, one dedicated operator Monitor bus, and a dedicated
// push-to-talk Talkback mic input. None of this is runtime-configurable —
// JACK ports are registered once at startup.
constexpr int NUM_CHANNELS = 32;
constexpr int NUM_AUX = 8;
constexpr int MASTER_ID = 100;
constexpr int AUX_BASE = 101;         // 101..108
constexpr int MONITOR_ID = 109;       // dedicated operator monitor bus
constexpr int TALKBACK_ID = 110;      // not a ChannelState; see TalkbackState

// Live per-channel controls are written from the IPC thread and read every
// audio block, so every field the RT thread touches is atomic — a plain
// std::map<int,float> aux_sends here was undefined behaviour (tree rebalance
// on insert racing the audio thread's traversal, i.e. a crash *inside* the
// process callback). Fixed-size atomic array instead: index 0 = Master send,
// 1..NUM_AUX = Aux 101..108. current_peak_* stay plain — only the RT thread
// ever touches them.
struct ChannelState {
    std::atomic<float> fader{0.75f};
    std::atomic<float> pan{0.0f};
    std::atomic<bool> mute{false};
    std::atomic<bool> solo{false};
    std::atomic<bool> phase{false};   // polarity invert (the "ø" button)

    float current_peak_l = 0.0f;
    float current_peak_r = 0.0f;
    std::atomic<float> aux_sends[NUM_AUX + 1];   // [0] Master, [1..NUM_AUX] Aux

    std::vector<std::unique_ptr<plugins::PluginInstance>> insert_chain;
};

// busId (Master 100 / Aux 101..108) -> aux_sends[] slot, or -1 if out of range.
static inline int aux_send_slot(int bus_id) {
    if (bus_id == MASTER_ID) return 0;
    if (bus_id >= AUX_BASE && bus_id < AUX_BASE + NUM_AUX) return bus_id - AUX_BASE + 1;
    return -1;
}

// Per-plugin in/out metering for whichever plugin editor the UI currently has
// open (docs/fx-ui-design.md §6, the `fx` key on the metering message). The
// UI announces its selection with an `fx_focus` command; the audio thread
// captures the pre- and post-plugin peak for exactly that one slot and the
// metering send-block rides the result out on the existing `metering` frame.
// Focus ids: IPC thread writes, audio thread reads. Peaks: audio thread only,
// same accumulate-then-decay scheme as ChannelState::current_peak_*.
static std::atomic<int> g_fx_focus_channel{-1};
static std::atomic<int> g_fx_focus_plugin{-1};
static float g_fx_in_peak_l = 0.0f, g_fx_in_peak_r = 0.0f;
static float g_fx_out_peak_l = 0.0f, g_fx_out_peak_r = 0.0f;

// Real-time analyser for the focused plugin's *input* — a bank of Goertzel
// detectors at log-spaced centre frequencies, fed sample-by-sample on the
// audio thread and read out (dBFS, fast-rise / slow-fall smoothed) once per
// RTA_WIN samples. Rendered behind the EQ curve in the UI. Audio thread only.
static constexpr int RTA_BANDS = 31;
static constexpr int RTA_WIN = 2048;
static constexpr float RTA_F_LO = 30.0f, RTA_F_HI = 18000.0f;
static float g_rta_coeff[RTA_BANDS];
static float g_rta_s1[RTA_BANDS];
static float g_rta_s2[RTA_BANDS];
static float g_rta_mag[RTA_BANDS];   // last readout, dBFS
static int   g_rta_count = 0;
static bool  g_rta_ready = false;

static void rta_init(double sample_rate) {
    for (int k = 0; k < RTA_BANDS; ++k) {
        float f = RTA_F_LO * std::pow(RTA_F_HI / RTA_F_LO, k / float(RTA_BANDS - 1));
        double w = 2.0 * M_PI * f / sample_rate;
        g_rta_coeff[k] = 2.0f * std::cos(w);
        g_rta_s1[k] = g_rta_s2[k] = 0.0f;
        g_rta_mag[k] = -120.0f;
    }
    g_rta_count = 0;
    g_rta_ready = true;
}

// ── ITU-R BS.1770-4 loudness on the Master output (the `lufs` key on the
// metering frame). K-weighting = a high-shelf pre-filter then an RLB
// high-pass; coefficients below are the standard 48 kHz set (this rig runs
// at 48 kHz). Mean-square of the K-weighted L+R is accumulated per ~100 ms
// chunk; Momentary = last 400 ms, Short-term = last 3 s, Integrated = the
// two-stage-gated mean over a rolling ring of 400 ms blocks. Audio thread
// only; `g_lufs_reset` (IPC thread) requests an integrated restart.
static constexpr double KW1_B0 = 1.53512485958697, KW1_B1 = -2.69169618940638, KW1_B2 = 1.19839281085285;
static constexpr double KW1_A1 = -1.69065929318241, KW1_A2 = 0.73248077421585;
static constexpr double KW2_B0 = 1.0, KW2_B1 = -2.0, KW2_B2 = 1.0;
static constexpr double KW2_A1 = -1.99004745483398, KW2_A2 = 0.99007225036621;

struct KwState { double s1x1{}, s1x2{}, s1y1{}, s1y2{}, s2x1{}, s2x2{}, s2y1{}, s2y2{}; };
static inline double kweight(double x, KwState& s) {
    double y1 = KW1_B0 * x + KW1_B1 * s.s1x1 + KW1_B2 * s.s1x2 - KW1_A1 * s.s1y1 - KW1_A2 * s.s1y2;
    s.s1x2 = s.s1x1; s.s1x1 = x; s.s1y2 = s.s1y1; s.s1y1 = y1;
    double y2 = KW2_B0 * y1 + KW2_B1 * s.s2x1 + KW2_B2 * s.s2x2 - KW2_A1 * s.s2y1 - KW2_A2 * s.s2y2;
    s.s2x2 = s.s2x1; s.s2x1 = y1; s.s2y2 = s.s2y1; s.s2y1 = y2;
    return y2;
}

static constexpr int    LUFS_CHUNK_MS = 100;
static constexpr int    LUFS_ST_CHUNKS = 30;      // 3 s of short-term history
static constexpr int    LUFS_BLOCK_RING = 3000;   // 400 ms blocks → 20 min rolling integrated
static KwState g_kw_l, g_kw_r;
static int     g_lufs_chunk_frames = 0;           // set in rta_init from sample rate
static double  g_lufs_sq_accum = 0.0;
static int     g_lufs_accum_n = 0;
static double  g_lufs_chunks[LUFS_ST_CHUNKS];     // per-chunk (z_L+z_R) mean square, ring
static int     g_lufs_chunk_pos = 0;
static int     g_lufs_chunk_filled = 0;
static double  g_lufs_blocks[LUFS_BLOCK_RING];    // per-400ms-block mean square, ring
static int     g_lufs_block_pos = 0;
static int     g_lufs_block_filled = 0;
static int     g_lufs_chunks_in_block = 0;
static double  g_lufs_block_accum = 0.0;
static float   g_lufs_tp = 0.0f;                  // true-peak (approx), linear, decayed
static std::atomic<bool> g_lufs_reset{false};

static void lufs_init(double sample_rate) {
    g_lufs_chunk_frames = std::max(1, int(sample_rate * LUFS_CHUNK_MS / 1000.0));
    g_kw_l = KwState{}; g_kw_r = KwState{};
    g_lufs_sq_accum = 0.0; g_lufs_accum_n = 0;
    for (double& c : g_lufs_chunks) c = 0.0;
    for (double& b : g_lufs_blocks) b = 0.0;
    g_lufs_chunk_pos = g_lufs_chunk_filled = 0;
    g_lufs_block_pos = g_lufs_block_filled = g_lufs_chunks_in_block = 0;
    g_lufs_block_accum = 0.0;
    g_lufs_tp = 0.0f;
}

// -0.691 dB offset + 10log10 of the summed K-weighted channel power.
static inline float lufs_db(double meanSq) {
    return meanSq > 1e-12 ? float(-0.691 + 10.0 * std::log10(meanSq)) : -120.0f;
}

// ── Master-bus analyser (the `master` key on the metering frame): a
// log-spaced Goertzel spectrum of the Master output, L/R stereo correlation,
// and a downsampled L/R scatter for the goniometer. Drives the mastering
// panel shown when Master or Monitor is the selected channel. Audio thread
// only, always running (Master is a single channel — cheap).
static constexpr int MRTA_BANDS = 31;
static constexpr int MRTA_WIN = 4096;   // ~85 ms → slower, steadier than the FX RTA
static constexpr int GONIO_POINTS = 48;
static float g_mrta_coeff[MRTA_BANDS];
static float g_mrta_s1[MRTA_BANDS], g_mrta_s2[MRTA_BANDS];
static float g_mrta_mag[MRTA_BANDS];
static int   g_mrta_count = 0;
static double g_corr_lr = 0.0, g_corr_ll = 0.0, g_corr_rr = 0.0;  // running sums over a window
static int    g_corr_n = 0;
static float  g_corr_val = 0.0f;    // smoothed correlation [-1, 1]
static float  g_gonio[GONIO_POINTS * 2];  // interleaved L,R
static int    g_gonio_pos = 0;
static int    g_gonio_stride = 8, g_gonio_skip = 0;

static void master_analyser_init(double sample_rate) {
    for (int k = 0; k < MRTA_BANDS; ++k) {
        float f = 30.0f * std::pow(18000.0f / 30.0f, k / float(MRTA_BANDS - 1));
        g_mrta_coeff[k] = 2.0f * std::cos(2.0 * M_PI * f / sample_rate);
        g_mrta_s1[k] = g_mrta_s2[k] = 0.0f;
        g_mrta_mag[k] = -120.0f;
    }
    g_mrta_count = 0;
    g_corr_lr = g_corr_ll = g_corr_rr = 0.0; g_corr_n = 0; g_corr_val = 0.0f;
    for (float& g : g_gonio) g = 0.0f;
    g_gonio_pos = g_gonio_skip = 0;
    g_gonio_stride = std::max(1, int(sample_rate / 6000.0));  // ~6k scatter points/sec
}

// Every generic param key the UI sends (drive, blend, out, threshold, b1..b8,
// etc.) mapped to the specific LV2 port symbol for each Calf plugin URI —
// shared by the live set_plugin_param path and by add/load, which both need
// to seed a freshly-instantiated plugin's initial parameter values.
static std::string remap_param_symbol(const std::string& uri, const std::string& generic_key) {
    std::string sym = generic_key;
    if (uri == "http://calf.sourceforge.net/plugins/Saturator") {
        if (sym == "out") sym = "level_out";
    } else if (uri == "http://calf.sourceforge.net/plugins/Compressor") {
        // exact matches for threshold, ratio, attack, release, makeup, mix
    } else if (uri == "http://calf.sourceforge.net/plugins/Deesser") {
        if (sym == "freq") sym = "f1_freq";
        if (sym == "out") sym = "makeup";
    } else if (uri == "http://calf.sourceforge.net/plugins/Equalizer8Band") {
        if (sym == "b1") sym = "ls_level";
        if (sym == "b2") sym = "p1_level";
        if (sym == "b3") sym = "p2_level";
        if (sym == "b4") sym = "p3_level";
        if (sym == "b5") sym = "p4_level";
        if (sym == "b6") sym = "hs_level";
        // b7, b8 not used in 8Band? Actually 8Band has p1 to p4, ls, hs. That's 6 bands.
    } else if (uri == "http://calf.sourceforge.net/plugins/VintageDelay") {
        if (sym == "time_l") sym = "time_l";
        if (sym == "time_r") sym = "time_r";
        if (sym == "feedback") sym = "feedback";
        if (sym == "mix") sym = "mix";
        if (sym == "amount") sym = "amount";
    } else if (uri == "http://calf.sourceforge.net/plugins/Reverb") {
        if (sym == "decay") sym = "decay_time";
        if (sym == "room_size") sym = "room_size";
        if (sym == "damping") sym = "high_frq_damp";
        if (sym == "dry_wet") sym = "amount";
    } else if (uri == "http://calf.sourceforge.net/plugins/Limiter") {
        if (sym == "limit") sym = "limit";
        if (sym == "attack") sym = "attack";
        if (sym == "release") sym = "release";
        if (sym == "asc") sym = "asc";
    }
    return sym;
}

// Hard cap on plugins per rack. Matched by ChannelState::insert_chain's
// reserve() below so insert/erase during normal operation never triggers a
// vector reallocation on the audio thread (not RT-safe) — enforced again,
// defensively, at the point Add commands are applied in case something ever
// enqueues past capacity.
constexpr size_t MAX_PLUGINS_PER_CHANNEL = 16;

// A plugin-chain mutation, queued from the IPC thread and applied only by
// the audio thread (which owns insert_chain) — see the drain loop at the
// top of the process callback. Trivially copyable so it can move through a
// lock-free jack_ringbuffer_t as raw bytes, the same mechanism IpcClient
// already uses for its own tx queue.
// SetParam / SetBypass are the live FX-editor knob/bypass path: they used to
// be applied straight from the IPC thread (dereferencing insert_chain[idx],
// racing the audio thread's insert/erase and the trash thread's delete), now
// they ride this same ring and are applied by the audio thread.
enum class PluginCmdType { Add, Remove, Reorder, Clear, SetParam, SetBypass };

struct PluginCmd {
    PluginCmdType type;
    int channel_id;
    int index;   // Add: insert position (clamped to chain bounds when applied); Remove/SetParam/SetBypass: index; Reorder: from-index
    int index2;  // Reorder: to-index
    plugins::PluginInstance* instance; // Add only — ownership transfers to whichever thread applies the command
    float value = 0.0f;   // SetParam / SetBypass
    char sym[48] = {};     // SetParam: LV2 control-port symbol (already remapped on the IPC thread)
};

// Push-to-talk state. Atomics because this is written from the IPC thread
// and read every audio callback: unlike the bulk per-channel state, a stuck
// or delayed read here has a real safety consequence (the operator's mic
// could stay open when they think they've released it), so it gets a
// correctness guarantee the rest of ChannelState doesn't have.
struct TalkbackState {
    std::atomic<bool> ptt_active{false};
    // Bitmask over Master + the 8 Aux buses — bit 0 is Master (100), bit i
    // (1..NUM_AUX) is Aux (100+i). Multiple bits may be set at once so
    // talkback can fan out to several buses simultaneously; the Monitor bus
    // is never a valid destination (enforced again, structurally, in the
    // audio callback below, not just at the IPC boundary) since it has no
    // bit position here at all.
    std::atomic<uint32_t> dest_bus_mask{1u}; // bit 0 (Master) set by default
};

// Sample-accurate transport clock. The engine owns it; the server and UI
// follow it (position rides out on the `transport` key of the metering
// frame). Written from the IPC thread (locate / play / stop / loop) and the
// audio thread (advance), read on the audio thread every callback — relaxed
// atomics are fine, a one-block-stale read here has no correctness cost.
struct Transport {
    std::atomic<uint64_t> frame{0};
    std::atomic<int> state{0};              // 0 stopped, 1 playing, 2 recording
    std::atomic<int64_t> locate_to{-1};     // IPC thread sets; audio thread consumes and resets to -1
    std::atomic<uint64_t> loop_start{0};
    std::atomic<uint64_t> loop_end{0};
    std::atomic<bool> loop_enabled{false};
    // Punch region (plan Phase 3e). The engine only stores + echoes it; the
    // server does the actual auto drop-in / drop-out by watching the frame on
    // the metering stream (metering-rate accuracy is fine for broadcast, and
    // opening take files must happen off the audio thread anyway).
    std::atomic<uint64_t> punch_in{0};
    std::atomic<uint64_t> punch_out{0};
    std::atomic<bool> punch_enabled{false};
};
static Transport g_transport;

// Bounce (plan Phase 4) — render a timeline region through the graph to a file.
// 0 idle, 1 running, 2 just-finished. `g_bounce_end` is the exclusive out-frame;
// the audio thread stops the recorder + transport when the clock reaches it.
// The server opens/closes the file (IPC thread) and picks the path.
static std::atomic<int> g_bounce_state{0};
static std::atomic<uint64_t> g_bounce_end{0};

// Metronome (plan Phase 5) — a click summed post-fader onto the monitor bus on
// each beat while the transport rolls. Written from the IPC thread.
static std::atomic<int>    g_metro_enabled{0};
static std::atomic<double> g_metro_fpb{24000.0};   // frames per beat = sr*60/bpm
static std::atomic<int>    g_metro_signum{4};
static std::atomic<int>    g_metro_dest{0};        // 0 monitor, 1 master, 2 both

// Count-in (plan Phase 5 tail) — N frames of metronome-only before the transport
// rolls / recording begins. Set from the IPC thread with transport_play /
// start_multitrack_record; counted down on the audio thread, which freezes the
// transport and skips the recorder tap until it reaches 0. Uses g_metro_fpb /
// g_metro_signum for the click (the server keeps those current with the tempo
// even when the metronome is off).
static std::atomic<int64_t> g_countin_frames{0};   // frames still to run (echoed)
static std::atomic<int64_t> g_countin_total{0};    // its value when it started (for beat index)

// Timecode & sync (plan/daw-timeline-roadmap.md Phase 3d). Written from the IPC
// thread, read every audio block. The engine generates LTC on `ltc_out` + MTC
// on `mtc_out`, and chases LTC on `ltc_in` (drives transport_locate). Status is
// echoed on the metering frame's `tc` key.
static std::atomic<int>     g_tc_fps{30};            // 24 | 25 | 30 (nominal integer rate)
static std::atomic<int>     g_tc_df{0};              // 29.97 drop-frame (fps 30 only)
static std::atomic<int>     g_tc_source{0};          // 0 = project transport, 1 = PTP time-of-day
static std::atomic<int64_t> g_tc_offset_frames{0};   // project-zero -> TC start (in TC frames)
static std::atomic<int>     g_ltc_gen{0};
static std::atomic<float>   g_ltc_level{0.35f};
static std::atomic<int>     g_mtc_gen{0};
static std::atomic<int>     g_ltc_chase{0};
static std::atomic<int>     g_ltc_chase_locked{0};   // echoed
static std::atomic<int64_t> g_ltc_chase_frame{-1};   // last decoded TC frame, echoed (-1 = none)
static std::atomic<double>  g_ltc_chase_err{0.0};    // flywheel: smoothed transport-vs-LTC error (ms), echoed
static std::atomic<double>  g_tod_sec{0.0};          // seconds-of-day at the last block, echoed
static std::atomic<float>   g_ltc_in_peak{0.0f};     // peak |ltc_in| while chasing, echoed (signal-present hint)

// Virtual-soundcheck per-channel monitor source override. Bit (i-1) set => input
// channel i monitors its LIVE JACK input even while the timeline is playing
// (state 1); clear => it follows the transport like normal. Written from the IPC
// thread, read once per channel per audio block — relaxed is fine.
static std::atomic<uint32_t> g_monitor_input_mask{0};

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;

    // Socket + JACK client name are overridable so an isolated test stack can
    // run its own engine alongside a production deck (server honours the same
    // AES67_SOCKET_PATH).
    const char* sock_env = std::getenv("AES67_SOCKET_PATH");
    const std::string sock_path = (sock_env && *sock_env) ? sock_env : "/tmp/aes67_deck.sock";
    const char* jname_env = std::getenv("AES67_JACK_NAME");
    const std::string jack_name = (jname_env && *jname_env) ? jname_env : "AES67_Deck";

    std::cout << "Starting AES67-Deck DSP & DAW Engine (" << NUM_CHANNELS
              << " inputs, " << NUM_AUX << " Aux buses, Master, Monitor, Talkback)..." << std::endl;

    audio::JackClient jack(jack_name);
    ipc::IpcClient ipc(sock_path);
    recorder::DiskWriter recorder;
    recorder::MultitrackRecorder mtr;
    plugins::Lv2Host lv2_host;

    // Scan system for LV2 plugins
    lv2_host.scan_plugins();

    // ChannelState holds atomics now (non-copyable, non-movable), so each
    // entry is default-constructed in place rather than assigned.
    std::map<int, ChannelState> channels;
    for (int i = 1; i <= NUM_CHANNELS; i++) (void)channels[i];
    (void)channels[MASTER_ID];
    for (int b = 0; b < NUM_AUX; b++) (void)channels[AUX_BASE + b];
    (void)channels[MONITOR_ID];

    for (auto& pair : channels) {
        // Seed aux sends: Master starts at 0.75 (unity after the /0.75
        // normalisation on the audio thread), Aux sends start closed.
        pair.second.aux_sends[0].store(0.75f, std::memory_order_relaxed);
        for (int b = 1; b <= NUM_AUX; b++)
            pair.second.aux_sends[b].store(0.0f, std::memory_order_relaxed);
        // Pre-reserve so Add/Remove/Reorder (applied on the audio thread, see
        // the process callback's drain loop) never trigger a vector
        // reallocation mid-stream.
        pair.second.insert_chain.reserve(MAX_PLUGINS_PER_CHANNEL);
    }

    TalkbackState talkback;

    // Plugin-chain mutations flow IPC thread -> audio thread via this
    // lock-free ring (mirrors IpcClient's own tx_buffer_ pattern); removed/
    // replaced instances flow audio thread -> this cleanup thread via the
    // trash ring, since destroying an LV2 plugin instance is not RT-safe
    // and must never happen on the audio thread.
    jack_ringbuffer_t* plugin_cmd_ring = jack_ringbuffer_create(64 * sizeof(PluginCmd));
    jack_ringbuffer_t* plugin_trash_ring = jack_ringbuffer_create(256 * sizeof(void*));
    if (!plugin_cmd_ring || !plugin_trash_ring) {
        std::cerr << "Failed to allocate plugin command/trash ring buffers!" << std::endl;
        return 1;
    }

    std::thread plugin_trash_thread([plugin_trash_ring]() {
        while (true) {
            while (jack_ringbuffer_read_space(plugin_trash_ring) >= sizeof(void*)) {
                void* raw = nullptr;
                jack_ringbuffer_read(plugin_trash_ring, reinterpret_cast<char*>(&raw), sizeof(raw));
                AES67_TSAN_ACQUIRE(plugin_trash_ring);
                delete static_cast<plugins::PluginInstance*>(raw);
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    });
    plugin_trash_thread.detach();

    // Channels, buses, master, and monitor all start with an empty effect
    // rack. Users add plugins explicitly from the UI.
    std::vector<std::string> default_rack = {};

    double sr = jack.get_sample_rate();
    if (sr == 0) sr = 48000.0;
    rta_init(sr);
    lufs_init(sr);
    master_analyser_init(sr);

    // Disk-streaming timeline playback (plan Phase 2a). Reader thread + a
    // per-track ring; the audio thread pulls via player.render().
    playback::TimelinePlayer player(static_cast<int>(sr));

    // Full system LV2 plugin catalog for the Rack Manager's plugin browser
    // — the UI groups these into "Live" (reportsLatency false) and
    // "Studio" (true) sections. Static port-metadata scan only, no
    // instantiate/run — see Lv2Host::get_all_plugins and
    // PluginInfo::reports_latency for why (a full scan that ran every
    // declared-latency plugin segfaulted inside lsp-plugins-lv2.so).
    // Sent once here; queued in the IPC ring buffer regardless of whether
    // the server has connected yet.
    {
        std::vector<plugins::PluginInfo> catalog = lv2_host.get_all_plugins();
        nlohmann::json catalog_json;
        catalog_json["type"] = "plugin_list";
        catalog_json["plugins"] = nlohmann::json::array();
        for (const auto& info : catalog) {
            nlohmann::json pj;
            pj["uri"] = info.uri;
            pj["name"] = info.name;
            pj["author"] = info.author;
            pj["reportsLatency"] = info.reports_latency;
            pj["controlPorts"] = nlohmann::json::array();
            for (const auto& cp : info.control_ports) {
                pj["controlPorts"].push_back({
                    {"symbol", cp.symbol},
                    {"name", cp.name},
                    {"min", cp.min},
                    {"max", cp.max},
                    {"default", cp.default_value}
                });
            }
            catalog_json["plugins"].push_back(pj);
        }
        std::cout << "Scanned " << catalog.size() << " LV2 plugins for the Rack Manager catalog." << std::endl;
        ipc.send_multichannel_metering(catalog_json.dump());
    }

    for (auto& pair : channels) {
        for (const auto& uri : default_rack) {
            auto inst = lv2_host.instantiate_plugin(uri, sr);
            if (inst) {
                pair.second.insert_chain.push_back(std::move(inst));
            }
        }
    }
    std::cout << "Effect racks initialized (empty)." << std::endl;

    // --- Port registration ---
    // Inputs: in_1_L/R .. in_NUM_CHANNELS_L/R (indices 0..2*NUM_CHANNELS-1),
    // then talkback_L/R (indices 2*NUM_CHANNELS, 2*NUM_CHANNELS+1).
    for (int i = 1; i <= NUM_CHANNELS; i++) {
        jack.register_input_port("in_" + std::to_string(i) + "_L");
        jack.register_input_port("in_" + std::to_string(i) + "_R");
    }
    jack.register_input_port("talkback_L");
    jack.register_input_port("talkback_R");
    const int TALKBACK_PORT_L = 2 * NUM_CHANNELS;
    const int TALKBACK_PORT_R = 2 * NUM_CHANNELS + 1;
    // LTC chase input (plan Phase 3d) — appended so the positional indices above
    // are unchanged. The operator patches a source (an AES67 receiver, a
    // hardware loop) to this port.
    jack.register_input_port("ltc_in");
    const int LTC_IN_PORT = 2 * NUM_CHANNELS + 2;

    // Outputs: out_L/R (0,1), bus_101_L/R..bus_108_L/R (2..2+2*NUM_AUX-1),
    // then monitor_L/R.
    jack.register_output_port("out_L");
    jack.register_output_port("out_R");
    for (int b = 0; b < NUM_AUX; b++) {
        int bus_id = AUX_BASE + b;
        jack.register_output_port("bus_" + std::to_string(bus_id) + "_L");
        jack.register_output_port("bus_" + std::to_string(bus_id) + "_R");
    }
    jack.register_output_port("monitor_L");
    jack.register_output_port("monitor_R");
    const int MONITOR_PORT_L = 2 + 2 * NUM_AUX;
    const int MONITOR_PORT_R = 2 + 2 * NUM_AUX + 1;
    // LTC generator output (plan Phase 3d) — appended, positional indices above
    // unchanged. Patchbay-routable to any AES67 sink channel.
    jack.register_output_port("ltc_out");
    const int LTC_OUT_PORT = 2 + 2 * NUM_AUX + 2;
    // MTC generator — a JACK MIDI port, kept in its own list.
    jack.register_midi_output_port("mtc_out");

    ipc.set_command_callback([&channels, &recorder, &jack, &talkback](const std::string& type, int channel_id, int bus_id, float value) {
        if (channels.find(channel_id) != channels.end()) {
            ChannelState& cs = channels[channel_id];
            if (type == "set_fader") {
                cs.fader.store(value, std::memory_order_relaxed);
            } else if (type == "set_pan") {
                cs.pan.store(value, std::memory_order_relaxed);
            } else if (type == "set_mute") {
                cs.mute.store(value > 0.5f, std::memory_order_relaxed);
            } else if (type == "set_solo") {
                cs.solo.store(value > 0.5f, std::memory_order_relaxed);
            } else if (type == "set_phase") {
                cs.phase.store(value > 0.5f, std::memory_order_relaxed);
            } else if (type == "set_aux_send") {
                int slot = aux_send_slot(bus_id);
                if (slot >= 0) cs.aux_sends[slot].store(value, std::memory_order_relaxed);
            }
        }
        if (type == "fx_focus") {
            // bus_id carries the plugin index here (see IpcClient); -1 == the
            // UI has no plugin editor open.
            g_fx_focus_channel.store(channel_id, std::memory_order_relaxed);
            g_fx_focus_plugin.store(bus_id, std::memory_order_relaxed);
        } else if (type == "lufs_reset") {
            g_lufs_reset.store(true, std::memory_order_relaxed);
        } else if (type == "start_record") {
            recorder.start_recording("/tmp/aes67_deck_master.wav", 2, jack.get_sample_rate());
        } else if (type == "stop_record") {
            recorder.stop_recording();
        } else if (type == "set_talkback_active") {
            talkback.ptt_active = (value > 0.5f);
        } else if (type == "set_talkback_dest") {
            // bus_id carries a bitmask here (bit 0 = Master, bit i = Aux i),
            // not a single bus id — see TalkbackState::dest_bus_mask. Clamp
            // to the valid bit range so a malformed/future value can never
            // set a bit for the (nonexistent) Monitor position or beyond.
            constexpr uint32_t VALID_MASK = (1u << (NUM_AUX + 1)) - 1; // bits 0..NUM_AUX
            uint32_t mask = static_cast<uint32_t>(bus_id) & VALID_MASK;
            if (mask != static_cast<uint32_t>(bus_id)) {
                std::cerr << "Talkback destination mask " << bus_id << " had bits outside Master/Aux range, clamped to " << mask << std::endl;
            }
            talkback.dest_bus_mask = mask;
        }
    });

    // Transport + multitrack record. Runs on the IPC thread: it opens/closes
    // take files here (never on the audio thread) and flips the transport
    // atomics the audio callback reads. take_started / take_finished replies
    // ride the same IPC tx path as metering.
    ipc.set_transport_callback([&mtr, &jack, &ipc, &player, &recorder](const nlohmann::json& j) {
        const std::string type = j.value("type", "");

        if (type == "set_timeline") {
            std::vector<playback::ClipSpec> clips;
            if (j.contains("clips") && j["clips"].is_array()) {
                for (const auto& cj : j["clips"]) {
                    playback::ClipSpec c;
                    c.trackId = cj.value("trackId", 0);
                    c.timelineStart = cj.value("timelineStart", (uint64_t)0);
                    c.length = cj.value("length", (uint64_t)0);
                    c.fileStart = cj.value("fileStart", (uint64_t)0);
                    c.gain = cj.value("gain", 1.0f);
                    c.fadeIn = cj.value("fadeIn", (uint64_t)0);
                    c.fadeOut = cj.value("fadeOut", (uint64_t)0);
                    c.path = cj.value("path", "");
                    if (c.trackId >= 1 && c.trackId <= playback::TimelinePlayer::MAX_CH &&
                        c.length > 0 && !c.path.empty()) {
                        clips.push_back(std::move(c));
                    }
                }
            }
            player.set_schedule(std::move(clips));
            return;
        }

        if (type == "transport_play") {
            // Don't clobber an in-progress recording (state 2).
            if (g_transport.state.load(std::memory_order_relaxed) != 2)
                g_transport.state.store(1, std::memory_order_relaxed);
            const int64_t ci = j.value("countinFrames", (int64_t)0);
            if (ci > 0) { g_countin_total.store(ci, std::memory_order_relaxed);
                          g_countin_frames.store(ci, std::memory_order_relaxed); }

        } else if (type == "transport_stop") {
            if (mtr.is_recording()) {
                mtr.stop();
                nlohmann::json done{{"type", "take_finished"}, {"dir", mtr.dir()},
                                    {"originFrame", mtr.origin_frame()},
                                    {"endFrame", g_transport.frame.load(std::memory_order_relaxed)},
                                    {"frames", mtr.recorded_frames()},
                                    {"sampleRate", mtr.sample_rate()},
                                    {"armed", mtr.armed()},
                                    {"ext", mtr.file_ext()},
                                    {"overrun", mtr.had_overrun()}};
                ipc.send_json(done.dump());
            }
            g_transport.state.store(0, std::memory_order_relaxed);
            g_countin_frames.store(0, std::memory_order_relaxed);

        } else if (type == "transport_locate") {
            int64_t f = j.value("frame", (int64_t)0);
            if (f < 0) f = 0;
            g_transport.locate_to.store(f, std::memory_order_relaxed);

        } else if (type == "set_monitor_input_mask") {
            g_monitor_input_mask.store(j.value("mask", (uint32_t)0), std::memory_order_relaxed);

        } else if (type == "transport_set_timecode") {
            int fps = j.value("fps", 30);
            if (fps != 24 && fps != 25 && fps != 30) fps = 30;
            g_tc_fps.store(fps, std::memory_order_relaxed);
            g_tc_df.store((j.value("df", false) && fps == 30) ? 1 : 0, std::memory_order_relaxed);
            g_tc_source.store(j.value("source", std::string("project")) == "tod" ? 1 : 0,
                              std::memory_order_relaxed);
            g_tc_offset_frames.store(j.value("offsetFrames", (int64_t)0), std::memory_order_relaxed);

        } else if (type == "ltc_gen") {
            g_ltc_gen.store(j.value("enabled", false) ? 1 : 0, std::memory_order_relaxed);
            float lv = j.value("level", 0.35f);
            g_ltc_level.store(lv < 0.0f ? 0.0f : lv > 1.0f ? 1.0f : lv, std::memory_order_relaxed);

        } else if (type == "mtc_gen") {
            g_mtc_gen.store(j.value("enabled", false) ? 1 : 0, std::memory_order_relaxed);

        } else if (type == "ltc_chase") {
            g_ltc_chase.store(j.value("enabled", false) ? 1 : 0, std::memory_order_relaxed);
            if (!j.value("enabled", false)) {
                g_ltc_chase_locked.store(0, std::memory_order_relaxed);
                g_ltc_chase_frame.store(-1, std::memory_order_relaxed);
                g_ltc_in_peak.store(0.0f, std::memory_order_relaxed);
                g_ltc_chase_err.store(0.0, std::memory_order_relaxed);
            }

        } else if (type == "transport_set_loop") {
            uint64_t s = j.value("start", (uint64_t)0);
            uint64_t e = j.value("end", (uint64_t)0);
            g_transport.loop_start.store(s, std::memory_order_relaxed);
            g_transport.loop_end.store(e, std::memory_order_relaxed);
            g_transport.loop_enabled.store(j.value("enabled", false) && e > s,
                                          std::memory_order_relaxed);

        } else if (type == "transport_set_punch") {
            uint64_t s = j.value("start", (uint64_t)0);
            uint64_t e = j.value("end", (uint64_t)0);
            g_transport.punch_in.store(s, std::memory_order_relaxed);
            g_transport.punch_out.store(e, std::memory_order_relaxed);
            g_transport.punch_enabled.store(j.value("enabled", false) && e > s,
                                            std::memory_order_relaxed);

        } else if (type == "bounce_start") {
            // Server has located the transport to (beginFrame - preroll) and
            // started playback so the timeline reader primes before the region;
            // it trims the preroll off the file head once the render completes.
            // Open the writer here (IPC thread, never the audio thread).
            const std::string path = j.value("path", "");
            const int bits = j.value("bits", 24);
            const uint64_t beginF = j.value("beginFrame", (uint64_t)0);
            const uint64_t endF = j.value("endFrame", (uint64_t)0);
            if (path.empty() || endF <= beginF ||
                !recorder.start_recording(path, 2, static_cast<int>(jack.get_sample_rate()), bits)) {
                ipc.send_json(nlohmann::json{{"type", "bounce_failed"}, {"path", path}}.dump());
            } else {
                g_bounce_end.store(endF, std::memory_order_relaxed);
                g_bounce_state.store(1, std::memory_order_relaxed);
                std::cout << "Bounce -> " << path << "  [" << beginF << ", " << endF
                          << ")  " << bits << "-bit" << std::endl;
            }

        } else if (type == "set_metronome") {
            const bool en = j.value("enabled", false);
            const double bpm = j.value("bpm", 120.0);
            const int signum = j.value("sigNum", 4);
            const std::string dest = j.value("dest", std::string("monitor"));
            const double sr = static_cast<double>(jack.get_sample_rate());
            g_metro_fpb.store(bpm > 0 ? sr * 60.0 / bpm : sr * 0.5, std::memory_order_relaxed);
            g_metro_signum.store(signum > 0 ? signum : 4, std::memory_order_relaxed);
            g_metro_dest.store(dest == "master" ? 1 : dest == "both" ? 2 : 0, std::memory_order_relaxed);
            g_metro_enabled.store(en ? 1 : 0, std::memory_order_relaxed);
            std::cout << "Metronome " << (en ? "on" : "off") << "  " << bpm
                      << " bpm  " << signum << "/x  -> " << dest << std::endl;

        } else if (type == "bounce_abort") {
            recorder.stop_recording();
            g_bounce_state.store(0, std::memory_order_relaxed);
            g_transport.state.store(0, std::memory_order_relaxed);

        } else if (type == "start_multitrack_record") {
            const std::string dir = j.value("dir", "");
            std::vector<int> armed;
            if (j.contains("armed") && j["armed"].is_array()) {
                for (const auto& v : j["armed"]) if (v.is_number_integer()) armed.push_back(v.get<int>());
            }
            if (dir.empty() || armed.empty()) {
                std::cerr << "start_multitrack_record: need dir + non-empty armed[]" << std::endl;
                return;
            }
            // The take's project-time zero is wherever the transport is right
            // now (accurate to within one audio block).
            const uint64_t origin = g_transport.frame.load(std::memory_order_relaxed);
            const int sr_i = static_cast<int>(jack.get_sample_rate());
            if (!mtr.start(dir, armed, sr_i, origin)) {
                nlohmann::json err{{"type", "take_failed"}, {"dir", dir}};
                ipc.send_json(err.dump());
                return;
            }
            g_transport.state.store(2, std::memory_order_relaxed);
            {
                const int64_t ci = j.value("countinFrames", (int64_t)0);
                if (ci > 0) { g_countin_total.store(ci, std::memory_order_relaxed);
                              g_countin_frames.store(ci, std::memory_order_relaxed); }
            }
            nlohmann::json started{{"type", "take_started"}, {"dir", mtr.dir()},
                                   {"originFrame", origin}, {"sampleRate", sr_i},
                                   {"armed", mtr.armed()}, {"ext", mtr.file_ext()}};
            ipc.send_json(started.dump());

        } else if (type == "stop_multitrack_record") {
            if (mtr.is_recording()) {
                mtr.stop();
                nlohmann::json done{{"type", "take_finished"}, {"dir", mtr.dir()},
                                    {"originFrame", mtr.origin_frame()},
                                    {"endFrame", g_transport.frame.load(std::memory_order_relaxed)},
                                    {"frames", mtr.recorded_frames()},
                                    {"sampleRate", mtr.sample_rate()},
                                    {"armed", mtr.armed()},
                                    {"ext", mtr.file_ext()},
                                    {"overrun", mtr.had_overrun()}};
                ipc.send_json(done.dump());
            }
            // Leave the transport running (state 1) so playback of what was
            // just captured can start immediately; an explicit transport_stop
            // parks it.
            if (g_transport.state.load(std::memory_order_relaxed) == 2)
                g_transport.state.store(1, std::memory_order_relaxed);
        }
    });

    // Live FX-editor param / bypass changes. These must NOT touch insert_chain
    // from this (IPC) thread — that vector, and the PluginInstance lifetimes,
    // are owned by the audio thread. Queue onto plugin_cmd_ring like the
    // structural commands; the audio thread applies them against the chain it
    // owns. The modern UI sends real LV2 control-port symbols (see
    // ui/src/data/calfPlugins.ts), so no per-URI remap is needed here — an
    // unrecognised symbol is a harmless no-op in set_control_value_by_symbol.
    ipc.set_plugin_callback([plugin_cmd_ring](const std::string& type, int channel_id, int p_idx, const std::string& param_id, float value) {
        if (p_idx < 0) return;
        PluginCmd cmd{};
        cmd.channel_id = channel_id;
        cmd.index = p_idx;
        cmd.value = value;
        if (type == "set_plugin_bypass") {
            cmd.type = PluginCmdType::SetBypass;
        } else if (type == "set_plugin_param") {
            cmd.type = PluginCmdType::SetParam;
            std::strncpy(cmd.sym, param_id.c_str(), sizeof(cmd.sym) - 1);
        } else {
            return;
        }
        if (jack_ringbuffer_write_space(plugin_cmd_ring) >= sizeof(PluginCmd)) {
            AES67_TSAN_RELEASE(plugin_cmd_ring);
            jack_ringbuffer_write(plugin_cmd_ring, reinterpret_cast<const char*>(&cmd), sizeof(PluginCmd));
        } else {
            std::cerr << "Plugin command ring full, dropping a param/bypass change" << std::endl;
        }
    });

    // Plugin-chain structure changes (add/remove/reorder/bulk-load) — see
    // PluginCmd's comment. LV2 instantiation (and seeding a fresh
    // instance's initial params/enabled state, safe here since nothing
    // else can see it yet) happens on this thread; the actual insert_chain
    // mutation is deferred to the audio thread via plugin_cmd_ring.
    ipc.set_plugin_manage_callback([&channels, &lv2_host, plugin_cmd_ring, sr](const nlohmann::json& j) {
        std::string type = j.value("type", "");
        int channel_id = j.value("channel", -1);
        if (channels.find(channel_id) == channels.end()) return;

        auto enqueue = [plugin_cmd_ring](const PluginCmd& cmd) {
            if (jack_ringbuffer_write_space(plugin_cmd_ring) >= sizeof(PluginCmd)) {
                AES67_TSAN_RELEASE(plugin_cmd_ring);
                jack_ringbuffer_write(plugin_cmd_ring, reinterpret_cast<const char*>(&cmd), sizeof(PluginCmd));
            } else {
                std::cerr << "Plugin command ring full, dropping a plugin-chain command" << std::endl;
            }
        };

        auto seed_params = [](plugins::PluginInstance* inst, const std::string& uri, const nlohmann::json& params) {
            if (!params.is_object()) return;
            for (auto& [key, val] : params.items()) {
                if (val.is_number()) {
                    inst->set_control_value_by_symbol(remap_param_symbol(uri, key), val.get<float>());
                }
            }
        };

        if (type == "add_plugin") {
            std::string uri = j.value("uri", "");
            auto inst = lv2_host.instantiate_plugin(uri, sr);
            if (!inst) { std::cerr << "add_plugin: failed to instantiate " << uri << std::endl; return; }
            inst->bypassed.store(!j.value("enabled", true), std::memory_order_relaxed);
            seed_params(inst.get(), uri, j.value("params", nlohmann::json::object()));
            // No index given (or a huge one) means "append" — the audio
            // thread clamps this to chain.size() when it applies the
            // command, so this thread never needs to read that size itself.
            int index = j.value("index", INT32_MAX);
            enqueue(PluginCmd{PluginCmdType::Add, channel_id, index, 0, inst.release()});
        } else if (type == "remove_plugin") {
            int idx = j.value("pluginIndex", -1);
            enqueue(PluginCmd{PluginCmdType::Remove, channel_id, idx, 0, nullptr});
        } else if (type == "reorder_plugin") {
            int from = j.value("fromIndex", -1);
            int to = j.value("toIndex", -1);
            enqueue(PluginCmd{PluginCmdType::Reorder, channel_id, from, to, nullptr});
        } else if (type == "replace_plugin") {
            int idx = j.value("pluginIndex", -1);
            std::string uri = j.value("uri", "");
            auto inst = lv2_host.instantiate_plugin(uri, sr);
            if (!inst) { std::cerr << "replace_plugin: failed to instantiate " << uri << std::endl; return; }
            inst->bypassed.store(false, std::memory_order_relaxed);
            seed_params(inst.get(), uri, j.value("params", nlohmann::json::object()));
            // Enqueued as Remove immediately followed by Add at the same
            // index — both land in the same drain pass on the audio thread
            // (nothing else can interleave between them, IPC is the only
            // producer), so this is effectively atomic from the outside.
            enqueue(PluginCmd{PluginCmdType::Remove, channel_id, idx, 0, nullptr});
            enqueue(PluginCmd{PluginCmdType::Add, channel_id, idx, 0, inst.release()});
        } else if (type == "load_rack") {
            enqueue(PluginCmd{PluginCmdType::Clear, channel_id, 0, 0, nullptr});
            if (j.contains("plugins") && j["plugins"].is_array()) {
                int next_index = 0;
                for (auto& pj : j["plugins"]) {
                    std::string uri = pj.value("uri", "");
                    auto inst = lv2_host.instantiate_plugin(uri, sr);
                    if (!inst) {
                        std::cerr << "load_rack: failed to instantiate " << uri << " (skipped)" << std::endl;
                        continue;
                    }
                    inst->bypassed.store(!pj.value("enabled", true), std::memory_order_relaxed);
                    seed_params(inst.get(), uri, pj.value("params", nlohmann::json::object()));
                    enqueue(PluginCmd{PluginCmdType::Add, channel_id, next_index, 0, inst.release()});
                    next_index++;
                }
            }
        }
    });

    // Every callback is installed — now it's safe to start the IPC worker
    // thread (it dispatches into these std::function objects with no lock).
    // Anything queued before now — the plugin catalog dump above — flushes
    // once the thread connects.
    ipc.start();

    // Telemetry cadence — gated on elapsed frames, not block count, so the
    // metering rate stays ~40 Hz regardless of the JACK/PipeWire quantum
    // (a small quantum was pushing this to ~125 Hz and swamping the UI).
    const int meter_interval_frames = std::max<int>(1, static_cast<int>(sr / 40.0));
    int frame_counter = 0;   // frames accumulated since the last metering emit
    // Metronome click voice (audio thread only).
    double metro_remain = 0.0, metro_phase = 0.0, metro_freq = 1000.0, metro_amp = 0.0;
    long long metro_last_beat = -1;
    // Count-in click voice (audio thread only) — plan Phase 5 tail.
    double ci_remain = 0.0, ci_phase = 0.0, ci_freq = 1000.0, ci_amp = 0.0;
    long long ci_last_beat = -1;
    std::vector<float> tmp_L(8192, 0.0f);
    std::vector<float> tmp_R(8192, 0.0f);
    std::vector<float> tmp_out_L(8192, 0.0f);
    std::vector<float> tmp_out_R(8192, 0.0f);
    std::vector<char> meter_json(32768, 0);   // headroom for live-record peak batches

    // Timecode & sync engines (audio thread only) — plan Phase 3d.
    timecode::LtcEncoder ltc_enc;
    timecode::LtcDecoder ltc_dec;
    timecode::MtcEncoder mtc_enc;
    timecode::MtcEvent   mtc_events[48];
    int chase_starve_blocks = 0;
    bool ltc_anchored = false;       // flywheel: transport jam-synced to the incoming LTC
    bool ltc_chase_prev = false;
    double ltc_err_smooth = 0.0;     // samples (transport behind LTC = positive)
    int  ltc_corr = 0;               // per-block transport nudge toward zero error
    int  ltc_recue_votes = 0;        // consecutive gross-error decodes before a re-cue
    int  ltc_settle_blocks = 0;      // fast-converge window right after anchoring

    jack.set_process_callback([&](jack_nframes_t nframes) {
        auto inputs = jack.get_input_ports();
        auto outputs = jack.get_output_ports();

        if (inputs.size() < static_cast<size_t>(2 * NUM_CHANNELS + 2) ||
            outputs.size() < static_cast<size_t>(2 + 2 * NUM_AUX + 2)) return;
        if (nframes > 8192) return;

        // ── Transport ── consume a pending locate, then read this block's
        // start frame (its value for the whole callback). Advancing happens
        // at the end so `block_start_frame` is the position of sample 0.
        {
            int64_t loc = g_transport.locate_to.exchange(-1, std::memory_order_relaxed);
            if (loc >= 0) g_transport.frame.store(static_cast<uint64_t>(loc), std::memory_order_relaxed);
        }
        const uint64_t block_start_frame = g_transport.frame.load(std::memory_order_relaxed);
        const int transport_state = g_transport.state.load(std::memory_order_relaxed);
        player.set_transport(block_start_frame, transport_state);

        // ── Count-in (plan Phase 5 tail) ── while frames remain: clicks only,
        // transport frozen, nothing mixed or recorded. Ends exactly on a block
        // boundary, after which the normal path resumes with the transport at
        // its origin and the recorder tap live.
        {
            int64_t countin = g_countin_frames.load(std::memory_order_relaxed);
            if (countin > 0) {
                for (jack_port_t* p : outputs) {
                    float* b = jack.get_buffer(p, nframes);
                    if (b) std::memset(b, 0, sizeof(float) * nframes);
                }
                for (jack_port_t* mp : jack.get_midi_output_ports())
                    jack_midi_clear_buffer(jack_port_get_buffer(mp, nframes));

                const int64_t total = std::max<int64_t>(1, g_countin_total.load(std::memory_order_relaxed));
                const double  fpb   = std::max(1.0, g_metro_fpb.load(std::memory_order_relaxed));
                const int     signum = std::max(1, g_metro_signum.load(std::memory_order_relaxed));
                const int     dest   = g_metro_dest.load(std::memory_order_relaxed);
                float* oL = jack.get_buffer(outputs[0], nframes);
                float* oR = jack.get_buffer(outputs[1], nframes);
                float* mL = outputs.size() > (size_t)MONITOR_PORT_L ? jack.get_buffer(outputs[MONITOR_PORT_L], nframes) : nullptr;
                float* mR = outputs.size() > (size_t)MONITOR_PORT_R ? jack.get_buffer(outputs[MONITOR_PORT_R], nframes) : nullptr;
                const bool to_mon = (dest == 0 || dest == 2);
                const bool to_mst = (dest == 1 || dest == 2);
                const double CI_LEN = sr * 0.035;   // 35 ms click

                for (jack_nframes_t s = 0; s < nframes && countin > 0; ++s, --countin) {
                    const int64_t elapsed = total - countin;
                    const long long beat = (long long)((double)elapsed / fpb);
                    if (beat != ci_last_beat) {
                        ci_last_beat = beat;
                        const bool down = (beat % signum) == 0;
                        ci_freq = down ? 1760.0 : 1245.0;
                        ci_amp  = down ? 0.5 : 0.3;
                        ci_remain = CI_LEN;
                        ci_phase = 0.0;
                    }
                    if (ci_remain > 0.0) {
                        const double env = ci_remain / CI_LEN;
                        const float smp = (float)(std::sin(ci_phase) * ci_amp * env * env);
                        if (to_mon) { if (mL) mL[s] += smp; if (mR) mR[s] += smp; }
                        if (to_mst) { if (oL) oL[s] += smp; if (oR) oR[s] += smp; }
                        ci_phase += 2.0 * M_PI * ci_freq / sr;
                        ci_remain -= 1.0;
                    }
                }
                g_countin_frames.store(countin, std::memory_order_relaxed);

                // Throttled minimal metering so the UI can show the count-in.
                frame_counter += static_cast<int>(nframes);
                if (frame_counter >= meter_interval_frames) {
                    frame_counter = 0;
                    snprintf(meter_json.data(), meter_json.size(),
                        "{\"type\":\"metering\",\"transport\":{\"frame\":%llu,\"state\":%d,\"sr\":%d},"
                        "\"tc\":{\"countin\":%lld}}",
                        static_cast<unsigned long long>(block_start_frame), transport_state,
                        static_cast<int>(sr), static_cast<long long>(countin));
                    ipc.send_multichannel_metering(meter_json.data());
                }
                return;
            }
            ci_last_beat = -1;
        }

        // ── Timecode & sync (plan Phase 3d) ── sample the PTP-disciplined wall
        // clock, work out the timecode at sample 0 of this block, then chase
        // incoming LTC (generation happens after the mix, near the end).
        struct timespec ts_now;
        clock_gettime(CLOCK_REALTIME, &ts_now);
        const double tod_sec = static_cast<double>(ts_now.tv_sec % 86400) + ts_now.tv_nsec * 1e-9;
        g_tod_sec.store(tod_sec, std::memory_order_relaxed);
        const int  tc_fps    = g_tc_fps.load(std::memory_order_relaxed);
        const bool tc_df     = g_tc_df.load(std::memory_order_relaxed) != 0;
        const int  tc_source = g_tc_source.load(std::memory_order_relaxed);
        const int64_t tc_off = g_tc_offset_frames.load(std::memory_order_relaxed);
        const double sr_per_tcf = timecode::sr_per_tc_frame(sr, tc_fps, tc_df);
        int64_t tc_frame0 = tc_source == 1
            ? static_cast<int64_t>(std::llround(tod_sec * sr / sr_per_tcf))
            : static_cast<int64_t>(std::llround(block_start_frame / sr_per_tcf)) + tc_off;
        if (tc_frame0 < 0) tc_frame0 = 0;

        // ── LTC chase (plan Phase 3d follow-up: jam-sync then flywheel) ──
        // On the first clean decode we jam the transport once; after that we
        // trust the JACK clock (same PTP media clock the LTC rides on this box)
        // and only re-jam on a gross discontinuity. Dropouts are ridden through
        // — the transport never stops on signal loss once anchored.
        const bool chase_on = g_ltc_chase.load(std::memory_order_relaxed) != 0;
        ltc_corr = 0;
        if (chase_on && inputs.size() > static_cast<size_t>(LTC_IN_PORT)) {
            if (!ltc_chase_prev) {
                ltc_anchored = false; ltc_err_smooth = 0.0; chase_starve_blocks = 0;
                ltc_recue_votes = 0; ltc_settle_blocks = 0;
                ltc_dec.reset();   // drop any stale shift-register / bit-clock state
            }
            if (ltc_settle_blocks > 0) --ltc_settle_blocks;
            float* ltc_in = jack.get_buffer(inputs[LTC_IN_PORT], nframes);
            if (ltc_in) {
                float pk = 0.0f;
                for (jack_nframes_t s = 0; s < nframes; ++s) pk = std::max(pk, std::fabs(ltc_in[s]));
                g_ltc_in_peak.store(pk, std::memory_order_relaxed);
            }
            const bool got = ltc_in && ltc_dec.process(ltc_in, nframes, sr_per_tcf / 160.0);
            if (got) {
                chase_starve_blocks = 0;
                timecode::SmpteTime st = ltc_dec.last();
                const int64_t dec_tcf = timecode::smpte_to_frames(st, tc_fps, tc_df);
                g_ltc_chase_frame.store(dec_tcf, std::memory_order_relaxed);
                g_ltc_chase_locked.store(1, std::memory_order_relaxed);
                const double now_samp =
                    static_cast<double>(dec_tcf + 1 - tc_off) * sr_per_tcf - ltc_dec.end_offset();
                int64_t target = static_cast<int64_t>(std::llround(now_samp));
                if (target < 0) target = 0;
                const int64_t err = target - static_cast<int64_t>(block_start_frame);
                if (!ltc_anchored) {
                    g_transport.locate_to.store(target, std::memory_order_relaxed);   // jam once
                    ltc_anchored = true;
                    ltc_err_smooth = 0.0;
                    ltc_recue_votes = 0;
                    ltc_settle_blocks = 512;   // ~2 s fast-converge window
                    if (g_transport.state.load(std::memory_order_relaxed) == 0)
                        g_transport.state.store(1, std::memory_order_relaxed);
                } else if (std::llabs(err) > static_cast<int64_t>(0.5 * sr)) {
                    // A gross error — but only re-cue after several agreeing
                    // decodes so a single garbled frame can't slam the transport.
                    if (++ltc_recue_votes >= 5) {
                        g_transport.locate_to.store(target, std::memory_order_relaxed);
                        ltc_err_smooth = 0.0;
                        ltc_recue_votes = 0;
                        ltc_settle_blocks = 512;
                    }
                } else if (ltc_settle_blocks > 0 &&
                           std::llabs(err) > static_cast<int64_t>(0.4 * sr_per_tcf)) {
                    // Fast converge just after (re-)acquiring: a handful of small
                    // locates instead of waiting for the servo.
                    g_transport.locate_to.store(target, std::memory_order_relaxed);
                    ltc_err_smooth = 0.0;
                    ltc_recue_votes = 0;
                } else {
                    ltc_recue_votes = 0;
                    // Flywheel servo: slew a few samples/block toward the LTC.
                    // Forward nudges are free; a small backward nudge stays well
                    // under TimelinePlayer's discontinuity threshold.
                    ltc_err_smooth += (static_cast<double>(err) - ltc_err_smooth) * 0.0625;
                    ltc_corr = std::clamp(static_cast<int>(std::llround(ltc_err_smooth * 0.08)), -6, 6);
                }
                g_ltc_chase_err.store(ltc_err_smooth * 1000.0 / sr, std::memory_order_relaxed);
            } else if (ltc_anchored) {
                // Flywheel through the dropout; drop the LOCK lamp only after a
                // long sustained loss — the transport keeps rolling regardless.
                if (++chase_starve_blocks * static_cast<int>(nframes) > static_cast<int>(sr * 5.0))
                    g_ltc_chase_locked.store(0, std::memory_order_relaxed);
            } else if (++chase_starve_blocks * static_cast<int>(nframes) > static_cast<int>(sr * 0.25)) {
                g_ltc_chase_locked.store(0, std::memory_order_relaxed);
            }
        }
        ltc_chase_prev = chase_on;

        // Apply any queued plugin-chain mutations before processing any
        // channel this cycle — insert_chain is only ever touched here, on
        // the audio thread, which is what makes Add/Remove/Reorder RT-safe
        // (bounded insert/erase within the reserved capacity below, no
        // allocation; removed instances are handed off to plugin_trash_ring
        // rather than destroyed here).
        while (jack_ringbuffer_read_space(plugin_cmd_ring) >= sizeof(PluginCmd)) {
            PluginCmd cmd;
            jack_ringbuffer_read(plugin_cmd_ring, reinterpret_cast<char*>(&cmd), sizeof(PluginCmd));
            AES67_TSAN_ACQUIRE(plugin_cmd_ring);

            auto trash = [plugin_trash_ring](plugins::PluginInstance* raw) {
                if (!raw) return;
                if (jack_ringbuffer_write_space(plugin_trash_ring) >= sizeof(void*)) {
                    AES67_TSAN_RELEASE(plugin_trash_ring);
                    jack_ringbuffer_write(plugin_trash_ring, reinterpret_cast<const char*>(&raw), sizeof(void*));
                } else {
                    // Trash ring full (should never happen in practice) —
                    // leak rather than call a non-RT-safe destructor here.
                    std::cerr << "Plugin trash ring full, leaking an instance" << std::endl;
                }
            };

            auto it = channels.find(cmd.channel_id);
            if (it == channels.end()) {
                if (cmd.type == PluginCmdType::Add) trash(cmd.instance);
                continue;
            }
            auto& chain = it->second.insert_chain;

            if (cmd.type == PluginCmdType::Add) {
                if (chain.size() >= MAX_PLUGINS_PER_CHANNEL) {
                    trash(cmd.instance);
                } else {
                    int pos = std::clamp(cmd.index, 0, static_cast<int>(chain.size()));
                    chain.insert(chain.begin() + pos, std::unique_ptr<plugins::PluginInstance>(cmd.instance));
                }
            } else if (cmd.type == PluginCmdType::Remove) {
                if (cmd.index >= 0 && cmd.index < static_cast<int>(chain.size())) {
                    trash(chain[cmd.index].release());
                    chain.erase(chain.begin() + cmd.index);
                }
            } else if (cmd.type == PluginCmdType::Reorder) {
                int from = cmd.index, to = cmd.index2;
                if (from >= 0 && from < static_cast<int>(chain.size()) &&
                    to >= 0 && to < static_cast<int>(chain.size()) && from != to) {
                    auto moved = std::move(chain[from]);
                    chain.erase(chain.begin() + from);
                    chain.insert(chain.begin() + to, std::move(moved));
                }
            } else if (cmd.type == PluginCmdType::Clear) {
                for (auto& p : chain) trash(p.release());
                chain.clear();
            } else if (cmd.type == PluginCmdType::SetBypass) {
                if (cmd.index >= 0 && cmd.index < static_cast<int>(chain.size()))
                    chain[cmd.index]->bypassed.store(cmd.value > 0.5f, std::memory_order_relaxed);
            } else if (cmd.type == PluginCmdType::SetParam) {
                if (cmd.index >= 0 && cmd.index < static_cast<int>(chain.size()))
                    chain[cmd.index]->set_control_value_by_symbol(cmd.sym, cmd.value);
            }
        }

        float* out_L = jack.get_buffer(outputs[0], nframes);
        float* out_R = jack.get_buffer(outputs[1], nframes);
        float* monitor_L = jack.get_buffer(outputs[MONITOR_PORT_L], nframes);
        float* monitor_R = jack.get_buffer(outputs[MONITOR_PORT_R], nframes);
        if (!out_L || !out_R) return;

        std::memset(out_L, 0, sizeof(float) * nframes);
        std::memset(out_R, 0, sizeof(float) * nframes);
        if (monitor_L) std::memset(monitor_L, 0, sizeof(float) * nframes);
        if (monitor_R) std::memset(monitor_R, 0, sizeof(float) * nframes);

        float* bus_out_L[NUM_AUX];
        float* bus_out_R[NUM_AUX];
        for (int b = 0; b < NUM_AUX; b++) {
            bus_out_L[b] = jack.get_buffer(outputs[2 + b*2], nframes);
            bus_out_R[b] = jack.get_buffer(outputs[2 + b*2 + 1], nframes);
            if (bus_out_L[b]) std::memset(bus_out_L[b], 0, sizeof(float) * nframes);
            if (bus_out_R[b]) std::memset(bus_out_R[b], 0, sizeof(float) * nframes);
        }

        bool any_solo = false;
        for (int i = 1; i <= NUM_CHANNELS; i++) {
            if (channels[i].solo.load(std::memory_order_relaxed)) { any_solo = true; break; }
        }

        // Per-plugin in/out metering for the UI's currently-open editor.
        const int fx_ch = g_fx_focus_channel.load(std::memory_order_relaxed);
        const int fx_pi = g_fx_focus_plugin.load(std::memory_order_relaxed);
        auto meter_fx = [&](int chan, int plugin_idx, bool is_input,
                            const float* l, const float* r) {
            if (plugin_idx != fx_pi || chan != fx_ch) return;
            float pl = 0.0f, pr = 0.0f;
            for (jack_nframes_t s = 0; s < nframes; s++) {
                float a = std::fabs(l[s]); if (a > pl) pl = a;
                float b = std::fabs(r[s]); if (b > pr) pr = b;
            }
            if (is_input) {
                g_fx_in_peak_l = std::max(g_fx_in_peak_l, pl);
                g_fx_in_peak_r = std::max(g_fx_in_peak_r, pr);

                // feed the RTA off the mono sum of this plugin's input
                for (jack_nframes_t s = 0; s < nframes; s++) {
                    float x = 0.5f * (l[s] + r[s]);
                    for (int k = 0; k < RTA_BANDS; ++k) {
                        float sn = x + g_rta_coeff[k] * g_rta_s1[k] - g_rta_s2[k];
                        g_rta_s2[k] = g_rta_s1[k];
                        g_rta_s1[k] = sn;
                    }
                }
                g_rta_count += nframes;
                if (g_rta_count >= RTA_WIN) {
                    for (int k = 0; k < RTA_BANDS; ++k) {
                        float power = g_rta_s1[k] * g_rta_s1[k] + g_rta_s2[k] * g_rta_s2[k]
                                    - g_rta_coeff[k] * g_rta_s1[k] * g_rta_s2[k];
                        float mag = std::sqrt(std::max(power, 0.0f)) * (2.0f / g_rta_count);
                        float db = mag > 1e-6f ? 20.0f * std::log10(mag) : -120.0f;
                        // fast rise, slow fall
                        g_rta_mag[k] = db > g_rta_mag[k] ? db : g_rta_mag[k] * 0.65f + db * 0.35f;
                        g_rta_s1[k] = g_rta_s2[k] = 0.0f;
                    }
                    g_rta_count = 0;
                }
            } else {
                g_fx_out_peak_l = std::max(g_fx_out_peak_l, pl);
                g_fx_out_peak_r = std::max(g_fx_out_peak_r, pr);
            }
        };

        for (int i = 1; i <= NUM_CHANNELS; i++) {
            float* in_buf_L = jack.get_buffer(inputs[(i - 1) * 2], nframes);
            float* in_buf_R = jack.get_buffer(inputs[(i - 1) * 2 + 1], nframes);
            if (!in_buf_L || !in_buf_R) continue;

            ChannelState& st = channels[i];

            // Multitrack record tap: raw pre-insert channel input (plan D1).
            // No-op unless this channel is armed in the current take.
            mtr.write(i, in_buf_L, in_buf_R, static_cast<int>(nframes));

            // 1. Copy Stereo input to temporary buffers
            std::memcpy(tmp_L.data(), in_buf_L, sizeof(float) * nframes);
            std::memcpy(tmp_R.data(), in_buf_R, sizeof(float) * nframes);

            // Timeline playback (plan Phase 2a): while the transport is
            // *playing* (not recording), the timeline is the channel source —
            // render() overwrites tmp_L/tmp_R with this track's clip audio
            // (silence in gaps). Everything downstream — inserts, fader, pan,
            // sends, metering, routing — then applies unchanged.
            //
            // Virtual soundcheck: a channel whose bit is set in
            // g_monitor_input_mask stays on its live input even while the
            // timeline plays, so the operator can A/B one source (or a
            // talkback mic) against the recorded mix.
            const bool force_live =
                g_monitor_input_mask.load(std::memory_order_relaxed) & (1u << (i - 1));
            if (transport_state == 1 && !force_live) {
                player.render(i, tmp_L.data(), tmp_R.data(), nframes);
            }

            // Polarity invert ("ø") — applied to whatever the channel source is
            // (live input or timeline playback), ahead of the insert chain.
            if (st.phase.load(std::memory_order_relaxed)) {
                for (uint32_t s = 0; s < nframes; ++s) { tmp_L[s] = -tmp_L[s]; tmp_R[s] = -tmp_R[s]; }
            }

            // 2. Process LV2 Insert Chain
            int p_i = 0;
            for (auto& plugin_ptr : st.insert_chain) {
                auto* plugin = plugin_ptr.get();
                meter_fx(i, p_i, true, tmp_L.data(), tmp_R.data());
                if (plugin->bypassed.load(std::memory_order_relaxed)) {
                    meter_fx(i, p_i, false, tmp_L.data(), tmp_R.data());
                    p_i++;
                    continue;
                }
                int in_l = plugin->get_audio_input_port(0);
                int in_r = plugin->get_audio_input_port(1);
                if (in_r == -1) in_r = in_l;

                int out_l = plugin->get_audio_output_port(0);
                int out_r = plugin->get_audio_output_port(1);
                if (out_r == -1) out_r = out_l;

                if (in_l != -1) plugin->connect_audio_port(in_l, tmp_L.data());
                if (in_r != -1) plugin->connect_audio_port(in_r, tmp_R.data());
                if (out_l != -1) plugin->connect_audio_port(out_l, tmp_out_L.data());
                if (out_r != -1) plugin->connect_audio_port(out_r, tmp_out_R.data());

                plugin->run(nframes);

                // Copy output back to input buffers for the next plugin in chain
                std::memcpy(tmp_L.data(), tmp_out_L.data(), sizeof(float) * nframes);
                std::memcpy(tmp_R.data(), tmp_out_R.data(), sizeof(float) * nframes);
                meter_fx(i, p_i, false, tmp_L.data(), tmp_R.data());
                p_i++;
            }

            // 3. Apply Fader, Mute, Pan
            bool muted = st.mute.load(std::memory_order_relaxed) ||
                         (any_solo && !st.solo.load(std::memory_order_relaxed));
            float gain = muted ? 0.0f : (st.fader.load(std::memory_order_relaxed) * 2.0f);
            float pan_norm = (st.pan.load(std::memory_order_relaxed) + 1.0f) / 2.0f;
            float pan_gain_L = std::cos(pan_norm * M_PI_2);
            float pan_gain_R = std::sin(pan_norm * M_PI_2);

            float peak_l = 0.0f;
            float peak_r = 0.0f;

            float master_send = st.aux_sends[0].load(std::memory_order_relaxed) / 0.75f;
            float b_send[NUM_AUX] = {0.0f};
            for (int b = 0; b < NUM_AUX; b++) {
                b_send[b] = st.aux_sends[b + 1].load(std::memory_order_relaxed) / 0.75f;
            }

            for (jack_nframes_t s = 0; s < nframes; s++) {
                float spl_L = tmp_L[s] * gain * pan_gain_L;
                float spl_R = tmp_R[s] * gain * pan_gain_R;

                out_L[s] += spl_L * master_send;
                out_R[s] += spl_R * master_send;

                for (int b = 0; b < NUM_AUX; b++) {
                    if (bus_out_L[b]) bus_out_L[b][s] += spl_L * b_send[b];
                    if (bus_out_R[b]) bus_out_R[b][s] += spl_R * b_send[b];
                }

                // Monitor bus: every input channel is summed here post-fader
                // at a fixed unity send with no per-channel level control
                // (there's no adjustable "send to Monitor" the operator can
                // set — it's always everything, post-fader).
                if (monitor_L) monitor_L[s] += spl_L;
                if (monitor_R) monitor_R[s] += spl_R;

                float abs_l = std::fabs(spl_L);
                float abs_r = std::fabs(spl_R);
                if (abs_l > peak_l) peak_l = abs_l;
                if (abs_r > peak_r) peak_r = abs_r;
            }

            st.current_peak_l = std::max(st.current_peak_l, peak_l);
            st.current_peak_r = std::max(st.current_peak_r, peak_r);
        }

        // Every multitrack tap for this block is in — advance the block
        // sequence the recorder's reaper fences retired-writer destruction on.
        mtr.end_audio_block();

        // Talkback: only while pressed, summed pre-fader/pan into every bus
        // buffer selected in the destination mask (Master and/or any Aux
        // buses), so it rides through each bus's own fader/pan/inserts like
        // any other source. Monitor is structurally excluded — the mask has
        // no bit position for it, so there is no code path that can route
        // talkback there, regardless of what a client requests.
        if (talkback.ptt_active.load(std::memory_order_relaxed)) {
            float* tb_in_L = jack.get_buffer(inputs[TALKBACK_PORT_L], nframes);
            float* tb_in_R = jack.get_buffer(inputs[TALKBACK_PORT_R], nframes);
            uint32_t dest_mask = talkback.dest_bus_mask.load(std::memory_order_relaxed);

            if (tb_in_L && tb_in_R && dest_mask != 0) {
                if (dest_mask & 1u) {
                    for (jack_nframes_t s = 0; s < nframes; s++) {
                        out_L[s] += tb_in_L[s];
                        out_R[s] += tb_in_R[s];
                    }
                }
                for (int b = 0; b < NUM_AUX; b++) {
                    if (!(dest_mask & (1u << (b + 1)))) continue;
                    float* dest_L = bus_out_L[b];
                    float* dest_R = bus_out_R[b];
                    if (!dest_L || !dest_R) continue;
                    for (jack_nframes_t s = 0; s < nframes; s++) {
                        dest_L[s] += tb_in_L[s];
                        dest_R[s] += tb_in_R[s];
                    }
                }
            }
        }

        // Process Master + Aux buses (100, 101..100+NUM_AUX), then Monitor
        // separately since its buffer isn't part of the aux array.
        for (int b_id = MASTER_ID; b_id <= AUX_BASE + NUM_AUX - 1; b_id++) {
            ChannelState& b_st = channels[b_id];
            float* buf_L = (b_id == MASTER_ID) ? out_L : bus_out_L[b_id - AUX_BASE];
            float* buf_R = (b_id == MASTER_ID) ? out_R : bus_out_R[b_id - AUX_BASE];
            if (!buf_L || !buf_R) continue;

            std::memcpy(tmp_L.data(), buf_L, sizeof(float) * nframes);
            std::memcpy(tmp_R.data(), buf_R, sizeof(float) * nframes);

            int b_p_i = 0;
            for (auto& plugin_ptr : b_st.insert_chain) {
                auto* plugin = plugin_ptr.get();
                meter_fx(b_id, b_p_i, true, tmp_L.data(), tmp_R.data());
                if (plugin->bypassed.load(std::memory_order_relaxed)) {
                    meter_fx(b_id, b_p_i, false, tmp_L.data(), tmp_R.data());
                    b_p_i++;
                    continue;
                }
                int in_l = plugin->get_audio_input_port(0);
                int in_r = plugin->get_audio_input_port(1);
                if (in_r == -1) in_r = in_l;
                int out_l = plugin->get_audio_output_port(0);
                int out_r = plugin->get_audio_output_port(1);
                if (out_r == -1) out_r = out_l;

                if (in_l != -1) plugin->connect_audio_port(in_l, tmp_L.data());
                if (in_r != -1) plugin->connect_audio_port(in_r, tmp_R.data());
                if (out_l != -1) plugin->connect_audio_port(out_l, tmp_out_L.data());
                if (out_r != -1) plugin->connect_audio_port(out_r, tmp_out_R.data());

                plugin->run(nframes);

                std::memcpy(tmp_L.data(), tmp_out_L.data(), sizeof(float) * nframes);
                std::memcpy(tmp_R.data(), tmp_out_R.data(), sizeof(float) * nframes);
                meter_fx(b_id, b_p_i, false, tmp_L.data(), tmp_R.data());
                b_p_i++;
            }

            float b_gain = b_st.mute.load(std::memory_order_relaxed) ? 0.0f
                         : (b_st.fader.load(std::memory_order_relaxed) * 2.0f);
            float b_pan_norm = (b_st.pan.load(std::memory_order_relaxed) + 1.0f) / 2.0f;
            float b_pan_gain_L = std::cos(b_pan_norm * M_PI_2);
            float b_pan_gain_R = std::sin(b_pan_norm * M_PI_2);
            float b_peak_l = 0.0f;
            float b_peak_r = 0.0f;

            for (jack_nframes_t s = 0; s < nframes; s++) {
                float out_spl_L = tmp_L[s] * b_gain * b_pan_gain_L;
                float out_spl_R = tmp_R[s] * b_gain * b_pan_gain_R;
                buf_L[s] = out_spl_L;
                buf_R[s] = out_spl_R;

                float abs_l = std::fabs(out_spl_L);
                float abs_r = std::fabs(out_spl_R);
                if (abs_l > b_peak_l) b_peak_l = abs_l;
                if (abs_r > b_peak_r) b_peak_r = abs_r;
            }

            b_st.current_peak_l = std::max(b_st.current_peak_l, b_peak_l);
            b_st.current_peak_r = std::max(b_st.current_peak_r, b_peak_r);
        }

        // Monitor: same insert-chain + fader/pan pattern as Master/Aux, on
        // its own dedicated buffer.
        if (monitor_L && monitor_R) {
            ChannelState& m_st = channels[MONITOR_ID];

            std::memcpy(tmp_L.data(), monitor_L, sizeof(float) * nframes);
            std::memcpy(tmp_R.data(), monitor_R, sizeof(float) * nframes);

            int m_p_i = 0;
            for (auto& plugin_ptr : m_st.insert_chain) {
                auto* plugin = plugin_ptr.get();
                meter_fx(MONITOR_ID, m_p_i, true, tmp_L.data(), tmp_R.data());
                if (plugin->bypassed.load(std::memory_order_relaxed)) {
                    meter_fx(MONITOR_ID, m_p_i, false, tmp_L.data(), tmp_R.data());
                    m_p_i++;
                    continue;
                }
                int in_l = plugin->get_audio_input_port(0);
                int in_r = plugin->get_audio_input_port(1);
                if (in_r == -1) in_r = in_l;
                int out_l = plugin->get_audio_output_port(0);
                int out_r = plugin->get_audio_output_port(1);
                if (out_r == -1) out_r = out_l;

                if (in_l != -1) plugin->connect_audio_port(in_l, tmp_L.data());
                if (in_r != -1) plugin->connect_audio_port(in_r, tmp_R.data());
                if (out_l != -1) plugin->connect_audio_port(out_l, tmp_out_L.data());
                if (out_r != -1) plugin->connect_audio_port(out_r, tmp_out_R.data());

                plugin->run(nframes);

                std::memcpy(tmp_L.data(), tmp_out_L.data(), sizeof(float) * nframes);
                std::memcpy(tmp_R.data(), tmp_out_R.data(), sizeof(float) * nframes);
                meter_fx(MONITOR_ID, m_p_i, false, tmp_L.data(), tmp_R.data());
                m_p_i++;
            }

            float m_gain = m_st.mute.load(std::memory_order_relaxed) ? 0.0f
                         : (m_st.fader.load(std::memory_order_relaxed) * 2.0f);
            float m_pan_norm = (m_st.pan.load(std::memory_order_relaxed) + 1.0f) / 2.0f;
            float m_pan_gain_L = std::cos(m_pan_norm * M_PI_2);
            float m_pan_gain_R = std::sin(m_pan_norm * M_PI_2);
            float m_peak_l = 0.0f;
            float m_peak_r = 0.0f;

            for (jack_nframes_t s = 0; s < nframes; s++) {
                float out_spl_L = tmp_L[s] * m_gain * m_pan_gain_L;
                float out_spl_R = tmp_R[s] * m_gain * m_pan_gain_R;
                monitor_L[s] = out_spl_L;
                monitor_R[s] = out_spl_R;

                float abs_l = std::fabs(out_spl_L);
                float abs_r = std::fabs(out_spl_R);
                if (abs_l > m_peak_l) m_peak_l = abs_l;
                if (abs_r > m_peak_r) m_peak_r = abs_r;
            }

            m_st.current_peak_l = std::max(m_st.current_peak_l, m_peak_l);
            m_st.current_peak_r = std::max(m_st.current_peak_r, m_peak_r);
        }

        // ── Metronome ── a short click on each beat while the transport rolls,
        // summed post-fader onto the monitor bus (and/or master) at a fixed
        // reference level.
        if (g_metro_enabled.load(std::memory_order_relaxed) && transport_state != 0) {
            const double fpb = g_metro_fpb.load(std::memory_order_relaxed);
            const int signum = std::max(1, g_metro_signum.load(std::memory_order_relaxed));
            const int dest = g_metro_dest.load(std::memory_order_relaxed);
            const bool to_mon = (dest == 0 || dest == 2) && monitor_L && monitor_R;
            const bool to_mst = (dest == 1 || dest == 2);
            const double click_len = static_cast<double>(sr) * 0.035;   // 35 ms
            for (jack_nframes_t s = 0; s < nframes; ++s) {
                const uint64_t pos = block_start_frame + s;
                const long long beat = fpb > 0.0 ? static_cast<long long>(static_cast<double>(pos) / fpb) : 0;
                if (beat != metro_last_beat) {
                    metro_last_beat = beat;
                    const bool down = (beat % signum) == 0;
                    metro_freq = down ? 1760.0 : 1245.0;
                    metro_amp  = down ? 0.45 : 0.28;
                    metro_remain = click_len;
                    metro_phase = 0.0;
                }
                if (metro_remain > 0.0) {
                    const double env = metro_remain / click_len;      // 1 → 0
                    const float smp = static_cast<float>(std::sin(metro_phase) * metro_amp * env * env);
                    if (to_mon) { monitor_L[s] += smp; monitor_R[s] += smp; }
                    if (to_mst) { out_L[s] += smp; out_R[s] += smp; }
                    metro_phase += 2.0 * M_PI * metro_freq / static_cast<double>(sr);
                    metro_remain -= 1.0;
                }
            }
        } else {
            metro_last_beat = -1;   // re-arm the first beat on the next roll
        }

        const float* master_bufs[2] = { out_L, out_R };
        recorder.write_audio(master_bufs, 2, nframes);

        // ── BS.1770 loudness on the final Master mix ──
        if (g_lufs_reset.exchange(false, std::memory_order_relaxed)) {
            for (double& b : g_lufs_blocks) b = 0.0;
            g_lufs_block_pos = g_lufs_block_filled = g_lufs_chunks_in_block = 0;
            g_lufs_block_accum = 0.0;
        }
        for (jack_nframes_t s = 0; s < nframes; s++) {
            float l = out_L[s], r = out_R[s];
            double kl = kweight(l, g_kw_l);
            double kr = kweight(r, g_kw_r);
            g_lufs_sq_accum += kl * kl + kr * kr;
            float ap = std::max(std::fabs(l), std::fabs(r));
            if (s > 0) {  // cheap 2x-oversample true-peak estimate
                ap = std::max(ap, 0.5f * (std::fabs(l) + std::fabs(out_L[s - 1])));
                ap = std::max(ap, 0.5f * (std::fabs(r) + std::fabs(out_R[s - 1])));
            }
            if (ap > g_lufs_tp) g_lufs_tp = ap;

            // Master analyser: Goertzel spectrum + correlation + scatter
            for (int k = 0; k < MRTA_BANDS; ++k) {
                float sn = l + r + g_mrta_coeff[k] * g_mrta_s1[k] - g_mrta_s2[k];
                g_mrta_s2[k] = g_mrta_s1[k];
                g_mrta_s1[k] = sn;
            }
            g_corr_lr += double(l) * r;
            g_corr_ll += double(l) * l;
            g_corr_rr += double(r) * r;
            g_corr_n++;
            if (--g_gonio_skip <= 0) {
                g_gonio[g_gonio_pos * 2] = l;
                g_gonio[g_gonio_pos * 2 + 1] = r;
                g_gonio_pos = (g_gonio_pos + 1) % GONIO_POINTS;
                g_gonio_skip = g_gonio_stride;
            }
        }
        g_mrta_count += nframes;
        if (g_mrta_count >= MRTA_WIN) {
            for (int k = 0; k < MRTA_BANDS; ++k) {
                float p = g_mrta_s1[k] * g_mrta_s1[k] + g_mrta_s2[k] * g_mrta_s2[k]
                        - g_mrta_coeff[k] * g_mrta_s1[k] * g_mrta_s2[k];
                float mag = std::sqrt(std::max(p, 0.0f)) * (2.0f / g_mrta_count);
                float db = mag > 1e-6f ? 20.0f * std::log10(mag) : -120.0f;
                g_mrta_mag[k] = db > g_mrta_mag[k] ? db : g_mrta_mag[k] * 0.7f + db * 0.3f;
                g_mrta_s1[k] = g_mrta_s2[k] = 0.0f;
            }
            g_mrta_count = 0;
        }
        if (g_corr_n >= g_lufs_chunk_frames) {
            double denom = std::sqrt(g_corr_ll * g_corr_rr);
            float c = denom > 1e-12 ? float(g_corr_lr / denom) : 0.0f;
            g_corr_val = g_corr_val * 0.6f + c * 0.4f;
            g_corr_lr = g_corr_ll = g_corr_rr = 0.0; g_corr_n = 0;
        }

        g_lufs_accum_n += nframes;
        if (g_lufs_accum_n >= g_lufs_chunk_frames) {
            double chunkMs = g_lufs_sq_accum / g_lufs_accum_n;   // (z_L + z_R) mean square
            g_lufs_chunks[g_lufs_chunk_pos] = chunkMs;
            g_lufs_chunk_pos = (g_lufs_chunk_pos + 1) % LUFS_ST_CHUNKS;
            if (g_lufs_chunk_filled < LUFS_ST_CHUNKS) g_lufs_chunk_filled++;
            g_lufs_sq_accum = 0.0; g_lufs_accum_n = 0;

            // every 4 chunks (~400 ms) close an integrated block
            g_lufs_block_accum += chunkMs;
            if (++g_lufs_chunks_in_block >= 4) {
                g_lufs_blocks[g_lufs_block_pos] = g_lufs_block_accum / 4.0;
                g_lufs_block_pos = (g_lufs_block_pos + 1) % LUFS_BLOCK_RING;
                if (g_lufs_block_filled < LUFS_BLOCK_RING) g_lufs_block_filled++;
                g_lufs_block_accum = 0.0;
                g_lufs_chunks_in_block = 0;
            }
        }

        frame_counter += static_cast<int>(nframes);
        if (frame_counter >= meter_interval_frames) {
            int offset = snprintf(meter_json.data(), meter_json.size(), "{\"type\":\"metering\",\"channels\":{");

            auto calc_db = [](float peak) {
                return (peak > 0.00001f) ? 20.0f * std::log10(peak) : -100.0f;
            };

            float decay = 0.5f;

            bool first = true;
            for (auto& pair : channels) {
                if (!first) {
                    offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, ",");
                }
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                    "\"%d\":{\"l\":%.1f,\"r\":%.1f}",
                    pair.first, calc_db(pair.second.current_peak_l), calc_db(pair.second.current_peak_r));

                pair.second.current_peak_l *= decay;
                pair.second.current_peak_r *= decay;
                first = false;
            }
            offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "}");

            // Per-plugin in/out for the editor the UI has open (fx_focus).
            const int fc = g_fx_focus_channel.load(std::memory_order_relaxed);
            const int fp = g_fx_focus_plugin.load(std::memory_order_relaxed);
            if (fc >= 0 && fp >= 0) {
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                    ",\"fx\":{\"channel\":%d,\"pluginIndex\":%d,\"inL\":%.1f,\"inR\":%.1f,\"outL\":%.1f,\"outR\":%.1f,\"rta\":[",
                    fc, fp,
                    calc_db(g_fx_in_peak_l), calc_db(g_fx_in_peak_r),
                    calc_db(g_fx_out_peak_l), calc_db(g_fx_out_peak_r));
                for (int k = 0; k < RTA_BANDS; ++k) {
                    offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                        "%s%.1f", k ? "," : "", g_rta_mag[k]);
                }
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "]}");
            }
            g_fx_in_peak_l *= decay;  g_fx_in_peak_r *= decay;
            g_fx_out_peak_l *= decay; g_fx_out_peak_r *= decay;

            // ── Master loudness (BS.1770): momentary / short-term / integrated ──
            {
                auto meanOfLast = [](const double* ring, int filled, int pos, int n) {
                    n = std::min(n, filled);
                    if (n <= 0) return 0.0;
                    double sum = 0.0;
                    for (int i = 0; i < n; i++) {
                        int idx = (pos - 1 - i + LUFS_ST_CHUNKS * 4) % LUFS_ST_CHUNKS;
                        sum += ring[idx];
                    }
                    return sum / n;
                };
                float m = lufs_db(meanOfLast(g_lufs_chunks, g_lufs_chunk_filled, g_lufs_chunk_pos, 4));
                float st = lufs_db(meanOfLast(g_lufs_chunks, g_lufs_chunk_filled, g_lufs_chunk_pos, LUFS_ST_CHUNKS));

                // Integrated: two-stage gate over the 400 ms block ring.
                float integ = -120.0f;
                if (g_lufs_block_filled > 0) {
                    const double absGateMs = std::pow(10.0, (-70.0 + 0.691) / 10.0);
                    double sum1 = 0.0; int n1 = 0;
                    for (int i = 0; i < g_lufs_block_filled; i++) {
                        double b = g_lufs_blocks[i];
                        if (b > absGateMs) { sum1 += b; n1++; }
                    }
                    if (n1 > 0) {
                        double relGateMs = std::pow(10.0, ((-0.691 + 10.0 * std::log10(sum1 / n1)) - 10.0 + 0.691) / 10.0);
                        double sum2 = 0.0; int n2 = 0;
                        for (int i = 0; i < g_lufs_block_filled; i++) {
                            double b = g_lufs_blocks[i];
                            if (b > absGateMs && b > relGateMs) { sum2 += b; n2++; }
                        }
                        if (n2 > 0) integ = lufs_db(sum2 / n2);
                    }
                }
                float tp = g_lufs_tp > 1e-6f ? 20.0f * std::log10(g_lufs_tp) : -120.0f;
                g_lufs_tp *= 0.92f;  // slow decay so a transient peak lingers

                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                    ",\"lufs\":{\"m\":%.1f,\"s\":%.1f,\"i\":%.1f,\"tp\":%.1f}", m, st, integ, tp);
            }

            // ── Master analyser: spectrum, correlation, goniometer scatter ──
            offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                ",\"master\":{\"corr\":%.2f,\"rta\":[", g_corr_val);
            for (int k = 0; k < MRTA_BANDS; ++k) {
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                    "%s%.1f", k ? "," : "", g_mrta_mag[k]);
            }
            offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "],\"gonio\":[");
            for (int i = 0; i < GONIO_POINTS; ++i) {
                int idx = (g_gonio_pos + i) % GONIO_POINTS;
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                    "%s%.3f,%.3f", i ? "," : "", g_gonio[idx * 2], g_gonio[idx * 2 + 1]);
            }
            offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "]}");

            // ── Live-record peak envelope: the per-block min/max pairs of each
            //    armed tap accumulated since the last frame, for the growing
            //    UI waveform. Flat [min,max,min,max,...] per channel. ──
            if (mtr.is_recording()) {
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, ",\"recPeaks\":{");
                bool rf = true;
                float pk[192];
                const uint32_t armed_mask = mtr.armed_mask();
                for (int ch = 1; ch <= NUM_CHANNELS; ++ch) {
                    if (!(armed_mask & (1u << (ch - 1)))) continue;
                    const int npairs = mtr.poll_tap_peaks(ch, pk, 96);
                    offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                        "%s\"%d\":[", rf ? "" : ",", ch);
                    for (int i = 0; i < npairs * 2 && offset < (int)meter_json.size() - 16; ++i)
                        offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                            "%s%.4f", i ? "," : "", pk[i]);
                    offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "]");
                    rf = false;
                }
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "}");
            }

            // ── Live insert-chain lengths ── so the server/UI can detect (and
            //    heal) a drift between what they think the rack holds and what
            //    the engine actually has. Only non-empty chains are listed.
            {
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, ",\"fxN\":{");
                bool ff = true;
                for (const auto& pr : channels) {
                    const size_t nfx = pr.second.insert_chain.size();
                    if (nfx == 0) continue;
                    offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                        "%s\"%d\":%zu", ff ? "" : ",", pr.first, nfx);
                    ff = false;
                }
                offset += snprintf(meter_json.data() + offset, meter_json.size() - offset, "}");
            }

            // ── Transport position (engine-owned clock; UI/server follow).
            //    `buf` = the process block size, for the toolbar latency readout.
            offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                ",\"transport\":{\"frame\":%llu,\"state\":%d,\"sr\":%d,\"buf\":%u,\"pbUnderrun\":%d,\"monInMask\":%u,"
                "\"loopOn\":%d,\"loopIn\":%llu,\"loopOut\":%llu,\"punchOn\":%d,\"punchIn\":%llu,\"punchOut\":%llu,"
                "\"bounceState\":%d,\"bounceOverrun\":%d}",
                static_cast<unsigned long long>(g_transport.frame.load(std::memory_order_relaxed)),
                g_transport.state.load(std::memory_order_relaxed),
                static_cast<int>(jack.get_sample_rate()),
                static_cast<unsigned>(nframes),
                player.take_underrun() ? 1 : 0,
                g_monitor_input_mask.load(std::memory_order_relaxed),
                g_transport.loop_enabled.load(std::memory_order_relaxed) ? 1 : 0,
                static_cast<unsigned long long>(g_transport.loop_start.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(g_transport.loop_end.load(std::memory_order_relaxed)),
                g_transport.punch_enabled.load(std::memory_order_relaxed) ? 1 : 0,
                static_cast<unsigned long long>(g_transport.punch_in.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(g_transport.punch_out.load(std::memory_order_relaxed)),
                g_bounce_state.load(std::memory_order_relaxed),
                recorder.had_overrun() ? 1 : 0);

            // ── Timecode & sync status (plan Phase 3d) ──
            offset += snprintf(meter_json.data() + offset, meter_json.size() - offset,
                ",\"tc\":{\"src\":%d,\"fps\":%d,\"df\":%d,\"off\":%lld,\"tod\":%.3f,"
                "\"gen\":%d,\"mtc\":%d,\"chase\":%d,\"lock\":%d,\"in\":%lld,\"inpk\":%.3f,"
                "\"countin\":%lld,\"err\":%.1f,\"fly\":%d}",
                tc_source, tc_fps, tc_df ? 1 : 0, static_cast<long long>(tc_off),
                g_tod_sec.load(std::memory_order_relaxed),
                g_ltc_gen.load(std::memory_order_relaxed),
                g_mtc_gen.load(std::memory_order_relaxed),
                g_ltc_chase.load(std::memory_order_relaxed),
                g_ltc_chase_locked.load(std::memory_order_relaxed),
                static_cast<long long>(g_ltc_chase_frame.load(std::memory_order_relaxed)),
                g_ltc_in_peak.load(std::memory_order_relaxed),
                static_cast<long long>(g_countin_frames.load(std::memory_order_relaxed)),
                g_ltc_chase_err.load(std::memory_order_relaxed),
                ltc_anchored ? 1 : 0);

            snprintf(meter_json.data() + offset, meter_json.size() - offset, "}");

            ipc.send_multichannel_metering(meter_json.data());
            frame_counter = 0;

            // The bounce-finished pulse (state 2) is published exactly once,
            // then drops back to idle so a stale 2 can't make the server treat
            // the *next* bounce as instantly complete.
            int finished = 2;
            g_bounce_state.compare_exchange_strong(finished, 0, std::memory_order_relaxed);
        }

        // ── Timecode generators (plan Phase 3d) ── run after the mix so the
        // LTC carrier never leaks into a bus. Free-run while the source is
        // time-of-day or the transport is rolling.
        {
            const timecode::SmpteTime tc0 =
                timecode::frames_to_smpte(tc_frame0, tc_fps, tc_df);
            const bool tc_running = (tc_source == 1) || (transport_state != 0);

            if (outputs.size() > static_cast<size_t>(LTC_OUT_PORT)) {
                float* lo = jack.get_buffer(outputs[LTC_OUT_PORT], nframes);
                if (lo) {
                    if (g_ltc_gen.load(std::memory_order_relaxed))
                        ltc_enc.generate(lo, static_cast<int>(nframes), tc0, tc_running,
                                         sr_per_tcf, tc_fps, tc_df,
                                         g_ltc_level.load(std::memory_order_relaxed));
                    else
                        std::memset(lo, 0, sizeof(float) * nframes);
                }
            }

            auto midi_ports = jack.get_midi_output_ports();
            if (!midi_ports.empty()) {
                void* mb = jack_port_get_buffer(midi_ports[0], nframes);
                jack_midi_clear_buffer(mb);
                if (g_mtc_gen.load(std::memory_order_relaxed)) {
                    const int ne = mtc_enc.generate(tc0, tc_running, sr_per_tcf, tc_fps,
                                                    tc_df, static_cast<int>(nframes),
                                                    mtc_events, 48);
                    for (int e = 0; e < ne; ++e) {
                        jack_nframes_t at = static_cast<jack_nframes_t>(
                            std::clamp(mtc_events[e].offset, 0, static_cast<int>(nframes) - 1));
                        jack_midi_data_t* d = jack_midi_event_reserve(mb, at, mtc_events[e].len);
                        if (d) std::memcpy(d, mtc_events[e].bytes, mtc_events[e].len);
                    }
                }
            }
        }

        // ── Transport ── advance the clock past the block just processed.
        if (transport_state != 0) {
            // ltc_corr: flywheel-chase servo nudge (bounded ±6 samples/block, so
            // the net advance never trips TimelinePlayer's discontinuity check).
            int64_t adv = static_cast<int64_t>(nframes) + ltc_corr;
            if (adv < 1) adv = 1;
            uint64_t next = block_start_frame + static_cast<uint64_t>(adv);
            if (g_transport.loop_enabled.load(std::memory_order_relaxed)) {
                const uint64_t ls = g_transport.loop_start.load(std::memory_order_relaxed);
                const uint64_t le = g_transport.loop_end.load(std::memory_order_relaxed);
                if (le > ls && next >= le) next = ls + (next - le) % (le - ls);
            }
            g_transport.frame.store(next, std::memory_order_relaxed);

            // Bounce end — stop the writer + transport when the clock reaches
            // the out-point. stop_recording() only flips a flag; the disk
            // thread finalises the file. Server sees g_bounce_state==2 on the
            // metering frame and reports the result.
            if (g_bounce_state.load(std::memory_order_relaxed) == 1 &&
                next >= g_bounce_end.load(std::memory_order_relaxed)) {
                recorder.stop_recording();
                g_transport.state.store(0, std::memory_order_relaxed);
                g_bounce_state.store(2, std::memory_order_relaxed);
            }
        }
    });

    if (!jack.activate()) {
        std::cerr << "Failed to activate JACK client!" << std::endl;
        return 1;
    }

    std::cout << "JACK Client active: " << NUM_CHANNELS << " inputs, " << NUM_AUX
              << " Aux buses, Master, Monitor, Talkback. Running processing loop." << std::endl;

    while (true) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    return 0;
}
