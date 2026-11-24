/* decoder.js - FM Multi-Mod Link receiver, ported from python/fmlink.py (decode, soft_bits,
   find_frames, bit_timing, parse_frame). Works on any sample rate: the bit period is fs/baud.
   Steps: band-pass 400-3600 Hz -> normalise -> mix each tone to 0 Hz and average over one bit
   -> soft decision per sample -> search preamble+sync at 16 timing offsets -> per frame, try
   41 clock errors (+-1 %) x 5 shifts and keep the clearest -> read type/len/payload -> CRC-8. */
(function (root) {
  "use strict";
  const C = root.FMCore;

  const SYNC_PATTERN = [1, 0, 1, 0, 1, 0, 1, 0].concat(C.bitsOf(C.SYNC_WORD, 16));  // 24 bits
  const PAT = SYNC_PATTERN.map((b) => 2 * b - 1);
  const CLOCK_SEARCH = Array.from({ length: 41 }, (_, i) => -0.01 + i * 0.0005);
  const EPS = 1e-12;

  // ---------- filters ----------
  function biquad(type, f0, fs) {              // RBJ cookbook, Butterworth Q
    const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * Math.SQRT1_2);
    const b = type === "lp" ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    const a0 = 1 + alpha;
    return [b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cw) / a0, (1 - alpha) / a0];
  }

  function runBiquad(y, c) {                   // transposed direct form II, in place
    const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
    let z1 = 0, z2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const v = b0 * xi + z1;
      z1 = b1 * xi - a1 * v + z2;
      z2 = b2 * xi - a2 * v;
      y[i] = v;
    }
  }

  function bandpassIIR(x, fs, lo, hi) {        // 4th-order Butterworth high-pass + low-pass
    const y = new Float64Array(x);
    const hp = biquad("hp", lo || 400, fs), lp = biquad("lp", hi || 3600, fs);
    runBiquad(y, hp); runBiquad(y, hp); runBiquad(y, lp); runBiquad(y, lp);
    return y;
  }

  // In-place radix-2 FFT (n = power of 2) with a cos/sin table, like numpy's but zero-padded.
  const twiddles = {};
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    let tw = twiddles[n];
    if (!tw) {
      tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
      for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos(2 * Math.PI * k / n); tw.s[k] = Math.sin(2 * Math.PI * k / n); }
      twiddles[n] = tw;
    }
    const sgn = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, stride = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = tw.c[k * stride], wi = sgn * tw.s[k * stride];
          const p = i + k, q = p + half;
          const br = re[q] * wr - im[q] * wi, bi = re[q] * wi + im[q] * wr;
          re[q] = re[p] - br; im[q] = im[p] - bi;
          re[p] += br; im[p] += bi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Brick-wall band-pass through the FFT, as python/fmlink.py bandpass() does.
  function bandpass(x, fs, lo, hi) {
    lo = lo || 400; hi = hi || 3600;
    let n = 1;
    while (n < x.length) n <<= 1;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < x.length; i++) re[i] = x[i];
    fft(re, im, false);
    for (let k = 0; k <= n / 2; k++) {
      const f = k * fs / n;
      if (f < lo || f > hi) {
        re[k] = 0; im[k] = 0;
        if (k > 0 && k < n / 2) { re[n - k] = 0; im[n - k] = 0; }
      }
    }
    fft(re, im, true);
    return re.subarray(0, x.length);
  }

  function percentile(arr, p, absolute) {      // on at most ~20 000 evenly spaced samples
    const stride = Math.max(1, Math.floor(arr.length / 20000));
    const s = [];
    for (let i = 0; i < arr.length; i += stride) s.push(absolute ? Math.abs(arr[i]) : arr[i]);
    if (!s.length) return 0;
    s.sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p / 100 * (s.length - 1)))];
  }

  // ---------- demodulators ----------
  // Mix tone f down to 0 Hz and average over `win` samples. out[i] covers x[i .. i+win).
  function mixAvg(x, f, win, fs) {
    const n = x.length, w = 2 * Math.PI * f / fs;
    const cr = new Float64Array(n + 1), ci = new Float64Array(n + 1);
    const cw = Math.cos(w), sw = Math.sin(w);
    let c = 1, s = 0;                          // recursive oscillator, re-synced every 4096 samples
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0) { c = Math.cos(w * i); s = Math.sin(w * i); }
      cr[i + 1] = cr[i] + x[i] * c;
      ci[i + 1] = ci[i] - x[i] * s;
      const t = c * cw - s * sw;
      s = s * cw + c * sw;
      c = t;
    }
    const m = Math.max(0, n - win + 1);
    const re = new Float64Array(m), im = new Float64Array(m);
    for (let i = 0; i < m; i++) { re[i] = (cr[i + win] - cr[i]) / win; im[i] = (ci[i + win] - ci[i]) / win; }
    return { re, im };
  }

  function mag(z) {
    const out = new Float64Array(z.re.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.hypot(z.re[i], z.im[i]);
    return out;
  }

  // Soft decision per sample, about -1..+1, positive = bit 1. Index = bit start sample.
  // `cache` (optional) keeps mixAvg results so ASK and DBPSK share the 1800 Hz mix.
  function softBits(x, scheme, win, fs, cache) {
    const mix = (f) => {
      if (!cache) return mixAvg(x, f, win, fs);
      if (!cache[f]) cache[f] = mixAvg(x, f, win, fs);
      return cache[f];
    };
    if (scheme === "FSK") {
      const a = mag(mix(C.F_MARK)), b = mag(mix(C.F_SPACE));
      const s = new Float64Array(a.length);
      for (let i = 0; i < s.length; i++) s[i] = (a[i] - b[i]) / (a[i] + b[i] + EPS);
      return s;
    }
    if (scheme === "ASK") {
      const e = mag(mix(C.F_CARRIER));
      const thr = 0.5 * percentile(e, 90, false) + EPS;
      const s = new Float64Array(e.length);
      for (let i = 0; i < s.length; i++) s[i] = Math.max(-1, Math.min(1, (e[i] - thr) / thr));
      return s;
    }
    const z = mix(C.F_CARRIER);                  // DBPSK: compare each bit with the one before
    const m = z.re.length;
    const s = new Float64Array(m);
    for (let i = 0; i + win < m; i++) {
      const ar = z.re[i + win], ai = z.im[i + win], br = z.re[i], bi = -z.im[i];
      const dr = ar * br - ai * bi, di = ar * bi + ai * br;
      s[i + win] = dr / (Math.hypot(dr, di) + EPS);
    }
    return s;
  }

  // ---------- framing ----------
  function at(soft, t) {
    const i = Math.round(t);
    return soft[i < 0 ? 0 : i >= soft.length ? soft.length - 1 : i];
  }

  function findFrames(soft, per) {             // preamble+sync at every timing offset
    const L = PAT.length, step = Math.max(1, Math.floor(per / 16));
    const cands = [];
    for (let off = 0; off < per; off += step) {
      const nb = Math.floor((soft.length - 1 - off) / per) + 1;
      if (nb < L + 24) continue;
      const s = new Float64Array(nb), sg = new Int8Array(nb);
      for (let k = 0; k < nb; k++) { s[k] = at(soft, off + k * per); sg[k] = s[k] > 0 ? 1 : -1; }
      for (let j = 0; j + L <= nb; j++) {
        let corr = 0;
        for (let q = 0; q < L; q++) corr += sg[j + q] * PAT[q];
        if (corr >= L - 2) {                     // at most 1 wrong bit in 24
          let margin = 0;
          for (let q = 0; q < L; q++) margin += Math.abs(s[j + q]);
          cands.push({ pos: Math.round(off + j * per), margin });
        }
      }
    }
    cands.sort((a, b) => a.pos - b.pos);
    const frames = [];
    let group = [];
    const flush = () => { if (group.length) frames.push(group.reduce((m, g) => (g.margin > m.margin ? g : m))); group = []; };
    for (const c of cands) {
      if (group.length && c.pos - group[group.length - 1].pos > 4 * per) flush();
      group.push(c);
    }
    flush();
    return frames;
  }

  // Best (first-bit sample, bit period) for the bits after `start`: tries 41 clock errors (+-1 %)
  // and 5 small shifts and keeps the one with the clearest decisions (largest mean |soft|).
  function bitTiming(soft, start, per0) {
    const sh = Math.max(1, Math.floor(per0 / 16));
    const shifts = [-2 * sh, -sh, 0, sh, 2 * sh];
    const maxPer = per0 * (1 + CLOCK_SEARCH[CLOCK_SEARCH.length - 1]);
    const n = Math.floor(Math.min(600, (soft.length - 1 - start - shifts[4]) / maxPer));
    if (n < SYNC_PATTERN.length + 16) return { t0: start, per: per0 };
    let best = -1, bt = start, bp = per0;
    for (const e of CLOCK_SEARCH) {
      const p = per0 * (1 + e);
      for (const d of shifts) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += Math.abs(at(soft, start + d + k * p));
        if (acc / n > best) { best = acc / n; bt = start + d; bp = p; }
      }
    }
    return { t0: bt, per: bp };
  }

  function hamming8(a, b) {
    let v = (a ^ b) & 0xFF, c = 0;
    while (v) { c += v & 1; v >>= 1; }
    return c;
  }

  function parseFrame(soft, per0, cand) {
    const { t0, per } = bitTiming(soft, cand.pos, per0);
    const k = SYNC_PATTERN.length;
    const want = k + 16 + 255 * 8 + 8;
    const s = [];
    for (let i = 0; i < want; i++) {
      const idx = Math.round(t0 + i * per);
      if (idx >= 0 && idx < soft.length) s.push(soft[idx]);
    }
    const bits = s.map((v) => (v > 0 ? 1 : 0));
    const clockPpm = Math.round((per0 / per - 1) * 1e6);     // + = transmitter clock runs fast
    if (k + 16 > bits.length) return null;
    let [typ, ln] = C.bitsToBytes(bits.slice(k, k + 16));
    if (hamming8(typ, C.TYPE_PRBS) <= 3) { typ = C.TYPE_PRBS; ln = C.PRBS_BYTES; }
    else if (hamming8(typ, C.TYPE_TEXT) <= 3) { typ = C.TYPE_TEXT; }
    else return { pos: cand.pos, type: "?", ok: false };
    const end = k + 16 + ln * 8 + 8;
    if (end > bits.length) return null;                     // cut off by the end of the audio
    const payloadBits = bits.slice(k + 16, k + 16 + ln * 8);
    const payload = C.bitsToBytes(payloadBits);
    const crcRx = C.bitsToBytes(bits.slice(end - 8, end))[0];
    const crcOk = C.crc8([typ, ln].concat(payload)) === crcRx;
    let q = 0;
    for (let i = k; i < end; i++) q += Math.abs(s[i]);
    q /= end - k;
    const base = { pos: cand.pos, crcOk, quality: q, clockPpm, ok: true, len: ln, nbits: end, per };
    if (typ === C.TYPE_PRBS) {
      let errs = 0;
      for (let i = 0; i < 511; i++) if (payloadBits[i] !== C.PRBS[i]) errs++;
      return Object.assign(base, { type: "PRBS", bits: 511, errors: errs });
    }
    return Object.assign(base, { type: "TEXT", text: String.fromCharCode.apply(null, payload) });
  }

  /* decode(x, fs, baud, scheme) -> { scheme, frames, soft, all }
     scheme "auto" tries ASK, FSK and DBPSK and keeps the one with the most good frames. */
  function decode(x, fs, baud, scheme, opts) {
    scheme = scheme || "auto";
    opts = opts || {};
    const per0 = fs / baud;
    const win = Math.max(2, Math.round(per0));
    const y = opts.iir ? bandpassIIR(x, fs) : bandpass(x, fs);
    const peak = percentile(y, 99.5, true);
    if (peak > 0) for (let i = 0; i < y.length; i++) y[i] /= peak;
    const all = {}, cache = {};
    let best = null;
    for (const sch of scheme === "auto" ? C.SCHEMES : [scheme]) {
      const soft = softBits(y, sch, win, fs, cache);
      const cands = findFrames(soft, per0).filter((c) => !(opts.skip && opts.skip(c.pos)));
      const frames = cands.map((c) => parseFrame(soft, per0, c)).filter((f) => f && f.ok);
      const good = frames.filter((f) => f.crcOk || (f.type === "PRBS" && f.errors < 100)).length;
      const errs = frames.reduce((a, f) => a + (f.errors || 0), 0);
      all[sch] = { good, errs, frames, soft };
      if (!best || good > all[best].good || (good === all[best].good && errs < all[best].errs)) best = sch;
    }
    // An ASK detector can also "decode" DBPSK (the envelope dips at every phase flip), but a DBPSK
    // detector cannot decode real ASK. So if DBPSK decodes at least as many good frames, it is DBPSK.
    if (scheme === "auto" && best === "ASK" && all.DBPSK && all.DBPSK.good >= Math.max(1, all.ASK.good)) best = "DBPSK";
    return { scheme: best, frames: all[best].frames, soft: all[best].soft, all };
  }

  /* Streaming wrapper: keeps the last `seconds` of audio, decodes the whole window on run(),
     and reports each frame once (frames are matched by their absolute sample position). */
  class LiveDecoder {
    constructor(fs, seconds) {
      this.fs = fs;
      this.cap = Math.round(fs * (seconds || 6));
      this.buf = new Float32Array(this.cap);
      this.len = 0;
      this.total = 0;
      this.seen = [];
    }
    push(chunk) {
      if (chunk.length >= this.cap) {
        this.buf.set(chunk.subarray(chunk.length - this.cap));
        this.len = this.cap;
      } else {
        const room = this.cap - this.len;
        if (chunk.length > room) {
          const drop = chunk.length - room;
          this.buf.copyWithin(0, drop, this.len);
          this.len -= drop;
        }
        this.buf.set(chunk, this.len);
        this.len += chunk.length;
      }
      this.total += chunk.length;
    }
    level() {                                  // RMS of the last 0.25 s
      const n = Math.min(this.len, Math.round(this.fs / 4));
      let p = 0;
      for (let i = this.len - n; i < this.len; i++) p += this.buf[i] * this.buf[i];
      return n ? Math.sqrt(p / n) : 0;
    }
    // final = true on the last call (audio ended): also report frames close to the end.
    run(baud, scheme, final) {
      if (this.len < this.fs) return { scheme: null, fresh: [], soft: null };
      const startAbs = this.total - this.len;
      const per = this.fs / baud;
      // bitTiming() fits the clock over up to 600 bits after the frame start, so a frame decoded with
      // less audio behind it can come out with a wrong bit. Report a frame only once ~600 bits of
      // audio follow it (capped by the window), like a decode of the whole recording would.
      const margin = final ? 0 : Math.min(Math.round(610 * per + 0.1 * this.fs), Math.round(0.45 * this.cap));
      // frames already reported are not parsed again (saves most of the work)
      const skip = (pos) => this.seen.some((a) => Math.abs(a - (startAbs + pos)) < 4 * per);
      const res = decode(this.buf.subarray(0, this.len), this.fs, baud, scheme, { skip });
      // remember the scheme of the last frames found, so the soft trace shown stays on it
      if (res.frames.length) this.lastScheme = res.scheme;
      const shown = scheme === "auto" && this.lastScheme && res.all[this.lastScheme] ? this.lastScheme : res.scheme;
      const fresh = [];
      for (const f of res.frames) {
        const abs = startAbs + f.pos;
        if (f.pos > this.len - margin) continue;
        if (this.seen.some((a) => Math.abs(a - abs) < 4 * per)) continue;
        this.seen.push(abs);
        fresh.push(Object.assign({}, f, { abs, t: abs / this.fs, scheme: res.scheme }));
      }
      this.seen = this.seen.filter((a) => a > startAbs - this.fs);
      return { scheme: shown, fresh, soft: res.all[shown].soft, per, startAbs };
    }
  }

  root.FMDecoder = { decode, softBits, findFrames, bitTiming, parseFrame, bandpass, bandpassIIR, fft, mixAvg, LiveDecoder, SYNC_PATTERN, CLOCK_SEARCH };
})(typeof window !== "undefined" ? window : globalThis);
