#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <memory>
#include <sndfile.h>
#include <jack/ringbuffer.h>

namespace aes67_deck {
namespace playback {

// One scheduled clip on the timeline. All positions in frames at the engine
// sample rate. Stereo assumed for the ring; the source file may be mono or
// stereo (mono is duplicated).
struct ClipSpec {
    int trackId = 0;
    uint64_t timelineStart = 0; // where the clip sits on the timeline
    uint64_t length = 0;        // clip length
    uint64_t fileStart = 0;     // offset into the source file the clip begins at
    float gain = 1.0f;          // linear
    uint64_t fadeIn = 0;        // linear fade-in ramp length, frames
    uint64_t fadeOut = 0;       // linear fade-out ramp length, frames
    std::string path;
};

// Disk-streaming timeline playback. A reader thread keeps a per-track ring
// buffer filled with the timeline mix for that track (clip audio + silence in
// gaps, clip gain applied); the audio thread pulls nframes per track per
// callback via render(). Nothing here opens files or allocates on the audio
// thread.
//
// Transport is external (the engine's g_transport). The host feeds position +
// state in every process callback via set_transport(); the reader follows it,
// re-seeking on a locate and flushing on stop->play.
class TimelinePlayer {
public:
    static constexpr int MAX_CH = 32; // track ids 1..32

    explicit TimelinePlayer(int sample_rate);
    ~TimelinePlayer();

    TimelinePlayer(const TimelinePlayer&) = delete;
    TimelinePlayer& operator=(const TimelinePlayer&) = delete;

    // IPC thread. Replaces the whole schedule; the reader picks it up on its
    // next iteration.
    void set_schedule(std::vector<ClipSpec> clips);

    // Audio thread, once per process callback.
    void set_transport(uint64_t frame, int state) {
        transport_frame_.store(frame, std::memory_order_relaxed);
        transport_state_.store(state, std::memory_order_relaxed);
    }

    // Audio thread. Overwrites L/R (nframes each) with this track's timeline
    // audio for the current block, or silence on a gap / ring underrun.
    void render(int track_id, float* L, float* R, uint32_t nframes);

    // Clear-on-read: true if the audio thread hit a ring underrun since the
    // last call (the reader couldn't keep the timeline fed).
    bool take_underrun() { return underrun_.exchange(false, std::memory_order_relaxed); }

private:
    void reader_loop();
    void produce_track(int track_id, uint64_t pos, uint32_t n, float* interleaved_dst);

    struct TrackReader {
        SNDFILE* sf = nullptr;
        SF_INFO info{};
        std::string open_path;
        int64_t cursor = -1; // frame position of sf, -1 = unknown
        jack_ringbuffer_t* ring = nullptr;
        ~TrackReader() { if (sf) sf_close(sf); if (ring) jack_ringbuffer_free(ring); }
    };

    const int sample_rate_;
    std::atomic<bool> running_{true};
    std::thread reader_;

    std::atomic<uint64_t> transport_frame_{0};
    std::atomic<int> transport_state_{0};

    std::mutex sched_mutex_;
    std::vector<ClipSpec> schedule_;       // reader-owned working copy
    std::vector<ClipSpec> pending_;        // set_schedule drop box
    std::atomic<bool> pending_ready_{false};

    std::unique_ptr<TrackReader> tracks_[MAX_CH + 1];

    uint64_t fill_pos_ = 0;
    bool was_playing_ = false;
    std::atomic<bool> priming_{false}; // reader flushed, ring not yet refilled

    std::vector<float> read_scratch_;      // reader thread
    std::vector<float> rt_scratch_;        // audio thread (render)

    std::atomic<bool> underrun_{false};
};

} // namespace playback
} // namespace aes67_deck
