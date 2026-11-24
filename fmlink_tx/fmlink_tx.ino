/*
  fmlink_tx.ino - FM Multi-Mod Link, transmit side
  Board : STM32F103C8 "Blue Pill" with the STM32duino core (STMicroelectronics:stm32)
  Tools : Board part number "BluePill F103C8", Upload method "STM32CubeProgrammer (SWD)",
          USB support "CDC (generic 'Serial' supersede U(S)ART)"
          (If USB serial does not appear, set USB support "None" and use a USB-TTL
           adapter on PA9 (TX) / PA10 (RX): the same code then talks over USART1.)

  Pins  : PA8  -> RC filter -> RV1 -> FM transmitter audio input   (TIM1_CH1, 281 kHz PWM DAC)
          PB0  -> push button -> GND                                 (cycle ASK / FSK / DBPSK)
          PC13 -> on-board LED                                       (blinks 1/2/3 times = scheme)

  Serial commands (115200 baud, end each line with Enter / newline):
    P            send the PRBS-9 test frame over and over (for BER)
    M <text>     send a text message over and over (max 200 characters)
    S0 S1 S2     scheme: 0 = ASK, 1 = FSK, 2 = DBPSK
    R<baud>      bit rate: R150, R300, R600, R1200
    T<hz>        continuous test tone, e.g. T1000 (for SNR / over-deviation tests)
    W            frequency sweep 100 Hz .. 12 kHz (for frequency response)
    Q            quiet (no audio, for noise-floor tests)
    D            back to data mode (resumes the last frame)
    ?            print status and help
*/
#include <Arduino.h>
#include "fmlink_core.h"
using namespace fl;

#define AUDIO_PIN PA8
#define BTN_PIN   PB0
#define LED_PIN   PC13           // active LOW on the Blue Pill

HardwareTimer *pwmTimer;
HardwareTimer *sampleTimer;
static BitBuf frameA, frameB;
static Modulator mod;
static uint16_t baud = 300;

// sweep state (runs in loop())
static const uint16_t SWEEP_HZ[] = {100, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000};
static const uint8_t SWEEP_N = sizeof(SWEEP_HZ) / sizeof(SWEEP_HZ[0]);
static bool sweeping = false;
static int8_t sweepIdx = -1;
static uint32_t sweepT = 0;

void onSample() { TIM1->CCR1 = mod.next(); }   // 48 000 times per second

// Frames are double-buffered: we write the buffer that is NOT playing, then the modulator
// switches to it at the start of its next frame, so a frame is never cut in half.
static BitBuf &idleBuf() {
  uint32_t t0 = millis();
  while (mod.pending && millis() - t0 < 15000) {}   // a previous swap is still waiting
  return (mod.active == &frameA) ? frameB : frameA;
}
static void sendPrbs() { BitBuf &b = idleBuf(); buildPrbsFrame(b); mod.pending = &b; }
static void sendText(const String &s) {
  uint8_t n = (uint8_t)min((int)s.length(), (int)MAX_PAYLOAD);
  BitBuf &b = idleBuf();
  buildFrame(b, TYPE_TEXT, (const uint8_t *)s.c_str(), n);
  mod.pending = &b;
}

static void printStatus() {
  Serial.println(F("--- FM Multi-Mod Link TX ---"));
  Serial.print(F("mode   : "));
  Serial.println(sweeping ? "SWEEP" : mod.mode == MODE_DATA ? "DATA" : mod.mode == MODE_TONE ? "TONE" : "QUIET");
  Serial.print(F("scheme : ")); Serial.println(schemeName(mod.nextScheme != 0xFF ? mod.nextScheme : mod.scheme));
  Serial.print(F("baud   : ")); Serial.println(baud);
  Serial.println(F("commands: P | M <text> | S0 S1 S2 | R150 R300 R600 R1200 | T<hz> | W | Q | D | ?"));
}

static void setScheme(uint8_t s) {
  mod.nextScheme = s;                 // applied at the next frame start
  Serial.print(F("scheme -> ")); Serial.println(schemeName(s));
}

static void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  char c = toupper(line[0]);
  String arg = line.substring(1); arg.trim();
  if (c == 'M' && line.length() > 1) {
    sweeping = false; mod.mode = MODE_DATA;
    sendText(arg);
    Serial.print(F("sending text: ")); Serial.println(arg);
  } else if (c == 'P') {
    sweeping = false; mod.mode = MODE_DATA;
    sendPrbs();
    Serial.println(F("sending PRBS-9 test frames"));
  } else if (c == 'S') {
    int s = arg.toInt();
    if (s >= 0 && s <= 2) setScheme((uint8_t)s); else Serial.println(F("use S0, S1 or S2"));
  } else if (c == 'R') {
    long b = arg.toInt();
    if (b == 150 || b == 300 || b == 600 || b == 1200) {
      baud = (uint16_t)b; mod.nextSpb = (uint16_t)(FS / baud);
      Serial.print(F("baud -> ")); Serial.println(baud);
    } else Serial.println(F("use R150, R300, R600 or R1200"));
  } else if (c == 'T') {
    long hz = arg.length() ? arg.toInt() : 1000;
    if (hz < 50 || hz > 15000) { Serial.println(F("tone must be 50..15000 Hz")); return; }
    sweeping = false; mod.toneStep = phaseStep((uint32_t)hz); mod.mode = MODE_TONE;
    Serial.print(F("tone ")); Serial.print(hz); Serial.println(F(" Hz"));
  } else if (c == 'W') {
    sweeping = true; sweepIdx = -1; sweepT = millis(); mod.mode = MODE_SILENT;
    Serial.println(F("sweep: 1 s quiet, then 15 tones x 600 ms, repeating"));
  } else if (c == 'Q') {
    sweeping = false; mod.mode = MODE_SILENT; Serial.println(F("quiet"));
  } else if (c == 'D') {
    sweeping = false; mod.mode = MODE_DATA; Serial.println(F("data mode"));
  } else if (c == '?') {
    printStatus();
  } else {
    Serial.println(F("unknown command, type ? for help"));
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
  mod.toneStep = phaseStep(SWEEP_HZ[sweepIdx]);
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
      uint8_t cur = (mod.nextScheme != 0xFF) ? mod.nextScheme : mod.scheme;
      setScheme((cur + 1) % 3);
    }
  }
}

static void runLed() {                 // blink (scheme+1) times, then pause
  static uint32_t t = 0;
  static uint8_t step = 0;
  uint8_t s = (mod.nextScheme != 0xFF) ? mod.nextScheme : mod.scheme;
  uint8_t flashes = s + 1;
  if (millis() - t < 150) return;
  t = millis();
  step++;
  if (step >= 2 * flashes + 8) step = 0;
  bool on = (step < 2 * flashes) && (step % 2 == 0) && mod.mode == MODE_DATA;
  digitalWrite(LED_PIN, on ? LOW : HIGH);
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);

  buildPrbsFrame(frameA);                         // start with the BER test pattern
  mod.begin(&frameA, FSK, baud);

  // TIM1 channel 1 on PA8: 72 MHz / 256 = 281.25 kHz PWM, 8-bit duty
  pwmTimer = new HardwareTimer(TIM1);
  pwmTimer->setPrescaleFactor(1);
  pwmTimer->setOverflow(256, TICK_FORMAT);
  pwmTimer->setMode(1, TIMER_OUTPUT_COMPARE_PWM1, AUDIO_PIN);
  pwmTimer->setCaptureCompare(1, 128, TICK_COMPARE_FORMAT);
  pwmTimer->resume();

  // TIM2: sample clock, 48 kHz interrupt
  sampleTimer = new HardwareTimer(TIM2);
  sampleTimer->setOverflow(FS, HERTZ_FORMAT);
  sampleTimer->attachInterrupt(onSample);
  sampleTimer->resume();

  delay(1500);                                    // give USB serial time to connect
  printStatus();
}

void loop() {
  static String line;
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') { if (line.length()) handleLine(line); line = ""; }
    else if (line.length() < 220) line += ch;
  }
  runSweep();
  runButton();
  runLed();
}
