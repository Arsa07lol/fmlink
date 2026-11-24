# FM Multi-Mod Link

Digital data (ASK, FSK and DBPSK audio tones) sent over an FM broadcast-band link and measured end to end with a laptop.

**Website: https://arsa07lol.github.io/fmlink/** walks through the whole chain (frame, modulation, the Uno's DDS, the RC filter, FM, the channel, the receiver) and runs the decoder in the browser: point it at the laptop microphone, or play one of the included recordings.

One Arduino Uno does both ends of the bench setup. It generates the modulated tones for a small FM transmitter and it controls an RDA5807M FM receiver over I2C. The laptop records the receiver audio and a Python toolkit decodes the frames, counts bit errors and measures SNR, THD, frequency response and RSSI.

Course project for Fundamentals of Communication Systems (Dasar Sistem Komunikasi), PENS.

## How it works

```
Arduino Uno: 31.25 kHz DDS -> 62.5 kHz PWM on D3 -> 2-stage RC filter -> level trimmer -> FM transmitter
                                   ~~~ 88-108 MHz ~~~
RDA5807M receiver (I2C to the same Uno, RSSI readout) -> audio -> laptop mic input -> fmlink.py or the website
```

| Item | Value |
|---|---|
| FSK | mark 1200 Hz, space 2200 Hz, phase continuous |
| ASK / DBPSK | 1800 Hz carrier (DBPSK: a 0 flips the phase 180°) |
| Bit rates | 150, 300, 600, 1200 baud |
| Frame | 32-bit preamble, sync 0x2DD4, type, length, payload, CRC-8, 32 idle bits |
| BER test | PRBS-9 payload (511 bits) |

The decoder tracks the transmitter's real bit rate (±1 %). The Uno runs from a ceramic resonator that can be ~0.5 % off, and without tracking a 0.2 % error already slides the bit timing far enough to ruin a 600-bit frame.

## Folders

| Path | Contents |
|---|---|
| `fmlink_uno/` | Arduino Uno firmware (TX audio + RDA5807M control) |
| `python/fmlink.py` | Laptop toolkit: record, decode, BER, SNR, sweep, spectrum, RSSI, live view, plots, WAV generator |
| `web/` | The website and its in-browser decoder (a JavaScript port of the Python decoder; both give the same result on the recordings in `web/audio/`) |
| `tools/` | PC simulator of the firmware core, a firmware-in-the-loop test, the website build script |
| `fmlink_tx/`, `fmlink_rx/` | Earlier STM32 transmitter and Uno-only receiver versions (archive) |
| `photos/` | Build photos |
| `results/`, `report/` | Measurement data and the report (added after the measurements) |

## Quick start

Run the commands from the repository root.

1. Open `fmlink_uno/fmlink_uno.ino` in the Arduino IDE, select Arduino Uno, upload.
2. Serial Monitor at 115200 baud, line ending Newline, type `?`.
3. `pip install numpy sounddevice pyserial matplotlib`
4. `python python/fmlink.py selftest` checks the decoder without hardware.
5. `python python/fmlink.py decode --device N` decodes the receiver audio (`devices` lists N).

Website on your own laptop: `python -m http.server 8765`, then open http://localhost:8765/web/. The microphone only works on localhost or https, not from a `file://` page. `web/selftest.html` checks the browser decoder. After editing `web/site.html`, run `python tools/build_web.py` to rebuild `web/index.html`.

## Status (24 Nov 2026)

- The transmit chain works on air: Uno, RC filter, trimmer, S-151 FM transmitter, received on a phone FM radio.
- First end-to-end decode: "halo PDSK" text frames at 300 baud went through the phone radio and its speaker into the laptop mic. Frames with CRC OK / CRC failed: FSK 6 / 2, ASK 14 / 3, DBPSK 12 / 4. The recordings are in `web/audio/`.
- The first RDA5807M module answers on I2C but its RF front end is dead (RSSI 2-3 on every channel, about 10 with the transmitter 10-30 cm away). Replacement modules are on the way; the official measurements follow.
