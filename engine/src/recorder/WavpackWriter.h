#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <atomic>
#include <vector>
#include <wavpack/wavpack.h>
#include <jack/ringbuffer.h>

namespace aes67_deck {
namespace recorder {

// Lossless WavPack encoder for a single multi-channel take file, holding the
// same lock-free ring + dedicated disk thread contract as DiskWriter: the RT
// audio thread only calls write_audio() (no alloc, no locks, no I/O); the disk
// thread drains the ring, encodes and writes.
//
// Fixed to 32-bit IEEE float, normalized (+/- 1.0), "fast" compression mode —
// bit-transparent for the engine's float taps at a fraction of the size of raw
// float WAV, and cheap enough to run many in parallel on the appliance.
class WavpackWriter {
public:
    WavpackWriter();
    ~WavpackWriter();

    bool start_recording(const std::string& filepath, int channels, int sample_rate);
    void stop_recording();

    bool had_overrun() const { return overrun_.load(std::memory_order_relaxed); }

    // RT audio thread. channel_buffers[c] for c in 0..nchannels-1; nchannels
    // must equal the value passed to start_recording().
    void write_audio(const float* const* channel_buffers, int nchannels, int nframes);

private:
    void disk_thread_func();
    void drain_ringbuffer();
    void close_file();

    static int write_block_cb(void* id, void* data, int32_t bcount);

    std::atomic<bool> is_recording_{false};
    std::atomic<bool> thread_running_{true};
    std::atomic<bool> overrun_{false};
    std::thread thread_;
    jack_ringbuffer_t* ringbuffer_;

    int channels_ = 0;
    FILE* file_ = nullptr;
    WavpackContext* wpc_ = nullptr;
    std::string path_;
    std::vector<unsigned char> first_block_;   // saved to patch the sample count on close

    std::vector<float> interleave_buffer_;     // RT thread scratch
};

} // namespace recorder
} // namespace aes67_deck
