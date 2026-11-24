/*
  fmlink_rx.ino - FM Multi-Mod Link, receive side
  Board : Arduino Uno R3
  Radio : RDA5807M module (RRD-102), 3.3 V, through a BSS138 level shifter
          Uno A4 (SDA) -> HV1 | LV1 -> RDA SDIO
          Uno A5 (SCL) -> HV2 | LV2 -> RDA SCLK
          Uno 5V -> HV, Uno 3.3V -> LV and RDA VCC, all GNDs together
  No extra library needed: only Wire (built in).

  Serial (115200 baud). Every 100 ms it prints:
    RSSI,<millis>,<freq in 10 kHz>,<rssi 0..127>,<fm_true 0/1>,<stereo 0/1>
  Commands (end with newline):
    F10390   tune to 103.90 MHz (value in 10 kHz steps, 8750..10800)
    V8       volume 0..15
    SCAN     measure RSSI on every channel 87.5..108.0 MHz, prints SCAN,<freq>,<rssi>
    MONO1 / MONO0   force mono (recommended: MONO1, less noise)
    P0 / P1  stop / start the periodic RSSI lines
    ?        status
*/
#include <Wire.h>

const uint8_t RDA_SEQ = 0x10;   // sequential access: reads start at register 0x0A
const uint8_t RDA_RND = 0x11;   // random access: write any single register

uint16_t freq = 10390;          // CHANGE THIS to your empty frequency (10 kHz units)
uint8_t volume = 8;
bool mono = true;
bool printing = true;
uint16_t reg02 = 0;

bool writeReg(uint8_t reg, uint16_t val) {
  Wire.beginTransmission(RDA_RND);
  Wire.write(reg);
  Wire.write(val >> 8);
  Wire.write(val & 0xFF);
  return Wire.endTransmission() == 0;
}

// reads registers 0x0A and 0x0B
bool readStatus(uint16_t &r0a, uint16_t &r0b) {
  if (Wire.requestFrom(RDA_SEQ, (uint8_t)4) != 4) return false;
  r0a = (uint16_t)Wire.read() << 8; r0a |= Wire.read();
  r0b = (uint16_t)Wire.read() << 8; r0b |= Wire.read();
  return true;
}

void setReg02() {
  // DHIZ=1 (audio on), DMUTE=1 (unmuted), MONO, NEW_METHOD=1, ENABLE=1
  reg02 = 0xC000 | (mono ? 0x2000 : 0) | 0x0004 | 0x0001;
  writeReg(0x02, reg02);
}

void tune(uint16_t f10k) {
  if (f10k < 8700) f10k = 8700;
  if (f10k > 10800) f10k = 10800;
  freq = f10k;
  uint16_t chan = (freq - 8700) / 10;                  // band 87-108 MHz, 100 kHz spacing
  writeReg(0x03, (chan << 6) | 0x0010);                // TUNE=1, BAND=00, SPACE=00
  uint32_t t0 = millis();
  uint16_t a, b;
  while (millis() - t0 < 300) {                        // wait for Seek/Tune Complete
    if (readStatus(a, b) && (a & 0x4000)) break;
    delay(5);
  }
}

void setVolume(uint8_t v) {
  volume = v > 15 ? 15 : v;
  writeReg(0x05, 0x8880 | volume);                    // INT_MODE=1, SEEKTH=8, LNA_PORT=LNAP
}

void scanBand() {
  uint16_t keep = freq;
  bool keepPrint = printing; printing = false;
  Serial.println(F("SCANSTART"));
  for (uint16_t f = 8750; f <= 10800; f += 10) {
    tune(f);
    delay(40);
    uint16_t a, b; uint16_t sum = 0;
    for (uint8_t i = 0; i < 4; i++) { if (readStatus(a, b)) sum += b >> 9; delay(10); }
    Serial.print(F("SCAN,")); Serial.print(f); Serial.print(','); Serial.println(sum / 4);
  }
  Serial.println(F("SCANDONE"));
  tune(keep);
  printing = keepPrint;
}

void printStatusLine() {
  uint16_t a, b;
  if (!readStatus(a, b)) { Serial.println(F("ERR,read failed - check SDA/SCL/3.3V/GND")); return; }
  Serial.print(F("RSSI,")); Serial.print(millis());
  Serial.print(','); Serial.print(freq);
  Serial.print(','); Serial.print(b >> 9);
  Serial.print(','); Serial.print((b >> 8) & 1);
  Serial.print(','); Serial.println((a >> 10) & 1);
}

void handleLine(String s) {
  s.trim(); s.toUpperCase();
  if (s.length() == 0) return;
  if (s == "SCAN") { scanBand(); return; }
  if (s.startsWith("MONO")) { mono = s.endsWith("1"); setReg02(); Serial.println(mono ? F("mono on") : F("mono off")); return; }
  char c = s[0];
  long v = s.substring(1).toInt();
  if (c == 'F') { tune((uint16_t)v); Serial.print(F("tuned ")); Serial.print(freq / 100.0, 2); Serial.println(F(" MHz")); }
  else if (c == 'V') { setVolume((uint8_t)v); Serial.print(F("volume ")); Serial.println(volume); }
  else if (c == 'P') { printing = (v != 0); }
  else if (c == '?') {
    Serial.print(F("freq ")); Serial.print(freq / 100.0, 2); Serial.print(F(" MHz, volume ")); Serial.print(volume);
    Serial.println(mono ? F(", mono") : F(", stereo"));
    Serial.println(F("commands: F<10kHz> | V0..15 | SCAN | MONO1/MONO0 | P0/P1 | ?"));
  } else Serial.println(F("unknown command, type ?"));
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(100000);
  delay(200);
  Wire.beginTransmission(RDA_RND);
  if (Wire.endTransmission() != 0) {
    Serial.println(F("ERR,RDA5807M not found at 0x11 - check wiring, 3.3V and the level shifter"));
  }
  writeReg(0x02, 0x0002);          // soft reset
  delay(50);
  setReg02();                      // power up
  delay(600);                      // crystal start-up
  writeReg(0x04, 0x0800);          // DE=1: 50 us de-emphasis, soft-mute off, AFC on
  setVolume(volume);
  tune(freq);
  Serial.print(F("READY,")); Serial.println(freq);
}

void loop() {
  static String line;
  static uint32_t tPrint = 0;
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') { if (line.length()) handleLine(line); line = ""; }
    else if (line.length() < 30) line += ch;
  }
  if (printing && millis() - tPrint >= 100) { tPrint = millis(); printStatusLine(); }
}
