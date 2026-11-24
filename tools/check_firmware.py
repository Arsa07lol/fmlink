#!/usr/bin/env python3
"""
check_firmware.py - firmware-in-the-loop test for fmlink_uno (no hardware needed)

1. Builds tools/sim_uno.cpp with g++. It runs the real fmlink_uno/fmlink_uno_core.h, so the
   samples are exactly what the Uno's timer interrupt writes to the PWM on D3.
2. Models the analog path: PWM average (zero-order hold) -> 2-stage RC filter loaded by RV1
   -> sound card at 48 kHz -> optional Uno clock error -> C3 high-pass -> 50 us de-emphasis -> noise.
3. Decodes with python/fmlink.py and checks scheme, PRBS bit errors and the text message.

Usage:  python tools/check_firmware.py          (needs g++ on PATH, numpy and scipy)
"""
import os, subprocess, sys, tempfile
import numpy as np
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import fmlink as fl   # noqa: E402

FS_UNO = 31250
OS = 8                        # analog model runs at 8 x 31 250 = 250 kHz
TEXT = "HALO PDSK 123"
SCHEME_ID = {"ASK": 0, "FSK": 1, "DBPSK": 2}


def build_sim(tmp):
    exe = os.path.join(tmp, "sim_uno.exe" if os.name == "nt" else "sim_uno")
    src = os.path.join(HERE, "sim_uno.cpp")
    subprocess.run(["g++", "-O2", "-std=c++11", "-o", exe, src], check=True)
    return exe


def run_sim(exe, tmp, scheme, baud, seconds, text):
    out = os.path.join(tmp, f"{scheme}_{baud}.u8")
    subprocess.run([exe, str(SCHEME_ID[scheme]), str(baud), f"{seconds:.3f}", out, text], check=True)
    return np.fromfile(out, dtype=np.uint8)


def analog_chain(u8, clock=1.0, snr_db=30.0, rng=None):
    x = (u8.astype(float) - 128.0) / 128.0
    x = np.repeat(x, OS)                                     # PWM duty held for one sample period
    a2, a1, a0 = fl.uno_filter_coeffs()
    b, a = signal.bilinear([a0], [a2, a1, a0], fs=FS_UNO * OS)
    x = signal.lfilter(b, a, x)                              # R1 C1 R2 C2 loaded by RV1
    y = signal.resample_poly(x, 24, 125)                     # 250 kHz -> 48 kHz sound card
    if clock != 1.0:                                         # Uno resonator fast (>1) or slow (<1)
        y = signal.resample(y, int(round(len(y) / clock)))
    bh, ah = signal.butter(1, 16, "highpass", fs=fl.FS)      # C3 1 uF into RV1 10k
    y = signal.lfilter(bh, ah, y)
    al = np.exp(-1 / (50e-6 * fl.FS))                        # receiver de-emphasis 50 us
    y = signal.lfilter([1 - al], [1, -al], y)
    band = fl.bandpass(y)
    sigma = np.sqrt(np.mean(band ** 2) / 10 ** (snr_db / 10) * (fl.FS / 2) / 3200)
    rng = rng or np.random.default_rng(7)
    return y + sigma * rng.standard_normal(len(y))


def check(exe, tmp, scheme, baud, clock=1.0, snr_db=30.0):
    frame_s = len(fl.build_frame("P")) / baud
    seconds = max(4.0, 7 * frame_s)                          # ~3 PRBS frames, then the text
    u8 = run_sim(exe, tmp, scheme, baud, seconds, TEXT)
    y = analog_chain(u8, clock, snr_db)
    got, frames = fl.decode(y, baud, "auto")
    pr = [f for f in frames if f["type"] == "PRBS"]
    tx = [f for f in frames if f["type"] == "TEXT"]
    good_txt = [f for f in tx if f["crc_ok"] and f["text"] == TEXT]
    errs = sum(f["errors"] for f in pr)
    ppm = int(np.median([f["clock_ppm"] for f in frames])) if frames else 0
    ok = got == scheme and len(pr) >= 2 and errs == 0 and len(good_txt) >= 1
    print(f"{scheme:6}{baud:>6}{(clock - 1) * 100:>+7.1f}%{snr_db:>6.0f}dB   {got:6}{len(pr):>5}{errs:>7}"
          f"{len(good_txt):>4}/{len(tx):<3}{ppm:>+8d}   {'OK' if ok else 'FAIL'}")
    return ok


def main():
    with tempfile.TemporaryDirectory() as tmp:
        exe = build_sim(tmp)
        print("Uno firmware core -> PWM/RC model -> 48 kHz -> de-emphasis + noise -> fmlink.py decoder\n")
        print("scheme  baud  clock   SNR   detect PRBS errors text  TX-ppm   result")
        allok = True
        for sch in fl.SCHEMES:
            for baud in (150, 300, 600, 1200):
                allok &= check(exe, tmp, sch, baud)
        for sch in fl.SCHEMES:                               # Uno resonator 0.5 % off
            for clk in (1.005, 0.995):
                allok &= check(exe, tmp, sch, 300, clock=clk)
                allok &= check(exe, tmp, sch, 1200, clock=clk)
        print("\nFIRMWARE CHECK", "PASSED" if allok else "FAILED")
        return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
