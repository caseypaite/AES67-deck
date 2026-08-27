#include "MultitrackRecorder.h"
#include <cstdio>
#include <iostream>

namespace aes67_deck {
namespace recorder {

bool MultitrackRecorder::start(const std::string& dir, const std::vector<int>& armed,
                               int sample_rate, uint64_t origin_frame) {
    if (recording_.load(std::memory_order_relaxed)) return false;
    if (armed.empty()) return false;

    // Reap the previous take's writers now (they have had the whole gap
    // between takes to flush and close — destroying earlier risks truncating
    // the tail still in a ringbuffer).
    for (auto& w : writers_) w.reset();

    dir_ = dir;
    armed_.clear();
    origin_frame_ = origin_frame;
    sample_rate_ = sample_rate > 0 ? sample_rate : 48000;

    // Trailing slash tolerated either way.
    std::string base = dir_;
    if (!base.empty() && base.back() != '/') base.push_back('/');

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
        opened++;
    }

    if (opened == 0) {
        for (auto& w : writers_) w.reset();
        armed_.clear();
        return false;
    }

    frames_tapped_.store(0, std::memory_order_relaxed);
    recording_.store(true, std::memory_order_release);
    std::cout << "MultitrackRecorder: recording " << opened << " channel(s) to "
              << base << " from frame " << origin_frame_ << std::endl;
    return true;
}

void MultitrackRecorder::stop() {
    if (!recording_.exchange(false, std::memory_order_acq_rel)) return;
    // Flip each DiskWriter's is_recording_ false; its own disk thread then
    // drains the ringbuffer, syncs and closes the file on its own time. The
    // unique_ptrs are kept (not reset here) so nothing is destroyed while a
    // ringbuffer tail is still unwritten — start() reaps them next take.
    for (auto& w : writers_) {
        if (w) w->stop_recording();
    }
    std::cout << "MultitrackRecorder: take closed (" << dir_ << "), "
              << (armed_.empty() ? 0 : frames_tapped_.load(std::memory_order_relaxed) / armed_.size())
              << " frames/ch across " << armed_.size() << " channel(s)" << std::endl;
}

} // namespace recorder
} // namespace aes67_deck
