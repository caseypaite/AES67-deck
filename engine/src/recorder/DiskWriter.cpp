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

    SNDFILE* sf = sf_open(filepath.c_str(), SFM_WRITE, &sf_info_);
    if (!sf) {
        std::cerr << "Failed to open sndfile for writing: " << filepath << std::endl;
        return false;
    }

    interleave_buffer_.resize(8192 * channels); // max nframes is usually 1024 to 8192
    jack_ringbuffer_reset(ringbuffer_);
    overrun_.store(false, std::memory_order_relaxed);
    // Publish sndfile_ only once everything else is ready, immediately before
    // is_recording_ — so the disk thread, which gates on is_recording_, never
    // observes a valid sndfile_ while is_recording_ is still false (that
    // window would let its "stopped + drained" branch close the file before
    // the first sample is even written).
    sndfile_ = sf;
    is_recording_ = true;
    return true;
}

void DiskWriter::stop_recording() {
    is_recording_ = false;
    // The disk thread drains the ringbuffer, then flushes and closes the file.
}

void DiskWriter::write_audio(const std::vector<float*>& channel_buffers, int nframes) {
    write_audio(channel_buffers.data(), static_cast<int>(channel_buffers.size()), nframes);
}

void DiskWriter::write_audio(const float* const* channel_buffers, int nchannels, int nframes) {
    if (!is_recording_) return;
    if (nchannels != channels_) return;
    if (static_cast<size_t>(nframes) * channels_ > interleave_buffer_.size()) return;

    // Interleave
    for (int i = 0; i < nframes; ++i) {
        for (int c = 0; c < channels_; ++c) {
            interleave_buffer_[i * channels_ + c] = channel_buffers[c][i];
        }
    }

    size_t bytes_to_write = static_cast<size_t>(nframes) * channels_ * sizeof(float);
    if (jack_ringbuffer_write_space(ringbuffer_) >= bytes_to_write) {
        jack_ringbuffer_write(ringbuffer_, (const char*)interleave_buffer_.data(), bytes_to_write);
    } else {
        // OVERFLOW (disk too slow) — latched, surfaced via had_overrun()
        overrun_.store(true, std::memory_order_relaxed);
    }
}

void DiskWriter::drain_ringbuffer() {
    static thread_local std::vector<float> buf;
    if (buf.empty()) buf.resize(8192 * 16);
    const int ch = channels_ > 0 ? channels_ : 1;
    size_t avail;
    while ((avail = jack_ringbuffer_read_space(ringbuffer_)) > 0) {
        size_t read_bytes = std::min(avail, buf.size() * sizeof(float));
        size_t frames = (read_bytes / sizeof(float)) / ch;
        read_bytes = frames * ch * sizeof(float);
        if (frames == 0) break;
        jack_ringbuffer_read(ringbuffer_, (char*)buf.data(), read_bytes);
        if (sndfile_) sf_writef_float(sndfile_, buf.data(), frames);
    }
}

void DiskWriter::disk_thread_func() {
    // Only take the "stopped + drained -> close" path once we've actually
    // seen recording start; otherwise the gap between sf_open and
    // is_recording_ = true in start_recording could trip it.
    bool saw_recording = false;

    while (thread_running_) {
        if (is_recording_) saw_recording = true;

        size_t available_bytes = jack_ringbuffer_read_space(ringbuffer_);
        if (available_bytes > 0) {
            drain_ringbuffer();
        } else if (saw_recording && !is_recording_ && sndfile_) {
            // Recording stopped and the ringbuffer is drained: flush and close
            // so the WAV header chunk sizes are finalised on disk.
            sf_write_sync(sndfile_);
            sf_close(sndfile_);
            sndfile_ = nullptr;
            saw_recording = false;
            std::cout << "Recording saved successfully." << std::endl;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    // Shutting down mid-recording: drain what's left so the tail isn't lost.
    if (sndfile_) {
        drain_ringbuffer();
        sf_write_sync(sndfile_);
        sf_close(sndfile_);
        sndfile_ = nullptr;
    }
}

} // namespace recorder
} // namespace aes67_deck
