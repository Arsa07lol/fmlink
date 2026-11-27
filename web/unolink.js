/* unolink.js: the Transmitter and RDA receiver panels of the live demo.
   Talks to the Arduino Uno over USB with Web Serial (Chrome or Edge on a laptop; the page has to be
   served over https or from localhost). It sends the same lines you would type in the Arduino
   Serial Monitor (115200 baud, Newline):
     S0 / S1 / S2      scheme ASK / FSK / DBPSK
     R150 .. R1200     bit rate
     M <text>          message, up to 100 characters, saved in the Uno's EEPROM
     T1000, D, ?       1000 Hz tone (to find the transmitter on a radio), data mode, status
     F<10 kHz>         tune the RDA5807M, e.g. F10260 = 102.60 MHz
     RSSI1 / RSSI0     RDA signal strength lines (RSSI,<ms>,<freq>,<rssi>,<fm_true>,<stereo>) every 100 ms
   Nothing is uploaded to the Uno: the firmware in fmlink_uno/ already understands these commands.
   window.FMLinkTx.sent holds the text the Uno is sending, so the decoder can mark matching frames. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const ui = {
    conn: $("#txConn"), connect: $("#txConnect"), disconnect: $("#txDisconnect"),
    text: $("#txText"), count: $("#txCount"), scheme: $("#txScheme"), baud: $("#txBaud"),
    send: $("#txSend"), tone: $("#txTone"), data: $("#txData"), status: $("#txStatus"),
    log: $("#txLog"), hint: $("#txHint"),
    mode: $("#txMode"), now: $("#txNow"), schemeNow: $("#txSchemeNow"), baudNow: $("#txBaudNow"),
  };
  if (!ui.connect) return;
  const rx = {
    conn: $("#rdaConn"), freq: $("#rdaFreq"), rssi: $("#rdaRssi"), vol: $("#rdaVol"), bar: $("#rdaBar"),
    spark: $("#rdaSpark"), sparkLbl: $("#rdaSparkLbl"), sweep: $("#rdaSweep"), sweepLbl: $("#rdaSweepLbl"),
    live: $("#rdaLive"), freqIn: $("#rdaFreqIn"), tune: $("#rdaTune"), find: $("#rdaFind"), hint: $("#rdaHint"),
  };
  const hasRx = !!rx.find;

  const SCHEMES = ["ASK", "FSK", "DBPSK"];
  const COLORS = { ASK: "var(--amber)", FSK: "var(--cyan)", DBPSK: "var(--violet)" };
  // the Uno's status line, e.g.  tx    : DATA | frame TEXT "halo PDSK" | FSK | 300 baud
  const STATUS_RE = /^tx\s*:\s*(SWEEP|TONE (\d+) Hz|QUIET|DATA) \| frame (PRBS-9|TEXT "(.*)") \| (ASK|FSK|DBPSK) \| (\d+) baud$/;
  const NO_REPLY = "The Uno did not reply. Check the USB cable, then click Disconnect and Connect Uno again.";
  const NO_RADIO = "The Uno can't find the RDA. Check the RDA's SDA, SCL, VCC and GND wires, then click Check status in the Transmitter panel.";
  const tx = (window.FMLinkTx = window.FMLinkTx || { sent: null });
  const st = { state: "off", port: null, reader: null, loop: null, buf: "", waiters: [], busy: false, closing: false };
  const rda = { ok: null, freq: null, live: false, hist: [], collect: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // ------------------------------------------------------------ view
  function hint(msg, good) {
    ui.hint.textContent = msg || "";
    ui.hint.classList.toggle("show", !!msg);
    ui.hint.classList.toggle("good", !!(msg && good));
  }
  function rxHint(msg, good) {
    if (!hasRx) return;
    rx.hint.textContent = msg || "";
    rx.hint.classList.toggle("show", !!msg);
    rx.hint.classList.toggle("good", !!(msg && good));
  }

  function setState(state) {
    st.state = state;
    const [label, cls] = {
      off: ["not connected", "idle"],
      wait: ["connecting…", "warn"],
      on: ["connected to Uno", "ok"],
      none: ["needs Chrome or Edge on a laptop", "bad"],
    }[state];
    ui.conn.textContent = label;
    ui.conn.className = "pill " + cls;
    ui.connect.hidden = state === "on" || state === "wait";
    ui.connect.disabled = state === "none";
    ui.disconnect.hidden = state !== "on";
    refresh();
  }

  function refresh() {
    const ready = st.state === "on" && !st.busy;
    for (const b of [ui.send, ui.tone, ui.data, ui.status]) b.disabled = !ready;
    if (hasRx) {
      const rxReady = ready && rda.ok !== false;
      for (const b of [rx.live, rx.tune, rx.find]) b.disabled = !rxReady;
    }
  }

  function log(line, mine) {
    const ph = ui.log.querySelector(".ph");
    if (ph) ph.remove();
    const div = document.createElement("div");
    if (mine) div.className = "me";
    div.textContent = (mine ? "> " : "") + line;
    ui.log.appendChild(div);
    while (ui.log.children.length > 40) ui.log.firstElementChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function show(s) {
    if (s.mode) ui.mode.textContent = s.mode;
    if (s.text !== undefined) ui.now.textContent = s.text === null ? "PRBS-9 (BER test)" : `"${s.text}"`;
    if (s.scheme) { ui.schemeNow.textContent = s.scheme; ui.schemeNow.style.color = COLORS[s.scheme]; }
    if (s.baud) ui.baudNow.textContent = s.baud + " baud";
  }

  function count() { ui.count.textContent = ui.text.value.length + "/100"; }

  function syncDecoder(baud) {                  // the decoder below has to listen at the Uno's bit rate
    const sel = document.getElementById("liveBaud");
    if (sel) sel.value = String(baud);
  }

  function fill(s) {                            // show the Uno's current settings in the form
    if (s.text !== null) { ui.text.value = s.text; count(); }
    ui.scheme.value = String(SCHEMES.indexOf(s.scheme));
    ui.baud.value = String(s.baud);
    tx.sent = s.text;
    syncDecoder(s.baud);
  }

  // ------------------------------------------------------------ receiver view
  function rdaSetLive(on) {
    rda.live = on;
    if (!hasRx) return;
    rx.live.textContent = on ? "Live: on" : "Live: off";
    rx.live.setAttribute("aria-pressed", on ? "true" : "false");
    rx.sparkLbl.textContent = on ? "updated 10× a second" : "Live off";
  }

  function rdaShow(s) {
    if (!hasRx) return;
    if (s.ok !== undefined) {
      rda.ok = s.ok;
      rx.conn.textContent = s.ok ? "radio OK" : "radio not found";
      rx.conn.className = "pill " + (s.ok ? "ok" : "bad");
      refresh();
    }
    if (s.freq) {
      rda.freq = s.freq;
      rx.freq.textContent = s.freq.toFixed(2) + " MHz";
      if (document.activeElement !== rx.freqIn) rx.freqIn.value = s.freq.toFixed(1);
    }
    if (s.rssi !== undefined) {
      rx.rssi.textContent = s.rssi;
      rx.bar.style.width = Math.min(100, (s.rssi / 127) * 100) + "%";
    }
    if (s.vol !== undefined) rx.vol.textContent = s.vol;
  }

  function rdaReset() {
    rda.ok = null; rda.freq = null; rda.collect = null;
    rdaSetLive(false);
    if (!hasRx) return;
    rx.conn.textContent = "not connected";
    rx.conn.className = "pill idle";
    rx.freq.textContent = "–"; rx.rssi.textContent = "–"; rx.vol.textContent = "–";
    rx.bar.style.width = "0";
  }

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }
  function canvas2d(cv) {
    const r = window.devicePixelRatio || 1, w = cv.clientWidth || 300, h = cv.clientHeight || 90;
    if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) { cv.width = Math.round(w * r); cv.height = Math.round(h * r); }
    const c = cv.getContext("2d");
    c.setTransform(r, 0, 0, r, 0, 0);
    c.clearRect(0, 0, w, h);
    c.font = "11px " + cssVar("--f-mono", "monospace");
    return { c, w, h };
  }

  let sparkQueued = false;
  function drawSpark() {
    if (!hasRx || sparkQueued) return;
    sparkQueued = true;
    requestAnimationFrame(() => {
      sparkQueued = false;
      const { c, w, h } = canvas2d(rx.spark);
      const y = (v) => h - 6 - (v / 127) * (h - 12);
      c.strokeStyle = cssVar("--line", "#1d3050"); c.lineWidth = 1; c.fillStyle = cssVar("--faint", "#5f7697");
      for (const g of [50, 100]) {
        c.beginPath(); c.moveTo(28, y(g)); c.lineTo(w, y(g)); c.stroke();
        c.fillText(String(g), 4, y(g) + 4);
      }
      const now = performance.now(), pts = rda.hist;
      if (pts.length < 2) return;
      c.strokeStyle = cssVar("--cyan", "#3fd2e6"); c.lineWidth = 1.6; c.beginPath();
      pts.forEach((p, i) => {
        const x = w - ((now - p.t) / 30000) * (w - 28);
        if (i) c.lineTo(x, y(p.v)); else c.moveTo(x, y(p.v));
      });
      c.stroke();
    });
  }

  function drawSweep(res, steps, best) {
    if (!hasRx) return;
    const { c, w, h } = canvas2d(rx.sweep);
    const n = steps.length, bw = w / n, y0 = h - 16;
    res.forEach((r, i) => {
      if (r.v === null) return;
      const bh = Math.max(1, (r.v / 127) * (y0 - 14));
      c.fillStyle = i === best ? cssVar("--amber", "#f4b860") : cssVar("--cyan", "#3fd2e6");
      c.globalAlpha = i === best ? 1 : 0.5;
      c.fillRect(i * bw + 1, y0 - bh, Math.max(1, bw - 2), bh);
    });
    c.globalAlpha = 1;
    c.fillStyle = cssVar("--faint", "#5f7697");
    c.textAlign = "left"; c.fillText(steps[0].toFixed(1), 2, h - 3);
    c.textAlign = "right"; c.fillText(steps[n - 1].toFixed(1) + " MHz", w - 2, h - 3);
    if (best >= 0) {
      const r = res[best], x = Math.min(w - 30, Math.max(30, best * bw + bw / 2));
      c.fillStyle = cssVar("--amber", "#f4b860"); c.textAlign = "center";
      c.fillText(`${r.f.toFixed(1)} · ${r.v}`, x, y0 - (r.v / 127) * (y0 - 14) - 4);
    }
    c.textAlign = "left";
  }

  function onRssi(freq, value) {
    const t = performance.now();
    rda.hist.push({ t, v: value });
    while (rda.hist.length && t - rda.hist[0].t > 30000) rda.hist.shift();
    if (rda.collect && Math.abs(freq - rda.collect.freq) < 0.005 && t >= rda.collect.from) rda.collect.vals.push(value);
    rdaShow({ freq, rssi: value });
    drawSpark();
  }

  // ------------------------------------------------------------ what the Uno says
  function parse(line) {
    let m = STATUS_RE.exec(line);
    if (m) {
      const s = {
        mode: m[1] === "DATA" ? "data" : m[1] === "QUIET" ? "quiet" : m[1] === "SWEEP" ? "sweep" : `tone ${m[2]} Hz`,
        text: m[3] === "PRBS-9" ? null : m[4],
        scheme: m[5],
        baud: +m[6],
      };
      show(s);
      return s;
    }
    if ((m = /^RSSI,(\d+),(\d+),(\d+),(\d),(\d)$/.exec(line))) { onRssi(+m[2] / 100, +m[3]); return null; }
    if ((m = /^radio : OK, (\d+\.\d+) MHz, RSSI (\d+), vol (\d+)/.exec(line))) { rdaShow({ ok: true, freq: +m[1], rssi: +m[2], vol: +m[3] }); return null; }
    if (line.startsWith("radio : NOT FOUND")) { rdaShow({ ok: false }); return null; }
    if ((m = /^tuned (\d+\.\d+) MHz/.exec(line))) { rdaShow({ freq: +m[1] }); return null; }
    if ((m = /^volume (\d+)$/.exec(line))) { rdaShow({ vol: +m[1] }); return null; }
    if (line === "RSSI lines on") { rdaSetLive(true); return null; }
    if (line === "RSSI lines off") { rdaSetLive(false); return null; }
    if ((m = /^sending text: (.*)$/.exec(line))) show({ mode: "data", text: m[1] });
    else if (line.startsWith("sending PRBS-9")) show({ mode: "data", text: null });
    else if ((m = /scheme -> (ASK|FSK|DBPSK)/.exec(line))) show({ scheme: m[1] });
    else if ((m = /^baud -> (\d+)/.exec(line))) show({ baud: +m[1] });
    else if ((m = /^tone (\d+) Hz$/.exec(line))) show({ mode: `tone ${m[1]} Hz` });
    else if (line === "data mode") show({ mode: "data" });
    else if (line === "quiet") show({ mode: "quiet" });
    return null;
  }

  function onLine(line) {
    const stream = line.startsWith("RSSI,") || line.startsWith("ERR,");   // 10 lines a second: keep them out of the log
    if (!stream) log(line, false);
    parse(line);
    for (const w of st.waiters.slice()) if (w.test(line)) w.finish(line);
  }

  function onData(text) {
    st.buf += text;
    let i;
    while ((i = st.buf.indexOf("\n")) >= 0) {
      const line = st.buf.slice(0, i).replace(/\r$/, "");
      st.buf = st.buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    if (st.buf.length > 4096) st.buf = "";      // no line end for ages: not the FM Link firmware
  }

  // resolves with the first line that passes `test`, or null after `ms`
  function waitFor(test, ms) {
    return new Promise((resolve) => {
      const w = { test, done: false };
      w.finish = (line) => {
        if (w.done) return;
        w.done = true;
        clearTimeout(w.timer);
        const k = st.waiters.indexOf(w);
        if (k >= 0) st.waiters.splice(k, 1);
        resolve(line);
      };
      w.timer = setTimeout(() => w.finish(null), ms);
      st.waiters.push(w);
    });
  }
  function dropWaiters() { for (const w of st.waiters.slice()) w.finish(null); }

  // ------------------------------------------------------------ serial port
  async function readLoop(port) {
    const dec = new TextDecoder("iso-8859-1");
    let more = true;
    while (more && port.readable && !st.closing) {
      const reader = port.readable.getReader();
      st.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { more = false; break; }
          if (value) onData(dec.decode(value, { stream: true }));
        }
      } catch (e) {
        // a framing or overrun error gives a fresh port.readable; a lost device leaves it null
      } finally {
        reader.releaseLock();
        st.reader = null;
      }
    }
  }

  async function writeLine(cmd) {
    const bytes = new Uint8Array(cmd.length + 1);
    for (let i = 0; i < cmd.length; i++) { const c = cmd.charCodeAt(i); bytes[i] = c < 128 ? c : 63; }
    bytes[cmd.length] = 10;
    log(cmd, true);
    const writer = st.port.writable.getWriter();
    try {
      for (let i = 0; i < bytes.length; i += 32) {      // short pieces: the Uno's receive buffer is 64 bytes
        await writer.write(bytes.subarray(i, i + 32));
        if (i + 32 < bytes.length) await sleep(5);
      }
    } finally {
      writer.releaseLock();
    }
  }

  async function command(cmd, test, ms) {
    if (!st.port || !st.port.writable) return null;
    const reply = waitFor(test, ms || 2000);           // listen before writing, the reply can be quick
    try {
      await writeLine(cmd);
    } catch (e) {
      dropWaiters();
      return null;
    }
    return reply;
  }

  async function connect() {
    hint("");
    if (!navigator.serial || !window.isSecureContext) { unsupported(); return; }
    let port;
    try {
      port = await navigator.serial.requestPort();       // Chrome shows its own port list
    } catch (e) {
      if (e && e.name === "NotFoundError") hint("No port was selected. Click Connect Uno again and pick the Arduino port (usually COM3).");
      else hint("USB access is blocked on this page. Open https://arsa07lol.github.io/fmlink/web/ directly in Chrome or Edge.");
      return;
    }
    setState("wait");
    try {
      await port.open({ baudRate: 115200 });
    } catch (e) {
      setState("off");
      hint("The port could not be opened. Close the Arduino IDE Serial Monitor or any other program using this port, then try again.");
      return;
    }
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (e) { /* not every driver has it */ }
    st.port = port;
    st.buf = "";
    st.closing = false;
    st.loop = readLoop(port);
    // Opening the port usually restarts the Uno (Arduino auto-reset); it then prints its status by itself.
    const isStatus = (l) => STATUS_RE.test(l);
    let line = await waitFor(isStatus, 3500);
    if (!line && st.port === port) line = await command("?", isStatus, 2500);
    if (st.port !== port) return;                        // unplugged or disconnected meanwhile
    if (!line) {
      await disconnect();
      hint("The port opened, but the Uno did not answer. Make sure you picked the Arduino Uno and that the FM Link firmware is uploaded.");
      return;
    }
    const s = parse(line);
    fill(s);
    setState("on");
    hint(`Connected. The Uno is transmitting ${s.text === null ? "PRBS-9 frames" : `"${s.text}"`} with ${s.scheme} at ${s.baud} baud. The decoder below is set to ${s.baud} baud too.`, true);
    // the "radio :" status line arrives right after; then start the live signal strength
    if (hasRx) setTimeout(() => { if (st.port === port && rda.ok && !rda.live && !st.busy) toggleLive(true); }, 400);
  }

  async function disconnect() {
    const port = st.port;
    if (!port) { setState(navigator.serial ? "off" : "none"); rdaReset(); return; }
    if (rda.live) await command("RSSI0", (l) => l === "RSSI lines off", 600);   // stop the stream before leaving
    st.closing = true;
    dropWaiters();
    try { if (st.reader) await st.reader.cancel(); } catch (e) { /* already gone */ }
    try { await st.loop; } catch (e) { /* ended */ }
    try { await port.close(); } catch (e) { /* already closed */ }
    st.port = null;
    st.loop = null;
    st.closing = false;
    setState("off");
    rdaReset();
  }

  function lost() {                                      // USB cable pulled while connected
    const port = st.port;
    if (!port) return;
    st.port = null;
    dropWaiters();
    port.close().catch(() => {});
    setState("off");
    rdaReset();
    hint("The USB link to the Uno dropped (cable pulled out?). Plug it back in, then click Connect Uno.");
  }

  function unsupported() {
    setState("none");
    hint("This browser can't reach USB devices (Web Serial). Open this page in Chrome or Edge on a laptop. Without it, the text can still be changed from the Arduino IDE Serial Monitor (115200 baud, Newline): type M <text>.");
  }

  // ------------------------------------------------------------ transmitter buttons
  async function send() {
    const text = ui.text.value.trim();
    if (!text) { hint("The text is empty."); return; }
    if (/[^\x20-\x7e]/.test(text)) {
      hint("Use plain letters, digits, spaces and punctuation (ASCII). Characters like é or emoji can't be sent.");
      return;
    }
    const s = +ui.scheme.value, b = +ui.baud.value;
    st.busy = true; refresh(); hint("");
    try {
      // scheme and bit rate first: the Uno applies them from the next frame, which is the new text
      const ok = (await command("S" + s, (l) => /scheme -> /.test(l)))
        && (await command("R" + b, (l) => l.startsWith("baud -> ")))
        && (await command("M " + text, (l) => l.startsWith("sending text: ")));
      if (!ok) { hint(NO_REPLY); return; }
      tx.sent = text;
      syncDecoder(b);
      hint(`Sent. The Uno now transmits "${text}" with ${SCHEMES[s]} at ${b} baud, over and over. The decoder below is set to ${b} baud; press Microphone, and frames with the same text are marked "match".`, true);
    } finally {
      st.busy = false; refresh();
    }
  }

  async function simple(cmd, test, okMsg) {
    st.busy = true; refresh(); hint("");
    try {
      const line = await command(cmd, test);
      if (!line) hint(NO_REPLY);
      else if (okMsg) hint(okMsg, true);
    } finally {
      st.busy = false; refresh();
    }
  }

  // ------------------------------------------------------------ receiver buttons
  async function setLive(on) {
    const line = await command(on ? "RSSI1" : "RSSI0",
      (l) => l === "RSSI lines on" || l === "RSSI lines off" || l.startsWith("radio NOT FOUND"), 1500);
    if (!line) { rxHint(NO_REPLY); return false; }
    if (line.startsWith("radio NOT FOUND")) { rdaShow({ ok: false }); rxHint(NO_RADIO); return false; }
    return true;
  }

  async function toggleLive(on) {
    st.busy = true; refresh(); rxHint("");
    try { await setLive(on); } finally { st.busy = false; refresh(); }
  }

  async function tune() {
    const mhz = parseFloat(rx.freqIn.value);
    if (!(mhz >= 87.5 && mhz <= 108)) { rxHint("The frequency must be between 87.5 and 108 MHz."); return; }
    st.busy = true; refresh(); rxHint("");
    try {
      const line = await command("F" + Math.round(mhz * 10) * 10,
        (l) => l.startsWith("tuned ") || l.startsWith("radio NOT FOUND") || l.startsWith("use F"), 2000);
      if (!line) rxHint(NO_REPLY);
      else if (!line.startsWith("tuned ")) rxHint(line.startsWith("use F") ? "The frequency must be between 87.5 and 108 MHz." : NO_RADIO);
      else rxHint(`RDA tuned to ${line.match(/tuned (\d+\.\d+)/)[1]} MHz. The signal strength settles after about 0.5 s.`, true);
    } finally {
      st.busy = false; refresh();
    }
  }

  // Step through ±1.5 MHz around the current frequency. The RDA's RSSI needs about 0.4 s to settle after
  // a tune (the firmware's FIND reads too early, and one bad I2C read can win), so every channel waits
  // 0.78 s and keeps the median of the readings taken after 0.38 s.
  async function findTx() {
    if (st.state !== "on" || st.busy) return;
    const center = Math.round((rda.freq || parseFloat(rx.freqIn.value) || 100) * 10);
    const steps = [];
    for (let k = Math.max(875, center - 15); k <= Math.min(1080, center + 15); k++) steps.push(k / 10);
    st.busy = true; refresh(); rxHint("");
    rx.sweepLbl.textContent = "";
    const res = [];
    try {
      if (!rda.live && !(await setLive(true))) return;
      for (let i = 0; i < steps.length; i++) {
        const f = steps[i];
        rxHint(`Searching for the transmitter… ${f.toFixed(1)} MHz (${i + 1}/${steps.length})`);
        const line = await command("F" + Math.round(f * 100), (l) => l.startsWith("tuned ") || l.startsWith("radio NOT FOUND"), 2000);
        if (!line) { rxHint(NO_REPLY); return; }
        if (!line.startsWith("tuned ")) { rxHint(NO_RADIO); return; }
        rda.collect = { freq: f, from: performance.now() + 380, vals: [] };
        await sleep(780);
        const vals = rda.collect ? rda.collect.vals : [];
        rda.collect = null;
        res.push({ f, v: vals.length ? median(vals) : null });
        drawSweep(res, steps, -1);
      }
      let bi = -1;
      res.forEach((r, i) => { if (r.v !== null && (bi < 0 || r.v > res[bi].v)) bi = i; });
      if (bi < 0) { rxHint("No signal strength readings came in. Turn Live on, then try again."); return; }
      // a strong carrier fills 2-3 neighbouring channels with nearly the same RSSI: take the middle one
      const near = (i) => i >= 0 && i < res.length && res[i].v !== null && res[i].v >= res[bi].v - 3;
      let a = bi, z = bi;
      while (near(a - 1)) a--;
      while (near(z + 1)) z++;
      bi = Math.round((a + z) / 2);
      const best = res[bi];
      await command("F" + Math.round(best.f * 100), (l) => l.startsWith("tuned "), 2000);
      const rest = res.filter((r) => r.v !== null && Math.abs(r.f - best.f) > 0.25).map((r) => r.v);
      const base = rest.length ? median(rest) : null;
      drawSweep(res, steps, bi);
      rx.sweepLbl.textContent = `peak ${best.f.toFixed(1)} MHz`;
      if (base !== null && best.v - base >= 20) {
        rxHint(`Transmitter found at ${best.f.toFixed(1)} MHz: signal strength ${best.v}, other frequencies around ${base}. The RDA is now tuned there.`, true);
      } else {
        rxHint(`Strongest at ${best.f.toFixed(1)} MHz (${best.v}), but not far above the other frequencies (${base}). The transmitter may be off, its antenna loose, or its frequency more than 1.5 MHz from ${(center / 10).toFixed(1)} MHz. The RDA stays tuned to ${best.f.toFixed(1)} MHz.`);
      }
    } finally {
      rda.collect = null;
      st.busy = false; refresh();
    }
  }

  // ------------------------------------------------------------ wiring
  ui.text.addEventListener("input", count);
  ui.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ui.send.disabled) { e.preventDefault(); send(); } });
  ui.connect.addEventListener("click", connect);
  ui.disconnect.addEventListener("click", () => { hint(""); rxHint(""); disconnect(); });
  ui.send.addEventListener("click", send);
  ui.tone.addEventListener("click", () => simple("T1000", (l) => /^tone \d+ Hz$/.test(l),
    "The Uno sends a steady 1000 Hz tone. Find the beep on an FM radio, then click Back to data."));
  ui.data.addEventListener("click", () => simple("D", (l) => l === "data mode", "The Uno is transmitting data frames again."));
  ui.status.addEventListener("click", () => simple("?", (l) => STATUS_RE.test(l), ""));
  if (hasRx) {
    rx.live.addEventListener("click", () => toggleLive(!rda.live));
    rx.tune.addEventListener("click", tune);
    rx.freqIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !rx.tune.disabled) { e.preventDefault(); tune(); } });
    rx.find.addEventListener("click", findTx);
    window.addEventListener("resize", drawSpark);
  }

  count();
  if (navigator.serial && window.isSecureContext) {
    setState("off");
    navigator.serial.addEventListener("disconnect", (e) => { if (st.port && e.target === st.port) lost(); });
  } else {
    unsupported();
  }
})();
