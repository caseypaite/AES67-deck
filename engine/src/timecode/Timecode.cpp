#include "timecode/Timecode.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

namespace aes67_deck {
namespace timecode {

// ---------------------------------------------------------------------------
// Frame <-> SMPTE
// ---------------------------------------------------------------------------

double sr_per_tc_frame(double sr, int fps, bool df) {
    if (df && fps == 30) return sr * 1001.0 / 30000.0;   // 29.97
    if (fps <= 0) fps = 30;
    return sr / static_cast<double>(fps);
}

SmpteTime frames_to_smpte(int64_t frame, int fps, bool df) {
    SmpteTime t;
    if (fps <= 0) fps = 30;
    if (frame < 0) frame = 0;

    if (df && fps == 30) {
        // NTSC drop-frame: frame numbers ;00 and ;01 are skipped at the top of
        // every minute except every tenth minute. Standard reconstruction.
        int64_t d = frame / 17982;      // whole 10-minute blocks
        int64_t mo = frame % 17982;
        if (mo < 2) mo += 2;
        frame += 18 * d + 2 * ((mo - 2) / 1798);
        t.f = static_cast<int>(frame % 30);
        t.s = static_cast<int>((frame / 30) % 60);
        t.m = static_cast<int>((frame / 1800) % 60);
        t.h = static_cast<int>((frame / 108000) % 24);
        return t;
    }

    int64_t fpm = 60LL * fps;
    int64_t fph = 3600LL * fps;
    t.h = static_cast<int>((frame / fph) % 24);
    t.m = static_cast<int>((frame / fpm) % 60);
    t.s = static_cast<int>((frame / fps) % 60);
    t.f = static_cast<int>(frame % fps);
    return t;
}

int64_t smpte_to_frames(const SmpteTime& t, int fps, bool df) {
    if (fps <= 0) fps = 30;
    if (df && fps == 30) {
        int64_t totalMinutes = 60LL * t.h + t.m;
        return 108000LL * t.h + 1800LL * t.m + 30LL * t.s + t.f
               - 2LL * (totalMinutes - totalMinutes / 10);
    }
    return static_cast<int64_t>(t.h) * 3600 * fps
           + static_cast<int64_t>(t.m) * 60 * fps
           + static_cast<int64_t>(t.s) * fps
           + t.f;
}

// ---------------------------------------------------------------------------
// LTC encoder
// ---------------------------------------------------------------------------

static inline void set_bit(uint8_t* w, int idx, int v) {
    if (v) w[idx >> 3] |= (1u << (idx & 7));
    else   w[idx >> 3] &= ~(1u << (idx & 7));
}
static inline int get_bit(const uint8_t* w, int idx) {
    return (w[idx >> 3] >> (idx & 7)) & 1;
}

int LtcEncoder::word_bit(int idx) const { return get_bit(word_, idx); }

void LtcEncoder::rebuild_word() {
    std::memset(word_, 0, sizeof(word_));

    auto put_bcd = [&](int lo_bit, int nbits, int value) {
        for (int i = 0; i < nbits; ++i) set_bit(word_, lo_bit + i, (value >> i) & 1);
    };

    // Time fields (SMPTE 12M bit positions).
    put_bcd(0, 4, cur_.f % 10);          // frame units
    put_bcd(8, 2, cur_.f / 10);          // frame tens
    set_bit(word_, 10, df_ ? 1 : 0);     // drop-frame flag
    // bit 11 colour-frame flag — left 0
    put_bcd(16, 4, cur_.s % 10);         // seconds units
    put_bcd(24, 3, cur_.s / 10);         // seconds tens
    put_bcd(32, 4, cur_.m % 10);         // minutes units
    put_bcd(40, 3, cur_.m / 10);         // minutes tens
    put_bcd(48, 4, cur_.h % 10);         // hours units
    put_bcd(56, 2, cur_.h / 10);         // hours tens

    // Sync word — frame bits 64..79 carry the fixed pattern
    // 0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1 (b64 first). LSB-first packing:
    word_[8] = 0xFC;   // bits 64..71
    word_[9] = 0xBF;   // bits 72..79

    // Phase-correction / parity bit: bit 27 for 25 fps, bit 59 otherwise. Set so
    // the count of 1s in bits 0..63 is even (helps a real decoder track polarity).
    int pcb = (fps_ == 25) ? 27 : 59;
    set_bit(word_, pcb, 0);
    int ones = 0;
    for (int i = 0; i < 64; ++i) ones += get_bit(word_, i);
    if (ones & 1) set_bit(word_, pcb, 1);
}

void LtcEncoder::generate(float* out, int nframes, SmpteTime block_start,
                          bool running, double sr_per_frame, int fps, bool df,
                          float level) {
    if (fps <= 0) fps = 30;
    const double half_samps = sr_per_frame / 160.0;   // 80 bits * 2 half-bits

    int64_t want = smpte_to_frames(block_start, fps, df);
    int64_t have = smpte_to_frames(cur_, fps, df);
    if (!inited_ || fps_ != fps || df_ != df || std::llabs(want - have) > 1) {
        inited_ = true;
        fps_ = fps;
        df_ = df;
        cur_ = block_start;
        rebuild_word();
        bit_idx_ = 0;
        half_ = 0;
        half_acc_ = 0.0;
    }

    for (int i = 0; i < nframes; ++i) {
        out[i] = static_cast<float>(level_) * level;
        half_acc_ += 1.0;
        if (half_acc_ >= half_samps) {
            half_acc_ -= half_samps;
            if (half_ == 0) {
                // Move to the middle of the current bit: toggle only for a '1'.
                if (word_bit(bit_idx_)) level_ = -level_;
                half_ = 1;
            } else {
                // Bit boundary: always toggle, advance to the next bit.
                level_ = -level_;
                half_ = 0;
                if (++bit_idx_ >= 80) {
                    bit_idx_ = 0;
                    if (running) {
                        int64_t n = smpte_to_frames(cur_, fps_, df_) + 1;
                        cur_ = frames_to_smpte(n, fps_, df_);
                    }
                    rebuild_word();
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// LTC decoder
// ---------------------------------------------------------------------------

void LtcDecoder::reset() {
    prev_sign_ = 0;
    since_cross_ = 0.0;
    hb_ = 0.0;
    short_run_ = 0;
    sr_ = 0;
    bits_seen_ = 0;
    end_offset_ = -1;
}

void LtcDecoder::push_bit(int bit) {
    sr_ = (sr_ << 1) | static_cast<unsigned __int128>(bit & 1);
    sr_ &= ((static_cast<unsigned __int128>(1) << 80) - 1);
    if (bits_seen_ < 80) ++bits_seen_;

    // Sync word lands in the low 16 bits once a full frame has shifted through.
    if (bits_seen_ >= 80 && static_cast<uint64_t>(sr_ & 0xFFFF) == 0x3FFD) {
        auto fb = [&](int k) -> int {
            return static_cast<int>((sr_ >> (79 - k)) & 1);
        };
        auto bcd = [&](int lo, int n) -> int {
            int v = 0;
            for (int i = 0; i < n; ++i) v |= fb(lo + i) << i;
            return v;
        };
        SmpteTime t;
        t.f = bcd(8, 2) * 10 + bcd(0, 4);
        t.s = bcd(24, 3) * 10 + bcd(16, 4);
        t.m = bcd(40, 3) * 10 + bcd(32, 4);
        t.h = bcd(56, 2) * 10 + bcd(48, 4);
        // Sanity gate — reject a false sync landing on garbage.
        if (t.f < 40 && t.s < 60 && t.m < 60 && t.h < 24) {
            last_ = t;
            last_df_ = fb(10) != 0;
            end_offset_ = block_pos_;
        }
    }
}

bool LtcDecoder::process(const float* in, int nframes, double expected_hb) {
    if (hb_ <= 0.0) hb_ = expected_hb > 1.0 ? expected_hb : 6.0;
    end_offset_ = -1;

    for (int i = 0; i < nframes; ++i) {
        block_pos_ = i;
        since_cross_ += 1.0;
        const float x = in[i];
        const int sign = x > 0.0f ? 1 : (x < 0.0f ? -1 : prev_sign_);

        if (prev_sign_ != 0 && sign != 0 && sign != prev_sign_) {
            const double dt = since_cross_;
            since_cross_ = 0.0;

            // Classify the interval against the running half-bit estimate.
            if (dt < hb_ * 1.5) {
                // A half-length interval — two in a row make one '1' bit.
                if (++short_run_ == 2) {
                    push_bit(1);
                    short_run_ = 0;
                    hb_ += 0.05 * (dt - hb_);
                }
            } else if (dt < hb_ * 3.0) {
                // A full-length interval — one '0' bit.
                push_bit(0);
                short_run_ = 0;
                hb_ += 0.05 * (dt * 0.5 - hb_);
            } else {
                // Way out of range: treat as a dropout, resync the bit clock.
                short_run_ = 0;
            }
        }
        if (sign != 0) prev_sign_ = sign;
    }

    return end_offset_ >= 0;
}

// ---------------------------------------------------------------------------
// MIDI Time Code encoder
// ---------------------------------------------------------------------------

int MtcEncoder::generate(SmpteTime block_start, bool running, double sr_per_frame,
                         int fps, bool df, int nframes, MtcEvent* ev, int cap) {
    rate_bits_ = df && fps == 30 ? 2 : (fps == 24 ? 0 : fps == 25 ? 1 : 3);
    const double qf_samps = sr_per_frame / 4.0;   // 8 quarter-frames per 2 TC frames
    int n = 0;

    auto push_full = [&](const SmpteTime& t, int offset) {
        if (n >= cap) return;
        MtcEvent& e = ev[n++];
        e.offset = offset < 0 ? 0 : offset;
        e.len = 10;
        e.bytes[0] = 0xF0; e.bytes[1] = 0x7F; e.bytes[2] = 0x7F;
        e.bytes[3] = 0x01; e.bytes[4] = 0x01;
        e.bytes[5] = static_cast<uint8_t>((rate_bits_ << 5) | (t.h & 0x1F));
        e.bytes[6] = static_cast<uint8_t>(t.m & 0x3F);
        e.bytes[7] = static_cast<uint8_t>(t.s & 0x3F);
        e.bytes[8] = static_cast<uint8_t>(t.f & 0x1F);
        e.bytes[9] = 0xF7;
        last_full_ = t;
    };

    if (!inited_) {
        inited_ = true;
        seq_start_ = block_start;
        qf_index_ = 0;
        qf_acc_ = 0.0;
        was_running_ = running;
        push_full(block_start, 0);
    }

    // A stop, a start, or a jump larger than a couple of frames re-issues a
    // full-frame message (receivers chase it directly).
    int64_t bs = smpte_to_frames(block_start, fps, df);
    int64_t sf = smpte_to_frames(seq_start_, fps, df);
    if (running != was_running_ || std::llabs(bs - sf) > 2) {
        seq_start_ = block_start;
        qf_index_ = 0;
        qf_acc_ = 0.0;
        push_full(block_start, 0);
    }
    was_running_ = running;

    if (!running) return n;

    auto qf_data = [&](int idx, const SmpteTime& t) -> uint8_t {
        int piece = 0;
        switch (idx) {
            case 0: piece = t.f & 0x0F; break;
            case 1: piece = (t.f >> 4) & 0x0F; break;
            case 2: piece = t.s & 0x0F; break;
            case 3: piece = (t.s >> 4) & 0x0F; break;
            case 4: piece = t.m & 0x0F; break;
            case 5: piece = (t.m >> 4) & 0x0F; break;
            case 6: piece = t.h & 0x0F; break;
            case 7: piece = ((rate_bits_ << 1) | ((t.h >> 4) & 1)) & 0x0F; break;
        }
        return static_cast<uint8_t>((idx << 4) | piece);
    };

    for (int i = 0; i < nframes; ++i) {
        if (qf_acc_ <= 0.0) {
            if (qf_index_ == 0) {
                // Latch the timecode at the start of each 8-message sequence
                // (block-start code plus whole TC frames elapsed within it).
                int64_t elapsed = static_cast<int64_t>(i / sr_per_frame);
                seq_start_ = frames_to_smpte(
                    smpte_to_frames(block_start, fps, df) + elapsed, fps, df);
            }
            if (n < cap) {
                MtcEvent& e = ev[n++];
                e.offset = i;
                e.len = 2;
                e.bytes[0] = 0xF1;
                e.bytes[1] = qf_data(qf_index_, seq_start_);
            }
            qf_index_ = (qf_index_ + 1) & 7;
            qf_acc_ += qf_samps;
        }
        qf_acc_ -= 1.0;
    }
    return n;
}

}  // namespace timecode
}  // namespace aes67_deck
