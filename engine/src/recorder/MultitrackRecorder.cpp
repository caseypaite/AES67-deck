#include "MultitrackRecorder.h"
#include <chrono>
#include <cstdio>
#include <iostream>

namespace aes67_deck {
namespace recorder {

MultitrackRecorder::MultitrackRecorder() {
    reaper_ = std::thread(&MultitrackRecorder::reaper_loop, this);
}

MultitrackRecorder::~MultitrackRecorder() {
    reaper_run_.store(false, std::memory_order_relaxed);
    if (reaper_.joinable()) reaper_.join();
    stop();
    for (auto& p : writer_ptr_) p.store(nullptr, std::memory_order_relaxed);
    for (auto& w : writers_) w.reset();
    std::lock_guard<std::mutex> lk(retired_mutex_);
    retired_.clear();
}

// Destroys retired writers (each ~WavpackWriter joins its own disk thread,
// which finishes the take file first) off the RT / IPC path — but only once
// the audio thread has completed at least one full block past the retire, so a
// write() that was mid-flight on the outgoing writer is guaranteed done.
void MultitrackRecorder::reaper_loop() {
    using namespace std::chrono_literals;
    while (reaper_run_.load(std::memory_order_relaxed)) {
        std::vector<std::unique_ptr<WavpackWriter>> batch;
        {
            const uint64_t seq = audio_block_seq_.load(std::memory_order_acquire);
            std::lock_guard<std::mutex> lk(retired_mutex_);
            auto it = retired_.begin();
            while (it != retired_.end()) {
                if (seq > it->seq + 1) {          // >= 2 blocks elapsed
                    batch.push_back(std::move(it->w));
                    it = retired_.erase(it);
                } else {
                    ++it;
                }
            }
        }
        batch.clear();   // ~WavpackWriter here, outside every lock
        std::this_thread::sleep_for(50ms);
    }
}

bool MultitrackRecorder::start(const std::string& dir, const std::vector<int>& armed,
                               int sample_rate, uint64_t origin_frame) {
    if (recording_.load(std::memory_order_relaxed)) return false;
    if (armed.empty()) return false;

    // Retire the previous take's writers — do NOT destroy them here. The audio
    // thread can still be one block deep in write() on one, and ~WavpackWriter
    // frees the ringbuffer under it. The reaper destroys them after the block
    // sequence advances. (stop() has already nulled writer_ptr_ and flipped
    // each writer's is_recording_ false, so their disk threads are closing.)
    {
        const uint64_t seq = audio_block_seq_.load(std::memory_order_acquire);
        std::lock_guard<std::mutex> lk(retired_mutex_);
        for (int c = 1; c <= MAX_CH; ++c) {
            writer_ptr_[c].store(nullptr, std::memory_order_release);
            if (writers_[c]) retired_.push_back({std::move(writers_[c]), seq});
        }
    }

    dir_ = dir;
    armed_.clear();
    origin_frame_ = origin_frame;
    sample_rate_ = sample_rate > 0 ? sample_rate : 48000;

    // Trailing slash tolerated either way.
    std::string base = dir_;
    if (!base.empty() && base.back() != '/') base.push_back('/');

    uint32_t mask = 0;
    int opened = 0;
    for (int ch_id : armed) {
        if (ch_id < 1 || ch_id > MAX_CH) continue;
        if (writers_[ch_id]) continue; // dup in the armed list

        char name[32];
        std::snprintf(name, sizeof(name), "ch%02d.%s", ch_id, file_ext());
        auto w = std::make_unique<WavpackWriter>();
        if (!w->start_recording(base + name, 2, sample_rate_)) {
            std::cerr << "MultitrackRecorder: failed to open " << base + name << std::endl;
            continue;
        }
        writers_[ch_id] = std::move(w);
        armed_.push_back(ch_id);
        mask |= (1u << (ch_id - 1));
        opened++;
    }

    if (opened == 0) {
        for (auto& w : writers_) w.reset();   // fresh, unpublished — safe
        armed_.clear();
        return false;
    }

    frames_tapped_.store(0, std::memory_order_relaxed);
    armed_mask_.store(mask, std::memory_order_release);
    // Publish the writer pointers, then recording_ last (release) — the audio
    // thread that sees recording_==true sees fully-populated writer_ptr_.
    for (int ch_id : armed_)
        writer_ptr_[ch_id].store(writers_[ch_id].get(), std::memory_order_release);
    recording_.store(true, std::memory_order_release);
    std::cout << "MultitrackRecorder: recording " << opened << " channel(s) to "
              << base << " from frame " << origin_frame_ << std::endl;
    return true;
}

void MultitrackRecorder::stop() {
    if (!recording_.exchange(false, std::memory_order_acq_rel)) return;
    // Hide the writers from the audio thread first, then flip each DiskWriter's
    // is_recording_ false; its own disk thread drains the ringbuffer, syncs and
    // closes the file on its own time. The unique_ptrs stay in writers_ until
    // the next start() retires them to the reaper.
    for (int c = 1; c <= MAX_CH; ++c) {
        writer_ptr_[c].store(nullptr, std::memory_order_release);
        if (writers_[c]) writers_[c]->stop_recording();
    }
    armed_mask_.store(0, std::memory_order_release);
    std::cout << "MultitrackRecorder: take closed (" << dir_ << "), "
              << (armed_.empty() ? 0 : frames_tapped_.load(std::memory_order_relaxed) / armed_.size())
              << " frames/ch across " << armed_.size() << " channel(s)" << std::endl;
}

} // namespace recorder
} // namespace aes67_deck
