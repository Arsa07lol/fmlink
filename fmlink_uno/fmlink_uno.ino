/*
  fmlink_uno.ino - FM Multi-Mod Link on ONE Arduino Uno:
                   makes the ASK / FSK / DBPSK audio for the FM transmitter (TX)
                   and controls the RDA5807M FM receiver over I2C (RX).
  Board : Arduino Uno R3 (ATmega328P, 16 MHz). Arduino IDE: Tools > Board > Arduino Uno.
          Keep fmlink_uno_core.h next to this file.

  Wiring
    TX audio : D3 -> R1 1.5k -> point A -> R2 1.5k -> point B
               point A -> C1 10 nF -> GND, point B -> C2 10 nF -> GND
               point B -> C3 10 uF electrolytic (1 uF is fine too, + leg here) -> RV1 pin 1, RV1 pin 3 -> GND
               RV1 wiper (pin 2) -> FM transmitter audio input, Uno GND -> transmitter GND
    RX radio : A4 (SDA) -> level shifter HV1, LV1 -> RDA5807M SDIO
               A5 (SCL) -> level shifter HV2, LV2 -> RDA5807M SCLK
               5V -> shifter HV, 3.3V -> shifter LV and RDA5807M VCC, every GND together
    Optional : D2 -> push button -> GND (cycles ASK -> FSK -> DBPSK)
               D13 LED "L" blinks 1/2/3 times = ASK/FSK/DBPSK (data mode only)
  Nothing on pins 0 and 1 (USB serial). RESET must NOT be wired to GND.

  Timers: Timer2 = 62.5 kHz 8-bit PWM on D3. Timer1 = 31 250 Hz sample interrupt, locked to
  Timer2 (exactly 2 PWM periods per sample, so the audio has no timing jitter). Timer0 = millis().
  So: no analogWrite() on pins 3, 9, 10, 11, no tone(), no Servo library.

  Serial Monitor: 115200 baud, line ending "Newline". Commands (upper or lower case):
    TX  P            send the PRBS-9 test frame over and over (for BER)
        M <text>     send a text message over and over (max 100 characters)
        S0 S1 S2     scheme ASK / FSK / DBPSK (switches at the start of the next frame)
        R150 R300 R600 R1200   bit rate (switches at the start of the next frame)
        T<hz>        continuous tone 50..12000 Hz, e.g. T1000 (SNR and deviation tests)
        W            sweep: 1 s quiet, then 15 tones x 600 ms (100 Hz .. 12 kHz), repeating
        Q            quiet (no audio)
        D            back to data mode
    RX  F<10 kHz>    tune, e.g. F10390 = 103.90 MHz (8750..10800)
        V0..V15      receiver volume
        SCAN         RSSI of every channel 87.5..108 MHz -> SCAN,<freq>,<rssi>
        FIND         check +-1.5 MHz around the current frequency, tune to the strongest
                     channel (the transmitter drifts when its battery runs down)
        MONO1 MONO0  force mono on / off
        RSSI1 RSSI0  print RSSI,<ms>,<freq>,<rssi>,<fm_true>,<stereo> every 100 ms on / off
        I2C          list every I2C address that answers (wiring check)
        REG          raw RDA5807M registers, read via 0x11 and 0x10 (debug)
        WR <r> <v>   write one RDA5807M register, hex, 02..07, e.g. WR 05 8888 (debug)
        ?            status and help
  Frequency, volume, mono, scheme, bit rate and the PRBS/text choice are saved in EEPROM,
  so a reset (for example when a program opens the serial port) keeps them.
*/
#include <Wire.h>
#include <EEPROM.h>
#include "fmlink_uno_core.h"
using namespace fl;

const uint8_t AUDIO_PIN = 3;    // OC2B
const uint8_t BTN_PIN = 2;
const uint8_t LED_PIN = 13;

const uint8_t RDA_SEQ = 0x10;   // sequential access: reads start at register 0x0A
const uint8_t RDA_RND = 0x11;   // random access: write one register

// ---------------- settings kept in EEPROM ----------------
struct Settings {
  uint8_t  magic, version;
  uint16_t freq;                // 10 kHz units
  uint8_t  volume, mono;
  uint8_t  scheme;
  uint16_t baud;
  uint8_t  kind;                // 0 = PRBS, 1 = TEXT
  uint8_t  textLen;
};
const uint8_t EE_MAGIC = 0xF7, EE_VERSION = 1;
const int EE_SETTINGS = 0;
const int EE_TEXT = 16;         // message bytes at 16 .. 115
static Settings cfg;

// ---------------- TX state ----------------
static Frame frameA, frameB;
static Modulator mod;
static const Frame *latest = &frameA;   // frame most recently queued (shown by "?")
static uint16_t toneHz = 1000;

static const uint16_t SWEEP_HZ[] = {100, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000};
static const uint8_t SWEEP_N = sizeof(SWEEP_HZ) / sizeof(SWEEP_HZ[0]);
static bool sweeping = false;
static int8_t sweepIdx = -1;
static uint32_t sweepT = 0;

// ---------------- RX state ----------------
static bool radioOK = false;
static bool rssiLines = false;
static uint32_t tRssi = 0;

static char line[112];
static uint8_t lineLen = 0;

// ================= audio: Timer1 interrupt writes the Timer2 PWM duty =================
ISR(TIMER1_COMPA_vect) {
  static uint8_t nextSample = 128;
  OCR2B = nextSample;           // first thing, so the write always lands in the same PWM period
  nextSample = mod.next();
}

static void startAudio() {
  noInterrupts();
  pinMode(AUDIO_PIN, OUTPUT);
  // Timer2: fast PWM, TOP 0xFF, non-inverting on OC2B (D3), no prescaler -> 62.5 kHz
  TCCR2B = 0;
  TCCR2A = _BV(COM2B1) | _BV(WGM21) | _BV(WGM20);
  TIMSK2 = 0;
  OCR2B = 128;
  TCNT2 = 0;
  // Timer1: CTC, TOP = OCR1A = 511, no prescaler -> 31 250 Hz = exactly 2 PWM periods
  TCCR1B = 0;
  TCCR1A = 0;
  OCR1A = 511;
  TCNT1 = 510;                  // phase: the interrupt fires just after Timer2 wraps to 0
  TIFR1 = _BV(OCF1A);
  TIMSK1 = _BV(OCIE1A);
  TCCR2B = _BV(CS20);           // start both back to back: their phase never changes after this
  TCCR1B = _BV(WGM12) | _BV(CS10);
  interrupts();
}

// 16/32-bit values shared with the interrupt are written with interrupts off
static void queueFrame(const Frame *f) { noInterrupts(); mod.pending = f; interrupts(); latest = f; }
static void queueBaud(uint16_t b) { noInterrupts(); mod.nextBaud = b; interrupts(); }
static void setTone(uint16_t hz) {
  uint32_t st = phaseStep(hz);
  noInterrupts(); mod.toneStep = st; interrupts();
}

// The buffer that is not playing. A swap that has not happened yet is cancelled first, so that
// buffer can be rewritten safely (the interrupt only ever reads `active`).
static Frame *idleFrame() {
  noInterrupts();
  mod.pending = 0;
  const Frame *a = mod.active;
  interrupts();
  return (a == &frameA) ? &frameB : &frameA;
}

// ================= settings =================
static bool validBaud(long b) { return b == 150 || b == 300 || b == 600 || b == 1200; }

static void saveSettings() { EEPROM.put(EE_SETTINGS, cfg); }   // put() only rewrites changed bytes

static void loadSettings() {
  EEPROM.get(EE_SETTINGS, cfg);
  bool ok = cfg.magic == EE_MAGIC && cfg.version == EE_VERSION &&
            cfg.freq >= 8750 && cfg.freq <= 10800 && cfg.volume <= 15 && cfg.mono <= 1 &&
            cfg.scheme <= 2 && validBaud(cfg.baud) && cfg.kind <= 1 && cfg.textLen <= MAX_TEXT;
  if (!ok) {                    // first run (or old data): defaults
    cfg.magic = EE_MAGIC; cfg.version = EE_VERSION;
    cfg.freq = 10390; cfg.volume = 8; cfg.mono = 1;
    cfg.scheme = FSK; cfg.baud = 300; cfg.kind = 0; cfg.textLen = 0;
    saveSettings();
  }
}

static void buildStartFrame() {
  if (cfg.kind == 1 && cfg.textLen > 0) {
    char t[MAX_TEXT];
    for (uint8_t i = 0; i < cfg.textLen; i++) t[i] = (char)EEPROM.read(EE_TEXT + i);
    buildFrame(frameA, TYPE_TEXT, (const uint8_t *)t, cfg.textLen);
  } else {
    buildPrbsFrame(frameA);
  }
  latest = &frameA;
}

static void sendPrbs() {
  Frame *f = idleFrame();
  buildPrbsFrame(*f);
  queueFrame(f);
  cfg.kind = 0;
  saveSettings();
}

static void sendText(const char *t, uint8_t n) {
  if (n > MAX_TEXT) n = MAX_TEXT;
  Frame *f = idleFrame();
  buildFrame(*f, TYPE_TEXT, (const uint8_t *)t, n);
  queueFrame(f);
  for (uint8_t i = 0; i < n; i++) EEPROM.update(EE_TEXT + i, (uint8_t)t[i]);
  cfg.kind = 1; cfg.textLen = n;
  saveSettings();
}

// ================= RDA5807M =================
static void printMHz(uint16_t f10k) {
  Serial.print(f10k / 100);
  Serial.print('.');
  uint8_t r = f10k % 100;
  if (r < 10) Serial.print('0');
  Serial.print(r);
}

static bool rdaWrite(uint8_t reg, uint16_t val) {
  Wire.beginTransmission(RDA_RND);
  Wire.write(reg);
  Wire.write((uint8_t)(val >> 8));
  Wire.write((uint8_t)(val & 0xFF));
  return Wire.endTransmission() == 0;
}

static bool rdaStatus(uint16_t &r0a, uint16_t &r0b) {      // registers 0x0A and 0x0B
  if (Wire.requestFrom(RDA_SEQ, (uint8_t)4) != 4) return false;
  r0a = (uint16_t)Wire.read() << 8; r0a |= Wire.read();
  r0b = (uint16_t)Wire.read() << 8; r0b |= Wire.read();
  return true;
}

static uint8_t rdaRssi() {                                  // 0..127, 255 = read failed
  uint16_t a, b;
  return rdaStatus(a, b) ? (uint8_t)(b >> 9) : 255;
}

static void rdaSetReg02() {
  // DHIZ (audio on) | DMUTE (unmuted) | MONO | NEW_METHOD | ENABLE
  rdaWrite(0x02, 0xC000 | (cfg.mono ? 0x2000 : 0) | 0x0004 | 0x0001);
}

static void rdaVolume(uint8_t v) { rdaWrite(0x05, 0x8880 | (v & 0x0F)); }   // INT_MODE, SEEKTH 8, LNAP

// Tunes to the nearest 100 kHz channel and returns the frequency actually tuned (10 kHz units)
static uint16_t rdaTune(uint16_t f10k) {
  if (f10k < 8750) f10k = 8750;
  if (f10k > 10800) f10k = 10800;
  uint16_t chan = (f10k - 8700) / 10;                       // band 87-108 MHz, 100 kHz spacing
  rdaWrite(0x03, (chan << 6) | 0x0010);                     // TUNE=1, BAND=00, SPACE=00
  uint32_t t0 = millis();
  uint16_t a, b;
  while (millis() - t0 < 300) {                             // wait for Seek/Tune Complete
    if (rdaStatus(a, b) && (a & 0x4000)) break;
    delay(5);
  }
  return 8700 + chan * 10;
}

static bool radioInit() {
  Wire.beginTransmission(RDA_RND);
  radioOK = (Wire.endTransmission() == 0);
  if (!radioOK) return false;
  rdaWrite(0x02, 0x0002);       // soft reset
  delay(50);
  rdaSetReg02();                // power up
  delay(600);                   // crystal start-up
  rdaWrite(0x04, 0x0800);       // DE=1: 50 us de-emphasis, soft mute off, AFC on
  rdaVolume(cfg.volume);
  cfg.freq = rdaTune(cfg.freq);
  return true;
}

static uint8_t rssiAvg(uint8_t n) {
  uint16_t sum = 0;
  uint8_t got = 0;
  for (uint8_t i = 0; i < n; i++) {
    uint8_t r = rdaRssi();
    if (r != 255) { sum += r; got++; }
    delay(10);
  }
  return got ? (uint8_t)(sum / got) : 0;
}

static bool needRadio() {
  if (radioOK) return true;
  Serial.println(F("radio NOT FOUND - type I2C to check the wiring, then ? to retry"));
  return false;
}

static void scanBand() {
  if (!needRadio()) return;
  bool keep = rssiLines; rssiLines = false;
  Serial.println(F("SCANSTART"));
  for (uint16_t f = 8750; f <= 10800; f += 10) {
    rdaTune(f);
    delay(40);
    uint8_t r = rssiAvg(4);
    Serial.print(F("SCAN,")); Serial.print(f); Serial.print(','); Serial.println(r);
  }
  Serial.println(F("SCANDONE"));
  rdaTune(cfg.freq);
  rssiLines = keep;
}

static void findStrongest() {
  if (!needRadio()) return;
  bool keep = rssiLines; rssiLines = false;
  uint16_t lo = (cfg.freq >= 8750 + 150) ? cfg.freq - 150 : 8750;
  uint16_t hi = (cfg.freq + 150 <= 10800) ? cfg.freq + 150 : 10800;
  uint16_t best = cfg.freq;
  uint8_t bestR = 0;
  for (uint16_t f = lo; f <= hi; f += 10) {
    rdaTune(f);
    delay(40);
    uint8_t r = rssiAvg(3);
    Serial.print(F("FIND,")); Serial.print(f); Serial.print(','); Serial.println(r);
    if (r > bestR) { bestR = r; best = f; }
  }
  cfg.freq = rdaTune(best);
  saveSettings();
  Serial.print(F("strongest: ")); printMHz(cfg.freq);
  Serial.print(F(" MHz, RSSI ")); Serial.print(bestR); Serial.println(F(" -> tuned"));
  rssiLines = keep;
}

static void i2cScan() {
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("I2C device at 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      found++;
    }
  }
  Serial.print(F("I2C scan done: ")); Serial.print(found);
  Serial.println(F(" found (an RDA5807M answers at 0x10 and 0x11)"));
  if (Wire.getWireTimeoutFlag()) {
    Serial.println(F("I2C timed out: SDA or SCL stuck low - check the level shifter wiring"));
    Wire.clearWireTimeoutFlag();
  }
}

// Random access read of one register through 0x11 (write the address, repeated start, read 2 bytes)
static bool rdaReadReg(uint8_t reg, uint16_t &val) {
  Wire.beginTransmission(RDA_RND);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(RDA_RND, (uint8_t)2) != 2) return false;
  val = (uint16_t)Wire.read() << 8; val |= Wire.read();
  return true;
}

static void printHex4(uint16_t v) {
  if (v < 0x1000) Serial.print('0');
  if (v < 0x100) Serial.print('0');
  if (v < 0x10) Serial.print('0');
  Serial.print(v, HEX);
}

static void printRegName(uint8_t r) {
  Serial.print(' ');
  if (r < 0x10) Serial.print('0');
  Serial.print(r, HEX);
  Serial.print('=');
}

// REG: raw RDA5807M registers, read two ways, to debug reception
static void dumpRegs() {
  static const uint8_t regs[] = {0x00, 0x02, 0x03, 0x04, 0x05, 0x0A, 0x0B};
  Serial.print(F("REG rnd"));
  for (uint8_t i = 0; i < sizeof(regs); i++) {
    uint16_t v;
    printRegName(regs[i]);
    if (rdaReadReg(regs[i], v)) printHex4(v); else Serial.print(F("----"));
  }
  Serial.println();
  Serial.print(F("REG seq"));
  if (Wire.requestFrom(RDA_SEQ, (uint8_t)12) == 12) {
    for (uint8_t r = 0x0A; r <= 0x0F; r++) {
      uint16_t v = (uint16_t)Wire.read() << 8; v |= Wire.read();
      printRegName(r); printHex4(v);
    }
  } else {
    Serial.print(F(" read failed"));
  }
  Serial.println();
}

static void printRssiLine() {
  uint16_t a, b;
  if (!rdaStatus(a, b)) { Serial.println(F("ERR,read failed")); return; }
  Serial.print(F("RSSI,")); Serial.print(millis());
  Serial.print(','); Serial.print(cfg.freq);
  Serial.print(','); Serial.print(b >> 9);
  Serial.print(','); Serial.print((b >> 8) & 1);
  Serial.print(','); Serial.println((a >> 10) & 1);
}

// ================= status and commands =================
static void printStatus() {
  Serial.println(F("--- FM Multi-Mod Link (Uno) ---"));
  Serial.print(F("tx    : "));
  if (sweeping) Serial.print(F("SWEEP"));
  else if (mod.mode == MODE_TONE) { Serial.print(F("TONE ")); Serial.print(toneHz); Serial.print(F(" Hz")); }
  else if (mod.mode == MODE_SILENT) Serial.print(F("QUIET"));
  else Serial.print(F("DATA"));
  Serial.print(F(" | frame "));
  if (latest->b[6] == TYPE_PRBS) {
    Serial.print(F("PRBS-9"));
  } else {
    Serial.print(F("TEXT \""));
    for (uint8_t i = 0; i < latest->b[7]; i++) Serial.print((char)latest->b[8 + i]);
    Serial.print('"');
  }
  Serial.print(F(" | ")); Serial.print(schemeName(cfg.scheme));
  Serial.print(F(" | ")); Serial.print(cfg.baud); Serial.println(F(" baud"));
  Serial.print(F("radio : "));
  if (radioOK) {
    Serial.print(F("OK, ")); printMHz(cfg.freq);
    Serial.print(F(" MHz, RSSI ")); Serial.print(rdaRssi());
    Serial.print(F(", vol ")); Serial.print(cfg.volume);
    Serial.println(cfg.mono ? F(", mono") : F(", stereo"));
  } else {
    Serial.println(F("NOT FOUND - check SDA/SCL, 3.3V, GND, level shifter, RDA solder (type I2C)"));
  }
  Serial.println(F("TX cmd: P | M <text> | S0 S1 S2 | R150 R300 R600 R1200 | T<hz> | W | Q | D"));
  Serial.println(F("RX cmd: F<10kHz> e.g. F10390 | V0..V15 | SCAN | FIND | MONO1 MONO0 | RSSI1 RSSI0 | I2C | REG | ?"));
}

static void handleLine(char *s) {
  while (*s == ' ' || *s == '\t') s++;
  uint8_t n = strlen(s);
  while (n && (s[n - 1] == ' ' || s[n - 1] == '\t')) s[--n] = 0;
  if (n == 0) return;
  char up[8];                                   // upper-case copy of a short command
  uint8_t k = 0;
  for (; k < sizeof(up) - 1 && s[k]; k++) up[k] = toupper(s[k]);
  up[k] = 0;
  bool whole = (k == n);                        // the whole line fits in `up`
  long v = atol(up + 1);

  if (whole && !strcmp(up, "SCAN")) { scanBand(); return; }
  if (whole && !strcmp(up, "FIND")) { findStrongest(); return; }
  if (whole && !strcmp(up, "I2C")) { i2cScan(); return; }
  if (whole && !strcmp(up, "REG")) { dumpRegs(); return; }
  if (up[0] == 'W' && up[1] == 'R' && up[2] == ' ') {    // WR <reg hex> <value hex>: raw write, for debugging
    char *e;
    unsigned long reg = strtoul(s + 3, &e, 16);
    unsigned long val = strtoul(e, NULL, 16);
    if (!radioOK || reg < 0x02 || reg > 0x07) { Serial.println(F("use: WR <02..07> <hex value> (radio must be OK)")); return; }
    bool ok = rdaWrite((uint8_t)reg, (uint16_t)val);
    Serial.print(F("WR")); printRegName((uint8_t)reg); printHex4((uint16_t)val);
    Serial.println(ok ? F(" ok") : F(" FAILED"));
    return;
  }
  if (whole && (!strcmp(up, "MONO1") || !strcmp(up, "MONO0"))) {
    cfg.mono = (up[4] == '1'); saveSettings();
    if (radioOK) rdaSetReg02();
    Serial.println(cfg.mono ? F("mono on") : F("mono off"));
    return;
  }
  if (whole && (!strcmp(up, "RSSI1") || !strcmp(up, "RSSI0"))) {
    rssiLines = (up[4] == '1');
    if (rssiLines && !radioOK) Serial.println(F("radio NOT FOUND, no RSSI lines"));
    else Serial.println(rssiLines ? F("RSSI lines on") : F("RSSI lines off"));
    return;
  }

  switch (up[0]) {
    case 'M': {
      char *t = s + 1;
      while (*t == ' ') t++;
      uint8_t len = strlen(t);
      if (len == 0) { Serial.println(F("use: M <text>")); return; }
      if (len > MAX_TEXT) { len = MAX_TEXT; Serial.println(F("text cut to 100 characters")); }
      sweeping = false; mod.mode = MODE_DATA;
      sendText(t, len);
      Serial.print(F("sending text: "));
      for (uint8_t i = 0; i < len; i++) Serial.print(t[i]);
      Serial.println();
      break;
    }
    case 'P':
      sweeping = false; mod.mode = MODE_DATA;
      sendPrbs();
      Serial.println(F("sending PRBS-9 test frames"));
      break;
    case 'S':
      if (n == 2 && up[1] >= '0' && up[1] <= '2') {
        cfg.scheme = (uint8_t)(up[1] - '0');
        mod.nextScheme = cfg.scheme;              // applied at the next frame start
        saveSettings();
        Serial.print(F("scheme -> ")); Serial.print(schemeName(cfg.scheme)); Serial.println(F(" (from the next frame)"));
      } else Serial.println(F("use S0 (ASK), S1 (FSK) or S2 (DBPSK)"));
      break;
    case 'R':
      if (validBaud(v)) {
        cfg.baud = (uint16_t)v; queueBaud(cfg.baud); saveSettings();
        Serial.print(F("baud -> ")); Serial.print(cfg.baud); Serial.println(F(" (from the next frame)"));
      } else Serial.println(F("use R150, R300, R600 or R1200"));
      break;
    case 'T': {
      long hz = (n > 1) ? v : 1000;
      if (hz < 50 || hz > 12000) { Serial.println(F("tone must be 50..12000 Hz, e.g. T1000")); return; }
      sweeping = false; toneHz = (uint16_t)hz; setTone(toneHz); mod.mode = MODE_TONE;
      Serial.print(F("tone ")); Serial.print(toneHz); Serial.println(F(" Hz"));
      break;
    }
    case 'W':
      sweeping = true; sweepIdx = -1; sweepT = millis(); mod.mode = MODE_SILENT;
      Serial.println(F("sweep: 1 s quiet, then 15 tones x 600 ms, repeating"));
      break;
    case 'Q':
      sweeping = false; mod.mode = MODE_SILENT; Serial.println(F("quiet"));
      break;
    case 'D':
      sweeping = false; mod.mode = MODE_DATA; Serial.println(F("data mode"));
      break;
    case 'F':
      if (!needRadio()) return;
      if (v < 8750 || v > 10800) { Serial.println(F("use F<10 kHz units>, e.g. F10390 = 103.90 MHz")); return; }
      cfg.freq = rdaTune((uint16_t)v); saveSettings();
      Serial.print(F("tuned ")); printMHz(cfg.freq); Serial.print(F(" MHz, RSSI ")); Serial.println(rssiAvg(3));
      break;
    case 'V':
      if (n > 1 && v >= 0 && v <= 15) {
        cfg.volume = (uint8_t)v; saveSettings();
        if (radioOK) rdaVolume(cfg.volume);
        Serial.print(F("volume ")); Serial.println(cfg.volume);
      } else Serial.println(F("use V0..V15"));
      break;
    case '?':
      if (!radioOK) radioInit();                // retry, in case the wiring was just fixed
      printStatus();
      break;
    default:
      Serial.println(F("unknown command, type ? for help"));
  }
}

static void readSerial() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (lineLen) { line[lineLen] = 0; handleLine(line); lineLen = 0; }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = ch;
    }
  }
}

static void runSweep() {
  if (!sweeping) return;
  uint32_t now = millis();
  uint32_t dur = (sweepIdx < 0) ? 1000 : 600;
  if (now - sweepT < dur) return;
  sweepT = now;
  sweepIdx++;
  if (sweepIdx >= SWEEP_N) { sweepIdx = -1; mod.mode = MODE_SILENT; return; }
  setTone(SWEEP_HZ[sweepIdx]);
  mod.mode = MODE_TONE;
}

static void runButton() {
  static uint8_t last = HIGH;
  static uint32_t tChange = 0;
  uint8_t now = digitalRead(BTN_PIN);
  if (now != last && millis() - tChange > 40) {
    tChange = millis();
    last = now;
    if (now == LOW) {
      cfg.scheme = (uint8_t)((cfg.scheme + 1) % 3);
      mod.nextScheme = cfg.scheme;
      saveSettings();
      Serial.print(F("button: scheme -> ")); Serial.println(schemeName(cfg.scheme));
    }
  }
}

static void runLed() {                          // blink (scheme+1) times, then pause
  static uint32_t t = 0;
  static uint8_t step = 0;
  if (millis() - t < 150) return;
  t = millis();
  uint8_t flashes = cfg.scheme + 1;
  step++;
  if (step >= 2 * flashes + 8) step = 0;
  bool on = (step < 2 * flashes) && (step % 2 == 0) && mod.mode == MODE_DATA && !sweeping;
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  loadSettings();
  buildStartFrame();
  mod.begin(&frameA, cfg.scheme, cfg.baud);
  startAudio();                       // TX audio runs from here on, even if the radio is missing
  Wire.begin();
  Wire.setClock(100000);
  Wire.setWireTimeout(25000, true);   // never hang if SDA/SCL are miswired
  radioInit();
  printStatus();
}

void loop() {
  readSerial();
  runSweep();
  runButton();
  runLed();
  if (rssiLines && radioOK && millis() - tRssi >= 100) {
    tRssi = millis();
    printRssiLine();
  }
}
