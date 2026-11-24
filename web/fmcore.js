/* fmcore.js - FM Multi-Mod Link: frame builder and Uno-style DDS modulator.
   A line-by-line mirror of fmlink_uno/fmlink_uno_core.h, so the audio made here is the audio
   the Arduino Uno makes (31 250 Hz DDS, 8-bit sine table 128 +- 100, fractional bit clock). */
(function (root) {
  "use strict";

  const FS_UNO = 31250;            // Uno DDS sample rate = 16 MHz / 512
  const F_MARK = 1200;             // FSK "1"
  const F_SPACE = 2200;            // FSK "0"
  const F_CARRIER = 1800;          // ASK and DBPSK tone
  const SYNC_WORD = 0x2DD4;
  const TYPE_TEXT = 0x3C;
  const TYPE_PRBS = 0xC3;
  const PRBS_BYTES = 64;
  const MAX_TEXT = 100;
  const SCHEMES = ["ASK", "FSK", "DBPSK"];
  const BAUDS = [150, 300, 600, 1200];

  // 128 + round(100 * sin(2*pi*i/256)): the Uno's PWM duty table
  const SINE = new Uint8Array(256);
  for (let i = 0; i < 256; i++) SINE[i] = 128 + Math.round(100 * Math.sin(2 * Math.PI * i / 256));

  function crc8(bytes) {                       // poly 0x07, init 0
    let c = 0;
    for (const d of bytes) {
      c ^= d;
      for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
    }
    return c;
  }

  function prbs9Bits() {                       // x^9 + x^5 + 1, seed 0x1FF, 511 bits + one 0
    let s = 0x1FF;
    const out = new Uint8Array(512);
    for (let i = 0; i < 511; i++) {
      out[i] = s & 1;
      const nb = ((s >> 8) ^ (s >> 4)) & 1;
      s = ((s << 1) | nb) & 0x1FF;
    }
    out[511] = 0;
    return out;
  }
  const PRBS = prbs9Bits();

  function bitsOf(value, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push((value >> i) & 1);
    return out;
  }

  function bytesToBits(bytes) {
    const out = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++)
      for (let k = 0; k < 8; k++) out[i * 8 + k] = (bytes[i] >> (7 - k)) & 1;
    return out;
  }

  function bitsToBytes(bits) {
    const out = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i + k] ? 1 : 0);
      out.push(v);
    }
    return out;
  }

  function textBytes(text) {                   // latin-1, '?' for anything else, max 100
    const out = [];
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      out.push(c < 256 ? c : 63);
      if (out.length >= MAX_TEXT) break;
    }
    return out;
  }

  // preamble 0xAA x4 | sync 0x2DD4 | type | len | payload | crc8(type,len,payload) | idle 0xFF x4
  function buildFrame(kind, text) {
    const isPrbs = kind === "PRBS";
    const type = isPrbs ? TYPE_PRBS : TYPE_TEXT;
    const payload = isPrbs ? bitsToBytes(PRBS) : textBytes(text || "");
    const bytes = [];
    const fields = [];
    const push = (name, arr) => { fields.push({ name, start: bytes.length, len: arr.length }); bytes.push(...arr); };
    push("preamble", [0xAA, 0xAA, 0xAA, 0xAA]);
    push("sync", [SYNC_WORD >> 8, SYNC_WORD & 0xFF]);
    push("type", [type]);
    push("len", [payload.length]);
    push("payload", payload);
    push("crc", [crc8([type, payload.length, ...payload])]);
    push("idle", [0xFF, 0xFF, 0xFF, 0xFF]);
    return { bytes, fields, bits: bytesToBits(bytes), type, payload };
  }

  function phaseStep(hz) {                     // ((uint64)hz << 32) / FS, integer
    return Math.floor(hz * 4294967296 / FS_UNO);
  }

  /* The Uno's Modulator.next(), run for `repeats` frames. Returns samples in -1..1 at 31 250 Hz,
     i.e. (PWM duty - 128) / 128. ASK "0" = duty 128 (no tone), DBPSK "0" = 180 degree flip. */
  function modulateUno(bits, scheme, baud, repeats) {
    repeats = repeats || 1;
    const total = bits.length * repeats;
    const n = Math.ceil(total * FS_UNO / baud);
    const out = new Float32Array(n);
    const stepMark = phaseStep(F_MARK), stepSpace = phaseStep(F_SPACE), stepCarrier = phaseStep(F_CARRIER);
    let bitAcc = FS_UNO - baud, pos = 0, cur = 1, phase = 0, sent = 0;
    for (let i = 0; i < n; i++) {
      bitAcc += baud;
      if (bitAcc >= FS_UNO) {
        bitAcc -= FS_UNO;
        if (sent >= total) return out.subarray(0, i);
        cur = bits[pos];
        pos = (pos + 1) % bits.length;
        sent++;
        if (scheme === "DBPSK" && cur === 0) phase = (phase + 0x80000000) >>> 0;
      }
      phase = (phase + (scheme === "FSK" ? (cur ? stepMark : stepSpace) : stepCarrier)) >>> 0;
      const duty = (scheme === "ASK" && cur === 0) ? 128 : SINE[phase >>> 24];
      out[i] = (duty - 128) / 128;
    }
    return out;
  }

  function toneUno(hz, seconds) {               // the Uno's MODE_TONE (T<hz> command)
    const n = Math.round(seconds * FS_UNO);
    const out = new Float32Array(n);
    const step = phaseStep(hz);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase = (phase + step) >>> 0;
      out[i] = (SINE[phase >>> 24] - 128) / 128;
    }
    return out;
  }

  /* Linear resampling from fsIn to fsOut. clock > 1 models a transmitter whose clock runs fast:
     every tone and the bit rate are scaled by it (like an Uno with an off-nominal resonator). */
  function resample(x, fsIn, fsOut, clock) {
    clock = clock || 1;
    const ratio = fsIn * clock / fsOut;          // input samples per output sample
    const n = Math.floor((x.length - 1) / ratio);
    const out = new Float32Array(Math.max(0, n));
    for (let i = 0; i < n; i++) {
      const t = i * ratio, k = Math.floor(t), f = t - k;
      out[i] = x[k] * (1 - f) + x[k + 1] * f;
    }
    return out;
  }

  function gaussian() {                         // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function addNoise(x, snrDb) {                 // white noise, SNR against the signal's power
    let p = 0;
    for (let i = 0; i < x.length; i++) p += x[i] * x[i];
    p /= Math.max(1, x.length);
    const sigma = Math.sqrt(p / Math.pow(10, snrDb / 10));
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] + sigma * gaussian();
    return out;
  }

  const api = {
    FS_UNO, F_MARK, F_SPACE, F_CARRIER, SYNC_WORD, TYPE_TEXT, TYPE_PRBS, PRBS_BYTES, MAX_TEXT,
    SCHEMES, BAUDS, SINE, PRBS,
    crc8, bitsOf, bytesToBits, bitsToBytes, textBytes, buildFrame, phaseStep,
    modulateUno, toneUno, resample, addNoise,
  };
  root.FMCore = api;
})(typeof window !== "undefined" ? window : globalThis);
