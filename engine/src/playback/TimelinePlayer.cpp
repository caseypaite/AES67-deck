#include "TimelinePlayer.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>

namespace aes67_deck {
namespace playback {

namespace {
constexpr uint32_t FILL_CHUNK = 4096;     // frames produced per track per pass
constexpr size_t RING_BYTES = 1u << 20;   // 1 MiB per track ≈ 2.7 s stereo f32
constexpr int64_t SEEK_THRESH = 2048;     // frame jump that counts as a locate
}

TimelinePlayer::TimelinePlayer(int sample_rate)
    : sample_rate_(sample_rate > 0 ? sample_rate : 48000) {
    read_scratch_.resize(FILL_CHUNK * 2);
    rt_scratch_.resize(8192 * 2);
    for (int t = 1; t <= MAX_CH; ++t) {
        tracks_[t] = std::make_unique<TrackReader>();
        tracks_[t]->ring = jack_ringbuffer_create(RING_BYTES);
    }
    reader_ = std::thread(&TimelinePlayer::reader_loop, this);
}

TimelinePlayer::~TimelinePlayer() {
    running_.store(false, std::memory_order_relaxed);
    if (reader_.joinable()) reader_.join();
}

void TimelinePlayer::set_schedule(std::vector<ClipSpec> clips) {
    std::lock_guard<std::mutex> lk(sched_mutex_);
    pending_ = std::move(clips);
    pending_ready_.store(true, std::memory_order_release);
}

void TimelinePlayer::render(int track_id, float* L, float* R, uint32_t nframes) {
    if (track_id < 1 || track_id > MAX_CH) return;
    jack_ringbuffer_t* ring = tracks_[track_id]->ring;
    const size_t want = static_cast<size_t>(nframes) * 2 * sizeof(float);
    if (jack_ringbuffer_read_space(ring) >= want &&
        rt_scratch_.size() >= static_cast<size_t>(nframes) * 2) {
        jack_ringbuffer_read(ring, reinterpret_cast<char*>(rt_scratch_.data()), want);
        for (uint32_t i = 0; i < nframes; ++i) {
            L[i] = rt_scratch_[2 * i];
            R[i] = rt_scratch_[2 * i + 1];
        }
    } else {
        std::memset(L, 0, sizeof(float) * nframes);
        std::memset(R, 0, sizeof(float) * nframes);
        // Silence during a post-locate refill is expected, not a dropout.
        if (!priming_.load(std::memory_order_relaxed)) {
            underrun_.store(true, std::memory_order_relaxed);
        }
    }
}

// Fill `interleaved_dst` (n stereo frames) with track_id's timeline audio at
// timeline position `pos`, walking clip boundaries. Reader thread only.
void TimelinePlayer::produce_track(int track_id, uint64_t pos, uint32_t n, float* dst) {
    uint32_t produced = 0;
    while (produced < n) {
        const uint64_t here = pos + produced;

        // Find the clip covering `here`, and the start of the next clip after
        // it (to bound the silent gap).
        const ClipSpec* cur = nullptr;
        uint64_t next_start = UINT64_MAX;
        for (const auto& c : schedule_) {
            if (c.trackId != track_id || c.length == 0) continue;
            if (here >= c.timelineStart && here < c.timelineStart + c.length) {
                cur = &c;
                break;
            }
            if (c.timelineStart > here && c.timelineStart < next_start) next_start = c.timelineStart;
        }

        if (!cur) {
            uint64_t gap = n - produced;
            if (next_start != UINT64_MAX && next_start - here < gap) gap = next_start - here;
            std::memset(dst + produced * 2, 0, sizeof(float) * 2 * gap);
            produced += static_cast<uint32_t>(gap);
            continue;
        }

        const uint64_t avail = cur->timelineStart + cur->length - here;
        const uint32_t take = static_cast<uint32_t>(std::min<uint64_t>(n - produced, avail));
        const int64_t file_off = static_cast<int64_t>(cur->fileStart + (here - cur->timelineStart));

        TrackReader& tr = *tracks_[track_id];
        if (tr.open_path != cur->path) {
            if (tr.sf) { sf_close(tr.sf); tr.sf = nullptr; }
            std::memset(&tr.info, 0, sizeof(tr.info));
            tr.sf = sf_open(cur->path.c_str(), SFM_READ, &tr.info);
            tr.open_path = cur->path;
            tr.cursor = -1;
            if (!tr.sf) std::cerr << "TimelinePlayer: cannot open " << cur->path << std::endl;
        }

        uint32_t got = 0;
        if (tr.sf && (tr.info.channels == 1 || tr.info.channels == 2)) {
            if (tr.cursor != file_off) {
                sf_seek(tr.sf, file_off, SEEK_SET);
                tr.cursor = file_off;
            }
            if (tr.info.channels == 2) {
                got = static_cast<uint32_t>(sf_readf_float(tr.sf, dst + produced * 2, take));
            } else {
                // Mono → duplicate into stereo.
                float mono[1024];
                uint32_t remaining = take;
                float* out = dst + produced * 2;
                while (remaining > 0) {
                    const uint32_t block = std::min<uint32_t>(remaining, 1024);
                    const uint32_t r = static_cast<uint32_t>(sf_readf_float(tr.sf, mono, block));
                    for (uint32_t i = 0; i < r; ++i) out[2 * i] = out[2 * i + 1] = mono[i];
                    out += 2 * r;
                    got += r;
                    remaining -= r;
                    if (r < block) break;
                }
            }
            tr.cursor += got;
        }

        if (got < take) {
            std::memset(dst + (produced + got) * 2, 0, sizeof(float) * 2 * (take - got));
        }

        // Per-frame envelope: constant clip gain × linear fade-in/out ramps.
        const uint64_t clip_off = here - cur->timelineStart;   // frames into the clip
        const bool has_fade = cur->fadeIn > 0 || cur->fadeOut > 0;
        if (cur->gain != 1.0f || has_fade) {
            for (uint32_t f = 0; f < take; ++f) {
                float e = cur->gain;
                const uint64_t p = clip_off + f;
                if (cur->fadeIn > 0 && p < cur->fadeIn)
                    e *= static_cast<float>(p) / static_cast<float>(cur->fadeIn);
                if (cur->fadeOut > 0 && cur->length > p &&
                    cur->length - p <= cur->fadeOut)
                    e *= static_cast<float>(cur->length - p) / static_cast<float>(cur->fadeOut);
                dst[(produced + f) * 2] *= e;
                dst[(produced + f) * 2 + 1] *= e;
            }
        }
        produced += take;
    }
}

void TimelinePlayer::reader_loop() {
    using namespace std::chrono_literals;

    while (running_.load(std::memory_order_relaxed)) {
        if (pending_ready_.load(std::memory_order_acquire)) {
            std::lock_guard<std::mutex> lk(sched_mutex_);
            schedule_ = std::move(pending_);
            pending_.clear();
            pending_ready_.store(false, std::memory_order_relaxed);
            // Force a re-seek so a schedule edit takes effect at the playhead.
            for (int t = 1; t <= MAX_CH; ++t) tracks_[t]->cursor = -1;
        }

        const int state = transport_state_.load(std::memory_order_relaxed);
        const uint64_t frame = transport_frame_.load(std::memory_order_relaxed);

        if (state == 0) {
            was_playing_ = false;
            std::this_thread::sleep_for(10ms);
            continue;
        }

        const bool locate =
            !was_playing_ ||
            std::llabs(static_cast<int64_t>(frame) - static_cast<int64_t>(fill_pos_)) > SEEK_THRESH;
        if (locate) {
            priming_.store(true, std::memory_order_relaxed);
            for (int t = 1; t <= MAX_CH; ++t) {
                jack_ringbuffer_reset(tracks_[t]->ring);
                tracks_[t]->cursor = -1;
            }
            fill_pos_ = frame;
            was_playing_ = true;
        }

        // How many frames can we add to every track's ring this pass?
        uint32_t to_fill = FILL_CHUNK;
        for (int t = 1; t <= MAX_CH; ++t) {
            const uint32_t space =
                static_cast<uint32_t>(jack_ringbuffer_write_space(tracks_[t]->ring) / (2 * sizeof(float)));
            to_fill = std::min(to_fill, space);
        }
        if (to_fill == 0) {
            std::this_thread::sleep_for(4ms);
            continue;
        }

        for (int t = 1; t <= MAX_CH; ++t) {
            produce_track(t, fill_pos_, to_fill, read_scratch_.data());
            jack_ringbuffer_write(tracks_[t]->ring,
                                  reinterpret_cast<const char*>(read_scratch_.data()),
                                  static_cast<size_t>(to_fill) * 2 * sizeof(float));
        }
        fill_pos_ += to_fill;

        // Once every track has a comfortable lead, dropouts are real again.
        if (priming_.load(std::memory_order_relaxed)) {
            size_t min_fill = SIZE_MAX;
            for (int t = 1; t <= MAX_CH; ++t)
                min_fill = std::min(min_fill, jack_ringbuffer_read_space(tracks_[t]->ring));
            if (min_fill >= static_cast<size_t>(sample_rate_) / 4 * 2 * sizeof(float))
                priming_.store(false, std::memory_order_relaxed);
        }

        std::this_thread::sleep_for(3ms);
    }
}

} // namespace playback
} // namespace aes67_deck
