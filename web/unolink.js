/* unolink.js: the "Pemancar" (transmitter) panel of the live demo.
   Talks to the Arduino Uno over USB with Web Serial (Chrome or Edge on a laptop; the page has to be
   served over https or from localhost). It sends the same lines you would type in the Arduino
   Serial Monitor (115200 baud, Newline):
     S0 / S1 / S2      scheme ASK / FSK / DBPSK
     R150 .. R1200     bit rate
     M <text>          message, up to 100 characters, saved in the Uno's EEPROM
     T1000, D, ?       1000 Hz tone (to find the transmitter on a radio), data mode, status
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

  const SCHEMES = ["ASK", "FSK", "DBPSK"];
  const COLORS = { ASK: "var(--amber)", FSK: "var(--cyan)", DBPSK: "var(--violet)" };
  // the Uno's status line, e.g.  tx    : DATA | frame TEXT "halo PDSK" | FSK | 300 baud
  const STATUS_RE = /^tx\s*:\s*(SWEEP|TONE (\d+) Hz|QUIET|DATA) \| frame (PRBS-9|TEXT "(.*)") \| (ASK|FSK|DBPSK) \| (\d+) baud$/;
  const NO_REPLY = "Uno tidak membalas. Cek kabel USB, lalu klik Putuskan dan Hubungkan Uno lagi.";
  const tx = (window.FMLinkTx = window.FMLinkTx || { sent: null });
  const st = { state: "off", port: null, reader: null, loop: null, buf: "", waiters: [], busy: false, closing: false };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ view
  function hint(msg, good) {
    ui.hint.textContent = msg || "";
    ui.hint.classList.toggle("show", !!msg);
    ui.hint.classList.toggle("good", !!(msg && good));
  }

  function setState(state) {
    st.state = state;
    const [label, cls] = {
      off: ["belum terhubung", "idle"],
      wait: ["menghubungkan…", "warn"],
      on: ["terhubung ke Uno", "ok"],
      none: ["perlu Chrome/Edge di laptop", "bad"],
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
    if (s.text !== undefined) ui.now.textContent = s.text === null ? "PRBS-9 (uji BER)" : `"${s.text}"`;
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

  // ------------------------------------------------------------ what the Uno says
  function parse(line) {
    let m = STATUS_RE.exec(line);
    if (m) {
      const s = {
        mode: m[1] === "DATA" ? "data" : m[1] === "QUIET" ? "diam" : m[1] === "SWEEP" ? "sweep" : `nada ${m[2]} Hz`,
        text: m[3] === "PRBS-9" ? null : m[4],
        scheme: m[5],
        baud: +m[6],
      };
      show(s);
      return s;
    }
    if ((m = /^sending text: (.*)$/.exec(line))) show({ mode: "data", text: m[1] });
    else if (line.startsWith("sending PRBS-9")) show({ mode: "data", text: null });
    else if ((m = /scheme -> (ASK|FSK|DBPSK)/.exec(line))) show({ scheme: m[1] });
    else if ((m = /^baud -> (\d+)/.exec(line))) show({ baud: +m[1] });
    else if ((m = /^tone (\d+) Hz$/.exec(line))) show({ mode: `nada ${m[1]} Hz` });
    else if (line === "data mode") show({ mode: "data" });
    else if (line === "quiet") show({ mode: "diam" });
    return null;
  }

  function onLine(line) {
    log(line, false);
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
      if (e && e.name === "NotFoundError") hint("Belum ada port yang dipilih. Klik Hubungkan Uno lagi, lalu pilih port Arduino (biasanya COM3).");
      else hint("Akses USB diblok di halaman ini. Buka https://arsa07lol.github.io/fmlink/web/ langsung di Chrome atau Edge.");
      return;
    }
    setState("wait");
    try {
      await port.open({ baudRate: 115200 });
    } catch (e) {
      setState("off");
      hint("Port tidak bisa dibuka. Tutup Serial Monitor Arduino IDE atau program lain yang sedang memakai port ini, lalu coba lagi.");
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
      hint("Port terbuka, tapi Uno tidak menjawab. Pastikan port yang dipilih adalah Arduino Uno dan firmware FM Link sudah ter-upload.");
      return;
    }
    const s = parse(line);
    fill(s);
    setState("on");
    hint(`Terhubung. Uno sedang memancarkan ${s.text === null ? "frame PRBS-9" : `"${s.text}"`} dengan ${s.scheme} ${s.baud} baud. Decoder di bawah ikut di-set ke ${s.baud} baud.`, true);
  }

  async function disconnect() {
    const port = st.port;
    if (!port) { setState(navigator.serial ? "off" : "none"); return; }
    st.closing = true;
    dropWaiters();
    try { if (st.reader) await st.reader.cancel(); } catch (e) { /* already gone */ }
    try { await st.loop; } catch (e) { /* ended */ }
    try { await port.close(); } catch (e) { /* already closed */ }
    st.port = null;
    st.loop = null;
    st.closing = false;
    setState("off");
  }

  function lost() {                                      // USB cable pulled while connected
    const port = st.port;
    if (!port) return;
    st.port = null;
    dropWaiters();
    port.close().catch(() => {});
    setState("off");
    hint("Sambungan USB ke Uno putus (kabel tercabut?). Colok lagi, lalu klik Hubungkan Uno.");
  }

  function unsupported() {
    setState("none");
    hint("Browser ini belum bisa mengakses USB (Web Serial). Buka halaman ini di Chrome atau Edge di laptop. Tanpa itu, teks tetap bisa diganti lewat Serial Monitor Arduino IDE (115200 baud, Newline): ketik M <teks>.");
  }

  // ------------------------------------------------------------ buttons
  async function send() {
    const text = ui.text.value.trim();
    if (!text) { hint("Teksnya masih kosong."); return; }
    if (/[^\x20-\x7e]/.test(text)) {
      hint("Pakai huruf, angka, spasi, dan tanda baca biasa saja (ASCII). Huruf seperti é atau emoji tidak bisa dikirim.");
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
      hint(`Terkirim. Uno sekarang memancarkan "${text}" dengan ${SCHEMES[s]} ${b} baud, berulang-ulang. Decoder di bawah sudah di-set ke ${b} baud; tekan Mikrofon, dan frame yang isinya sama ditandai "cocok".`, true);
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

  ui.text.addEventListener("input", count);
  ui.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ui.send.disabled) { e.preventDefault(); send(); } });
  ui.connect.addEventListener("click", connect);
  ui.disconnect.addEventListener("click", () => { hint(""); disconnect(); });
  ui.send.addEventListener("click", send);
  ui.tone.addEventListener("click", () => simple("T1000", (l) => /^tone \d+ Hz$/.test(l),
    "Uno mengirim nada 1000 Hz terus-menerus. Cari bunyi \"tiiit\" di radio FM, lalu klik Kembali ke data."));
  ui.data.addEventListener("click", () => simple("D", (l) => l === "data mode", "Uno kembali memancarkan frame data."));
  ui.status.addEventListener("click", () => simple("?", (l) => STATUS_RE.test(l), ""));

  count();
  if (navigator.serial && window.isSecureContext) {
    setState("off");
    navigator.serial.addEventListener("disconnect", (e) => { if (st.port && e.target === st.port) lost(); });
  } else {
    unsupported();
  }
})();
