#pragma once
#include <cstdint>
#include <string>
#include <thread>
#include <atomic>
#include <vector>
#include <sndfile.h>
#include <jack/ringbuffer.h>

namespace aes67_deck {
namespace recorder {

class DiskWriter {
public:
    DiskWriter();
    ~DiskWriter();

    // `bits`: 16 or 24 → PCM WAV, anything else → 32-bit float WAV.
    bool start_recording(const std::string& filepath, int channels, int sample_rate, int bits = 32);
    void stop_recording();

    // Set true (and latched until the next start_recording) if the RT thread
    // ever found the ringbuffer full — i.e. the disk could not keep up.
    bool had_overrun() const { return overrun_.load(std::memory_order_relaxed); }

    // Call from audio thread
    void write_audio(const std::vector<float*>& channel_buffers, int nframes);
    // Same, but from a caller-owned pointer array — no std::vector, so it
    // allocates nothing on the RT thread. `channel_buffers[c]` for c in
    // 0..nchannels-1; nchannels must equal the value passed to
    // start_recording().
    void write_audio(const float* const* channel_buffers, int nchannels, int nframes);

private:
    void disk_thread_func();
    void drain_ringbuffer();

    std::atomic<bool> is_recording_;
    std::atomic<bool> thread_running_;
    std::atomic<bool> overrun_{false};
    std::thread thread_;
    jack_ringbuffer_t* ringbuffer_;

    int channels_;
    SNDFILE* sndfile_;
    SF_INFO sf_info_;
    
    // Scratch buffer for interleaving
    std::vector<float> interleave_buffer_;
};

} // namespace recorder
} // namespace aes67_deck
