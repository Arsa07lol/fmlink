/* app.js - the interactive parts of the FM Multi-Mod Link page.
   Uses FMCore (frame + Uno DDS modulator) and FMDecoder (port of python/fmlink.py). */
(function () {
  "use strict";
  const C = window.FMCore, D = window.FMDecoder;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduceMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const root = getComputedStyle(document.documentElement);
  const cssv = (n) => root.getPropertyValue(n).trim();
  const COL = {};
  for (const k of ["text", "muted", "faint", "line", "line-2", "panel", "panel-2", "ink", "cyan", "amber", "violet", "ok", "bad"]) COL[k] = cssv("--" + k);
  COL.ASK = COL.amber; COL.FSK = COL.cyan; COL.DBPSK = COL.violet;
  const MONO = cssv("--f-mono") || "monospace";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, "0");

  function canvas(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, cv.clientWidth), h = Math.max(10, cv.clientHeight);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h, dpr };
  }

  function seg(el, key, onChange) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !el.contains(b)) return;
      $$("button", el).forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      onChange(b.dataset[key]);
    });
  }

  function hexToRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return [200, 200, 200];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const rgba = (h, a) => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; };

  // ---------------------------------------------------------------- audio playback
  let actx = null;
  async function getCtx() {
    if (!actx) {
      try { actx = new AudioContext({ sampleRate: 48000 }); } catch (e) { actx = new AudioContext(); }
    }
    if (actx.state === "suspended") await actx.resume();
    return actx;
  }
  function unoBuffer(ctx, samples) {
    const b = ctx.createBuffer(1, samples.length, C.FS_UNO);
    b.copyToChannel(samples, 0);
    return b;
  }
  function concat(parts) {
    const n = parts.reduce((a, p) => a + p.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const silence = (sec, fs) => new Float32Array(Math.round(sec * (fs || C.FS_UNO)));

  // ---------------------------------------------------------------- hero oscilloscope
  const hero = { scheme: "FSK", frame: C.buildFrame("TEXT", "halo PDSK"), samples: {}, pos: 24 * C.FS_UNO / 300, last: 0, visible: true };
  for (const s of C.SCHEMES) hero.samples[s] = C.modulateUno(hero.frame.bits, s, 300, 1);
  const SPB300 = C.FS_UNO / 300;

  function fieldOf(fr, bit) {
    const byte = Math.floor(bit / 8);
    const f = fr.fields.find((x) => byte >= x.start && byte < x.start + x.len);
    return f ? f.name : "";
  }

  function drawHero() {
    const { ctx, w, h } = canvas($("#heroScope"));
    ctx.clearRect(0, 0, w, h);
    const x = hero.samples[hero.scheme], n = x.length, bits = hero.frame.bits, nb = bits.length;
    const visBits = w < 460 ? 5 : 7, span = visBits * SPB300;
    const start = hero.pos, mid = h * 0.58, amp = h * 0.3;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    ctx.font = `500 12px ${MONO}`;
    ctx.textAlign = "center";
    const first = Math.floor(start / SPB300);
    for (let b = first; b <= first + visBits + 1; b++) {
      const bx = ((b * SPB300 - start) / span) * w, cw = (SPB300 / span) * w;
      ctx.strokeStyle = COL.line;
      ctx.beginPath(); ctx.moveTo(bx, 26); ctx.lineTo(bx, h - 10); ctx.stroke();
      const v = bits[((b % nb) + nb) % nb];
      ctx.fillStyle = v ? COL[hero.scheme] : COL.faint;
      ctx.fillText(String(v), bx + cw / 2, 18);
      if (hero.scheme === "DBPSK" && v === 0) {
        ctx.fillStyle = rgba(COL.violet, 0.9);
        ctx.beginPath(); ctx.moveTo(bx - 5, h - 8); ctx.lineTo(bx + 5, h - 8); ctx.lineTo(bx, h - 16); ctx.closePath(); ctx.fill();
      }
    }
    ctx.strokeStyle = COL[hero.scheme]; ctx.lineWidth = 2; ctx.beginPath();
    const steps = Math.min(Math.ceil(w * 1.5), Math.ceil(span));
    for (let i = 0; i <= steps; i++) {
      const t = start + (i * span) / steps;
      const k = ((Math.floor(t) % n) + n) % n;
      const px = (i / steps) * w, py = mid - x[k] * amp;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
    const cur = ((Math.floor((start + span / 2) / SPB300) % nb) + nb) % nb;
    $("#heroFoot").textContent = `bit ${cur} of ${nb} · ${fieldOf(hero.frame, cur)} · ${hero.scheme} 300 baud, slowed down`;
  }

  function heroLoop(t) {
    if (hero.visible) {
      const dt = hero.last ? Math.min(0.1, (t - hero.last) / 1000) : 0;
      hero.pos = (hero.pos + dt * SPB300 * 1.6) % (hero.samples.FSK.length);
      drawHero();
    }
    hero.last = t;
    requestAnimationFrame(heroLoop);
  }
  seg($("#heroSeg"), "s", (s) => { hero.scheme = s; drawHero(); });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => { hero.visible = es[0].isIntersecting; }).observe($("#heroScope"));
  }
  drawHero();
  if (!reduceMotion) requestAnimationFrame(heroLoop);

  // ---------------------------------------------------------------- signal chain
  const STAGES = [
    { t: "Data", s: "text or PRBS-9",
      p: ["A message is typed in the Transmitter panel or the Serial Monitor (for example <b>M halo PDSK</b>), or the <b>PRBS-9</b> pattern is chosen to measure the BER. The firmware wraps it in a frame: preamble, sync, type, len, payload, CRC-8 and idle.",
        "The same frame repeats non-stop, so the receiver can start listening at any moment."],
      f: [["Text length", "up to 100 bytes"], ["Largest frame", "113 bytes"], ["CRC", "CRC-8, poly 0x07"], ["PRBS", "x⁹ + x⁵ + 1, 511 bits"]],
      code: "fmlink_uno_core.h · buildFrame()" },
    { t: "DDS modulator", s: "31 250 samples/s",
      p: ["Timer1 fires an interrupt every 32 µs. A 32-bit phase accumulator adds the <b>phase step</b> of the current tone (1200, 2200 or 1800 Hz), and its top 8 bits index a sine table.",
        "Bit changes use a fractional accumulator, so 300 baud stays exact even though 31 250 / 300 = 104.17 samples per bit."],
      f: [["Sample rate", "31 250 Hz = 16 MHz / 512"], ["Phase step", "f · 2³² / 31 250"], ["Sine table", "256 × 8 bit, 128 ± 100"]],
      code: "fmlink_uno_core.h · Modulator.next()" },
    { t: "PWM on D3", s: "62.5 kHz, 8 bit",
      p: ["The Uno has no DAC. Timer2 makes a 62.5 kHz PWM on pin D3, and its duty cycle is loaded with the sample value 0–255.",
        "The Timer1 interrupt is locked to the PWM: exactly 2 PWM periods per sample. The first plan used 32 kHz, which was not in step with the PWM and caused 16 µs of jitter."],
      f: [["PWM frequency", "62.5 kHz"], ["Resolution", "8 bit"], ["Synchronisation", "2 PWM periods per sample"]],
      code: "fmlink_uno.ino · startAudio()" },
    { t: "RC filter", s: "2 stages, −3 dB ≈ 5 kHz",
      p: ["Two R–C stages smooth the PWM pulses into an audio wave. The 1200 / 1800 / 2200 Hz data tones lose only 0.23 / 0.51 / 0.75 dB, while the 62.5 kHz PWM leftover drops about 29 dB.",
        "A 10 µF capacitor blocks the 2.5 V DC level, so only the audio reaches the trimmer."],
      f: [["R1 = R2", "1.5 kΩ"], ["C1 = C2", "10 nF"], ["−3 dB", "≈ 5.0 kHz"], ["Capacitor", "10 µF"]],
      code: "Section 03 on this page" },
    { t: "Trimmer", s: "audio level = deviation",
      p: ["A 10 kΩ trimmer divides the audio voltage before the transmitter. The audio voltage sets how far the FM carrier frequency moves (the deviation).",
        "Too much distorts the sound, too little buries the signal in hiss. The wiper goes to TIP and RING1 of the jack, RING2 and SLEEVE go to GND."],
      f: [["Value", "10 kΩ"], ["Wiper", "→ TIP + RING1"], ["GND", "RING2 + SLEEVE"]],
      code: "3.5 mm TRRS jack on the breadboard" },
    { t: "FM transmitter", s: "S-151 kit, ≈ 104 MHz",
      p: ["Audio goes in through a 3.5 mm plug. A C828 transistor oscillator makes the carrier in the FM band, and a C930 amplifier drives the antenna.",
        "Its frequency moves with the battery voltage and with hands nearby. On 24 Nov it measured 104.2 MHz, and 102.4 MHz about 30 minutes later."],
      f: [["Supply", "9 V battery"], ["Measured", "104.2 → 102.4 MHz"], ["Drift", "≈ 0.93 MHz/V"]],
      code: "Section 04 on this page" },
    { t: "Air", s: "FM channel",
      p: ["In the air the signal weakens with distance and picks up noise. The bandwidth it takes follows Carson's rule.",
        "A transmitter too close also disturbs digital circuits: at 10–30 cm, I2C reads from the RDA5807M came back corrupted. So the transmitter sits about 1 m from the Uno."],
      f: [["Band", "88–108 MHz"], ["Bandwidth", "2 (Δf + fm)"], ["Safe distance to the Uno", "≥ 1 m"]],
      code: "Section 05 on this page" },
    { t: "Receiver", s: "RDA5807M · phone radio",
      p: ["The receiver turns the FM signal back into audio: FM demodulation, then 50 µs de-emphasis. The Uno controls the RDA5807M over I2C and reads its RSSI.",
        "The first RDA module had a dead RF section; the replacement picks up the transmitter at RSSI 107. Until its audio is wired to the laptop, a phone FM radio feeds the decoder."],
      f: [["I2C address", "0x10, 0x11"], ["RSSI", "0–127"], ["De-emphasis", "50 µs"]],
      code: "fmlink_uno.ino · radioInit(), rdaTune()" },
    { t: "Decoder", s: "Python & browser",
      p: ["Audio is recorded at 48 kHz. The decoder filters 400–3600 Hz, makes a soft decision per sample, looks for preamble + sync at 16 time offsets, tries 41 clock errors (±1 %), then reads the payload and checks the CRC-8.",
        "The same decoder runs on this page (section 07), straight from the laptop microphone."],
      f: [["Recording rate", "48 kHz"], ["Clock tracking", "±1 %, 41 steps"], ["Sync tolerance", "1 wrong bit in 24"]],
      code: "python/fmlink.py · decode() · web/decoder.js" },
  ];

  function renderChain(i) {
    $$("#chain button").forEach((b, k) => b.setAttribute("aria-pressed", k === i ? "true" : "false"));
    const st = STAGES[i];
    $("#chainDetail").innerHTML =
      `<div class="panel what"><p class="eyebrow">Stage ${i + 1} of ${STAGES.length}</p><h3>${esc(st.t)}</h3>${st.p.map((p) => `<p>${p}</p>`).join("")}` +
      `<p class="code-ref">${esc(st.code)}</p></div>` +
      `<div class="panel"><h3>Key numbers</h3><dl class="kv">${st.f.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>`;
  }
  $("#chain").innerHTML = STAGES.map((st, i) =>
    `<li><button type="button" aria-pressed="false"><span class="n">${String(i + 1).padStart(2, "0")}</span><span class="t">${esc(st.t)}</span><span class="s">${esc(st.s)}</span></button></li>`).join("");
  $$("#chain button").forEach((b, i) => b.addEventListener("click", () => renderChain(i)));
  renderChain(0);

  // ---------------------------------------------------------------- frame builder
  const fb = { kind: "TEXT" };
  function renderFrame() {
    const text = $("#frameText").value;
    const baud = +$("#frameBaud").value;
    const fr = C.buildFrame(fb.kind, text);
    const parts = [];
    for (const f of fr.fields) {
      for (let i = 0; i < f.len; i++) {
        const v = fr.bytes[f.start + i];
        const ch = f.name === "payload" && fb.kind === "TEXT" ? String.fromCharCode(v) : "";
        const cls = f.name === "len" ? "f-len" : "f-" + f.name;
        parts.push(`<span class="byte ${cls}" title="${f.name}, byte ${f.start + i}">${hex2(v)}${ch ? `<small>${esc(ch === " " ? "␠" : ch)}</small>` : ""}</span>`);
      }
    }
    $("#frameBytes").innerHTML = parts.join("");
    const nbits = fr.bits.length;
    const crc = fr.bytes[fr.fields.find((f) => f.name === "crc").start];
    const stats = [
      ["Total bytes", fr.bytes.length], ["Total bits", nbits],
      ["Duration @ " + baud + " baud", (nbits / baud * 1000).toFixed(0) + " ms"],
      ["Payload (len)", fr.payload.length + " bytes"], ["CRC-8", "0x" + hex2(crc)],
    ];
    $("#frameStats").innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");
    $("#frameBitCount").textContent = nbits + " bits";
    drawFrameBits(fr);
  }
  function drawFrameBits(fr) {
    const cv = $("#frameBits");
    const n = fr.bits.length;
    const wAvail = Math.max(10, cv.clientWidth);
    const cell = n > 400 ? 7 : 10;
    const cols = Math.max(8, Math.floor((wAvail - 8) / cell));
    const rows = Math.ceil(n / cols);
    cv.style.height = rows * cell + 10 + "px";
    const { ctx, w, h } = canvas(cv);
    ctx.clearRect(0, 0, w, h);
    const colors = { preamble: COL.faint, sync: COL.violet, type: COL.amber, len: COL.amber, payload: COL.cyan, crc: COL.ok, idle: COL["line-2"] };
    for (let i = 0; i < n; i++) {
      const c = colors[fieldOf(fr, i)] || COL.muted;
      const x = 5 + (i % cols) * cell, y = 5 + Math.floor(i / cols) * cell;
      if (fr.bits[i]) { ctx.fillStyle = c; ctx.fillRect(x, y, cell - 2, cell - 2); }
      else { ctx.strokeStyle = rgba(c, 0.85); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cell - 3, cell - 3); }
    }
  }
  $("#frameText").addEventListener("input", renderFrame);
  $("#frameBaud").addEventListener("change", renderFrame);
  seg($("#frameKind"), "k", (k) => { fb.kind = k; $("#frameText").disabled = k === "PRBS"; renderFrame(); });
  renderFrame();

  // ---------------------------------------------------------------- modulation playground
  const mod = { scheme: "FSK", player: null };
  const MOD_NOTES = {
    ASK: "ASK: bit 1 = 1800 Hz tone, bit 0 = silence (PWM duty 128). It looks a lot like Morse code.",
    FSK: "FSK: bit 1 = 1200 Hz (wide cycles), bit 0 = 2200 Hz (tight cycles). The phase stays continuous across bit changes, so there are no jumps.",
    DBPSK: "DBPSK: a steady 1800 Hz tone. The purple triangles mark the 0 bits, where the phase flips by 180°. A 1 bit leaves the phase alone.",
  };
  function drawMod() {
    const sch = mod.scheme, baud = +$("#modBaud").value, i0 = +$("#modWin").value;
    const fr = C.buildFrame("TEXT", "halo PDSK");
    const x = C.modulateUno(fr.bits, sch, baud, 1);
    const spb = C.FS_UNO / baud, nb = 12;
    const a = Math.ceil(i0 * spb), b = Math.min(x.length, Math.ceil((i0 + nb) * spb));
    const { ctx, w, h } = canvas($("#modScope"));
    ctx.clearRect(0, 0, w, h);
    const top = 34, mid = top + (h - top - 14) / 2, amp = (h - top - 20) / 2;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    ctx.font = `500 11px ${MONO}`; ctx.textAlign = "center";
    for (let k = 0; k <= nb; k++) {
      const bx = (Math.ceil((i0 + k) * spb) - a) / (b - a) * w;
      ctx.strokeStyle = COL.line; ctx.beginPath(); ctx.moveTo(bx, top - 8); ctx.lineTo(bx, h - 6); ctx.stroke();
      if (k < nb) {
        const v = fr.bits[i0 + k], cx = bx + w / nb / 2;
        ctx.fillStyle = v ? COL[sch] : COL.faint;
        ctx.fillText(String(v), cx, 14);
        ctx.fillStyle = COL.faint;
        ctx.fillText(fieldOf(fr, i0 + k).slice(0, 3), cx, 27);
        if (sch === "DBPSK" && v === 0) {
          ctx.fillStyle = COL.violet;
          ctx.beginPath(); ctx.moveTo(bx - 5, h - 4); ctx.lineTo(bx + 5, h - 4); ctx.lineTo(bx, h - 12); ctx.closePath(); ctx.fill();
        }
      }
    }
    ctx.strokeStyle = COL[sch]; ctx.lineWidth = 1.6; ctx.beginPath();
    const len = b - a;
    if (len > w * 1.5) {                      // min/max per pixel column
      for (let px = 0; px < w; px++) {
        const s0 = a + Math.floor(px / w * len), s1 = a + Math.floor((px + 1) / w * len);
        let lo = 1, hi = -1;
        for (let s = s0; s <= s1 && s < b; s++) { lo = Math.min(lo, x[s]); hi = Math.max(hi, x[s]); }
        ctx.moveTo(px + 0.5, mid - hi * amp); ctx.lineTo(px + 0.5, mid - lo * amp);
      }
    } else {
      for (let s = a; s < b; s++) {
        const px = (s - a) / len * w, py = mid - x[s] * amp;
        if (s === a) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    $("#modNote").textContent = MOD_NOTES[sch] + ` Showing bits ${i0}–${i0 + nb - 1} of the "halo PDSK" frame at ${baud} baud (${(nb / baud * 1000).toFixed(0)} ms).`;
  }
  async function playMod() {
    stopMod();
    const ctx = await getCtx();
    const fr = C.buildFrame("TEXT", "halo PDSK");
    const x = concat([silence(0.15), C.modulateUno(fr.bits, mod.scheme, +$("#modBaud").value, 3), silence(0.1)]);
    const src = ctx.createBufferSource(); src.buffer = unoBuffer(ctx, x);
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(g); g.connect(ctx.destination);
    src.onended = () => { if (mod.player === src) { mod.player = null; $("#modStop").disabled = true; } };
    src.start();
    mod.player = src; $("#modStop").disabled = false;
  }
  function stopMod() { if (mod.player) { try { mod.player.stop(); } catch (e) { /* already stopped */ } mod.player = null; } $("#modStop").disabled = true; }
  seg($("#modSeg"), "s", (s) => { mod.scheme = s; drawMod(); });
  $("#modBaud").addEventListener("change", drawMod);
  $("#modWin").addEventListener("change", drawMod);
  $("#modPlay").addEventListener("click", playMod);
  $("#modStop").addEventListener("click", stopMod);
  drawMod();

  // ---------------------------------------------------------------- DDS, PWM and the RC filter
  const R1 = 1500, C1 = 10e-9, R2 = 1500, C2 = 10e-9, RL = 10e3, C3 = 10e-6;
  function unoFilterDb(f) {                  // same formula as python/fmlink.py uno_filter_db()
    const k = R2 / RL, m = R1 / R2;
    const a2 = R1 * C1 * R2 * C2, a1 = (1 + k) * R1 * C1 + (1 + m) * R2 * C2, a0 = 1 + k * (1 + m);
    const wv = 2 * Math.PI * f, re = a0 - a2 * wv * wv, im = a1 * wv;
    return 20 * Math.log10(a0 / Math.hypot(re, im));
  }
  const deemphDb = (f) => -10 * Math.log10(1 + Math.pow(2 * Math.PI * f * 50e-6, 2));

  function drawDDS() {
    const f = +$("#ddsF").value;
    $("#ddsFv").textContent = f + " Hz";
    const step = C.phaseStep(f), real = step * C.FS_UNO / 4294967296;
    $("#ddsKv").innerHTML = [
      ["Phase step", step.toLocaleString("en-US") + " (0x" + step.toString(16).toUpperCase() + ")"],
      ["Actual frequency", real.toFixed(3) + " Hz"],
      ["Samples per period", (C.FS_UNO / real).toFixed(1)],
      ["Phase advance per sample", (step / 4294967296 * 360).toFixed(2) + "°"],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    const N = 40, duty = [];
    let ph = 0;
    for (let i = 0; i < N; i++) { ph = (ph + step) >>> 0; duty.push(C.SINE[ph >>> 24]); }
    // circuit simulation: PWM (0/5 V) -> R1/C1 -> R2/C2 -> C3 -> RL, started in DC steady state
    const Ts = 1 / C.FS_UNO, Tp = Ts / 2, dt = 5e-8, steps = Math.round(N * Ts / dt);
    let v1 = 2.5, v2 = 2.5, vc3 = 2.5;
    const out = new Float32Array(steps);
    const warm = Math.round(10 * Ts / dt);
    for (let s = -warm; s < steps; s++) {
      const t = ((s % steps) + steps) % steps * dt;
      const si = Math.min(N - 1, Math.floor(t / Ts));
      const vin = (t % Tp) < (duty[si] / 256) * Tp ? 5 : 0;
      const v3 = v2 - vc3, iL = v3 / RL;
      const d1 = ((vin - v1) / R1 - (v1 - v2) / R2) / C1;
      const d2 = ((v1 - v2) / R2 - iL) / C2;
      v1 += d1 * dt; v2 += d2 * dt; vc3 += (iL / C3) * dt;
      if (s >= 0) out[s] = v2 - vc3;
    }
    const { ctx, w, h } = canvas($("#ddsPlot"));
    ctx.clearRect(0, 0, w, h);
    const lane = (h - 24) / 3;
    ctx.font = `11px ${MONO}`; ctx.textAlign = "left"; ctx.fillStyle = COL.faint;
    const labels = ["DDS samples (duty 0–255)", "62.5 kHz PWM on D3", "after the RC filter and the DC-blocking capacitor"];
    labels.forEach((l, i) => ctx.fillText(l, 6, 12 + i * (lane + 8)));
    // lane 1: stems
    const y1 = (v) => 16 + lane - 6 - (v / 255) * (lane - 14);
    ctx.strokeStyle = COL.cyan; ctx.fillStyle = COL.cyan; ctx.lineWidth = 1.2;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * w;
      ctx.beginPath(); ctx.moveTo(x, y1(128)); ctx.lineTo(x, y1(duty[i])); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y1(duty[i]), 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = COL.line; ctx.beginPath(); ctx.moveTo(0, y1(128)); ctx.lineTo(w, y1(128)); ctx.stroke();
    // lane 2: PWM pulses
    const yb = 16 + 2 * lane + 2, yt = 16 + lane + 18;
    ctx.fillStyle = rgba(COL.amber, 0.85);
    for (let i = 0; i < N; i++) for (let p = 0; p < 2; p++) {
      const x0 = (i * 2 + p) / (2 * N) * w, wd = (duty[i] / 256) * w / (2 * N);
      ctx.fillRect(x0, yt, Math.max(0.6, wd), yb - yt);
    }
    // lane 3: filtered audio
    let mx = 1e-9;
    for (let s = 0; s < steps; s++) mx = Math.max(mx, Math.abs(out[s]));
    const ym = 16 + 2.5 * lane + 12, ya = lane / 2 - 10;
    ctx.strokeStyle = COL.line; ctx.beginPath(); ctx.moveTo(0, ym); ctx.lineTo(w, ym); ctx.stroke();
    ctx.strokeStyle = COL.ok; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const s = Math.min(steps - 1, Math.floor(px / w * steps));
      const py = ym - out[s] / mx * ya;
      if (px) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
  }
  $("#ddsF").addEventListener("input", drawDDS);
  drawDDS();

  function drawFilter() {
    const { ctx, w, h } = canvas($("#filterPlot"));
    ctx.clearRect(0, 0, w, h);
    const fmin = 100, fmax = 100000, dbTop = 3, dbBot = -45, padL = 36, padB = 20, padT = 8;
    const X = (f) => padL + (Math.log10(f / fmin) / Math.log10(fmax / fmin)) * (w - padL - 8);
    const Y = (d) => padT + (dbTop - d) / (dbTop - dbBot) * (h - padT - padB);
    ctx.font = `10.5px ${MONO}`; ctx.fillStyle = COL.faint; ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.textAlign = "right";
    for (const d of [0, -10, -20, -30, -40]) {
      ctx.beginPath(); ctx.moveTo(padL, Y(d)); ctx.lineTo(w - 8, Y(d)); ctx.stroke();
      ctx.fillText(d + " dB", padL - 4, Y(d) + 3);
    }
    ctx.textAlign = "center";
    for (const [f, l] of [[100, "100"], [1000, "1k"], [10000, "10k"], [100000, "100k Hz"]]) {
      ctx.beginPath(); ctx.moveTo(X(f), padT); ctx.lineTo(X(f), h - padB); ctx.stroke();
      ctx.fillText(l, Math.min(w - 26, X(f)), h - 6);
    }
    const curve = (fn, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.beginPath();
      for (let i = 0; i <= 300; i++) {
        const f = fmin * Math.pow(fmax / fmin, i / 300), y = Y(Math.max(dbBot, fn(f)));
        if (i) ctx.lineTo(X(f), y); else ctx.moveTo(X(f), y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    curve((f) => deemphDb(f), COL.faint, 1.2, [4, 4]);
    curve((f) => unoFilterDb(f), COL.ok, 2);
    curve((f) => unoFilterDb(f) + deemphDb(f), COL.text, 1.4);
    for (const [f, c] of [[1200, COL.cyan], [1800, COL.violet], [2200, COL.cyan], [62500, COL.amber]]) {
      ctx.strokeStyle = rgba(c, 0.8); ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(f), padT); ctx.lineTo(X(f), h - padB); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.textAlign = "left"; ctx.font = `10.5px ${MONO}`;
    const legend = [[COL.ok, "Uno filter"], [COL.text, "+ de-emphasis"], [COL.faint, "de-emphasis only"]];
    legend.forEach(([c, l], i) => { ctx.fillStyle = c; ctx.fillRect(padL + 8, Y(-40) - 26 + i * 13 - 32, 10, 3); ctx.fillStyle = COL.muted; ctx.fillText(l, padL + 22, Y(-40) - 22 + i * 13 - 32); });
    $("#filterTbl tbody").innerHTML = [1200, 1800, 2200, 5000, 62500].map((f) =>
      `<tr><td class="mono">${f.toLocaleString("en-US")} Hz${f === 62500 ? " (PWM)" : ""}</td><td class="num">${unoFilterDb(f).toFixed(2)} dB</td><td class="num">${f === 62500 ? "–" : (unoFilterDb(f) + deemphDb(f)).toFixed(2) + " dB"}</td></tr>`).join("");
  }
  drawFilter();

  // ---------------------------------------------------------------- FM
  const fm = { tone: 1200 };
  function drawFM() {
    const dev = +$("#fmDev").value;
    $("#fmDevV").textContent = dev + " kHz";
    const fmk = fm.tone / 1000;
    $("#fmKv").innerHTML = [
      ["Audio tone fm", fm.tone + " Hz"],
      ["Deviation Δf", dev + " kHz"],
      ["Modulation index β = Δf / fm", (dev / fmk).toFixed(1)],
      ["Carson bandwidth 2(Δf + fm)", (2 * (dev + fmk)).toFixed(1) + " kHz"],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    const { ctx, w, h } = canvas($("#fmPlot"));
    ctx.clearRect(0, 0, w, h);
    const cycles = 2, carrier = 22, depth = Math.min(0.85, dev / 100 * 0.9);
    const yA = h * 0.2, aA = h * 0.13, yB = h * 0.66, aB = h * 0.24;
    ctx.font = `11px ${MONO}`; ctx.fillStyle = COL.faint; ctx.textAlign = "left";
    ctx.fillText("audio from the Uno", 6, 12);
    ctx.fillText("FM signal (carrier scaled down so the cycles are visible)", 6, h * 0.38);
    ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const t = px / w, y = yA - Math.sin(2 * Math.PI * cycles * t) * aA;
      if (px) ctx.lineTo(px, y); else ctx.moveTo(px, y);
    }
    ctx.stroke();
    ctx.strokeStyle = COL.text; ctx.lineWidth = 1.2; ctx.beginPath();
    let phase = 0;
    const N = Math.max(600, w * 3);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const inst = carrier * (1 + depth * Math.sin(2 * Math.PI * cycles * t));
      phase += 2 * Math.PI * inst / N;
      const x = t * w, y = yB - Math.sin(phase) * aB;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  $("#fmDev").addEventListener("input", drawFM);
  seg($("#fmTone"), "f", (f) => { fm.tone = +f; drawFM(); });
  drawFM();

  // ---------------------------------------------------------------- channel simulator
  const SIM_FS = 48000;
  function noisy(x, sigPower, snrDb) {
    const sigma = Math.sqrt(sigPower / Math.pow(10, snrDb / 10));
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      out[i] = x[i] + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    return out;
  }
  // White noise fills 0-24 kHz, but the decoder only looks at 400-3600 Hz. The slider gives the SNR
  // inside that band, so the wide-band noise is 10*log10(24000/3200) = 8.75 dB stronger.
  const BAND_DB = 10 * Math.log10((SIM_FS / 2) / 3200);
  function updSimLabels() {
    const v = +$("#simSnr").value;
    $("#simSnrV").textContent = (v < 0 ? "−" : "") + Math.abs(v) + " dB";
    const c = +$("#simClk").value / 10;
    $("#simClkV").textContent = (c > 0 ? "+" : c < 0 ? "−" : "") + Math.abs(c).toFixed(1) + " %";
  }
  $("#simSnr").addEventListener("input", updSimLabels);
  $("#simClk").addEventListener("input", updSimLabels);
  updSimLabels();
  const sim = { hist: null, busy: false };
  function drawSimSoft() {
    const { ctx, w, h } = canvas($("#simSoft"));
    ctx.clearRect(0, 0, w, h);
    const padB = 18;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 6); ctx.lineTo(w / 2, h - padB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h - padB); ctx.lineTo(w, h - padB); ctx.stroke();
    ctx.font = `10.5px ${MONO}`; ctx.fillStyle = COL.faint; ctx.textAlign = "center";
    ctx.fillText("−1 (bit 0)", 34, h - 5); ctx.fillText("0", w / 2, h - 5); ctx.fillText("+1 (bit 1)", w - 34, h - 5);
    if (!sim.hist) {
      ctx.fillStyle = COL.muted; ctx.fillText("no data yet", w / 2, h / 2);
      return;
    }
    let mx = 1;
    for (const s of C.SCHEMES) if (sim.hist[s]) for (const v of sim.hist[s]) mx = Math.max(mx, v);
    for (const s of C.SCHEMES) {
      const hs = sim.hist[s];
      if (!hs) continue;
      ctx.strokeStyle = COL[s]; ctx.fillStyle = rgba(COL[s], 0.16); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(0, h - padB);
      hs.forEach((v, i) => ctx.lineTo((i + 0.5) / hs.length * w, h - padB - v / mx * (h - padB - 10)));
      ctx.lineTo(w, h - padB); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  async function runSim() {
    if (sim.busy) return;
    sim.busy = true;
    $("#simRun").disabled = true;
    const snr = +$("#simSnr").value, clk = 1 + (+$("#simClk").value) / 1000, baud = +$("#simBaud").value;
    const fr = C.buildFrame("PRBS");
    const rows = [], hist = {};
    for (const s of C.SCHEMES) {
      $("#simNote").textContent = `Sending through the channel: ${s} …`;
      await new Promise((r) => setTimeout(r, 30));
      const sig = C.resample(C.modulateUno(fr.bits, s, baud, 3), C.FS_UNO, SIM_FS, clk);
      let p = 0;
      for (let i = 0; i < sig.length; i++) p += sig[i] * sig[i];
      p /= sig.length;
      const x = noisy(concat([silence(0.25, SIM_FS), sig, silence(0.25, SIM_FS)]), p, snr - BAND_DB);
      const r = D.decode(x, SIM_FS, baud, s);
      // a false sync inside noise reads as a "PRBS frame" with about half its bits wrong: drop those
      const pf = r.frames.filter((f) => f.type === "PRBS" && f.errors < 200);
      const errs = pf.reduce((a, f) => a + f.errors, 0);
      const ok = pf.filter((f) => f.crcOk).length;
      rows.push({ s, found: pf.length, ok, errs, ber: pf.length ? errs / (511 * pf.length) : null });
      const bins = new Array(48).fill(0);
      for (const f of pf) for (let k = 24; k < f.nbits; k++) {
        const v = r.soft[Math.round(f.pos + k * f.per)];
        if (v === undefined) continue;
        bins[Math.max(0, Math.min(47, Math.floor((v + 1) / 2 * 48)))]++;
      }
      hist[s] = bins;
    }
    $("#simTbl tbody").innerHTML = rows.map((r) =>
      `<tr><td><span class="pill s-${r.s}">${r.s}</span></td><td class="num">${r.found} / 3</td><td class="num">${r.ok}</td><td class="num">${r.errs}</td>` +
      `<td class="num">${r.ber === null ? "–" : r.ber === 0 ? "0" : r.ber.toExponential(1)}</td></tr>`).join("");
    const lost = rows.filter((r) => r.found < 3).map((r) => r.s);
    $("#simNote").textContent = `SNR ${snr} dB (400–3600 Hz band), clock ${((clk - 1) * 100).toFixed(1)} %, ${baud} baud. ` +
      (lost.length ? `Lost frames (no sync found) are not counted in the BER: ${lost.join(", ")}.` : "All frames found.") +
      " The noise is random, so every run comes out a little different.";
    sim.hist = hist;
    drawSimSoft();
    $("#simSoftLbl").textContent = "ASK · FSK · DBPSK";
    $("#simRun").disabled = false;
    sim.busy = false;
  }
  $("#simRun").addEventListener("click", runSim);
  drawSimSoft();

  // ---------------------------------------------------------------- live decoder
  const WORKLET_SRC = `class FmTap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === 4096) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(4096); this.n = 0; }
      }
      return true;
    }
  }
  registerProcessor("fm-tap", FmTap);`;

  const live = {
    kind: null, src: null, stream: null, analyser: null, tap: null, mute: null, worker: null, local: null,
    timer: null, raf: null, running: false, ok: 0, bad: 0, workletReady: false, fs: 48000, freq: null, lut: null, ending: null, playOnly: null,
  };

  function setStatus(text, on) {
    $("#liveStatus").textContent = text;
    $("#liveRec").classList.toggle("on", !!on);
  }
  function showHint(html) { const el = $("#micHint"); el.innerHTML = html; el.classList.toggle("show", !!html); }
  function setPressed(kind) { $$("#sources [data-src]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.src === kind ? "true" : "false")); }

  function initDecoder(fs) {
    live.fs = fs;
    if (!live.worker) {
      try {
        live.worker = new Worker("decoder-worker.js");
        live.worker.onmessage = (e) => { if (e.data.type === "result") onResult(e.data); };
        live.worker.onerror = () => { live.worker = null; live.local = new D.LiveDecoder(live.fs, 5.4); };
      } catch (e) { live.worker = null; }
    }
    // 5.4 s at 48 kHz fits a 2^18-point FFT; enough for a frame plus the 600 bits the clock fit uses
    if (live.worker) live.worker.postMessage({ type: "init", fs, seconds: 5.4 });
    else live.local = new D.LiveDecoder(fs, 5.4);
  }
  function feed(chunk) {
    if (live.worker) live.worker.postMessage({ type: "push", chunk }, [chunk.buffer]);
    else if (live.local) live.local.push(chunk);
  }
  function runDecode(final) {
    const baud = +$("#liveBaud").value, scheme = $("#liveScheme").value;
    if (live.worker) live.worker.postMessage({ type: "run", baud, scheme, final: final === true });
    else if (live.local) {
      const t = performance.now();
      const r = live.local.run(baud, scheme, final === true);
      onResult({ scheme: r.scheme, fresh: r.fresh, soft: r.soft ? Float32Array.from(r.soft.subarray(Math.max(0, r.soft.length - live.fs * 2))) : null, level: live.local.level(), ms: Math.round(performance.now() - t) });
    }
  }

  let exampleShown = true;
  function addRow(f) {
    if (exampleShown) { $("#liveLog").innerHTML = ""; $("#logNote").textContent = "Newest frame on top."; exampleShown = false; }
    const tr = document.createElement("tr");
    tr.className = "fresh";
    const isText = f.type === "TEXT";
    const content = isText ? `"${f.text}"` : `PRBS-9 · ${f.errors} wrong bits of ${f.bits}`;
    const cells = [
      (f.t || 0).toFixed(2) + " s", f.scheme || "", content,
      f.crcOk ? "OK" : "failed", (f.quality || 0).toFixed(2), (f.clockPpm > 0 ? "+" : "") + f.clockPpm + " ppm",
    ];
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      if (i === 1 && c) { const sp = document.createElement("span"); sp.className = "pill s-" + c; sp.textContent = c; td.appendChild(sp); }
      else if (i === 3) { const sp = document.createElement("span"); sp.className = "pill " + (f.crcOk ? "ok" : "bad"); sp.textContent = c; td.appendChild(sp); }
      else if (i === 2) {
        td.textContent = c;
        const sent = window.FMLinkTx && window.FMLinkTx.sent;      // text the Transmitter panel put on the Uno
        if (isText && f.crcOk && sent && f.text === sent) {
          const sp = document.createElement("span"); sp.className = "pill info"; sp.textContent = "match";
          sp.title = "Same as the text sent from the Transmitter panel";
          td.append(" ", sp);
        }
      }
      else td.textContent = c;
      if (i >= 4) td.className = "num";
      tr.appendChild(td);
    });
    const tb = $("#liveLog");
    tb.insertBefore(tr, tb.firstChild);
    while (tb.children.length > 60) tb.removeChild(tb.lastChild);
  }

  function onResult(r) {
    for (const f of r.fresh || []) {
      if (f.crcOk) live.ok++; else live.bad++;
      addRow(f);
      if (f.clockPpm !== undefined) $("#cClock").textContent = (f.clockPpm > 0 ? "+" : "") + f.clockPpm + " ppm";
    }
    $("#cOk").textContent = live.ok;
    $("#cBad").textContent = live.bad;
    if (r.scheme && (r.fresh || []).length) { $("#cScheme").textContent = r.scheme; $("#cScheme").style.color = COL[r.scheme]; }
    if (r.soft) drawLiveSoft(r.soft, r.scheme);
    if (typeof r.level === "number") $("#mLevel").style.width = Math.min(100, Math.sqrt(r.level) * 160) + "%";
    if (live.running) $("#liveSoftLbl").textContent = `decode ${r.ms} ms`;
  }

  function drawLiveSoft(soft, scheme) {
    const { ctx, w, h } = canvas($("#liveSoft"));
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!soft || !soft.length) return;
    ctx.strokeStyle = COL[scheme] || COL.text; ctx.lineWidth = 1.2; ctx.beginPath();
    const n = soft.length;
    for (let px = 0; px < w; px++) {
      const a = Math.floor(px / w * n), b = Math.max(a + 1, Math.floor((px + 1) / w * n));
      let lo = 1, hi = -1;
      for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, soft[i]); hi = Math.max(hi, soft[i]); }
      ctx.moveTo(px + 0.5, h / 2 - hi * (h / 2 - 6)); ctx.lineTo(px + 0.5, h / 2 - lo * (h / 2 - 6));
    }
    ctx.stroke();
  }

  function buildLut() {
    const stops = [[0, hexToRgb(COL.ink)], [0.35, hexToRgb("#123a5c")], [0.6, hexToRgb(COL.cyan)], [0.85, hexToRgb("#d8fbff")], [1, [255, 255, 255]]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k], [t1, c1] = stops[k + 1], u = (t - t0) / (t1 - t0);
      for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
    }
    return lut;
  }

  function drawSpecIdle() {
    const { ctx, w, h } = canvas($("#liveSpec"));
    ctx.clearRect(0, 0, w, h);
    specGrid(ctx, w, h);
    ctx.fillStyle = COL.faint; ctx.font = `11px ${MONO}`; ctx.textAlign = "center";
    ctx.fillText("waiting for a signal", w / 2, h / 2);
    canvas($("#liveFall"));
  }
  function specGrid(ctx, w, h) {
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1; ctx.font = `10px ${MONO}`; ctx.fillStyle = COL.faint; ctx.textAlign = "center";
    for (let f = 500; f < 4000; f += 500) {
      const x = f / 4000 * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke();
      ctx.fillText(f >= 1000 ? (f / 1000) + "k" : String(f), x, h - 3);
    }
    for (const [f, c] of [[1200, COL.cyan], [1800, COL.violet], [2200, COL.cyan]]) {
      ctx.strokeStyle = rgba(c, 0.75); ctx.setLineDash([3, 3]);
      const x = f / 4000 * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function visLoop() {
    if (!live.analyser) return;
    const an = live.analyser, bins = an.frequencyBinCount, fs = live.fs;
    if (!live.freq || live.freq.length !== bins) live.freq = new Float32Array(bins);
    an.getFloatFrequencyData(live.freq);
    const hzPerBin = fs / an.fftSize;
    const dbAt = (f) => { const i = Math.round(f / hzPerBin); let m = -200; for (let k = i - 4; k <= i + 4; k++) if (k >= 0 && k < bins) m = Math.max(m, live.freq[k]); return m; };
    // spectrum
    {
      const { ctx, w, h } = canvas($("#liveSpec"));
      ctx.clearRect(0, 0, w, h);
      specGrid(ctx, w, h);
      ctx.strokeStyle = COL.text; ctx.lineWidth = 1.3; ctx.beginPath();
      for (let px = 0; px <= w; px++) {
        const f = px / w * 4000, d = dbAt(f);
        const y = (h - 14) * (1 - Math.max(0, Math.min(1, (d + 110) / 85)));
        if (px) ctx.lineTo(px, y); else ctx.moveTo(px, y);
      }
      ctx.stroke();
    }
    // waterfall: 30 rows per second by the clock, so it keeps pace even when the tab is throttled
    const now = performance.now();
    const add = live.lastRow ? Math.floor((now - live.lastRow) / 33) : 1;
    if (add > 0) {
      live.lastRow = live.lastRow ? live.lastRow + add * 33 : now;
      const cv = $("#liveFall");
      const { ctx, dpr } = canvas(cv);
      const W = cv.width, H = cv.height, k = Math.min(H, add * Math.round(dpr));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (k < H) ctx.drawImage(cv, 0, 0, W, H - k, 0, k, W, H - k);
      if (!live.lut) live.lut = buildLut();
      const row = ctx.createImageData(W, k);
      for (let x = 0; x < W; x++) {
        const d = dbAt(x / W * 4000);
        const v = Math.max(0, Math.min(255, Math.round((d + 110) / 80 * 255)));
        for (let y = 0; y < k; y++) {
          const o = (y * W + x) * 4;
          row.data[o] = live.lut[v * 3]; row.data[o + 1] = live.lut[v * 3 + 1]; row.data[o + 2] = live.lut[v * 3 + 2]; row.data[o + 3] = 255;
        }
      }
      ctx.putImageData(row, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // tone meters
    for (const f of [1200, 1800, 2200]) {
      const v = Math.max(0, Math.min(1, (dbAt(f) + 100) / 65));
      $("#m" + f).style.width = (v * 100).toFixed(0) + "%";
    }
    live.raf = requestAnimationFrame(visLoop);
  }

  async function liveStart(kind, fileBuf, fileName) {
    if (kind === "test" && live.kind === "mic" && live.running) { await playTestAloud(); return; }
    await liveStop(true);
    showHint("");
    setPressed(kind);
    let ctx;
    try { ctx = await getCtx(); } catch (e) { setStatus("Audio can't run in this browser."); return; }
    if (!live.workletReady && ctx.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        live.workletReady = true;
      } catch (e) { live.workletReady = false; }
    }
    initDecoder(ctx.sampleRate);
    let node;
    try {
      if (kind === "mic") {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error("no getUserMedia"), { name: "NotSupportedError" });
        setStatus("Asking for microphone access …");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
        live.stream = stream;
        node = ctx.createMediaStreamSource(stream);
      } else {
        let buffer, label;
        if (kind.startsWith("rec-")) {
          const sch = kind.slice(4);
          setStatus(`Loading the ${sch} recording …`);
          const res = await fetch("audio/recording_" + sch.toLowerCase() + ".wav");
          if (!res.ok) throw new Error("recording not found");
          buffer = await ctx.decodeAudioData(await res.arrayBuffer());
          label = `the ${sch} recording of 24 Nov (phone radio → laptop mic)`;
          $("#liveBaud").value = "300";
        } else if (kind === "file") {
          buffer = await ctx.decodeAudioData(fileBuf);
          label = "the file " + fileName;
        } else {
          const sch = $("#testScheme").value, baud = +$("#liveBaud").value;
          const fr = C.buildFrame("TEXT", $("#testText").value || "hello");
          buffer = unoBuffer(ctx, concat([silence(0.3), C.modulateUno(fr.bits, sch, baud, 4), silence(0.6)]));
          label = `a ${sch} ${baud} baud test signal, fed straight into the decoder`;
        }
        const s = ctx.createBufferSource();
        s.buffer = buffer;
        const g = ctx.createGain(); g.gain.value = 0.55;
        s.connect(g); g.connect(ctx.destination);
        s.onended = () => { if (live.src === s) liveFinish(); };
        node = s;
        live.label = label;
      }
    } catch (e) {
      setPressed(null);
      if (kind === "mic") {
        const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
        const why = e.name === "NotFoundError" ? "No microphone found." :
          e.name === "NotAllowedError" || e.name === "SecurityError" ? "Microphone access was denied or blocked on this page." : "No microphone is available on this page.";
        showHint(`<b>${why}</b> ` + (local ? "Check the microphone permission at the icon next to the address bar, then try again." :
          "Check the microphone permission at the icon next to the address bar and try again. If this page is embedded somewhere else, open it directly at https://arsa07lol.github.io/fmlink/web/. The recordings, your own file and the test signal work without a microphone."));
        setStatus("The microphone can't be used.");
      } else setStatus("Could not load the audio: " + e.message);
      return;
    }
    live.kind = kind; live.src = node; live.running = true; live.ok = 0; live.bad = 0;
    $("#cOk").textContent = "0"; $("#cBad").textContent = "0"; $("#cScheme").textContent = "–"; $("#cScheme").style.color = ""; $("#cClock").textContent = "–";
    live.analyser = ctx.createAnalyser();
    live.analyser.fftSize = 8192;
    live.analyser.smoothingTimeConstant = 0.25;
    node.connect(live.analyser);
    if (live.workletReady) {
      live.tap = new AudioWorkletNode(ctx, "fm-tap");
      live.tap.port.onmessage = (e) => feed(e.data);
    } else {
      live.tap = ctx.createScriptProcessor(4096, 1, 1);
      live.tap.onaudioprocess = (e) => feed(Float32Array.from(e.inputBuffer.getChannelData(0)));
    }
    node.connect(live.tap);
    live.mute = ctx.createGain(); live.mute.gain.value = 0;
    live.tap.connect(live.mute); live.mute.connect(ctx.destination);
    if (node.start) node.start();
    $("#liveStop").disabled = false;
    $("#liveFs").textContent = (ctx.sampleRate / 1000).toFixed(1) + " kHz";
    setStatus((kind === "mic" ? "Listening to the microphone." : "Playing " + live.label + ".") +
      " Frames show up about 2 seconds after they arrive, because the decoder waits for enough audio to track the clock.", true);
    live.timer = setInterval(runDecode, 1000);
    live.lastRow = 0;
    cancelAnimationFrame(live.raf);
    live.raf = requestAnimationFrame(visLoop);
  }

  function liveFinish() {                      // a recording ended: decode the tail, then stop
    clearTimeout(live.ending);
    live.ending = setTimeout(() => { runDecode(true); setTimeout(() => liveStop(false, "Done. Pick another source to try again."), 600); }, 900);
  }

  async function liveStop(silent, msg) {
    clearInterval(live.timer); live.timer = null;
    clearTimeout(live.ending);
    cancelAnimationFrame(live.raf); live.raf = null;
    if (live.src) {
      try { if (live.src.stop) live.src.stop(); } catch (e) { /* already stopped */ }
      try { live.src.disconnect(); } catch (e) { /* not connected */ }
    }
    if (live.tap) { try { live.tap.disconnect(); } catch (e) { /* */ } if (live.tap.port) live.tap.port.onmessage = null; }
    if (live.mute) { try { live.mute.disconnect(); } catch (e) { /* */ } }
    if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
    if (live.playOnly) { try { live.playOnly.stop(); } catch (e) { /* */ } live.playOnly = null; }
    live.src = live.tap = live.mute = live.stream = live.analyser = null;
    live.running = false; live.kind = null;
    $("#liveStop").disabled = true;
    setPressed(null);
    if (!silent) setStatus(msg || "Stopped.", false);
  }

  async function playTestAloud() {             // mic is listening: play the test signal through the speaker
    const ctx = await getCtx();
    const sch = $("#testScheme").value, baud = +$("#liveBaud").value;
    const fr = C.buildFrame("TEXT", $("#testText").value || "hello");
    const s = ctx.createBufferSource();
    s.buffer = unoBuffer(ctx, concat([silence(0.3), C.modulateUno(fr.bits, sch, baud, 4), silence(0.3)]));
    const g = ctx.createGain(); g.gain.value = 0.6;
    s.connect(g); g.connect(ctx.destination);
    s.start();
    live.playOnly = s;
    setStatus(`Microphone listening while the speaker plays a ${sch} ${baud} baud test signal (acoustic path, speaker → mic).`, true);
  }

  $$("#sources [data-src]").forEach((b) => b.addEventListener("click", () => liveStart(b.dataset.src)));
  $("#liveFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    liveStart("file", buf, f.name);
    e.target.value = "";
  });
  $("#liveStop").addEventListener("click", () => liveStop(false));

  // example rows: the real FSK recording of 24 Nov, decoded by this page's decoder
  const EXAMPLE = [
    ["9.13 s", "FSK", '"(`D\' P "', false, "–", "−500 ppm"], ["7.37 s", "FSK", '"hö`PD{þ"', false, "–", "−500 ppm"],
    ["6.78 s", "FSK", '"halo PDSK"', true, "–", "−999 ppm"], ["6.19 s", "FSK", '"halo PDSK"', true, "–", "−999 ppm"],
    ["5.61 s", "FSK", '"halo PDSK"', true, "–", "−999 ppm"], ["5.02 s", "FSK", '"halo PDSK"', true, "–", "−999 ppm"],
    ["4.43 s", "FSK", '"halo PDSK"', true, "–", "−999 ppm"], ["3.85 s", "FSK", '"halo PDSK"', true, "–", "−999 ppm"],
  ];
  $("#liveLog").innerHTML = EXAMPLE.map((r) =>
    `<tr class="example"><td>${r[0]}</td><td><span class="pill s-${r[1]}">${r[1]}</span></td><td>${esc(r[2])}</td>` +
    `<td><span class="pill ${r[3] ? "ok" : "bad"}">${r[3] ? "OK" : "failed"}</span></td><td class="num">${r[4]}</td><td class="num">${r[5]}</td></tr>`).join("");
  drawSpecIdle();
  drawLiveSoft(null);

  // ---------------------------------------------------------------- journal
  const JOURNAL = [
    { d: "5 Nov", k: "decision", t: "Project started", b: "First design: an STM32 Blue Pill makes the TX audio, an Arduino Uno controls the RDA5807M receiver, the laptop decodes." },
    { d: "21 Nov", k: "fail", t: "Uploading to the STM32 through the Uno failed", b: "The STM32 bootloader did not answer (\"Activating device: KO\") at 115200 or 9600 baud, from either the Arduino IDE or STM32CubeProgrammer. The Uno loopback was fine and BOOT0 was set to 1.", f: "With no ST-Link or USB-TTL adapter at hand, one Arduino Uno now handles both TX and RX." },
    { d: "23 Nov", k: "ok", t: "Uno firmware rewritten", b: "The 31 250 Hz sample interrupt is locked to the 62.5 kHz PWM (2 PWM periods per sample). The earlier 32 kHz plan was not in step with the PWM and caused 16 µs of jitter. Settings live in EEPROM so they survive the serial port being opened." },
    { d: "23 Nov", k: "fail", t: "Decoder bug: the Uno's clock is off", b: "The Uno's ceramic resonator can be ±0.5 % off. The old decoder used a fixed timing grid: a +0.2 % clock already gave a BER of 0.26, and +0.5 % gave 0.40.", f: "The decoder now tries 41 possible clock errors (±1 %) per frame. The firmware simulation and the selftest pass." },
    { d: "23 Nov", k: "ok", t: "Upload to the Uno works", b: "Banner, TX commands, error messages and EEPROM proven on the hardware. An I2C scan without the RDA connected doesn't hang the Uno (25 ms timeout)." },
    { d: "23 Nov", k: "fail", t: "The RDA pinout from memory was wrong", b: "First guess: pins 3 and 9 are GND too. Five pinout drawings from different sources agree that only pin 6 is GND.", f: "The check procedure was dropped before it was used, and the notes were corrected. Lesson: never build a procedure on a pinout that hasn't been confirmed." },
    { d: "24 Nov", k: "fail", t: "RDA module pads lifted while soldering", b: "Pad 7 on module 1 and pad 10 on module 2 came off together with their copper. Solder won't stick to a board with no copper left.", f: "Audio moved to pad 8: the firmware forces mono, so pads 7 and 8 carry the same signal." },
    { d: "24 Nov", k: "ok", t: "The RDA answers on I2C", b: "First power-up through a 1.5 kΩ resistor as a safeguard, with the VCC wire plugged in last. The scan found 0x10, 0x11 and 0x60; with the resistor replaced by a wire, the radio reported OK at 103.9 MHz." },
    { d: "24 Nov", k: "fail", t: "No signal at all", b: "SCAN over 87.5–108 MHz: RSSI 2 on all 206 channels, even with a 75 cm antenna and a 2.4 Ω connection. The raw registers (a new REG command) showed a genuine chip and correct settings; switching to the other LNA input changed nothing.", f: "With the transmitter 10–30 cm away it read only about RSSI 10, where a healthy module reads 50+. Conclusion: module 1's RF section is dead, so a new module was ordered." },
    { d: "24 Nov", k: "fail", t: "A transmitter too close disturbs I2C", b: "With the transmitter on next to the breadboard, many RDA register reads failed or came back corrupted; an RSSI peak of 64 in one scan turned out to be corrupted data.", f: "The transmitter now sits about 1 m from the Uno and its wiring." },
    { d: "24 Nov", k: "fail", t: "The TX filter was silent", b: "The 1000 Hz tone couldn't be heard in an earphone, only crackling while turning the trimmer.", f: "Used the earphone as a probe, moving the TIP jumper to each capacitor leg in turn. One resistor leg was in the wrong row; once moved, the tone came through." },
    { d: "24 Nov", k: "ok", t: "Transmitter on the air", b: "The transmitter's audio cable plugs straight into the TRRS jack on the breadboard. The Uno's tone came through on a phone FM radio at 104.2 MHz." },
    { d: "24 Nov", k: "fail", t: "The transmitter frequency drifts", b: "About 30 minutes later the transmitter had moved to 102.4 MHz, so the first decode test recorded only hiss.", f: "Found the frequency again on the radio and left the transmitter untouched during the test." },
    { d: "24 Nov", k: "ok", t: "End-to-end data link", b: "The text \"halo PDSK\" went out from the Uno with FSK, ASK and DBPSK, through the FM transmitter, a phone radio, its speaker and the laptop microphone, and decoded with CRC OK: FSK 6 of 8 frames, ASK 14 of 17, DBPSK 12 of 16." },
    { d: "24 Nov", k: "ok", t: "The decoder runs in the browser too", b: "The Python decoder was ported to JavaScript for this page. On all three recordings the results match Python exactly." },
    { d: "25 Nov", k: "ok", t: "Text changed straight from this page", b: "The Transmitter panel sends commands to the Uno over USB (Web Serial). Text, scheme and bit rate change without re-uploading and without the Arduino IDE." },
    { d: "26 Nov", k: "fail", t: "Forgot the transmitter's antenna", b: "The new RDA module powered up, but at the transmitter's frequency the signal strength was barely above an empty frequency, and the tone on the phone radio was faint.", f: "With the antenna on, the RDA reads RSSI 107–108 at the transmitter's frequency and 28–55 elsewhere." },
    { d: "26 Nov", k: "ok", t: "The new RDA module catches the transmitter", b: "First power-up through a safety resistor: I2C answers at 0x10 and 0x11, chip ID 5804, radio OK. The signal strength only settles about 0.5 s after a retune, so the Find transmitter button on this page waits before it reads." },
  ];
  function renderJournal(filter) {
    const label = { ok: ["ok", "worked"], fail: ["bad", "failed → fixed"], decision: ["warn", "decision"] };
    $("#timeline").innerHTML = JOURNAL.filter((j) => filter === "all" || j.k === filter || (filter === "decision" && j.k === "decision")).map((j) =>
      `<li class="tl ${j.k}"><div class="tl-head"><span class="tl-date">${esc(j.d)}</span><h3>${esc(j.t)}</h3><span class="pill ${label[j.k][0]}">${label[j.k][1]}</span></div>` +
      `<p>${esc(j.b)}</p>${j.f ? `<p class="fix"><b>Fix:</b> ${esc(j.f)}</p>` : ""}</li>`).join("");
  }
  seg($("#tlChips"), "f", renderJournal);
  renderJournal("all");

  // ---------------------------------------------------------------- results bars
  const RES = [["FSK", 6, 2], ["ASK", 14, 3], ["DBPSK", 12, 4]];
  const maxTot = Math.max(...RES.map((r) => r[1] + r[2]));
  $("#resBars").innerHTML = RES.map(([s, ok, bad]) =>
    `<div class="barrow"><span class="pill s-${s}">${s}</span><div class="track" role="img" aria-label="${s}: ${ok} OK, ${bad} failed">` +
    `<i style="width:${ok / maxTot * 100}%;background:${COL[s]}"></i><i style="width:${bad / maxTot * 100}%;background:${rgba(COL.bad, 0.55)}"></i></div>` +
    `<span class="mono">${ok} / ${ok + bad}</span></div>`).join("");

  // ---------------------------------------------------------------- resize
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      drawHero(); drawMod(); drawDDS(); drawFilter(); drawFM(); drawSimSoft(); renderFrame();
      if (!live.running) { drawSpecIdle(); }
    }, 150);
  });
})();
