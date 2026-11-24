// fmlink_core.h - frame builder + DDS modulator for the FM Multi-Mod Link
// Plain C++ (no Arduino calls) so the same code runs on the STM32 and in a PC test.
// Keep this file next to fmlink_tx.ino (Arduino IDE shows it as a second tab).
#pragma once
#include <stdint.h>
#include <math.h>

namespace fl {

// ---------- link parameters (must match python/fmlink.py) ----------
const uint32_t FS        = 48000;   // DDS sample rate (Hz)
const uint16_t F_MARK    = 1200;    // FSK "1"
const uint16_t F_SPACE   = 2200;    // FSK "0"
const uint16_t F_CARRIER = 1800;    // ASK and DBPSK tone
const uint16_t SYNC_WORD = 0x2DD4;
const uint8_t  TYPE_TEXT = 0x3C;   // the two type codes differ in all 8 bits
const uint8_t  TYPE_PRBS = 0xC3;
const uint8_t  PRBS_BYTES = 64;     // 511 PRBS-9 bits + 1 zero pad
const uint8_t  MAX_PAYLOAD = 200;
const uint16_t PREAMBLE_BITS = 32;
const uint16_t IDLE_BITS = 32;
const uint16_t MAX_BITS = PREAMBLE_BITS + 16 + 16 + MAX_PAYLOAD * 8 + 8 + IDLE_BITS;

enum Scheme : uint8_t { ASK = 0, FSK = 1, DBPSK = 2 };
enum Mode   : uint8_t { MODE_DATA = 0, MODE_TONE = 1, MODE_SILENT = 2 };

inline const char *schemeName(uint8_t s) { return s == ASK ? "ASK" : s == FSK ? "FSK" : "DBPSK"; }

inline uint32_t phaseStep(uint32_t hz) { return (uint32_t)(((uint64_t)hz << 32) / FS); }

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

struct BitBuf {
  uint8_t bits[MAX_BITS];
  uint16_t len;
  void clear() { len = 0; }
  void push(uint8_t b) { if (len < MAX_BITS) bits[len++] = b & 1; }
  void pushByte(uint8_t v) { for (int8_t i = 7; i >= 0; i--) push((v >> i) & 1); }
};

// Frame: preamble 1010.. | sync 0x2DD4 | type | len | payload | crc8(type,len,payload) | idle 1s
inline void buildFrame(BitBuf &f, uint8_t type, const uint8_t *payload, uint8_t len) {
  static uint8_t tmp[2 + 255];
  if (len > MAX_PAYLOAD && type == TYPE_TEXT) len = MAX_PAYLOAD;
  f.clear();
  for (uint16_t i = 0; i < PREAMBLE_BITS; i++) f.push((i & 1) ? 0 : 1);
  f.pushByte(SYNC_WORD >> 8);
  f.pushByte(SYNC_WORD & 0xFF);
  tmp[0] = type; tmp[1] = len;
  for (uint16_t i = 0; i < len; i++) tmp[2 + i] = payload[i];
  for (uint16_t i = 0; i < (uint16_t)(2 + len); i++) f.pushByte(tmp[i]);
  f.pushByte(crc8(tmp, 2 + len));
  for (uint16_t i = 0; i < IDLE_BITS; i++) f.push(1);
}

inline void buildPrbsFrame(BitBuf &f) {
  uint8_t p[PRBS_BYTES];
  prbs9Bytes(p);
  buildFrame(f, TYPE_PRBS, p, PRBS_BYTES);
}

// Called FS times per second; returns the next 8-bit PWM sample (128 = silence).
struct Modulator {
  uint8_t sine[256];
  const BitBuf *volatile active;
  const BitBuf *volatile pending;   // swapped in at the next frame start
  volatile uint8_t scheme, nextScheme, mode;
  volatile uint16_t spb, nextSpb;
  volatile uint32_t toneStep;
  uint16_t pos, cnt;
  uint8_t cur;
  uint32_t phase, stepMark, stepSpace, stepCarrier;

  void begin(const BitBuf *first, uint8_t sch, uint16_t baud) {
    for (int i = 0; i < 256; i++) sine[i] = (uint8_t)lround(128.0 + 100.0 * sin(2.0 * M_PI * i / 256.0));
    stepMark = phaseStep(F_MARK); stepSpace = phaseStep(F_SPACE); stepCarrier = phaseStep(F_CARRIER);
    toneStep = phaseStep(1000);
    active = first; pending = 0;
    scheme = sch; nextScheme = 0xFF; spb = FS / baud; nextSpb = 0;
    mode = MODE_DATA; pos = 0; cnt = 0; cur = 1; phase = 0;
  }

  inline uint8_t next() {
    if (mode == MODE_SILENT) return 128;
    if (mode == MODE_TONE) { phase += toneStep; return sine[phase >> 24]; }
    if (cnt == 0) {
      if (pos == 0) {                                   // frame boundary: apply changes
        if (pending) { active = pending; pending = 0; }
        if (nextScheme != 0xFF) { scheme = nextScheme; nextScheme = 0xFF; }
        if (nextSpb) { spb = nextSpb; nextSpb = 0; }
      }
      cur = active->bits[pos];
      if (++pos >= active->len) pos = 0;
      if (scheme == DBPSK && cur == 0) phase += 0x80000000UL;   // 0 = 180 degree flip
    }
    if (++cnt >= spb) cnt = 0;
    phase += (scheme == FSK) ? (cur ? stepMark : stepSpace) : stepCarrier;
    if (scheme == ASK && cur == 0) return 128;
    return sine[phase >> 24];
  }
};

}  // namespace fl
