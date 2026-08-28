#include "TimelinePlayer.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>

namespace aes67_deck {
namespace playback {

namespace {
constexpr uint32_t FILL_CHUNK = 4096;     // frames produced per track per pass
constexpr size_t RING_BYTES = 1u << 20;   // 1 MiB per track ≈ 2.7 s stereo f32
constexpr int64_t SEEK_THRESH = 2048;     // frame jump that counts as a locate

bool ends_with_ci(const std::string& s, const char* suffix) {
    const size_t n = std::strlen(suffix);
    if (s.size() < n) return false;
    for (size_t i = 0; i < n; ++i)
        if (std::tolower(s[s.size() - n + i]) != std::tolower(suffix[i])) return false;
    return true;
}
}

// --- TrackReader: dual-format (libsndfile / WavPack) interleaved-stereo reader ---

void TimelinePlayer::TrackReader::close() {
    if (sf) { sf_close(sf); sf = nullptr; }
    if (wv) { WavpackCloseFile(wv); wv = nullptr; }
    std::memset(&info, 0, sizeof(info));
    wv_channels = 0;
    wv_float = false;
    wv_scale = 1.0f;
    open_path.clear();
}

bool TimelinePlayer::TrackReader::open(const std::string& path) {
    close();
    open_path = path;
    cursor = -1;

    if (ends_with_ci(path, ".wv")) {
        char err[128] = {0};
        wv = WavpackOpenFileInput(path.c_str(), err, OPEN_NORMALIZE, 0);
        if (!wv) {
            std::cerr << "TimelinePlayer: cannot open " << path << " (" << err << ")" << std::endl;
            return false;
        }
        wv_channels = WavpackGetNumChannels(wv);
        wv_float = (WavpackGetMode(wv) & MODE_FLOAT) != 0;
        if (!wv_float) {
            const int bits = WavpackGetBitsPerSample(wv);
            wv_scale = 1.0f / static_cast<float>(1LL << (bits > 1 ? bits - 1 : 1));
        }
        wv_scratch.assign(static_cast<size_t>(FILL_CHUNK) * 2, 0);
        return true;
    }

    sf = sf_open(path.c_str(), SFM_READ, &info);
    if (!sf) {
        std::cerr << "TimelinePlayer: cannot open " << path << std::endl;
        return false;
    }
    return true;
}

void TimelinePlayer::TrackReader::seek(int64_t frame) {
    if (wv) WavpackSeekSample64(wv, frame);
    else if (sf) sf_seek(sf, frame, SEEK_SET);
}

uint32_t TimelinePlayer::TrackReader::read_stereo(float* out, uint32_t frames) {
    if (frames == 0) return 0;
    const int nch = channels();
    if (nch != 1 && nch != 2) return 0;

    if (sf) {
        if (nch == 2) return static_cast<uint32_t>(sf_readf_float(sf, out, frames));
        uint32_t remaining = frames, got = 0;
        float mono[1024];
        float* o = out;
        while (remaining > 0) {
            const uint32_t block = std::min<uint32_t>(remaining, 1024);
            const uint32_t r = static_cast<uint32_t>(sf_readf_float(sf, mono, block));
            for (uint32_t i = 0; i < r; ++i) o[2 * i] = o[2 * i + 1] = mono[i];
            o += 2 * r; got += r; remaining -= r;
            if (r < block) break;
        }
        return got;
    }

    if (wv) {
        const size_t need = static_cast<size_t>(frames) * (nch == 2 ? 2 : 1);
        if (wv_scratch.size() < need) wv_scratch.resize(need);
        const uint32_t r = WavpackUnpackSamples(wv, wv_scratch.data(), frames);
        const int32_t* s = wv_scratch.data();
        if (wv_float) {
            const float* f = reinterpret_cast<const float*>(s);
            if (nch == 2) std::memcpy(out, f, sizeof(float) * 2 * r);
            else for (uint32_t i = 0; i < r; ++i) out[2 * i] = out[2 * i + 1] = f[i];
        } else {
            if (nch == 2)
                for (uint32_t i = 0; i < r; ++i) { out[2 * i] = s[2 * i] * wv_scale; out[2 * i + 1] = s[2 * i + 1] * wv_scale; }
            else
                for (uint32_t i = 0; i < r; ++i) out[2 * i] = out[2 * i + 1] = s[i] * wv_scale;
        }
        return r;
    }
    return 0;
}

TimelinePlayer::TimelinePlayer(int sample_rate)
    : sample_rate_(sample_rate > 0 ? sample_rate : 48000) {
    read_scratch_.resize(FILL_CHUNK * 2);
    read_scratch_b_.resize(FILL_CHUNK * 2);
    rt_scratch_.resize(8192 * 2);
    for (int t = 1; t <= MAX_CH; ++t) {
        tracks_[t] = std::make_unique<TrackReader>();
        tracks_[t]->ring = jack_ringbuffer_create(RING_BYTES);
        tracks_b_[t] = std::make_unique<TrackReader>();   // no ring — crossfade only
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
// timeline position `pos`, walking clip boundaries. Two overlapping clips on
// the track are mixed with an equal-power (cos/sin) crossfade across the
// overlap span. Reader thread only.
void TimelinePlayer::produce_track(int track_id, uint64_t pos, uint32_t n, float* dst) {
    constexpr float HALF_PI = 1.5707963267948966f;

    // Read `frames` interleaved-stereo frames of clip `c` at timeline position
    // `at` into `out` via reader `tr`, zero-filling a short read.
    auto read_clip = [](TrackReader& tr, const ClipSpec& c,
                        uint64_t at, uint32_t frames, float* out) {
        const int64_t file_off = static_cast<int64_t>(c.fileStart + (at - c.timelineStart));
        if (tr.open_path != c.path) tr.open(c.path);
        uint32_t got = 0;
        const int nch = tr.channels();
        if ((tr.sf || tr.wv) && (nch == 1 || nch == 2)) {
            if (tr.cursor != file_off) { tr.seek(file_off); tr.cursor = file_off; }
            got = tr.read_stereo(out, frames);
            tr.cursor += got;
        }
        if (got < frames)
            std::memset(out + got * 2, 0, sizeof(float) * 2 * (frames - got));
    };

    uint32_t produced = 0;
    while (produced < n) {
        const uint64_t here = pos + produced;

        // Clips covering `here` on this track (0, 1, or — during a crossfade —
        // 2), plus the start of the next clip to bound a silent gap.
        const ClipSpec* c0 = nullptr;   // earlier start (outgoing)
        const ClipSpec* c1 = nullptr;   // later start (incoming)
        uint64_t next_start = UINT64_MAX;
        for (const auto& c : schedule_) {
            if (c.trackId != track_id || c.length == 0) continue;
            if (here >= c.timelineStart && here < c.timelineStart + c.length) {
                if (!c0) { c0 = &c; }
                else if (!c1) { c1 = &c; }
                else {
                    // 3+ deep (pathological): keep the two latest-starting.
                    const ClipSpec** lo =
                        c0->timelineStart <= c1->timelineStart ? &c0 : &c1;
                    if (c.timelineStart > (*lo)->timelineStart) *lo = &c;
                }
            } else if (c.timelineStart > here && c.timelineStart < next_start) {
                next_start = c.timelineStart;
            }
        }
        if (c0 && c1 && c1->timelineStart < c0->timelineStart) std::swap(c0, c1);

        if (!c0) {
            uint64_t gap = n - produced;
            if (next_start != UINT64_MAX && next_start - here < gap) gap = next_start - here;
            std::memset(dst + produced * 2, 0, sizeof(float) * 2 * gap);
            produced += static_cast<uint32_t>(gap);
            continue;
        }

        // Run until the next boundary: c0's end, c1's end/start, or the next
        // clip's start.
        uint64_t bound = c0->timelineStart + c0->length - here;
        if (c1) bound = std::min(bound, c1->timelineStart + c1->length - here);
        else if (next_start != UINT64_MAX) bound = std::min(bound, next_start - here);
        const uint32_t take = static_cast<uint32_t>(std::min<uint64_t>(n - produced, bound));
        float* out = dst + produced * 2;

        read_clip(*tracks_[track_id], *c0, here, take, out);

        if (!c1) {
            // Single clip: constant gain × linear fade-in/out ramps.
            const uint64_t clip_off = here - c0->timelineStart;
            const bool has_fade = c0->fadeIn > 0 || c0->fadeOut > 0;
            if (c0->gain != 1.0f || has_fade) {
                for (uint32_t f = 0; f < take; ++f) {
                    float e = c0->gain;
                    const uint64_t p = clip_off + f;
                    if (c0->fadeIn > 0 && p < c0->fadeIn)
                        e *= static_cast<float>(p) / static_cast<float>(c0->fadeIn);
                    if (c0->fadeOut > 0 && c0->length > p &&
                        c0->length - p <= c0->fadeOut)
                        e *= static_cast<float>(c0->length - p) / static_cast<float>(c0->fadeOut);
                    out[f * 2] *= e;
                    out[f * 2 + 1] *= e;
                }
            }
        } else {
            // Overlap → equal-power crossfade from c0 to c1 across
            // [c1.start, c0.end]. Each clip's own linear fades are ignored
            // inside the overlap; the xfade is the authority.
            if (read_scratch_b_.size() < static_cast<size_t>(take) * 2)
                read_scratch_b_.resize(static_cast<size_t>(take) * 2);
            read_clip(*tracks_b_[track_id], *c1, here, take, read_scratch_b_.data());

            const double xf_start = static_cast<double>(c1->timelineStart);
            const double xf_end = static_cast<double>(c0->timelineStart + c0->length);
            const double xf_len = std::max(1.0, xf_end - xf_start);
            for (uint32_t f = 0; f < take; ++f) {
                double t = (static_cast<double>(here + f) - xf_start) / xf_len;
                t = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
                const float ga = c0->gain * std::cos(static_cast<float>(t) * HALF_PI);
                const float gb = c1->gain * std::sin(static_cast<float>(t) * HALF_PI);
                out[f * 2]     = out[f * 2]     * ga + read_scratch_b_[f * 2]     * gb;
                out[f * 2 + 1] = out[f * 2 + 1] * ga + read_scratch_b_[f * 2 + 1] * gb;
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
            for (int t = 1; t <= MAX_CH; ++t) {
                tracks_[t]->cursor = -1;
                tracks_b_[t]->cursor = -1;
            }
        }

        const int state = transport_state_.load(std::memory_order_relaxed);
        const uint64_t frame = transport_frame_.load(std::memory_order_relaxed);

        if (state == 0) {
            was_playing_ = false;
            std::this_thread::sleep_for(10ms);
            continue;
        }

        // A re-seek is needed on stop->play, a transport discontinuity (manual
        // locate / loop wrap), or if the playhead has run past what we've
        // buffered. The reader normally sits FILL lead-frames *ahead* of the
        // playhead — that is not a seek, so compare against the last observed
        // transport frame, never against fill_pos_.
        const int64_t advance =
            static_cast<int64_t>(frame) - static_cast<int64_t>(last_transport_frame_);
        const bool discontinuity =
            advance < 0 || advance > static_cast<int64_t>(sample_rate_) / 2;
        const bool playhead_ran_dry =
            static_cast<int64_t>(frame) > static_cast<int64_t>(fill_pos_) + SEEK_THRESH;
        last_transport_frame_ = frame;

        if (!was_playing_ || discontinuity || playhead_ran_dry) {
            priming_.store(true, std::memory_order_relaxed);
            for (int t = 1; t <= MAX_CH; ++t) {
                jack_ringbuffer_reset(tracks_[t]->ring);
                tracks_[t]->cursor = -1;
                tracks_b_[t]->cursor = -1;
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
