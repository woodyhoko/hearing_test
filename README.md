# Audiometry Test — Browser-Based Pure-Tone Hearing Screener

A self-administered **clinical-grade pure-tone audiometry test** running entirely in the browser via the Web Audio API, producing a standard audiogram with no app install or account required.

**[▶ Live Demo](https://woodyhoko.github.io/hearing_test)**

---

## 1. Clinical background

**Pure-tone audiometry** is the gold-standard method for characterizing hearing threshold levels (HTLs) across the speech-frequency range. Thresholds are measured at octave and half-octave frequencies from 250 Hz to 8 kHz, for each ear independently. Results are plotted on an **audiogram** — frequency (Hz) on the x-axis, hearing level (dB HL) on the y-axis, with downward displacement indicating loss.

The reference standard (0 dB HL at each frequency) is the median threshold of a population of otologically normal young adults (ISO 389-1), established via standardized transducers at known Sound Pressure Levels. This test approximates that reference for a specific headphone model (Sennheiser PXC 550 II) calibrated at the OS master volume set to 100%.

---

## 2. Test procedure

### 2.1 Phase 1 — Pure-tone thresholds

Each ear is tested independently. At each test frequency:

1. A sinusoidal tone is synthesized at an initial level of **30 dB HL**
2. The subject clicks a response button when they hear the tone
3. A **modified Hughson–Westlake** (ascending bracketing) procedure adjusts the level:
   - On response: decrease by 10 dB
   - On no response: increase by 5 dB
4. Threshold = lowest level heard in ≥ 2 of 3 ascending presentations

### 2.2 Phase 2 — Masked thresholds

**Contralateral masking** applies narrowband noise to the non-test ear to prevent cross-hearing via bone conduction. The masking level follows the **shadow curve rule**: masking = air-conduction threshold of test ear minus 40 dB interaural attenuation. This phase isolates the true air-conduction threshold of each ear.

### 2.3 Random-guessing detection (statistical reliability check)

Self-administered tests are vulnerable to a subject who simply taps the button at random, producing a plausible-looking but meaningless audiogram. To detect this, the test interleaves hidden **silent catch-trials** and applies a **binomial hypothesis test** to the responses.

**Catch-trials.** Roughly 1 in 5 trials (`CATCH_PROBABILITY = 0.20`) is a *silent* response window — same timing and same button as a real trial, but **no tone is ever played**. Catch-trials never lead a block and never run back-to-back, so they are unpredictable and the subject cannot learn to avoid them. They also never perturb the Hughson–Westlake state machine.

**The signal.** Let *c* = number of catch-trials presented and *f* = number of those silent windows in which the subject responded (false alarms). An attentive, honest listener almost never responds to silence, so we model their false-alarm behaviour as a Bernoulli process with a small baseline rate *p₀ = 0.05*.

**The test.** Under the null hypothesis *H₀ = "honest, attentive listener"*, the false-alarm count follows a Binomial(*c*, *p₀*) distribution. We compute the upper-tail p-value — the probability that an honest listener would produce *at least* as many false alarms purely by accident:

$$p = P(X \ge f), \quad X \sim \mathrm{Binomial}(c,\, p_0)$$

**Classification.**

| Condition | Verdict |
|---|---|
| False-alarm rate ≥ 40% (≈ a coin flip) | **Random guessing** — thresholds discarded as untrustworthy |
| p-value < 0.05 (significantly more false alarms than chance) | **Questionable** — retest advised |
| Otherwise | **Reliable** — consistent with genuine listening |
| Fewer than 4 catch-trials collected | **Not assessed** |

The verdict, the false-alarm rate (*f/c*), and the binomial p-value are all displayed on the results screen above the audiogram. This mirrors the clinical practice of monitoring false-alarm rate to validate that thresholds reflect true hearing rather than button-mashing.

---

## 3. Tone synthesis — Web Audio API

Tones are synthesized with sub-millisecond precision using the browser's audio graph:

```javascript
const audioCtx = new AudioContext();

function playTone(freq, dBHL, durationMs) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.value = freq;

    // Convert dB HL to linear gain (calibrated per-frequency)
    const linearGain = calibration[freq] * Math.pow(10, dBHL / 20);
    gain.gain.setValueAtTime(linearGain, audioCtx.currentTime);

    // Cosine-ramped onset/offset to suppress clicks
    gain.gain.linearRampToValueAtTime(linearGain, audioCtx.currentTime + 0.01);
    osc.start(); osc.stop(audioCtx.currentTime + durationMs / 1000);
}
```

**Safety lock:** the maximum gain is hard-clamped so output never exceeds 80 dB HL. This is below the 85 dB(A) 8-hour occupational exposure limit (NIOSH 1998) for brief audiometric stimuli.

---

## 4. Audiogram rendering — HTML5 Canvas

Thresholds are plotted on a standard audiogram layout:

- **X-axis:** 250, 500, 1000, 2000, 4000, 8000 Hz (log-spaced)
- **Y-axis:** −10 to 120 dB HL (inverted — larger values downward)
- **Symbols:** `X` (left ear, blue), `O` (right ear, red) — per ASHA convention

Normal hearing: all thresholds ≤ 20 dB HL. Mild loss: 21–40 dB. Moderate: 41–55 dB. Severe: 56–70 dB. Profound: > 70 dB.

---

## 5. Calibration requirements

Results map to absolute dB HL **only** when:

1. OS master volume at **100%**
2. Headphone volume at **maximum**
3. Tested with **Sennheiser PXC 550 II** headphones in a **quiet room**

On other hardware, the frequency contour of results remains diagnostically informative (relative thresholds between frequencies) but absolute values will shift. For clinical diagnosis, always use calibrated audiometric equipment.

---

## 6. Stack

- Vanilla **JavaScript** + **Web Audio API** (tone and noise synthesis)
- **HTML5 Canvas** (audiogram rendering)
- No frameworks, no dependencies, single HTML file

---

## 7. Run locally

```bash
python -m http.server 8000
# open http://localhost:8000
```

Some browsers restrict the AudioContext on `file://` URLs; serving over HTTP avoids this.

---

## 8. References

1. ISO 389-1. *Acoustics — Reference zero for the calibration of audiometric equipment.* ISO, 2017.
2. NIOSH. *Criteria for a Recommended Standard: Occupational Noise Exposure.* DHHS, 1998.
3. ASHA. *Guidelines for Manual Pure-Tone Threshold Audiometry.* American Speech-Language-Hearing Association, 2005.
