// sim_uno.cpp - runs the Uno modulator (fmlink_uno/fmlink_uno_core.h) on the PC.
// It uses the same header the firmware uses, so every sample is exactly what the Uno's timer
// interrupt writes to the PWM (OCR2B), 31 250 samples per second.
//
// Build : g++ -O2 -std=c++11 -o sim_uno.exe sim_uno.cpp
// Usage : sim_uno <scheme 0|1|2> <baud> <seconds> <out.u8> [text]
//         Sends PRBS-9 frames. With [text], a TEXT frame is queued half way through with the same
//         double-buffer swap the firmware uses, so the second half carries the text.
//         Output: raw unsigned 8-bit samples (128 = silence).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "../fmlink_uno/fmlink_uno_core.h"
using namespace fl;

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: sim_uno <scheme 0|1|2> <baud> <seconds> <out.u8> [text]\n");
    return 2;
  }
  int scheme = atoi(argv[1]);
  int baud = atoi(argv[2]);
  double seconds = atof(argv[3]);
  const char *out = argv[4];
  const char *text = (argc > 5) ? argv[5] : 0;
  if (scheme < 0 || scheme > 2 || !(baud == 150 || baud == 300 || baud == 600 || baud == 1200)) {
    fprintf(stderr, "bad scheme or baud\n");
    return 2;
  }
  static Frame a, b;
  static Modulator mod;
  buildPrbsFrame(a);
  mod.begin(&a, (uint8_t)scheme, (uint16_t)baud);
  long n = (long)(seconds * FS);
  FILE *fp = fopen(out, "wb");
  if (!fp) { perror(out); return 1; }
  for (long i = 0; i < n; i++) {
    if (text && i == n / 2) {
      buildFrame(b, TYPE_TEXT, (const uint8_t *)text, (uint8_t)strlen(text));
      mod.pending = &b;              // the firmware's queueFrame()
    }
    fputc(mod.next(), fp);
  }
  fclose(fp);
  return 0;
}
