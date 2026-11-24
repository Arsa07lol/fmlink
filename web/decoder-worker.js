/* decoder-worker.js - runs the live decoder off the page's main thread.
   Messages in:  {type:"init", fs, seconds} | {type:"push", chunk:Float32Array} | {type:"run", baud, scheme, final}
   Messages out: {type:"result", scheme, fresh:[frames], soft:Float32Array (last 2 s), per, level, ms} */
importScripts("fmcore.js", "decoder.js");

let ld = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    ld = new self.FMDecoder.LiveDecoder(m.fs, m.seconds || 6);
  } else if (m.type === "push" && ld) {
    ld.push(m.chunk);
  } else if (m.type === "run" && ld) {
    const t = performance.now();
    const r = ld.run(m.baud, m.scheme, !!m.final);
    let tail = null;
    if (r.soft) {
      const n = Math.min(r.soft.length, Math.round(ld.fs * 2));
      tail = Float32Array.from(r.soft.subarray(r.soft.length - n));
    }
    const fresh = r.fresh.map((f) => ({
      type: f.type, text: f.text || "", crcOk: f.crcOk, errors: f.errors, bits: f.bits,
      quality: f.quality, clockPpm: f.clockPpm, t: f.t, scheme: f.scheme, len: f.len,
    }));
    self.postMessage({ type: "result", scheme: r.scheme, fresh, soft: tail, per: r.per, level: ld.level(), ms: Math.round(performance.now() - t) },
      tail ? [tail.buffer] : []);
  }
};
