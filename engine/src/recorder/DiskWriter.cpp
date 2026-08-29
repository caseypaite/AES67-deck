#include "DiskWriter.h"
#include <iostream>
#include <cstring>

namespace aes67_deck {
namespace recorder {

DiskWriter::DiskWriter() : is_recording_(false), thread_running_(true) {
    // Pre-allocate the interleave scratch to its ceiling so start_recording()
    // never resizes it while the audio thread is in write_audio().
    interleave_buffer_.assign(static_cast<size_t>(MAX_NFRAMES) * MAX_CHANNELS, 0.0f);
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

bool DiskWriter::start_recording(const std::string& filepath, int channels, int sample_rate, int bits) {
    if (is_recording_) return false;
    if (channels < 1 || channels > MAX_CHANNELS) {
        std::cerr << "DiskWriter: unsupported channel count " << channels << std::endl;
        return false;
    }

    channels_.store(channels, std::memory_order_relaxed);
    sf_info_.channels = channels;
    sf_info_.samplerate = sample_rate;
    const int subtype = bits == 16 ? SF_FORMAT_PCM_16
                      : bits == 24 ? SF_FORMAT_PCM_24
                                   : SF_FORMAT_FLOAT;
    sf_info_.format = SF_FORMAT_WAV | subtype;   // libsndfile converts float→PCM on write

    SNDFILE* sf = sf_open(filepath.c_str(), SFM_WRITE, &sf_info_);
    if (!sf) {
        std::cerr << "Failed to open sndfile for writing: " << filepath << std::endl;
        return false;
    }

    // A previous take may still be closing on the disk thread; let it finish so
    // the ring drain below can't race its drain. IPC thread, never the RT
    // thread — a bounded wait here is harmless.
    for (int i = 0; i < 200 && sndfile_.load(std::memory_order_acquire) != nullptr; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(2));

    // Drain any stale bytes instead of jack_ringbuffer_reset() — the disk
    // thread only touches the ring while sndfile_ is set or a recording has
    // been seen, and both are clear here, so this is uncontended.
    if (size_t stale = jack_ringbuffer_read_space(ringbuffer_))
        jack_ringbuffer_read_advance(ringbuffer_, stale);
    overrun_.store(false, std::memory_order_relaxed);
    // Publish sndfile_ only once everything else is ready, immediately before
    // is_recording_ — so the disk thread, which gates on is_recording_, never
    // observes a valid sndfile_ while is_recording_ is still false (that
    // window would let its "stopped + drained" branch close the file before
    // the first sample is even written).
    sndfile_.store(sf, std::memory_order_release);
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
    const int ch = channels_.load(std::memory_order_relaxed);
    if (nchannels != ch) return;
    if (static_cast<size_t>(nframes) * ch > interleave_buffer_.size()) return;

    // Interleave
    for (int i = 0; i < nframes; ++i) {
        for (int c = 0; c < ch; ++c) {
            interleave_buffer_[i * ch + c] = channel_buffers[c][i];
        }
    }

    size_t bytes_to_write = static_cast<size_t>(nframes) * ch * sizeof(float);
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
    const int chv = channels_.load(std::memory_order_relaxed);
    const int ch = chv > 0 ? chv : 1;
    SNDFILE* sf = sndfile_.load(std::memory_order_acquire);
    size_t avail;
    while ((avail = jack_ringbuffer_read_space(ringbuffer_)) > 0) {
        size_t read_bytes = std::min(avail, buf.size() * sizeof(float));
        size_t frames = (read_bytes / sizeof(float)) / ch;
        read_bytes = frames * ch * sizeof(float);
        if (frames == 0) break;
        jack_ringbuffer_read(ringbuffer_, (char*)buf.data(), read_bytes);
        if (sf) sf_writef_float(sf, buf.data(), frames);
    }
}

void DiskWriter::disk_thread_func() {
    // Only take the "stopped + drained -> close" path once we've actually
    // seen recording start; otherwise the gap between sf_open and
    // is_recording_ = true in start_recording could trip it.
    bool saw_recording = false;

    while (thread_running_) {
        const bool rec = is_recording_.load(std::memory_order_acquire);
        if (rec) saw_recording = true;

        // Only touch the ring while a recording is active or still draining —
        // otherwise start_recording()'s own drain would have a second reader.
        if (rec || saw_recording) {
            size_t available_bytes = jack_ringbuffer_read_space(ringbuffer_);
            if (available_bytes > 0) {
                drain_ringbuffer();
            } else if (saw_recording && !rec) {
                // Recording stopped and the ringbuffer is drained: flush and
                // close so the WAV header chunk sizes are finalised on disk.
                if (SNDFILE* sf = sndfile_.load(std::memory_order_acquire)) {
                    sf_write_sync(sf);
                    sf_close(sf);
                    sndfile_.store(nullptr, std::memory_order_release);
                    std::cout << "Recording saved successfully." << std::endl;
                }
                saw_recording = false;
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    // Shutting down mid-recording: drain what's left so the tail isn't lost.
    if (SNDFILE* sf = sndfile_.load(std::memory_order_acquire)) {
        drain_ringbuffer();
        sf_write_sync(sf);
        sf_close(sf);
        sndfile_.store(nullptr, std::memory_order_release);
    }
}

} // namespace recorder
} // namespace aes67_deck
