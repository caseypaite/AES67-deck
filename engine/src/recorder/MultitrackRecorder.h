#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "WavpackWriter.h"

namespace aes67_deck {
namespace recorder {

// One take = one directory of per-channel lossless WavPack files, 32-bit float
// (projects/<name>/takes/<timestamp>/ch<NN>.wv), written by a WavpackWriter per
// armed channel. Files are opened/closed on the IPC thread (start()/stop());
// the audio thread only calls write(), which is lock-free and allocation-free.
//
// Thread model (the reason for the atomics below): start()/stop() run on the
// IPC thread and mutate the writer set; the audio thread reads it every block
// via write() + the metering builder's armed_mask()/poll_tap_peaks(); a reaper
// thread destroys writers from finished takes. A stop()+immediate start()
// (auto-punch, or an operator mashing the button) must never free a writer the
// audio thread is one block deep inside — hence the retire/reap with an audio
// block-sequence fence rather than an inline reset.
//
// Tap point is the raw pre-insert channel input (see plan D1) — the caller
// passes the JACK input buffers straight through.
class MultitrackRecorder {
public:
    static constexpr int MAX_CH = 32; // channel ids 1..32

    MultitrackRecorder();
    ~MultitrackRecorder();
    MultitrackRecorder(const MultitrackRecorder&) = delete;
    MultitrackRecorder& operator=(const MultitrackRecorder&) = delete;

    // armed: 1-based channel ids to capture. origin_frame: transport frame the
    // take starts at (its project-time zero). Returns false if already
    // recording or nothing armed / no file could be opened.
    bool start(const std::string& dir, const std::vector<int>& armed,
               int sample_rate, uint64_t origin_frame);

    // Close every open writer. Safe to call when not recording.
    void stop();

    // acquire so a reader that sees `true` also sees the writer_ptr_ / armed_mask_
    // that start() published before flipping this.
    bool is_recording() const { return recording_.load(std::memory_order_acquire); }
    const std::string& dir() const { return dir_; }
    uint64_t origin_frame() const { return origin_frame_; }
    int sample_rate() const { return sample_rate_; }
    const std::vector<int>& armed() const { return armed_; }   // IPC thread only

    // RT thread. No-op for channels not armed in the current take.
    void write(int ch_id, const float* l, const float* r, int nframes) {
        if (!recording_.load(std::memory_order_acquire)) return;
        if (ch_id < 1 || ch_id > MAX_CH) return;
        // Atomic load: an in-flight write() that raced a retire sees either the
        // still-live outgoing writer (kept alive by the reaper's block-seq
        // fence) or nullptr — never a torn pointer.
        WavpackWriter* w = writer_ptr_[ch_id].load(std::memory_order_acquire);
        if (!w) return;
        const float* chans[2] = { l, r };
        w->write_audio(chans, 2, nframes);
        frames_tapped_.fetch_add(nframes, std::memory_order_relaxed);

        // Live-waveform envelope: one min/max pair per PEAK_BUCKET frames pushed
        // to a small per-channel ring, so the resolution is independent of the
        // graph quantum. The process thread is the only reader/writer (it also
        // builds the metering frame that drains this), so no atomics.
        TapRing& tr = tap_[ch_id];
        for (int base = 0; base < nframes; base += PEAK_BUCKET) {
            const int end = base + PEAK_BUCKET < nframes ? base + PEAK_BUCKET : nframes;
            float mn = 0.0f, mx = 0.0f;
            for (int i = base; i < end; ++i) {
                const float a = l[i], b = r[i];
                if (a < mn) mn = a; else if (a > mx) mx = a;
                if (b < mn) mn = b; else if (b > mx) mx = b;
            }
            const int nw = (tr.w + 1) % PEAK_RING;
            if (nw != tr.r) { tr.mn[tr.w] = mn; tr.mx[tr.w] = mx; tr.w = nw; }
        }
    }

    // RT thread, once per process callback after the per-channel write()s. Bumps
    // the block sequence the reaper fences retired-writer destruction against.
    void end_audio_block() { audio_block_seq_.fetch_add(1, std::memory_order_release); }

    // RT thread (metering builder): which channels to poll_tap_peaks(). Bit
    // (ch-1) set = armed. Own snapshot so the audio thread never touches armed_.
    uint32_t armed_mask() const { return armed_mask_.load(std::memory_order_acquire); }

    // RT thread (metering builder). Drains up to `cap` accumulated min/max
    // pairs into out[] as [min,max,min,max,...]; returns the pair count.
    int poll_tap_peaks(int ch_id, float* out, int cap) {
        if (ch_id < 1 || ch_id > MAX_CH) return 0;
        TapRing& tr = tap_[ch_id];
        int n = 0;
        while (tr.r != tr.w && n < cap) {
            out[n * 2] = tr.mn[tr.r];
            out[n * 2 + 1] = tr.mx[tr.r];
            tr.r = (tr.r + 1) % PEAK_RING;
            ++n;
        }
        return n;
    }

    uint64_t frames_tapped() const { return frames_tapped_.load(std::memory_order_relaxed); }

    // Frames actually written per channel this take — the reliable clip length,
    // independent of where the transport was when record armed. IPC thread.
    uint64_t recorded_frames() const {
        const size_t n = armed_.size();
        return n ? frames_tapped_.load(std::memory_order_relaxed) / n : 0;
    }

    // True if any armed channel's disk writer reported a ringbuffer overrun.
    // IPC thread (writers_ is IPC-owned).
    bool had_overrun() const {
        for (int c = 1; c <= MAX_CH; ++c) {
            const WavpackWriter* w = writers_[c].get();
            if (w && w->had_overrun()) return true;
        }
        return false;
    }

    // Take-file extension (no dot), for the take manifest / clip naming.
    static constexpr const char* file_ext() { return "wv"; }

private:
    void reaper_loop();

    // Ownership (IPC thread) and the audio thread's atomic view of it.
    std::array<std::unique_ptr<WavpackWriter>, MAX_CH + 1> writers_{};
    std::array<std::atomic<WavpackWriter*>, MAX_CH + 1> writer_ptr_{};

    std::atomic<bool> recording_{false};
    std::atomic<uint64_t> frames_tapped_{0};
    std::atomic<uint32_t> armed_mask_{0};
    std::atomic<uint64_t> audio_block_seq_{0};

    // Writers from finished takes wait here to be destroyed off the RT / IPC
    // path, and only once the audio block sequence has advanced past the retire
    // point (so any in-flight write() on the outgoing writer has completed).
    struct Retired { std::unique_ptr<WavpackWriter> w; uint64_t seq; };
    std::vector<Retired> retired_;
    std::mutex retired_mutex_;
    std::thread reaper_;
    std::atomic<bool> reaper_run_{true};

    // Live-waveform peak envelope: one min/max pair per PEAK_BUCKET frames
    // (~5 ms @ 48k), per channel. Single-thread (process) ring; the metering
    // builder drains it. PEAK_RING covers ~1 s so a slow metering frame
    // (large quantum) can't lose points.
    static constexpr int PEAK_BUCKET = 256;
    static constexpr int PEAK_RING = 256;
    struct TapRing { float mn[PEAK_RING] = {}; float mx[PEAK_RING] = {}; int w = 0; int r = 0; };
    TapRing tap_[MAX_CH + 1];
    std::string dir_;
    std::vector<int> armed_;
    uint64_t origin_frame_ = 0;
    int sample_rate_ = 48000;
};

} // namespace recorder
} // namespace aes67_deck
