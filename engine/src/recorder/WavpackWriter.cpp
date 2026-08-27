#include "WavpackWriter.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>

namespace aes67_deck {
namespace recorder {

namespace {
constexpr size_t RING_BYTES = 16 * 1024 * 1024;
constexpr int MAX_NFRAMES = 8192;
}

WavpackWriter::WavpackWriter() {
    ringbuffer_ = jack_ringbuffer_create(RING_BYTES);
    thread_ = std::thread(&WavpackWriter::disk_thread_func, this);
}

WavpackWriter::~WavpackWriter() {
    stop_recording();
    thread_running_.store(false, std::memory_order_relaxed);
    if (thread_.joinable()) thread_.join();
    jack_ringbuffer_free(ringbuffer_);
}

int WavpackWriter::write_block_cb(void* id, void* data, int32_t bcount) {
    auto* self = static_cast<WavpackWriter*>(id);
    if (!self->file_) return 0;
    if (self->first_block_.empty()) {
        // The very first block carries the stream header whose sample count we
        // patch on close (encoding with unknown length).
        self->first_block_.assign(static_cast<unsigned char*>(data),
                                  static_cast<unsigned char*>(data) + bcount);
    }
    return std::fwrite(data, 1, static_cast<size_t>(bcount), self->file_) == static_cast<size_t>(bcount);
}

bool WavpackWriter::start_recording(const std::string& filepath, int channels, int sample_rate) {
    if (is_recording_.load(std::memory_order_relaxed)) return false;
    channels_ = channels;
    path_ = filepath;
    first_block_.clear();

    file_ = std::fopen(filepath.c_str(), "wb");
    if (!file_) {
        std::cerr << "WavpackWriter: cannot open " << filepath << std::endl;
        return false;
    }

    WavpackContext* wpc = WavpackOpenFileOutput(&WavpackWriter::write_block_cb, this, nullptr);
    if (!wpc) { std::fclose(file_); file_ = nullptr; return false; }

    WavpackConfig cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    cfg.bytes_per_sample = 4;
    cfg.bits_per_sample = 32;
    cfg.num_channels = channels;
    cfg.channel_mask = channels == 1 ? 0x4 : 0x3;   // MONO / FL|FR
    cfg.sample_rate = sample_rate;
    cfg.float_norm_exp = 127;                        // normalized IEEE float, +/- 1.0
    cfg.flags = CONFIG_FAST_FLAG;

    if (!WavpackSetConfiguration64(wpc, &cfg, -1, nullptr) || !WavpackPackInit(wpc)) {
        std::cerr << "WavpackWriter: config/init failed: " << WavpackGetErrorMessage(wpc) << std::endl;
        WavpackCloseFile(wpc);
        std::fclose(file_); file_ = nullptr;
        return false;
    }

    interleave_buffer_.resize(static_cast<size_t>(MAX_NFRAMES) * channels);
    jack_ringbuffer_reset(ringbuffer_);
    overrun_.store(false, std::memory_order_relaxed);

    // Publish wpc_ last, immediately before is_recording_ — matches DiskWriter:
    // the disk thread gates on is_recording_ and must never see a live wpc_
    // while is_recording_ is still false.
    wpc_ = wpc;
    is_recording_.store(true, std::memory_order_release);
    return true;
}

void WavpackWriter::stop_recording() {
    is_recording_.store(false, std::memory_order_release);
    // The disk thread drains the ring, flushes the encoder, patches the header
    // and closes the file on its own time.
}

void WavpackWriter::write_audio(const float* const* channel_buffers, int nchannels, int nframes) {
    if (!is_recording_.load(std::memory_order_acquire)) return;
    if (nchannels != channels_) return;
    if (static_cast<size_t>(nframes) * channels_ > interleave_buffer_.size()) return;

    for (int i = 0; i < nframes; ++i)
        for (int c = 0; c < channels_; ++c)
            interleave_buffer_[i * channels_ + c] = channel_buffers[c][i];

    const size_t bytes = static_cast<size_t>(nframes) * channels_ * sizeof(float);
    if (jack_ringbuffer_write_space(ringbuffer_) >= bytes) {
        jack_ringbuffer_write(ringbuffer_, reinterpret_cast<const char*>(interleave_buffer_.data()), bytes);
    } else {
        overrun_.store(true, std::memory_order_relaxed);
    }
}

void WavpackWriter::drain_ringbuffer() {
    static thread_local std::vector<float> buf;
    if (buf.empty()) buf.resize(static_cast<size_t>(MAX_NFRAMES) * 16);
    const int ch = channels_ > 0 ? channels_ : 1;
    size_t avail;
    while ((avail = jack_ringbuffer_read_space(ringbuffer_)) > 0) {
        size_t read_bytes = std::min(avail, buf.size() * sizeof(float));
        size_t frames = (read_bytes / sizeof(float)) / ch;
        if (frames == 0) break;
        read_bytes = frames * ch * sizeof(float);
        jack_ringbuffer_read(ringbuffer_, reinterpret_cast<char*>(buf.data()), read_bytes);
        if (wpc_) {
            // WavPack takes an int32 buffer; for float data each int32 slot is
            // the bit pattern of the sample.
            WavpackPackSamples(wpc_, reinterpret_cast<int32_t*>(buf.data()),
                               static_cast<uint32_t>(frames));
        }
    }
}

void WavpackWriter::close_file() {
    if (!wpc_) return;
    WavpackFlushSamples(wpc_);
    if (!first_block_.empty()) {
        WavpackUpdateNumSamples(wpc_, first_block_.data());
        if (file_ && std::fseek(file_, 0, SEEK_SET) == 0) {
            std::fwrite(first_block_.data(), 1, first_block_.size(), file_);
        }
    }
    WavpackCloseFile(wpc_);
    wpc_ = nullptr;
    if (file_) { std::fflush(file_); std::fclose(file_); file_ = nullptr; }
    std::cout << "WavpackWriter: take file closed (" << path_ << ")" << std::endl;
}

void WavpackWriter::disk_thread_func() {
    bool saw_recording = false;
    while (thread_running_.load(std::memory_order_relaxed)) {
        if (is_recording_.load(std::memory_order_acquire)) saw_recording = true;

        if (jack_ringbuffer_read_space(ringbuffer_) > 0) {
            drain_ringbuffer();
        } else if (saw_recording && !is_recording_.load(std::memory_order_acquire) && wpc_) {
            close_file();
            saw_recording = false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    // Shutdown mid-take: don't lose the tail.
    if (wpc_) {
        drain_ringbuffer();
        close_file();
    }
}

} // namespace recorder
} // namespace aes67_deck
