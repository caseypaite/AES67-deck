#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "WavpackWriter.h"

namespace aes67_deck {
namespace recorder {

// One take = one directory of per-channel lossless WavPack files, 32-bit float
// (projects/<name>/takes/<timestamp>/ch<NN>.wv), one WavpackWriter per channel.
//
// The writers are a PERSISTENT POOL, created once at engine startup — never on
// start()/stop(). Spinning up N × (16 MB ringbuffer alloc + disk thread) at the
// moment the transport flips to recording caused a JACK xrun burst that
// distorted the head of every take. Per take, start() only opens the files.
//
// Thread model: start()/stop() run on the IPC thread and flip per-writer
// is_recording_; the audio thread only calls write() (lock-free, no I/O); each
// writer's disk thread drains its ring, encodes and finalises the file. The
// writer pointers never move, so the audio thread needs no atomics on them —
// mtr's recording_ (acquire/release) is the one gate.
//
// Tap point is the raw pre-insert channel input (see plan D1).
class MultitrackRecorder {
public:
    static constexpr int MAX_CH = 32; // channel ids 1..32

    MultitrackRecorder();
    ~MultitrackRecorder() = default;
    MultitrackRecorder(const MultitrackRecorder&) = delete;
    MultitrackRecorder& operator=(const MultitrackRecorder&) = delete;

    // armed: 1-based channel ids to capture. origin_frame: transport frame the
    // take starts at (its project-time zero). Returns false if already
    // recording or nothing armed / no file could be opened.
    bool start(const std::string& dir, const std::vector<int>& armed,
               int sample_rate, uint64_t origin_frame);

    // Close every open writer. Safe to call when not recording.
    void stop();

    // acquire — a reader that sees `true` also sees the armed_mask_ / open
    // writers start() set up before flipping this.
    bool is_recording() const { return recording_.load(std::memory_order_acquire); }
    const std::string& dir() const { return dir_; }
    uint64_t origin_frame() const { return origin_frame_; }
    int sample_rate() const { return sample_rate_; }
    const std::vector<int>& armed() const { return armed_; }   // IPC thread only

    // RT thread. No-op for channels not armed in the current take.
    void write(int ch_id, const float* l, const float* r, int nframes) {
        if (!recording_.load(std::memory_order_acquire)) return;
        if (ch_id < 1 || ch_id > MAX_CH) return;
        WavpackWriter* w = writers_[ch_id].get();   // pool pointer, never moves
        if (!w) return;
        const float* chans[2] = { l, r };
        w->write_audio(chans, 2, nframes);          // internally gated on its is_recording_
        frames_tapped_.fetch_add(nframes, std::memory_order_relaxed);

        // Live-waveform envelope: one min/max pair per PEAK_BUCKET frames pushed
        // to a small per-channel ring, drained by the metering builder (same
        // thread), so no atomics.
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

    // RT thread (metering builder): which channels to poll_tap_peaks(). Bit
    // (ch-1) set = armed.
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

    // Frames actually written per channel this take. IPC thread.
    uint64_t recorded_frames() const {
        const size_t n = armed_.size();
        return n ? frames_tapped_.load(std::memory_order_relaxed) / n : 0;
    }

    // True if any armed channel's writer reported a ringbuffer overrun. IPC thread.
    bool had_overrun() const {
        for (int c : armed_) {
            const WavpackWriter* w = writers_[c].get();
            if (w && w->had_overrun()) return true;
        }
        return false;
    }

    static constexpr const char* file_ext() { return "wv"; }

private:
    // Per-channel ring — 4 MB stereo f32 ≈ 10 s of headroom, ×32 = 128 MB held
    // resident for the life of the process (vs. the 16 MB the single-file
    // DiskWriter uses, since 32 of these run in parallel).
    static constexpr size_t MTR_RING_BYTES = 4 * 1024 * 1024;

    std::array<std::unique_ptr<WavpackWriter>, MAX_CH + 1> writers_{}; // [1..MAX_CH], created in ctor

    std::atomic<bool> recording_{false};
    std::atomic<uint64_t> frames_tapped_{0};
    std::atomic<uint32_t> armed_mask_{0};

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
