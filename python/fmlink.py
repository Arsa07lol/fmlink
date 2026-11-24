#!/usr/bin/env python3
"""
fmlink.py - laptop toolkit for the FM Multi-Mod Link project
=============================================================
Records the RDA5807M audio from the USB sound card, decodes ASK / FSK / DBPSK frames
sent by the Arduino Uno (fmlink_uno), counts bit errors, measures SNR / THD / frequency
response, logs RSSI and draws every graph for the report.

Install once:   pip install numpy sounddevice pyserial matplotlib

Commands (run "python fmlink.py <command> -h" for options):
  devices                       list audio inputs and serial ports
  selftest                      simulate the whole link (no hardware) and check the decoder
  record  --out x.wav           record raw audio to a WAV file
  decode  [--wav x.wav]         record (or load) and print every decoded frame
  ber     --distance 2          record, decode PRBS frames, append BER to results/ber.csv
  snr     --distance 2          Uno sends T1000; measures SNR/THD, appends results/snr.csv
  rssi    --port COM3 --distance 2   averages the RDA5807M RSSI, appends results/rssi.csv
  scan    --port COM3           scans 87.5-108 MHz, lists the emptiest channels
  send    --port COM3 FIND      sends one command to the Uno without resetting it, prints the reply
  sweep                         Uno sends W; measures audio frequency response
  spectrum [--wav x.wav]        plots the spectrum of the received audio
  live    [--port COM3]         live demo dashboard: decoded text, BER history, RSSI, spectrum
  plot                          makes every report graph from results/*.csv
  gen     --scheme FSK --text halo   writes the same signal as the firmware to a WAV (phone = TX)
  gen     --all                 writes the whole test-audio set (ask/fsk/dbpsk x prbs/text, tone, sweep)

The decoder follows the transmitter's real bit rate: the Uno's 16 MHz ceramic resonator can be
off by up to 0.5 %, which would otherwise slide the bit timing by several bits over one frame.
"""
import argparse, csv, os, sys, time, threading, wave
from datetime import datetime
import numpy as np

# ---------------- link parameters (must match fmlink_uno/fmlink_uno_core.h) ----------------
FS = 48000                             # recording rate (the Uno generates at 31 250 Hz; tones and baud are what matter)
MAX_TEXT = 100                         # Uno limit
F_MARK, F_SPACE, F_CARRIER = 1200, 2200, 1800
SYNC_WORD = 0x2DD4
TYPE_TEXT, TYPE_PRBS = 0x3C, 0xC3      # differ in all 8 bits
PRBS_BYTES = 64
PREAMBLE_BITS, IDLE_BITS = 32, 32
SCHEMES = ["ASK", "FSK", "DBPSK"]
RESULTS = "results"


def bits_of(value, n):
    return [(value >> (n - 1 - i)) & 1 for i in range(n)]


SYNC_PATTERN = np.array([1, 0] * 4 + bits_of(SYNC_WORD, 16))   # last 8 preamble bits + sync


def prbs9_bits():
    s, out = 0x1FF, []
    for _ in range(511):
        out.append(s & 1)
        nb = ((s >> 8) ^ (s >> 4)) & 1
        s = ((s << 1) | nb) & 0x1FF
    return np.array(out + [0])          # 512 bits = 64 bytes


PRBS = prbs9_bits()


def crc8(data):
    c = 0
    for d in data:
        c ^= d
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def bytes_to_bits(bs):
    out = []
    for b in bs:
        out += bits_of(b, 8)
    return out


def bits_to_bytes(bits):
    return [int("".join(str(int(b)) for b in bits[i:i + 8]), 2) for i in range(0, len(bits) - 7, 8)]


# ---------------- transmitter model (mirror of the Uno firmware) ----------------
def build_frame(kind="P", text=""):
    if kind == "P":
        payload = bits_to_bytes(PRBS)
        hdr = [TYPE_PRBS, PRBS_BYTES]
    else:
        payload = list(text.encode("latin-1", "replace"))[:MAX_TEXT]
        hdr = [TYPE_TEXT, len(payload)]
    body = hdr + payload
    return ([1, 0] * (PREAMBLE_BITS // 2) + bits_of(SYNC_WORD, 16) + bytes_to_bits(body)
            + bits_of(crc8(body), 8) + [1] * IDLE_BITS)


def modulate(bits, scheme, baud, fs=FS, clock=1.0):
    """Audio for `bits`. clock != 1 models a transmitter whose clock runs fast (>1) or slow (<1):
    every tone and the bit rate are scaled by it, like an Uno with an off-nominal resonator."""
    bits = np.asarray(bits, dtype=int)
    rate = baud * clock
    n = np.arange(int(np.ceil(len(bits) * fs / rate)))
    bi = np.minimum((n * rate / fs).astype(int), len(bits) - 1)   # bit index of every sample
    b = bits[bi].astype(float)
    if scheme == "FSK":
        f = np.where(b > 0, F_MARK, F_SPACE) * clock
        return np.sin(2 * np.pi * np.cumsum(f) / fs)                # phase-continuous
    if scheme == "ASK":
        return b * np.sin(2 * np.pi * F_CARRIER * clock * n / fs)
    flips = np.cumsum(bits == 0) % 2                                # DBPSK: each 0 flips the phase
    return np.sin(2 * np.pi * F_CARRIER * clock * n / fs + np.pi * flips[bi])


# ---------------- receiver DSP ----------------
def bandpass(x, fs=FS, lo=400, hi=3600):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / fs)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def mix_avg(x, f, spb, fs=FS):
    """Mix tone f down to 0 Hz and average over one bit. Output[i] covers x[i : i+spb]."""
    n = np.arange(len(x))
    z = x * np.exp(-2j * np.pi * f * n / fs)
    c = np.concatenate([[0], np.cumsum(z)])
    return (c[spb:] - c[:-spb]) / spb


def soft_bits(x, scheme, spb):
    """Per-sample soft decision in about -1..+1; positive = bit 1. Index = bit start sample."""
    eps = 1e-12
    if scheme == "FSK":
        a, b = np.abs(mix_avg(x, F_MARK, spb)), np.abs(mix_avg(x, F_SPACE, spb))
        return (a - b) / (a + b + eps)
    if scheme == "ASK":
        e = np.abs(mix_avg(x, F_CARRIER, spb))
        thr = 0.5 * np.percentile(e, 90) + eps
        return np.clip((e - thr) / thr, -1, 1)
    z = mix_avg(x, F_CARRIER, spb)
    d = z[spb:] * np.conj(z[:-spb])
    s = np.real(d) / (np.abs(d) + eps)
    return np.concatenate([np.zeros(spb), s])


def find_frames(soft, spb):
    """Search every bit-timing offset for preamble+sync; keep the best timing per frame."""
    pat = 2 * SYNC_PATTERN - 1
    L = len(pat)
    cands = []
    step = max(1, spb // 16)
    for off in range(0, spb, step):
        idx = np.arange(off, len(soft), spb)
        s = soft[idx]
        if len(s) < L + 24:
            continue
        sign = np.where(s > 0, 1, -1)
        corr = np.correlate(sign, pat, "valid")
        for j in np.nonzero(corr >= L - 2)[0]:          # at most 1 wrong bit in 24
            margin = float(np.sum(np.abs(s[j:j + L])))
            cands.append((int(idx[j]), off, int(j), margin))
    cands.sort()
    frames, group = [], []
    for c in cands:
        if group and c[0] - group[-1][0] > 4 * spb:
            frames.append(max(group, key=lambda g: g[3])); group = []
        group.append(c)
    if group:
        frames.append(max(group, key=lambda g: g[3]))
    return frames


def hamming8(a, b):
    return bin((a ^ b) & 0xFF).count("1")


CLOCK_SEARCH = np.linspace(-0.010, 0.010, 41)     # TX clock errors tried by the decoder (+-1 %)


def bit_timing(soft, start, spb):
    """Best (first-bit sample, bit period) for the bits that follow `start`. Tries bit periods
    spb*(1+e) for e in CLOCK_SEARCH plus small start shifts and keeps the one with the clearest
    decisions (largest mean |soft|). This follows a transmitter whose clock is a bit off."""
    per = spb * (1 + CLOCK_SEARCH)
    shifts = np.arange(-2, 3) * max(1, spb // 16)
    n = int(min(600, (len(soft) - 1 - start - shifts[-1]) // per.max()))
    if n < len(SYNC_PATTERN) + 16:
        return float(start), float(spb)
    k = np.arange(n)
    P = np.repeat(per, len(shifts))
    D = np.tile(shifts, len(per))
    idx = np.clip(np.rint(start + D[:, None] + k[None, :] * P[:, None]).astype(int), 0, len(soft) - 1)
    best = int(np.argmax(np.mean(np.abs(soft[idx]), axis=1)))
    return float(start + D[best]), float(P[best])


def sample_bits(soft, t0, per, nbits):
    idx = np.rint(t0 + np.arange(nbits) * per).astype(int)
    return soft[idx[(idx >= 0) & (idx < len(soft))]]


def parse_frame(soft, spb, cand):
    pos, off, j, margin = cand
    t0, per = bit_timing(soft, pos, spb)
    k = len(SYNC_PATTERN)                            # bits are counted from the pattern start
    s = sample_bits(soft, t0, per, k + 16 + 255 * 8 + 8)
    bits = (s > 0).astype(int)
    clock_ppm = int(round((spb / per - 1) * 1e6))   # + = transmitter clock runs fast
    if k + 16 > len(bits):
        return None
    typ, ln = bits_to_bytes(bits[k:k + 16])
    if hamming8(typ, TYPE_PRBS) <= 3:
        typ, ln = TYPE_PRBS, PRBS_BYTES
    elif hamming8(typ, TYPE_TEXT) <= 3:
        typ = TYPE_TEXT
    else:
        return {"pos": pos, "type": "?", "ok": False}
    end = k + 16 + ln * 8 + 8
    if end > len(bits):
        return None                                   # frame cut off by the recording edge
    payload_bits = bits[k + 16:k + 16 + ln * 8]
    payload = bits_to_bytes(payload_bits)
    crc_rx = bits_to_bytes(bits[end - 8:end])[0]
    crc_ok = crc8([typ, ln] + payload) == crc_rx
    q = float(np.mean(np.abs(s[k:end])))             # decision quality 0..1
    if typ == TYPE_PRBS:
        errs = int(np.sum(payload_bits[:511] != PRBS[:511]))
        return {"pos": pos, "type": "PRBS", "bits": 511, "errors": errs, "crc_ok": crc_ok, "quality": q,
                "clock_ppm": clock_ppm, "ok": True}
    text = bytes(payload).decode("latin-1", "replace")
    return {"pos": pos, "type": "TEXT", "text": text, "crc_ok": crc_ok, "quality": q,
            "clock_ppm": clock_ppm, "ok": True}


def decode(x, baud=300, scheme="auto", fs=FS):
    """Returns (scheme, list_of_frames)."""
    if fs != FS:
        raise SystemExit(f"Please record at {FS} Hz (got {fs}).")
    spb = FS // baud
    x = bandpass(np.asarray(x, dtype=float))
    peak = np.percentile(np.abs(x), 99.5)
    if peak > 0:
        x = x / peak
    results = {}
    for sch in (SCHEMES if scheme == "auto" else [scheme]):
        soft = soft_bits(x, sch, spb)
        frames = [f for f in (parse_frame(soft, spb, c) for c in find_frames(soft, spb)) if f and f["ok"]]
        good = sum(1 for f in frames if f.get("crc_ok") or (f["type"] == "PRBS" and f["errors"] < 100))
        errs = sum(f.get("errors", 0) for f in frames)
        results[sch] = ((good, -errs), frames)
    best = max(results, key=lambda s: results[s][0])
    if scheme == "auto" and best == "ASK" and "DBPSK" in results:
        # An ASK detector can also "decode" DBPSK (the envelope dips at every phase flip),
        # but a DBPSK detector cannot decode real ASK (the "off" bits have no phase).
        # So if DBPSK decodes at least as many good frames, the signal is DBPSK.
        if results["DBPSK"][0][0] >= max(1, results["ASK"][0][0]):
            best = "DBPSK"
    return best, results[best][1]


# ---------------- audio I/O ----------------
def record(seconds, device=None):
    import sounddevice as sd
    print(f"Recording {seconds:.0f} s at {FS} Hz ...", flush=True)
    x = sd.rec(int(seconds * FS), samplerate=FS, channels=1, dtype="float32", device=device)
    sd.wait()
    x = x[:, 0].astype(float)
    pk = np.max(np.abs(x)) if len(x) else 0
    if pk > 0.98:
        print("WARNING: the recording clips (peak at full scale). Lower the mic gain or the RDA volume.")
    elif pk < 0.02:
        print("WARNING: very quiet recording. Check cables, the sound card input and the RDA volume.")
    return x


def load_wav(path):
    with wave.open(path, "rb") as w:
        fs, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    dt = {1: np.uint8, 2: np.int16, 4: np.int32}[sw]
    x = np.frombuffer(raw, dtype=dt).astype(float)
    if sw == 1:
        x -= 128
    x = x.reshape(-1, ch)[:, 0] / float(2 ** (8 * sw - 1))
    return x, fs


def save_wav(path, x, fs=FS):
    y = np.clip(np.asarray(x) / max(1e-9, np.max(np.abs(x))) * 0.9, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(fs)
        w.writeframes((y * 32767).astype(np.int16).tobytes())


def get_audio(args):
    if getattr(args, "wav", None):
        x, fs = load_wav(args.wav)
        return x, fs
    return record(args.seconds, args.device), FS


def append_csv(name, row):
    os.makedirs(RESULTS, exist_ok=True)
    path = os.path.join(RESULTS, name)
    new = not os.path.exists(path)
    with open(path, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(row.keys()))
        if new:
            w.writeheader()
        w.writerow(row)
    print(f"saved -> {path}")


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------- measurements ----------------
def tone_metrics(x, f0, fs=FS):
    x = np.asarray(x, dtype=float) - np.mean(x)
    w = np.hanning(len(x))
    P = np.abs(np.fft.rfft(x * w)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / fs)
    band = (f > 100) & (f < 8000)
    win = np.abs(f - f0) <= 0.03 * f0                # the Uno's clock can put the tone ~0.5 % off
    if win.any():
        f0 = float(f[win][np.argmax(P[win])])
    near = lambda fc: np.abs(f - fc) <= 15
    sig = P[near(f0)].sum()
    harm = sum(P[near(k * f0)].sum() for k in range(2, 6) if k * f0 < 8000)
    mask = band & ~near(f0)
    for k in range(2, 6):
        mask &= ~near(k * f0)
    noise = P[mask].sum() * (band.sum() / max(1, mask.sum()))
    db = lambda a: 10 * np.log10(max(a, 1e-20))
    return {"snr_db": round(db(sig) - db(noise), 2), "thd_pct": round(100 * np.sqrt(harm / max(sig, 1e-20)), 2),
            "sinad_db": round(db(sig) - db(noise + harm), 2),
            "level_dbfs": round(20 * np.log10(np.sqrt(np.mean(x ** 2)) * np.sqrt(2) + 1e-12), 2)}


def welch_db(x, fs=FS, n=8192):
    x = np.asarray(x, dtype=float)
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    w = np.hanning(n)
    P = np.zeros(n // 2 + 1); k = 0
    for st in range(0, len(x) - n + 1, n // 2):
        P += np.abs(np.fft.rfft(x[st:st + n] * w)) ** 2; k += 1
    P /= max(k, 1)
    return np.fft.rfftfreq(n, 1 / fs), 10 * np.log10(P / P.max() + 1e-15)


# ---------------- serial (Arduino) ----------------
BANNER = "--- FM Multi-Mod Link"            # first line the Uno prints after a reset


def open_serial(port, rssi=True):
    """Open the Uno's port with DTR off, so the Uno normally does NOT reset. If it still resets,
    the firmware reloads its settings from EEPROM (tone/quiet/sweep mode goes back to data)."""
    import serial
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 0.2
    s.dtr = False
    s.rts = False
    s.open()
    time.sleep(0.3)
    s.reset_input_buffer()
    if rssi:
        s.write(b"RSSI1\n")
    return s


def close_serial(ser, rssi=True):
    try:
        if rssi:
            ser.write(b"RSSI0\n")
            time.sleep(0.05)
        ser.close()
    except Exception:
        pass


def read_rssi(ser, seconds):
    vals, t0 = [], time.time()
    while time.time() - t0 < seconds:
        line = ser.readline().decode(errors="ignore").strip()
        if line.startswith(BANNER):                    # the Uno reset after all: ask again
            print("note: the Uno reset when the port opened (settings come back from EEPROM)")
            time.sleep(0.2)
            ser.write(b"RSSI1\n")
        elif line.startswith("RSSI,"):
            p = line.split(",")
            if len(p) >= 4:
                vals.append(int(p[3]))
    return vals


# ---------------- Uno audio filter (for theory curves and the firmware simulation) ----------------
def uno_filter_coeffs(R1=1500.0, C1=10e-9, R2=1500.0, C2=10e-9, RL=10e3):
    """Denominator (a2, a1, a0) of H(s) = 1 / (a2 s^2 + a1 s + a0) for the D3 filter:
    R1 -> C1 to GND -> R2 -> C2 to GND, loaded by the 10k trimmer RV1 (C3 is a short at audio)."""
    k, m = R2 / RL, R1 / R2
    return R1 * C1 * R2 * C2, (1 + k) * R1 * C1 + (1 + m) * R2 * C2, 1 + k * (1 + m)


def uno_filter_db(f):
    """Each RC stage alone has fc = 10.6 kHz, but the two stages load each other:
    the pair is about -3 dB at 5.0 kHz (relative to DC). 1200 / 1800 / 2200 Hz lose 0.23 / 0.51 / 0.75 dB;
    the PWM carrier at 62.5 kHz drops about 29 dB."""
    a2, a1, a0 = uno_filter_coeffs()
    s = 2j * np.pi * np.asarray(f, dtype=float)
    return 20 * np.log10(np.abs(a0 / (a2 * s ** 2 + a1 * s + a0)))


# ---------------- signal generator (phone or laptop as the transmitter) ----------------
def tx_signal(kind, scheme, baud, seconds, text=""):
    frame = build_frame("P") if kind == "P" else build_frame("T", text)
    reps = max(1, int(np.ceil(seconds * baud / len(frame))))
    return modulate(frame * reps, scheme, baud)


def tone_signal(hz, seconds):
    return np.sin(2 * np.pi * hz * np.arange(int(seconds * FS)) / FS)


def sweep_signal(seconds):
    """Same pattern as the firmware's W command: 1 s quiet, then 15 tones x 600 ms, repeating."""
    one = np.concatenate([np.zeros(FS)] + [tone_signal(hz, 0.6) for hz in SWEEP_HZ])
    reps = max(1, int(np.ceil(seconds * FS / len(one))))
    return np.tile(one, reps)[:max(len(one), int(seconds * FS))]


# ---------------- commands ----------------
def cmd_gen(a):
    if a.all:
        os.makedirs(a.out_dir, exist_ok=True)
        made = []
        for sch in SCHEMES:
            for kind in ("P", "T"):
                name = f"{sch.lower()}_{'prbs' if kind == 'P' else 'text'}_{a.baud}.wav"
                save_wav(os.path.join(a.out_dir, name), tx_signal(kind, sch, a.baud, a.seconds, a.text or "HALO PDSK"))
                made.append(name)
        save_wav(os.path.join(a.out_dir, "tone_1000.wav"), tone_signal(1000, a.seconds)); made.append("tone_1000.wav")
        save_wav(os.path.join(a.out_dir, "sweep.wav"), sweep_signal(a.seconds)); made.append("sweep.wav")
        print(f"wrote {len(made)} files ({a.seconds:g} s each, {FS} Hz) to {a.out_dir}: " + ", ".join(made))
        return
    if a.tone:
        x, what = tone_signal(a.tone, a.seconds), f"tone {a.tone:g} Hz"
    elif a.sweep:
        x, what = sweep_signal(a.seconds), "sweep"
    else:
        x = tx_signal("T" if a.text else "P", a.scheme, a.baud, a.seconds, a.text)
        what = f"{a.scheme} {a.baud} baud " + (f'TEXT "{a.text[:MAX_TEXT]}"' if a.text else "PRBS-9")
    save_wav(a.out, x)
    print(f"saved {a.out}: {what}, {len(x) / FS:.1f} s at {FS} Hz")
    if a.play:
        import sounddevice as sd
        print("playing ... (Ctrl+C to stop)")
        sd.play(0.9 * x / max(1e-9, np.max(np.abs(x))), FS, device=a.device)
        sd.wait()


def cmd_send(a):
    cmd = " ".join(a.command)
    secs = a.seconds if a.seconds else {"SCAN": 45, "FIND": 8}.get(cmd.upper(), 2)
    ser = open_serial(a.port, rssi=False)
    ser.write((cmd + "\n").encode("latin-1", "replace"))
    t0, resent = time.time(), False
    while time.time() - t0 < secs:
        line = ser.readline().decode(errors="ignore").rstrip()
        if not line:
            continue
        print(line)
        # The Uno reset and lost the command. The status from "?" starts with the banner too,
        # so never resend "?" (after a reset the Uno prints that same status anyway).
        if line.startswith(BANNER) and not resent and cmd.strip() != "?":
            resent = True
            time.sleep(0.3)
            ser.write((cmd + "\n").encode("latin-1", "replace"))
        if line == "SCANDONE":
            break
    close_serial(ser, rssi=False)


def cmd_devices(a):
    try:
        import sounddevice as sd
        print(sd.query_devices())
        print("\nUse --device <number> to pick the USB sound card's input.")
    except Exception as e:
        print("sounddevice not available:", e)
    try:
        from serial.tools import list_ports
        print("\nSerial ports:")
        for p in list_ports.comports():
            print(" ", p.device, "-", p.description)
    except Exception as e:
        print("pyserial not available:", e)


def cmd_selftest(a):
    rng = np.random.default_rng(1)
    print("Simulated link: Uno frames -> de-emphasis + noise -> decoder")
    print("clock = transmitter clock error (the Uno's resonator can be ~0.5 % off)\n")
    print(f"{'scheme':7}{'baud':>6}{'Eb/N0':>7}{'clock':>8}{'frames':>8}{'BER':>11}{'  text frame'}")
    allok = True
    cases = [(sch, baud, ebn0, 1.0) for sch in SCHEMES for baud in (300, 1200) for ebn0 in (14, 8)]
    cases += [(sch, 300, 14, clk) for sch in SCHEMES for clk in (1.005, 0.995)]
    for sch, baud, ebn0, clk in cases:
        bits = build_frame("P") * 3 + build_frame("T", "HELLO PDSK") * 2
        x = modulate(bits, sch, baud, clock=clk)
        y = np.zeros_like(x); a1 = np.exp(-1 / (50e-6 * FS))      # 50 us de-emphasis
        acc = 0.0
        for i, v in enumerate(x):
            acc = a1 * acc + (1 - a1) * v; y[i] = acc
        y /= np.std(y) * np.sqrt(2)
        spb = FS // baud
        eb = 0.5 * spb * (0.5 if sch == "ASK" else 1)
        sigma = np.sqrt(eb / 10 ** (ebn0 / 10) / 2)
        y = np.concatenate([np.zeros(3000), y, np.zeros(3000)]) + sigma * rng.standard_normal(len(y) + 6000)
        got, frames = decode(y, baud)
        pr = [f for f in frames if f["type"] == "PRBS"]
        tx = [f for f in frames if f["type"] == "TEXT"]
        nb = sum(f["bits"] for f in pr); ne = sum(f["errors"] for f in pr)
        ber = ne / nb if nb else float("nan")
        good_txt = [f for f in tx if f["crc_ok"] and f["text"] == "HELLO PDSK"]
        txt = tx[0]["text"] if tx else "-"
        ok = got == sch and len(pr) == 3 and len(tx) == 2
        if ebn0 >= 14:
            ok = ok and len(good_txt) == 2 and ber < 1e-3
            allok &= ok
        print(f"{sch:7}{baud:>6}{ebn0:>6}dB{(clk - 1) * 100:>+7.1f}%{len(pr) + len(tx):>6}/5{ber:>11.2e}  {txt}  "
              f"{'OK' if ok else 'check'}" + ("" if got == sch else f" (detected {got})"))
    print("\nSELFTEST", "PASSED" if allok else "FAILED (see rows marked check at 14 dB)")


def cmd_record(a):
    x = record(a.seconds, a.device)
    save_wav(a.out, x)
    print("saved", a.out)


def print_frames(sch, frames, t0=None):
    if not frames:
        print("No frames found. Check: Uno in data mode (D), same baud (--baud), audio level, frequency (FIND).")
        return
    print(f"scheme detected: {sch}")
    for f in frames:
        t = f["pos"] / FS
        if f["type"] == "PRBS":
            print(f"  t={t:6.2f}s  PRBS  {f['errors']:3d}/511 bit errors  BER={f['errors'] / 511:.2e}  "
                  f"quality={f['quality']:.2f}  TX clock {f['clock_ppm']:+d} ppm")
        else:
            print(f"  t={t:6.2f}s  TEXT  \"{f['text']}\"  CRC {'OK' if f['crc_ok'] else 'FAIL'}  "
                  f"TX clock {f['clock_ppm']:+d} ppm")


def cmd_decode(a):
    x, fs = get_audio(a)
    if a.save:
        save_wav(a.save, x, fs)
    sch, frames = decode(x, a.baud, a.scheme, fs)
    print_frames(sch, frames)


def cmd_ber(a):
    x, fs = get_audio(a)
    if a.save:
        save_wav(a.save, x, fs)
    sch, frames = decode(x, a.baud, a.scheme, fs)
    print_frames(sch, frames)
    pr = [f for f in frames if f["type"] == "PRBS"]
    expected = int(len(x) / fs / ((len(build_frame("P"))) / a.baud))
    nb = sum(f["bits"] for f in pr); ne = sum(f["errors"] for f in pr)
    ber = ne / nb if nb else ""
    clock = int(np.median([f["clock_ppm"] for f in pr])) if pr else ""
    print(f"\nRESULT {sch} @ {a.baud} baud, {a.distance} m: {ne}/{nb} errors, BER={ber if ber == '' else f'{ber:.2e}'}, "
          f"frames found {len(pr)} of ~{expected}")
    append_csv("ber.csv", {"time": now(), "distance_m": a.distance, "scheme": sch, "baud": a.baud,
                           "frames": len(pr), "frames_expected": expected, "bits": nb, "errors": ne,
                           "ber": ber, "clock_ppm": clock, "note": a.note})


def cmd_snr(a):
    x, fs = get_audio(a)
    m = tone_metrics(x, a.tone, fs)
    print(f"SNR {m['snr_db']} dB | THD {m['thd_pct']} % | SINAD {m['sinad_db']} dB | level {m['level_dbfs']} dBFS")
    append_csv("snr.csv", {"time": now(), "distance_m": a.distance, "tone_hz": a.tone, **m, "note": a.note})


def cmd_rssi(a):
    ser = open_serial(a.port)
    vals = read_rssi(ser, a.seconds)
    close_serial(ser)
    if not vals:
        print("No RSSI lines received. Is fmlink_uno.ino running, the port right, and 'radio : OK' in '?'?"); return
    print(f"RSSI mean {np.mean(vals):.1f}, std {np.std(vals):.1f}, n={len(vals)}")
    append_csv("rssi.csv", {"time": now(), "distance_m": a.distance, "rssi_mean": round(float(np.mean(vals)), 2),
                            "rssi_std": round(float(np.std(vals)), 2), "samples": len(vals), "note": a.note})


def cmd_scan(a):
    print("Switch your FM transmitter OFF for the scan, so it does not hide a busy channel.")
    ser = open_serial(a.port, rssi=False)
    ser.write(b"SCAN\n")
    res, t0 = [], time.time()
    while time.time() - t0 < 90:
        line = ser.readline().decode(errors="ignore").strip()
        if line.startswith(BANNER):                    # the Uno reset: send the command again
            time.sleep(0.2); ser.write(b"SCAN\n"); res = []
        elif line.startswith("SCAN,"):
            _, f, r = line.split(","); res.append((int(f), int(r)))
            print(f"\r{int(f) / 100:.1f} MHz  RSSI {r}   ", end="", flush=True)
        elif line.startswith("radio NOT FOUND"):
            print(line); break
        if line == "SCANDONE":
            break
    close_serial(ser, rssi=False)
    print()
    if not res:
        print("No scan data."); return
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "scan.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["freq_10khz", "rssi"]); w.writerows(res)
    quiet = sorted(res, key=lambda t: t[1])
    # prefer channels whose neighbours (+-200 kHz) are also quiet
    d = dict(res)
    score = sorted(res, key=lambda t: max(d.get(t[0] + k, 0) for k in (-20, -10, 0, 10, 20)))
    print("Emptiest channels (pick one far from real stations):")
    for f, r in score[:8]:
        print(f"  {f / 100:.1f} MHz   RSSI {r}   -> Arduino command F{f}")
    if a.plot:
        import matplotlib.pyplot as plt
        f, r = zip(*res)
        plt.figure(figsize=(10, 3.5)); plt.plot(np.array(f) / 100, r)
        plt.xlabel("MHz"); plt.ylabel("RSSI"); plt.title("FM band scan"); plt.grid(alpha=.3); plt.tight_layout(); plt.show()


SWEEP_HZ = [100, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000]


def cmd_sweep(a):
    x, fs = get_audio(a)
    n = 4096
    w = np.hanning(n)
    f = np.fft.rfftfreq(n, 1 / fs)
    frames = [np.abs(np.fft.rfft(x[i:i + n] * w)) ** 2 for i in range(0, len(x) - n, n // 4)]
    S = np.array(frames)
    lv = {}
    for hz in SWEEP_HZ:
        b = np.abs(f - hz) <= max(2 * fs / n, 0.012 * hz)     # allow for the Uno's clock error
        lv[hz] = 10 * np.log10(S[:, b].sum(axis=1).max() + 1e-20)
    ref = lv[1000]
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "sweep.csv"), "w", newline="") as fh:
        wr = csv.writer(fh); wr.writerow(["freq_hz", "level_db_rel_1k"])
        for hz in SWEEP_HZ:
            wr.writerow([hz, round(lv[hz] - ref, 2)])
            print(f"{hz:6d} Hz  {lv[hz] - ref:+6.1f} dB")
    print("saved -> results/sweep.csv  (run 'plot' for the graph)")


def cmd_spectrum(a):
    import matplotlib.pyplot as plt
    x, fs = get_audio(a)
    f, P = welch_db(x, fs)
    plt.figure(figsize=(10, 4)); plt.plot(f, P)
    for t, c in ((F_MARK, "C1"), (F_CARRIER, "C2"), (F_SPACE, "C3")):
        plt.axvline(t, color=c, ls=":", lw=1)
    plt.xlim(0, a.fmax); plt.ylim(-90, 3); plt.grid(alpha=.3)
    plt.xlabel("Frequency (Hz)"); plt.ylabel("dB (relative)"); plt.title(a.title or "Received audio spectrum")
    plt.tight_layout()
    if a.png:
        os.makedirs(RESULTS, exist_ok=True); plt.savefig(os.path.join(RESULTS, a.png), dpi=150); print("saved", a.png)
    plt.show()


def cmd_live(a):
    import sounddevice as sd
    import matplotlib.pyplot as plt
    buf_len = int(a.window * FS)
    ring = np.zeros(buf_len)
    state = {"total": 0, "rssi": [], "lock": threading.Lock(), "run": True}

    def cb(indata, frames, t, status):
        with state["lock"]:
            ring[:-frames] = ring[frames:]
            ring[-frames:] = indata[:, 0]
            state["total"] += frames

    def serial_thread():
        try:
            ser = open_serial(a.port)
        except Exception as e:
            print("RSSI disabled:", e); return
        while state["run"]:
            line = ser.readline().decode(errors="ignore").strip()
            if line.startswith(BANNER):
                time.sleep(0.2); ser.write(b"RSSI1\n")
            elif line.startswith("RSSI,"):
                p = line.split(",")
                state["rssi"].append((time.time(), int(p[3])))
                state["rssi"] = state["rssi"][-600:]
        close_serial(ser)

    if a.port:
        threading.Thread(target=serial_thread, daemon=True).start()
    seen, ber_hist, texts = set(), [], []
    t_start = time.time()
    plt.ion()
    fig, ax = plt.subplots(3, 1, figsize=(10, 8))
    fig.canvas.manager.set_window_title("FM Multi-Mod Link - live")
    stream = sd.InputStream(samplerate=FS, channels=1, dtype="float32", callback=cb, device=a.device, blocksize=2048)
    stream.start()
    print("Live. Close the window or press Ctrl+C to stop.")
    try:
        while plt.fignum_exists(fig.number):
            plt.pause(a.every)
            with state["lock"]:
                x = ring.copy(); total = state["total"]
            if total < FS:
                continue
            start_abs = total - buf_len
            sch, frames = decode(x, a.baud, a.scheme)
            for fr in frames:
                key = (start_abs + fr["pos"]) // (FS // a.baud * 16)
                if key in seen or key - 1 in seen or key + 1 in seen:
                    continue
                seen.add(key)
                tt = time.time() - t_start
                if fr["type"] == "PRBS":
                    ber_hist.append((tt, fr["errors"] / 511, sch))
                    print(f"[{tt:6.1f}s] {sch} PRBS {fr['errors']}/511 errors")
                else:
                    texts.append(f"[{tt:5.0f}s] {fr['text']}" + ("" if fr["crc_ok"] else "  (CRC FAIL)"))
                    print(texts[-1])
            for axx in ax:
                axx.cla()
            f, P = welch_db(x[-FS * 2:])
            ax[0].plot(f, P); ax[0].set_xlim(0, 4000); ax[0].set_ylim(-80, 3)
            ax[0].set_title(f"Received audio  |  scheme {sch}  |  {texts[-1] if texts else 'no text yet'}")
            ax[0].set_xlabel("Hz")
            if ber_hist:
                t, b, _ = zip(*ber_hist)
                ax[1].semilogy(t, np.maximum(b, 1 / 511 / 2), "o-")
            ax[1].set_ylim(5e-4, 1); ax[1].set_ylabel("BER per frame"); ax[1].grid(alpha=.3, which="both")
            if state["rssi"]:
                tr = [r[0] - t_start for r in state["rssi"]]; rv = [r[1] for r in state["rssi"]]
                ax[2].plot(tr, rv)
            ax[2].set_ylabel("RSSI"); ax[2].set_xlabel("time (s)"); ax[2].grid(alpha=.3)
            fig.tight_layout()
    except KeyboardInterrupt:
        pass
    finally:
        state["run"] = False
        stream.stop(); stream.close()


def read_csv(name):
    p = os.path.join(RESULTS, name)
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return list(csv.DictReader(f))


def cmd_plot(a):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    out = os.path.join(RESULTS, "figures"); os.makedirs(out, exist_ok=True)
    made = []

    rows = read_csv("ber.csv")
    if rows:
        plt.figure(figsize=(7, 4.5))
        for sch in SCHEMES:
            for baud in sorted({r["baud"] for r in rows}):
                pts = {}
                for r in rows:
                    if r["scheme"] == sch and r["baud"] == baud and r["bits"] not in ("", "0"):
                        d = float(r["distance_m"]); pts.setdefault(d, [0, 0])
                        pts[d][0] += int(r["errors"]); pts[d][1] += int(r["bits"])
                if pts:
                    d = sorted(pts); b = [max(pts[k][0] / pts[k][1], 0.5 / pts[k][1]) for k in d]
                    plt.semilogy(d, b, "o-", label=f"{sch} {baud} baud")
        plt.xlabel("Distance (m)"); plt.ylabel("Bit error rate"); plt.grid(alpha=.3, which="both")
        plt.title("BER vs distance"); plt.legend(); plt.tight_layout()
        plt.savefig(os.path.join(out, "ber_vs_distance.png"), dpi=150); made.append("ber_vs_distance.png")

        plt.figure(figsize=(7, 4.5))
        for sch in SCHEMES:
            pts = {}
            for r in rows:
                if r["scheme"] == sch and r["bits"] not in ("", "0") and "rate" in r.get("note", ""):
                    k = int(r["baud"]); pts.setdefault(k, [0, 0]); pts[k][0] += int(r["errors"]); pts[k][1] += int(r["bits"])
            if pts:
                k = sorted(pts); plt.semilogy(k, [max(pts[i][0] / pts[i][1], 0.5 / pts[i][1]) for i in k], "o-", label=sch)
        if plt.gca().lines:
            plt.xscale("log", base=2); plt.xlabel("Bit rate (baud)"); plt.ylabel("BER"); plt.legend(); plt.grid(alpha=.3, which="both")
            plt.title("BER vs bit rate (rows with note 'rate')"); plt.tight_layout()
            plt.savefig(os.path.join(out, "ber_vs_baud.png"), dpi=150); made.append("ber_vs_baud.png")
        plt.close("all")

    rows = read_csv("snr.csv")
    dist_rows = [r for r in rows if "level" not in r.get("note", "")]
    if dist_rows:
        d = [float(r["distance_m"]) for r in dist_rows]; s = [float(r["snr_db"]) for r in dist_rows]
        o = np.argsort(d)
        plt.figure(figsize=(7, 4.5)); plt.plot(np.array(d)[o], np.array(s)[o], "o-")
        plt.xlabel("Distance (m)"); plt.ylabel("SNR (dB)"); plt.title("Audio SNR vs distance (1 kHz tone)")
        plt.grid(alpha=.3); plt.tight_layout(); plt.savefig(os.path.join(out, "snr_vs_distance.png"), dpi=150)
        made.append("snr_vs_distance.png"); plt.close("all")
    lvl = [r for r in rows if "level" in r.get("note", "")]
    if lvl:
        plt.figure(figsize=(7, 4.5))
        steps = [r["note"] for r in lvl]
        plt.plot(range(len(lvl)), [float(r["thd_pct"]) for r in lvl], "o-", label="THD %")
        plt.plot(range(len(lvl)), [float(r["sinad_db"]) for r in lvl], "s-", label="SINAD dB")
        plt.xticks(range(len(lvl)), steps, rotation=30, ha="right")
        plt.title("Over-deviation: trimmer position vs distortion"); plt.legend(); plt.grid(alpha=.3); plt.tight_layout()
        plt.savefig(os.path.join(out, "overdeviation.png"), dpi=150); made.append("overdeviation.png"); plt.close("all")

    rows = read_csv("rssi.csv")
    if rows:
        d = np.array([float(r["distance_m"]) for r in rows]); m = np.array([float(r["rssi_mean"]) for r in rows])
        sd_ = np.array([float(r["rssi_std"]) for r in rows]); o = np.argsort(d)
        plt.figure(figsize=(7, 4.5)); plt.errorbar(d[o], m[o], yerr=sd_[o], fmt="o-", capsize=3)
        plt.xscale("log"); plt.xlabel("Distance (m, log scale)"); plt.ylabel("RSSI (RDA5807M units, ~dB)")
        if len(set(d)) >= 2 and np.all(d > 0):
            k, c = np.polyfit(np.log10(d), m, 1)
            xx = np.logspace(np.log10(d.min()), np.log10(d.max()), 50)
            plt.plot(xx, k * np.log10(xx) + c, "--", label=f"fit: {k:.1f} per decade (free space ≈ -20)")
            plt.legend()
        plt.title("Received signal strength vs distance"); plt.grid(alpha=.3, which="both"); plt.tight_layout()
        plt.savefig(os.path.join(out, "rssi_vs_distance.png"), dpi=150); made.append("rssi_vs_distance.png"); plt.close("all")

    rows = read_csv("sweep.csv")
    if rows:
        f = [float(r["freq_hz"]) for r in rows]; l = [float(r["level_db_rel_1k"]) for r in rows]
        fx = np.logspace(2, np.log10(12000), 100)
        de = -10 * np.log10(1 + (2 * np.pi * fx * 50e-6) ** 2)
        rc = uno_filter_db(fx)
        plt.figure(figsize=(7, 4.5)); plt.semilogx(f, l, "o-", label="measured")
        plt.semilogx(fx, de - np.interp(1000, fx, de), "--", label="50 µs de-emphasis (theory)")
        plt.semilogx(fx, de + rc - np.interp(1000, fx, de + rc), ":",
                     label="de-emphasis + Uno RC filter (theory, Uno as source)")
        plt.xlabel("Audio frequency (Hz)"); plt.ylabel("dB relative to 1 kHz"); plt.legend()
        plt.title("FM link audio frequency response"); plt.grid(alpha=.3, which="both"); plt.tight_layout()
        plt.savefig(os.path.join(out, "frequency_response.png"), dpi=150); made.append("frequency_response.png"); plt.close("all")

    rows = read_csv("scan.csv")
    if rows:
        plt.figure(figsize=(10, 3.5))
        plt.plot([int(r["freq_10khz"]) / 100 for r in rows], [int(r["rssi"]) for r in rows])
        plt.xlabel("MHz"); plt.ylabel("RSSI"); plt.title("FM band scan (RDA5807M)"); plt.grid(alpha=.3); plt.tight_layout()
        plt.savefig(os.path.join(out, "band_scan.png"), dpi=150); made.append("band_scan.png"); plt.close("all")

    print("made:", ", ".join(made) if made else "nothing yet (no CSV files in results/)")
    print("folder:", out)


def main():
    p = argparse.ArgumentParser(description="FM Multi-Mod Link laptop toolkit")
    sub = p.add_subparsers(dest="cmd", required=True)

    def audio_opts(sp, seconds):
        sp.add_argument("--wav", help="analyse a WAV file instead of recording")
        sp.add_argument("--seconds", type=float, default=seconds)
        sp.add_argument("--device", type=int, default=None, help="audio input number from 'devices'")

    sp = sub.add_parser("devices"); sp.set_defaults(fn=cmd_devices)
    sp = sub.add_parser("selftest"); sp.set_defaults(fn=cmd_selftest)
    sp = sub.add_parser("record"); sp.add_argument("--out", default="recording.wav"); sp.add_argument("--seconds", type=float, default=10)
    sp.add_argument("--device", type=int, default=None); sp.set_defaults(fn=cmd_record)
    for name, fn, secs in (("decode", cmd_decode, 8), ("ber", cmd_ber, 12)):
        sp = sub.add_parser(name); audio_opts(sp, secs)
        sp.add_argument("--baud", type=int, default=300); sp.add_argument("--scheme", default="auto", choices=["auto"] + SCHEMES)
        sp.add_argument("--save", help="also save the recording as WAV")
        if name == "ber":
            sp.add_argument("--distance", type=float, required=True); sp.add_argument("--note", default="")
        sp.set_defaults(fn=fn)
    sp = sub.add_parser("snr"); audio_opts(sp, 4); sp.add_argument("--tone", type=float, default=1000)
    sp.add_argument("--distance", type=float, default=0); sp.add_argument("--note", default=""); sp.set_defaults(fn=cmd_snr)
    sp = sub.add_parser("rssi"); sp.add_argument("--port", required=True); sp.add_argument("--distance", type=float, required=True)
    sp.add_argument("--seconds", type=float, default=10); sp.add_argument("--note", default=""); sp.set_defaults(fn=cmd_rssi)
    sp = sub.add_parser("scan"); sp.add_argument("--port", required=True); sp.add_argument("--plot", action="store_true"); sp.set_defaults(fn=cmd_scan)
    sp = sub.add_parser("sweep"); audio_opts(sp, 12); sp.set_defaults(fn=cmd_sweep)
    sp = sub.add_parser("spectrum"); audio_opts(sp, 4); sp.add_argument("--fmax", type=float, default=5000)
    sp.add_argument("--title", default=""); sp.add_argument("--png", default=""); sp.set_defaults(fn=cmd_spectrum)
    sp = sub.add_parser("live"); sp.add_argument("--port"); sp.add_argument("--device", type=int, default=None)
    sp.add_argument("--baud", type=int, default=300); sp.add_argument("--scheme", default="auto", choices=["auto"] + SCHEMES)
    sp.add_argument("--window", type=float, default=8.0); sp.add_argument("--every", type=float, default=2.0); sp.set_defaults(fn=cmd_live)
    sp = sub.add_parser("plot"); sp.set_defaults(fn=cmd_plot)
    sp = sub.add_parser("gen", help="write the transmitter signal to a WAV (phone or laptop as TX)")
    sp.add_argument("--scheme", default="FSK", choices=SCHEMES)
    sp.add_argument("--baud", type=int, default=300, choices=[150, 300, 600, 1200])
    sp.add_argument("--text", default="", help="send this text (default: PRBS-9 test frames)")
    sp.add_argument("--tone", type=float, default=0, help="a plain tone instead, e.g. 1000")
    sp.add_argument("--sweep", action="store_true", help="the W sweep instead")
    sp.add_argument("--seconds", type=float, default=30)
    sp.add_argument("--out", default="tx.wav")
    sp.add_argument("--play", action="store_true", help="also play it on the laptop's speaker / output")
    sp.add_argument("--device", type=int, default=None, help="output device number for --play")
    sp.add_argument("--all", action="store_true", help="write the whole test set into --out-dir")
    sp.add_argument("--out-dir", default="test-audio")
    sp.set_defaults(fn=cmd_gen)
    sp = sub.add_parser("send", help="send one command to the Uno without resetting it")
    sp.add_argument("--port", required=True)
    sp.add_argument("--seconds", type=float, default=0, help="how long to print replies (auto)")
    sp.add_argument("command", nargs="+", help='e.g. FIND, T1000, S2, "M halo dunia", "?"')
    sp.set_defaults(fn=cmd_send)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
