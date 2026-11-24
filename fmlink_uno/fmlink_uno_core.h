// fmlink_uno_core.h - frame builder + DDS modulator for the FM Multi-Mod Link (Arduino Uno version)
// Plain C++ with no Arduino calls. The same file builds for the ATmega328P and for the PC simulator
// in tools/sim_uno.cpp, so the samples tested on the PC are exactly the samples the Uno sends.
// Keep this file next to fmlink_uno.ino (Arduino IDE shows it as a second tab).
#pragma once
#include <stdint.h>

#if defined(__AVR__)
  #include <avr/pgmspace.h>
  #define FL_PROGMEM PROGMEM
  #define FL_TABLE(t, i) pgm_read_byte(&(t)[(i)])
#else
  #define FL_PROGMEM
  #define FL_TABLE(t, i) ((t)[(i)])
#endif

namespace fl {

// ---------- link parameters (must match python/fmlink.py) ----------
const uint16_t FS        = 31250;   // DDS sample rate (Hz) = 16 MHz / 512, locked to the 62.5 kHz PWM
const uint16_t F_MARK    = 1200;    // FSK "1"
const uint16_t F_SPACE   = 2200;    // FSK "0"
const uint16_t F_CARRIER = 1800;    // ASK and DBPSK tone
const uint16_t SYNC_WORD = 0x2DD4;
const uint8_t  TYPE_TEXT = 0x3C;    // the two type codes differ in all 8 bits
const uint8_t  TYPE_PRBS = 0xC3;
const uint8_t  PRBS_BYTES = 64;     // 511 PRBS-9 bits + 1 zero pad
const uint8_t  MAX_TEXT = 100;      // Uno has 2 KB of RAM
const uint8_t  PREAMBLE_BYTES = 4;  // 0xAA x 4 = 32 bits 1010...
const uint8_t  IDLE_BYTES = 4;      // 0xFF x 4 = 32 bits of 1
const uint8_t  FRAME_BYTES_MAX = PREAMBLE_BYTES + 2 + 2 + MAX_TEXT + 1 + IDLE_BYTES;   // 113

enum Scheme : uint8_t { ASK = 0, FSK = 1, DBPSK = 2 };
enum Mode   : uint8_t { MODE_DATA = 0, MODE_TONE = 1, MODE_SILENT = 2 };

inline const char *schemeName(uint8_t s) { return s == ASK ? "ASK" : s == FSK ? "FSK" : "DBPSK"; }

// 32-bit phase increment for a tone of `hz` at the DDS rate (only called outside the interrupt)
inline uint32_t phaseStep(uint32_t hz) { return (uint32_t)(((uint64_t)hz << 32) / FS); }

// 128 + round(100 * sin(2*pi*i/256)): 8-bit PWM duty, 128 = silence
const uint8_t SINE[256] FL_PROGMEM = {
  128, 130, 133, 135, 138, 140, 143, 145, 148, 150, 152, 155, 157, 159, 162, 164,
  166, 169, 171, 173, 175, 177, 179, 181, 184, 186, 188, 190, 191, 193, 195, 197,
  199, 200, 202, 204, 205, 207, 208, 210, 211, 212, 214, 215, 216, 217, 218, 219,
  220, 221, 222, 223, 224, 224, 225, 226, 226, 227, 227, 227, 228, 228, 228, 228,
  228, 228, 228, 228, 228, 227, 227, 227, 226, 226, 225, 224, 224, 223, 222, 221,
  220, 219, 218, 217, 216, 215, 214, 212, 211, 210, 208, 207, 205, 204, 202, 200,
  199, 197, 195, 193, 191, 190, 188, 186, 184, 181, 179, 177, 175, 173, 171, 169,
  166, 164, 162, 159, 157, 155, 152, 150, 148, 145, 143, 140, 138, 135, 133, 130,
  128, 126, 123, 121, 118, 116, 113, 111, 108, 106, 104, 101,  99,  97,  94,  92,
   90,  87,  85,  83,  81,  79,  77,  75,  72,  70,  68,  66,  65,  63,  61,  59,
   57,  56,  54,  52,  51,  49,  48,  46,  45,  44,  42,  41,  40,  39,  38,  37,
   36,  35,  34,  33,  32,  32,  31,  30,  30,  29,  29,  29,  28,  28,  28,  28,
   28,  28,  28,  28,  28,  29,  29,  29,  30,  30,  31,  32,  32,  33,  34,  35,
   36,  37,  38,  39,  40,  41,  42,  44,  45,  46,  48,  49,  51,  52,  54,  56,
   57,  59,  61,  63,  65,  66,  68,  70,  72,  75,  77,  79,  81,  83,  85,  87,
   90,  92,  94,  97,  99, 101, 104, 106, 108, 111, 113, 116, 118, 121, 123, 126,
};

inline uint8_t crc8(const uint8_t *d, uint16_t n) {          // CRC-8, poly 0x07, init 0
  uint8_t c = 0;
  for (uint16_t i = 0; i < n; i++) {
    c ^= d[i];
    for (uint8_t k = 0; k < 8; k++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1);
  }
  return c;
}

// PRBS-9 (x^9 + x^5 + 1), seed 0x1FF, 511 bits then one 0, packed MSB first
inline void prbs9Bytes(uint8_t *out) {
  uint16_t s = 0x1FF;
  for (uint16_t i = 0; i < PRBS_BYTES; i++) {
    uint8_t v = 0;
    for (uint8_t k = 0; k < 8; k++) {
      uint8_t b = 0;
      if (i * 8 + k < 511) {
        b = s & 1;
        uint8_t nb = ((s >> 8) ^ (s >> 4)) & 1;
        s = ((s << 1) | nb) & 0x1FF;
      }
      v = (uint8_t)((v << 1) | b);
    }
    out[i] = v;
  }
}

// A frame stored as packed bytes (8 bits per byte, MSB first): 113 bytes max instead of 900+
struct Frame {
  uint8_t  b[FRAME_BYTES_MAX];
  uint16_t nbits;
};

// preamble 0xAA x4 | sync 0x2DD4 | type | len | payload | crc8(type,len,payload) | idle 0xFF x4
inline void buildFrame(Frame &f, uint8_t type, const uint8_t *payload, uint8_t len) {
  if (len > MAX_TEXT) len = MAX_TEXT;
  uint8_t n = 0;
  for (uint8_t i = 0; i < PREAMBLE_BYTES; i++) f.b[n++] = 0xAA;
  f.b[n++] = (uint8_t)(SYNC_WORD >> 8);
  f.b[n++] = (uint8_t)(SYNC_WORD & 0xFF);
  uint8_t hdr = n;
  f.b[n++] = type;
  f.b[n++] = len;
  for (uint8_t i = 0; i < len; i++) f.b[n++] = payload[i];
  f.b[n] = crc8(&f.b[hdr], (uint16_t)(2 + len));
  n++;
  for (uint8_t i = 0; i < IDLE_BYTES; i++) f.b[n++] = 0xFF;
  f.nbits = (uint16_t)n * 8;
}

inline void buildPrbsFrame(Frame &f) {
  uint8_t p[PRBS_BYTES];
  prbs9Bytes(p);
  buildFrame(f, TYPE_PRBS, p, PRBS_BYTES);
}

// Called FS times per second (timer interrupt); returns the next 8-bit PWM sample.
struct Modulator {
  // Written by the main program. On the Uno, write the 16/32-bit ones with interrupts off.
  const Frame *volatile active;     // frame being sent
  const Frame *volatile pending;    // swapped in at the start of the next frame (0 = none)
  volatile uint8_t  mode;           // MODE_DATA / MODE_TONE / MODE_SILENT
  volatile uint8_t  nextScheme;     // applied at the next frame start (0xFF = no change)
  volatile uint16_t nextBaud;       // applied at the next frame start (0 = no change)
  volatile uint32_t toneStep;       // phase increment in MODE_TONE
  // Used only inside next()
  uint8_t  scheme;
  uint16_t baud;
  uint16_t bitAcc;                  // fractional bit clock: += baud every sample, new bit at >= FS
  uint16_t pos;                     // index of the next bit in the active frame
  uint8_t  cur;                     // bit being sent
  uint32_t phase;
  uint32_t stepMark, stepSpace, stepCarrier;

  void begin(const Frame *first, uint8_t sch, uint16_t bd) {
    stepMark = phaseStep(F_MARK);
    stepSpace = phaseStep(F_SPACE);
    stepCarrier = phaseStep(F_CARRIER);
    toneStep = phaseStep(1000);
    active = first; pending = 0;
    mode = MODE_DATA; nextScheme = 0xFF; nextBaud = 0;
    scheme = sch; baud = bd;
    bitAcc = (uint16_t)(FS - bd);   // so the very first sample starts bit 0
    pos = 0; cur = 1; phase = 0;
  }

  inline uint8_t next() {
    uint8_t m = mode;
    if (m == MODE_SILENT) return 128;
    if (m == MODE_TONE) { phase += toneStep; return FL_TABLE(SINE, (uint8_t)(phase >> 24)); }
    bitAcc += baud;
    if (bitAcc >= FS) {                                   // a new bit starts on this sample
      bitAcc -= FS;                                       // (31250/300 = 104.17: exact on average)
      if (pos == 0) {                                     // frame boundary: apply queued changes
        if (pending) { active = pending; pending = 0; }
        if (nextScheme != 0xFF) { scheme = nextScheme; nextScheme = 0xFF; }
        if (nextBaud) { baud = nextBaud; nextBaud = 0; }
      }
      const Frame *f = active;
      cur = (f->b[pos >> 3] >> (7 - (pos & 7))) & 1;
      if (++pos >= f->nbits) pos = 0;
      if (scheme == DBPSK && cur == 0) phase += 0x80000000UL;   // 0 = 180 degree phase flip
    }
    phase += (scheme == FSK) ? (cur ? stepMark : stepSpace) : stepCarrier;
    if (scheme == ASK && cur == 0) return 128;            // ASK "0" = no tone
    return FL_TABLE(SINE, (uint8_t)(phase >> 24));
  }
};

}  // namespace fl
