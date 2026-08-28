#pragma once

// Timecode & sync (plan/daw-timeline-roadmap.md Phase 3d).
//
// Hand-rolled SMPTE LTC encode/decode + MIDI Time Code generation. No external
// library (libltc is not packaged on the appliance and the "light on the
// system" rule applies). Everything here is RT-safe: fixed-size state, no
// allocation, no locking — instances live on the audio thread only.
//
// Supported rates: 24, 25, 30 (non-drop) and 29.97 drop-frame (fps 30 + df).
// The carrier bit rate is 80 bits/frame; for 29.97DF the frame period is
// 1001/30000 s (so `sr_per_tc_frame` differs from the nominal 30 fps value).

#include <cstdint>
#include <cstddef>

namespace aes67_deck {
namespace timecode {

struct SmpteTime {
    int h = 0, m = 0, s = 0, f = 0;
};

// Frame <-> SMPTE. `fps` is the nominal integer rate (24/25/30). `df` applies
// only at fps 30 and selects the NTSC drop-frame numbering. `frame` is a plain
// running count of timecode frames from 00:00:00:00.
SmpteTime frames_to_smpte(int64_t frame, int fps, bool df);
int64_t   smpte_to_frames(const SmpteTime& t, int fps, bool df);

// Samples of audio per timecode frame for a given engine sample rate.
double sr_per_tc_frame(double sr, int fps, bool df);

// --- LTC generator --------------------------------------------------------
// Emits a biphase-mark-coded square carrier. Free-runs (keeps toggling) even
// when `running` is false — a parked generator still holds a downstream device
// in lock, which is what lets an operator jam other gear at a park position.
class LtcEncoder {
public:
    // Fill `out[0..nframes)` with the carrier. `block_start` is the timecode
    // the first sample should carry; the encoder re-snaps if it has drifted
    // more than a frame from its own running position (normal free-run stays
    // sub-frame so there is no glitch), otherwise it advances itself while
    // `running`.
    void generate(float* out, int nframes, SmpteTime block_start,
                  bool running, double sr_per_frame, int fps, bool df, float level);

private:
    void rebuild_word();
    int  word_bit(int idx) const;   // frame bit `idx` (0..79), LSB-first order

    bool     inited_ = false;
    SmpteTime cur_{};
    int      fps_ = 30;
    bool     df_ = false;
    uint8_t  word_[10] = {0};       // 80 bits, byte 0 = bits 0..7, LSB-first
    int      bit_idx_ = 0;          // 0..79
    int      half_ = 0;             // 0 = first half of the bit, 1 = second
    double   half_acc_ = 0.0;       // samples into the current half-bit
    int      level_ = 1;            // current carrier polarity (+1 / -1)
};

// --- LTC decoder --------------------------------------------------------
class LtcDecoder {
public:
    // Feed one audio block. Returns true when a full 80-bit frame completed in
    // this block; `last()` / `end_offset()` then describe it. `expected_hb`
    // seeds the bit-clock estimate (sr_per_tc_frame / 160).
    bool process(const float* in, int nframes, double expected_hb);

    SmpteTime last() const { return last_; }
    int  end_offset() const { return end_offset_; }   // sample index within the last block
    bool drop_frame() const { return last_df_; }

    void reset();

private:
    void push_bit(int bit);

    // zero-cross / bit-clock recovery
    int      prev_sign_ = 0;
    double   since_cross_ = 0.0;
    double   hb_ = 0.0;            // running half-bit estimate (samples)
    int      short_run_ = 0;      // consecutive half-length intervals seen

    unsigned __int128 sr_ = 0;    // 80-bit shift register (LSB = most recent bit)
    int      bits_seen_ = 0;

    SmpteTime last_{};
    bool     last_df_ = false;
    int      end_offset_ = -1;
    int      block_pos_ = 0;      // sample cursor within the current process() call
};

// --- MIDI Time Code generator -----------------------------------------
struct MtcEvent {
    int    offset;          // sample offset within the block
    uint8_t bytes[10];
    int    len;
};

class MtcEncoder {
public:
    // Step the block. Fills `ev[0..return)` (bounded, caller passes cap >= 40)
    // with quarter-frame messages and, on a stop or a discontinuity, one
    // full-frame SysEx.
    int generate(SmpteTime block_start, bool running, double sr_per_frame,
                 int fps, bool df, int nframes, MtcEvent* ev, int cap);

private:
    bool     inited_ = false;
    bool     was_running_ = false;
    int      qf_index_ = 0;        // 0..7
    double   qf_acc_ = 0.0;        // samples until the next quarter-frame
    SmpteTime seq_start_{};        // timecode latched at qf_index_ == 0
    SmpteTime last_full_{};
    int      rate_bits_ = 0;       // 0=24 1=25 2=29.97df 3=30
};

}  // namespace timecode
}  // namespace aes67_deck
