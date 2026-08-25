#pragma once
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

    bool start_recording(const std::string& filepath, int channels, int sample_rate);
    void stop_recording();

    // Call from audio thread
    void write_audio(const std::vector<float*>& channel_buffers, int nframes);

private:
    void disk_thread_func();

    std::atomic<bool> is_recording_;
    std::atomic<bool> thread_running_;
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
