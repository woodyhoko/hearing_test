# Audiometry Test

A browser-based **pure-tone audiometry diagnostic** that generates a clinical-style audiogram — no app install, no account, no server.

**[▶ Live Demo](https://woodyhoko.github.io/hearing_test)**

---

## What It Does

Runs a two-phase hearing threshold test:

| Phase | Method |
|---|---|
| **Phase 1 — Pure Tone** | Both ears tested independently across standard audiometric frequencies |
| **Phase 2 — Masked** | Contralateral masking noise played to isolate each ear's true threshold |

Results are plotted as a standard **audiogram** (dB HL vs. frequency) using HTML5 Canvas, matching the format used by audiologists. Left ear marked `X`, right ear marked `O`.

---

## Safety

- **Software safety lock engaged** — test will not exceed **80 dB HL**
- Starts quietly at 30 dB HL and adapts upward via a Békésy-style threshold-seeking algorithm
- A warning fires if the response button is pressed during silence (catches false positives)

---

## Calibration Requirements

For results to map to absolute Hearing Level (dB HL):

1. OS master volume set to **100%**
2. Headphone touch volume at **maximum**
3. Use in a **quiet environment**

The test was calibrated for **Sennheiser PXC 550 II** headphones. Results on other hardware will still show relative thresholds between frequencies but may not map exactly to clinical dB HL values.

---

## Stack

- Vanilla **JavaScript** + **Web Audio API** (tone generation & masking)
- **HTML5 Canvas** (audiogram rendering)
- No frameworks, no dependencies, single page

---

## Run Locally

```bash
# Serve (required for Web Audio API on some browsers)
python -m http.server 8000
# then open http://localhost:8000
```

