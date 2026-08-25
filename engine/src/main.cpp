#include <map>
#include <iostream>
#include <chrono>
#include <thread>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <atomic>
#include <memory>
#include <vector>
#include "audio/JackClient.h"
#include "plugins/Lv2Host.h"
#include "ipc/IpcClient.h"
#include "recorder/DiskWriter.h"

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

struct ChannelState {
    float fader = 0.75f;
    float pan = 0.0f;
    bool mute = false;
    bool solo = false;

    float current_peak_l = 0.0f;
    float current_peak_r = 0.0f;
    std::map<int, float> aux_sends;

    std::vector<std::unique_ptr<plugins::PluginInstance>> insert_chain;
};

// Push-to-talk state. Atomics because this is written from the IPC thread
// and read every audio callback: unlike the bulk per-channel state, a stuck
// or delayed read here has a real safety consequence (the operator's mic
// could stay open when they think they've released it), so it gets a
// correctness guarantee the rest of ChannelState doesn't have.
struct TalkbackState {
    std::atomic<bool> ptt_active{false};
    // Master or one of the Aux buses only — the Monitor bus is never a
    // valid destination (enforced again, structurally, in the audio
    // callback below, not just at the IPC boundary).
    std::atomic<int> dest_bus_id{MASTER_ID};
};

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;

    std::cout << "Starting AES67-Deck DSP & DAW Engine (" << NUM_CHANNELS
              << " inputs, " << NUM_AUX << " Aux buses, Master, Monitor, Talkback)..." << std::endl;

    audio::JackClient jack("AES67_Deck");
    ipc::IpcClient ipc("/tmp/aes67_deck.sock");
    recorder::DiskWriter recorder;
    plugins::Lv2Host lv2_host;

    // Scan system for LV2 plugins
    lv2_host.scan_plugins();

    std::map<int, ChannelState> channels;
    for (int i = 1; i <= NUM_CHANNELS; i++) channels[i] = ChannelState();
    channels[MASTER_ID] = ChannelState();
    for (int b = 0; b < NUM_AUX; b++) channels[AUX_BASE + b] = ChannelState();
    channels[MONITOR_ID] = ChannelState();

    TalkbackState talkback;

    // Channels, buses, master, and monitor all start with an empty effect
    // rack. Users add plugins explicitly from the UI.
    std::vector<std::string> default_rack = {};

    double sr = jack.get_sample_rate();
    if (sr == 0) sr = 48000.0;

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

    ipc.set_command_callback([&channels, &recorder, &jack, &talkback](const std::string& type, int channel_id, int bus_id, float value) {
        if (channels.find(channel_id) != channels.end()) {
            if (type == "set_fader") {
                channels[channel_id].fader = value;
            } else if (type == "set_pan") {
                channels[channel_id].pan = value;
            } else if (type == "set_mute") {
                channels[channel_id].mute = (value > 0.5f);
            } else if (type == "set_solo") {
                channels[channel_id].solo = (value > 0.5f);
            } else if (type == "set_aux_send") {
                channels[channel_id].aux_sends[bus_id] = value; std::cout << "Set AUX SEND CH " << channel_id << " BUS " << bus_id << " to " << value << std::endl;
            }
        }
        if (type == "start_record") {
            recorder.start_recording("/tmp/aes67_deck_master.wav", 2, jack.get_sample_rate());
        } else if (type == "stop_record") {
            recorder.stop_recording();
        } else if (type == "set_talkback_active") {
            talkback.ptt_active = (value > 0.5f);
        } else if (type == "set_talkback_dest") {
            bool valid = (bus_id == MASTER_ID) || (bus_id >= AUX_BASE && bus_id < AUX_BASE + NUM_AUX);
            if (valid) {
                talkback.dest_bus_id = bus_id;
            } else {
                std::cerr << "Rejected talkback destination bus " << bus_id << " (Monitor is never a valid target)" << std::endl;
            }
        }
    });

    ipc.set_plugin_callback([&channels](const std::string& type, int channel_id, int p_idx, const std::string& param_id, float value) {
        if (channels.find(channel_id) != channels.end()) {
            if (p_idx >= 0 && p_idx < channels[channel_id].insert_chain.size()) {
                auto* plugin = channels[channel_id].insert_chain[p_idx].get();
                if (type == "set_plugin_bypass") {
                    plugin->bypassed = (value > 0.5f);
                } else if (type == "set_plugin_param") {
                    std::string sym = param_id;
                    std::string uri = plugin->get_uri();

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

                    plugin->set_control_value_by_symbol(sym, value);
                }
            }
        }
    });

    std::atomic<int> frame_counter{0};
    std::vector<float> tmp_L(8192, 0.0f);
    std::vector<float> tmp_R(8192, 0.0f);
    std::vector<float> tmp_out_L(8192, 0.0f);
    std::vector<float> tmp_out_R(8192, 0.0f);
    std::vector<char> meter_json(8192, 0);

    jack.set_process_callback([&](jack_nframes_t nframes) {
        auto inputs = jack.get_input_ports();
        auto outputs = jack.get_output_ports();

        if (inputs.size() < static_cast<size_t>(2 * NUM_CHANNELS + 2) ||
            outputs.size() < static_cast<size_t>(2 + 2 * NUM_AUX + 2)) return;
        if (nframes > 8192) return;

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
            if (channels[i].solo) { any_solo = true; break; }
        }

        for (int i = 1; i <= NUM_CHANNELS; i++) {
            float* in_buf_L = jack.get_buffer(inputs[(i - 1) * 2], nframes);
            float* in_buf_R = jack.get_buffer(inputs[(i - 1) * 2 + 1], nframes);
            if (!in_buf_L || !in_buf_R) continue;

            ChannelState& st = channels[i];

            // 1. Copy Stereo input to temporary buffers
            std::memcpy(tmp_L.data(), in_buf_L, sizeof(float) * nframes);
            std::memcpy(tmp_R.data(), in_buf_R, sizeof(float) * nframes);

            // 2. Process LV2 Insert Chain
            for (auto& plugin_ptr : st.insert_chain) {
                auto* plugin = plugin_ptr.get();
                if (plugin->bypassed) continue;
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
            }

            // 3. Apply Fader, Mute, Pan
            bool muted = st.mute || (any_solo && !st.solo);
            float gain = muted ? 0.0f : (st.fader * 2.0f);
            float pan_norm = (st.pan + 1.0f) / 2.0f;
            float pan_gain_L = std::cos(pan_norm * M_PI_2);
            float pan_gain_R = std::sin(pan_norm * M_PI_2);

            float peak_l = 0.0f;
            float peak_r = 0.0f;

            float master_send = (st.aux_sends.count(MASTER_ID) ? st.aux_sends[MASTER_ID] : 0.75f) / 0.75f;
            float b_send[NUM_AUX] = {0.0f};
            for (int b = 0; b < NUM_AUX; b++) {
                b_send[b] = (st.aux_sends.count(AUX_BASE + b) ? st.aux_sends[AUX_BASE + b] : 0.0f) / 0.75f;
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

        // Talkback: only while pressed, summed pre-fader/pan into whichever
        // bus buffer was selected (Master or an Aux bus), so it rides
        // through that bus's own fader/pan/inserts like any other source.
        // Monitor is structurally excluded — it's neither MASTER_ID nor in
        // the Aux range, so there is no code path that can route talkback
        // there, regardless of what a client requests.
        if (talkback.ptt_active.load(std::memory_order_relaxed)) {
            float* tb_in_L = jack.get_buffer(inputs[TALKBACK_PORT_L], nframes);
            float* tb_in_R = jack.get_buffer(inputs[TALKBACK_PORT_R], nframes);
            int dest = talkback.dest_bus_id.load(std::memory_order_relaxed);

            float* dest_L = nullptr;
            float* dest_R = nullptr;
            if (dest == MASTER_ID) {
                dest_L = out_L; dest_R = out_R;
            } else if (dest >= AUX_BASE && dest < AUX_BASE + NUM_AUX) {
                dest_L = bus_out_L[dest - AUX_BASE];
                dest_R = bus_out_R[dest - AUX_BASE];
            }

            if (tb_in_L && tb_in_R && dest_L && dest_R) {
                for (jack_nframes_t s = 0; s < nframes; s++) {
                    dest_L[s] += tb_in_L[s];
                    dest_R[s] += tb_in_R[s];
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

            for (auto& plugin_ptr : b_st.insert_chain) {
                auto* plugin = plugin_ptr.get();
                if (plugin->bypassed) continue;
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
            }

            float b_gain = b_st.mute ? 0.0f : (b_st.fader * 2.0f);
            float b_pan_norm = (b_st.pan + 1.0f) / 2.0f;
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

            for (auto& plugin_ptr : m_st.insert_chain) {
                auto* plugin = plugin_ptr.get();
                if (plugin->bypassed) continue;
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
            }

            float m_gain = m_st.mute ? 0.0f : (m_st.fader * 2.0f);
            float m_pan_norm = (m_st.pan + 1.0f) / 2.0f;
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

        std::vector<float*> out_bufs = {out_L, out_R};
        recorder.write_audio(out_bufs, nframes);

        frame_counter++;
        if (frame_counter > 2) {
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
            snprintf(meter_json.data() + offset, meter_json.size() - offset, "}}");

            ipc.send_multichannel_metering(meter_json.data());
            frame_counter = 0;
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
