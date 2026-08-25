#include "DiskWriter.h"
#include <iostream>
#include <cstring>

namespace aes67_deck {
namespace recorder {

DiskWriter::DiskWriter() : is_recording_(false), thread_running_(true), sndfile_(nullptr) {
    // 16MB ringbuffer for lock-free writing
    ringbuffer_ = jack_ringbuffer_create(16 * 1024 * 1024);
    thread_ = std::thread(&DiskWriter::disk_thread_func, this);
}

DiskWriter::~DiskWriter() {
    stop_recording();
    thread_running_ = false;
    if (thread_.joinable()) thread_.join();
    jack_ringbuffer_free(ringbuffer_);
}

bool DiskWriter::start_recording(const std::string& filepath, int channels, int sample_rate) {
    if (is_recording_) return false;

    channels_ = channels;
    sf_info_.channels = channels;
    sf_info_.samplerate = sample_rate;
    sf_info_.format = SF_FORMAT_WAV | SF_FORMAT_FLOAT;

    sndfile_ = sf_open(filepath.c_str(), SFM_WRITE, &sf_info_);
    if (!sndfile_) {
        std::cerr << "Failed to open sndfile for writing: " << filepath << std::endl;
        return false;
    }

    interleave_buffer_.resize(8192 * channels); // max nframes is usually 1024 to 8192
    jack_ringbuffer_reset(ringbuffer_);
    is_recording_ = true;
    return true;
}

void DiskWriter::stop_recording() {
    is_recording_ = false;
    // The background thread will close the file when it sees is_recording is false and buffer is empty
}

void DiskWriter::write_audio(const std::vector<float*>& channel_buffers, int nframes) {
    if (!is_recording_) return;

    if (nframes * channels_ > interleave_buffer_.size()) return;

    // Interleave
    for (int i = 0; i < nframes; ++i) {
        for (int c = 0; c < channels_; ++c) {
            interleave_buffer_[i * channels_ + c] = channel_buffers[c][i];
        }
    }

    size_t bytes_to_write = nframes * channels_ * sizeof(float);
    if (jack_ringbuffer_write_space(ringbuffer_) >= bytes_to_write) {
        jack_ringbuffer_write(ringbuffer_, (const char*)interleave_buffer_.data(), bytes_to_write);
    } else {
        // OVERFLOW (Disk too slow!)
        // In a pro DAW we would flag this in the UI
    }
}

void DiskWriter::disk_thread_func() {
    std::vector<float> write_buf(8192 * 16); // Batch write buffer

    while (thread_running_) {
        if (is_recording_ || jack_ringbuffer_read_space(ringbuffer_) > 0) {
            size_t available_bytes = jack_ringbuffer_read_space(ringbuffer_);
            if (available_bytes > 0) {
                size_t read_bytes = std::min(available_bytes, write_buf.size() * sizeof(float));
                
                // Align to frames
                size_t frames = (read_bytes / sizeof(float)) / channels_;
                read_bytes = frames * channels_ * sizeof(float);

                if (frames > 0) {
                    jack_ringbuffer_read(ringbuffer_, (char*)write_buf.data(), read_bytes);
                    if (sndfile_) {
                        sf_writef_float(sndfile_, write_buf.data(), frames);
                    }
                }
            } else if (!is_recording_ && sndfile_) {
                // Done recording, buffer empty, flush and close
                sf_write_sync(sndfile_);
                sf_close(sndfile_);
                sndfile_ = nullptr;
                std::cout << "Recording saved successfully." << std::endl;
            }
        }
        
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    if (sndfile_) {
        sf_write_sync(sndfile_);
        sf_close(sndfile_);
    }
}

} // namespace recorder
} // namespace aes67_deck
