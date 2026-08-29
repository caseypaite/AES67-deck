#include "MultitrackRecorder.h"
#include <cstdio>
#include <iostream>

namespace aes67_deck {
namespace recorder {

MultitrackRecorder::MultitrackRecorder() {
    // Persistent writer pool — created once, here, so start() never allocates a
    // ringbuffer or spawns a disk thread at the moment recording begins.
    for (int c = 1; c <= MAX_CH; ++c)
        writers_[c] = std::make_unique<WavpackWriter>(MTR_RING_BYTES);
}

bool MultitrackRecorder::start(const std::string& dir, const std::vector<int>& armed,
                               int sample_rate, uint64_t origin_frame) {
    if (recording_.load(std::memory_order_relaxed)) return false;
    if (armed.empty()) return false;

    dir_ = dir;
    armed_.clear();
    origin_frame_ = origin_frame;
    sample_rate_ = sample_rate > 0 ? sample_rate : 48000;

    std::string base = dir_;
    if (!base.empty() && base.back() != '/') base.push_back('/');

    uint32_t mask = 0;
    int opened = 0;
    for (int ch_id : armed) {
        if (ch_id < 1 || ch_id > MAX_CH) continue;
        if (mask & (1u << (ch_id - 1))) continue;   // dup in the armed list

        char name[32];
        std::snprintf(name, sizeof(name), "ch%02d.%s", ch_id, file_ext());
        // Pool writer — start_recording() only opens the file + encoder here
        // (it drains its own ring and waits out any still-closing prior take).
        if (!writers_[ch_id]->start_recording(base + name, 2, sample_rate_)) {
            std::cerr << "MultitrackRecorder: failed to open " << base + name << std::endl;
            continue;
        }
        armed_.push_back(ch_id);
        mask |= (1u << (ch_id - 1));
        opened++;
    }

    if (opened == 0) {
        for (int c : armed_) writers_[c]->stop_recording();
        armed_.clear();
        return false;
    }

    frames_tapped_.store(0, std::memory_order_relaxed);
    armed_mask_.store(mask, std::memory_order_release);
    // recording_ flips last (release) — the audio thread that sees it true also
    // sees armed_mask_ and every armed writer's own is_recording_.
    recording_.store(true, std::memory_order_release);
    std::cout << "MultitrackRecorder: recording " << opened << " channel(s) to "
              << base << " from frame " << origin_frame_ << std::endl;
    return true;
}

void MultitrackRecorder::stop() {
    if (!recording_.exchange(false, std::memory_order_acq_rel)) return;
    armed_mask_.store(0, std::memory_order_release);
    // Flip each armed writer's is_recording_ false; its disk thread drains the
    // ring, flushes the encoder, patches the header and closes the file on its
    // own time. The pool writer itself lives on for the next take.
    for (int c : armed_)
        if (writers_[c]) writers_[c]->stop_recording();
    std::cout << "MultitrackRecorder: take closed (" << dir_ << "), "
              << (armed_.empty() ? 0 : frames_tapped_.load(std::memory_order_relaxed) / armed_.size())
              << " frames/ch across " << armed_.size() << " channel(s)" << std::endl;
}

} // namespace recorder
} // namespace aes67_deck
