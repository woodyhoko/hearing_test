const DOM = {
    screens: document.querySelectorAll('.screen'),
    btnStart: document.getElementById('btn-start'),
    btnRespond: document.getElementById('btn-respond'),
    btnRestart: document.getElementById('btn-restart'),
    testPhase: document.getElementById('test-phase'),
    testPhaseOutof: document.getElementById('test-phase-out-of'),
    testProgress: document.getElementById('test-progress'),
    warningMessage: document.getElementById('warning-message'),
    canvas: document.getElementById('audiogram'),
    reliabilityReport: document.getElementById('reliability-report')
};

function switchScreen(id) {
    DOM.screens.forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// Audio Context
let audioCtx;
let keepAliveOsc;
let noiseBuffer;
let activeMaskingSource = null;

const FREQUENCIES = [125, 250, 500, 1000, 2000, 4000, 8000];
const EARS = ['left', 'right'];

// Add RETSPL standard offsets mapping clinical 0 dB HL -> actual dB SPL
const RETSPL = {
    125: 45.0,
    250: 25.5,
    500: 11.5,
    1000: 7.0,
    2000: 9.0,
    4000: 9.5,
    8000: 13.0
};
// Browsers and Windows Bluetooth drivers often cap 0 dBFS signal below the theoretical hardware max. 
// 95 dB SPL is a much more accurate absolute max anchor for consumer Bluetooth hardware at 100% OS Volume.
const MAX_SYSTEM_SPL = 95;

// --- Random-guessing detection -------------------------------------------
// "Catch trials" present a perfectly silent response window. An attentive,
// honest listener essentially never responds during silence, whereas a
// person clicking at random will trigger them at roughly their guessing
// rate. The false-alarm count is then run through a binomial test to decide
// whether the response pattern is statistically distinguishable from genuine
// listening.
const CATCH_PROBABILITY = 0.20;   // ~1 in 5 non-leading trials are silent
const BASELINE_FA = 0.05;         // assumed false-alarm rate of an honest listener
const MIN_CATCH_FOR_STATS = 4;    // need at least this many catch trials to judge

// Test State
let testBlocks = [];
let currentBlockIndex = 0;
let results = {
    unmasked: { left: {}, right: {} },
    masked: { left: {}, right: {} }
};

let currentDb = 30;
let lastResult = null;
let ascentCount = {};
let trialsInThisBlock = 0;
let toneTimeout;
let trialDelayTimeout;

let isResponseWindowActive = false;
let hasRespondedThisTrial = false;
let userHeard = false;

// Catch-trial / reliability tracking
let currentTrialIsCatch = false;
let lastWasCatch = false;
let catchTrials = 0;      // number of silent windows presented
let falseAlarms = 0;      // responses given during those silent windows
let realTrials = 0;       // number of real (audible-candidate) trials
let realResponses = 0;    // responses given during real trials

// Audio Utils
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Anti BT sleep 
        keepAliveOsc = audioCtx.createOscillator();
        const keepAliveGain = audioCtx.createGain();
        keepAliveGain.gain.value = 0.000001;
        keepAliveOsc.connect(keepAliveGain).connect(audioCtx.destination);
        keepAliveOsc.start();

        // White noise buffer
        const bufferSize = audioCtx.sampleRate * 2;
        noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function dbToGain(dbHL, freq = 1000) {
    // 1. Get offset for this frequency
    let offset = RETSPL[freq] || 7.0;
    // 2. target SPL = test HL + required frequency offset
    let targetSPL = dbHL + offset;
    // 3. PXC 550 II Max is ~110dB SPL. Required attenuation = targetSPL - 110
    let attenuation = targetSPL - MAX_SYSTEM_SPL;
    if (attenuation > 0) attenuation = 0; // Safety clamp physically
    return Math.pow(10, attenuation / 20);
}

function playTone(freq, ear, db) {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    const panner = audioCtx.createStereoPanner();

    osc.type = 'sine';
    osc.frequency.value = freq;
    panner.pan.value = ear === 'left' ? -1 : 1;

    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    const targetGain = dbToGain(db, freq);

    // Smooth attack and release to prevent clicking
    gainNode.gain.linearRampToValueAtTime(targetGain, audioCtx.currentTime + 0.1);

    osc.connect(gainNode).connect(panner).connect(audioCtx.destination);
    osc.start();

    // Schedule stop
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 1.4);
    osc.stop(audioCtx.currentTime + 1.5);

    return osc;
}

function startMaskingNoise(targetEar, freq = 1000) {
    stopMaskingNoise();
    // Masking goes in the opposite ear
    const maskingEar = targetEar === 'left' ? 'right' : 'left';
    const pannerVal = maskingEar === 'left' ? -1 : 1;

    activeMaskingSource = audioCtx.createBufferSource();
    activeMaskingSource.buffer = noiseBuffer;
    activeMaskingSource.loop = true;

    // Narrowband Filter to match the pitch being tested
    const bandpass = audioCtx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = freq;
    bandpass.Q.value = 3; // Approx 1/3 octave bandwidth

    const panner = audioCtx.createStereoPanner();
    panner.pan.value = pannerVal;

    const gainNode = audioCtx.createGain();
    // Lowered volume slightly, as narrowband concentrates the energy
    gainNode.gain.value = dbToGain(40, freq);

    activeMaskingSource.connect(bandpass).connect(panner).connect(gainNode).connect(audioCtx.destination);
    activeMaskingSource.start();
}

function stopMaskingNoise() {
    if (activeMaskingSource) {
        activeMaskingSource.stop();
        activeMaskingSource.disconnect();
        activeMaskingSource = null;
    }
}

// Logic flow
function generateTestBlocks() {
    testBlocks = [];
    // Phase 1: Unmasked
    for (const ear of EARS) {
        for (const freq of FREQUENCIES) {
            testBlocks.push({ phase: 'unmasked', ear, freq });
        }
    }
    // Phase 2: Masked
    for (const ear of EARS) {
        for (const freq of FREQUENCIES) {
            testBlocks.push({ phase: 'masked', ear, freq });
        }
    }
}

function updateProgress() {
    let perc = Math.round((currentBlockIndex / testBlocks.length) * 100);
    DOM.testProgress.innerText = `${perc}%`;

    if (testBlocks[currentBlockIndex]) {
        const isMasked = testBlocks[currentBlockIndex].phase === 'masked';
        DOM.testPhase.innerText = isMasked ? "Masked Tone" : "Pure Tone";
        DOM.testPhaseOutof.innerText = isMasked ? "2/2" : "1/2";
    }
}

function endDiagnostic() {
    stopMaskingNoise();
    switchScreen('results-screen');
    renderReliability();
    drawAudiogram();
}

// --- Statistics ----------------------------------------------------------
function logFactorial(n) {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
}

function binomPmf(k, n, p) {
    if (p <= 0) return k === 0 ? 1 : 0;
    if (p >= 1) return k === n ? 1 : 0;
    const logC = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
    return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

// P(X >= k) for X ~ Binomial(n, p): the chance an honest listener produces at
// least this many false alarms purely by accident.
function binomUpperTail(k, n, p) {
    let s = 0;
    for (let i = k; i <= n; i++) s += binomPmf(i, n, p);
    return Math.min(1, s);
}

// Classify the response pattern. The core signal is the catch-trial false-alarm
// rate, validated against a binomial null model of an attentive listener.
function assessReliability() {
    const c = catchTrials, f = falseAlarms;
    const pressRate = realTrials ? realResponses / realTrials : 0;

    if (c < MIN_CATCH_FOR_STATS) {
        return { verdict: 'insufficient', c, f, faRate: 0, pGenuine: 1, pressRate };
    }

    const faRate = f / c;
    // p-value: how plausible this many false alarms is under honest listening.
    const pGenuine = binomUpperTail(f, c, BASELINE_FA);

    let verdict;
    if (faRate >= 0.40) {
        // Responding to ~half of silent trials ≈ a coin flip → guessing.
        verdict = 'guessing';
    } else if (pGenuine < 0.05) {
        // Significantly more false alarms than an honest listener would give.
        verdict = 'questionable';
    } else {
        verdict = 'reliable';
    }
    return { verdict, c, f, faRate, pGenuine, pressRate };
}

function renderReliability() {
    if (!DOM.reliabilityReport) return;
    const r = assessReliability();
    const pct = x => (x * 100).toFixed(0) + '%';
    const pStr = r.pGenuine < 0.001 ? '< 0.001' : r.pGenuine.toFixed(3);

    const meta = {
        reliable: {
            cls: 'rel-good', icon: '✓', title: 'Results appear reliable',
            note: 'Your responses are statistically consistent with genuine listening.'
        },
        questionable: {
            cls: 'rel-warn', icon: '⚠', title: 'Results may be unreliable',
            note: 'You responded during silence more often than an attentive listener typically would. Consider retesting in a quieter setting with full focus.'
        },
        guessing: {
            cls: 'rel-bad', icon: '✕', title: 'Pattern consistent with random guessing',
            note: 'Responses during silent catch-trials occurred about as often as a coin flip. These thresholds are not trustworthy — please retest and respond only to tones you actually hear.'
        },
        insufficient: {
            cls: 'rel-warn', icon: 'ℹ', title: 'Reliability not assessed',
            note: 'Too few catch-trials were collected to judge response validity.'
        }
    }[r.verdict];

    let stats = '';
    if (r.verdict !== 'insufficient') {
        stats = `<div class="rel-stats">
            <span><strong>${r.f}/${r.c}</strong> silent catch-trials triggered a response (false-alarm rate ${pct(r.faRate)})</span>
            <span>Binomial p-value vs. honest listening: <strong>${pStr}</strong></span>
        </div>`;
    }

    DOM.reliabilityReport.className = 'reliability ' + meta.cls;
    DOM.reliabilityReport.innerHTML = `
        <div class="rel-head"><span class="rel-icon">${meta.icon}</span><span class="rel-title">${meta.title}</span></div>
        <p class="rel-note">${meta.note}</p>
        ${stats}`;
}

function startNextBlock() {
    if (currentBlockIndex >= testBlocks.length) {
        endDiagnostic();
        return;
    }

    const block = testBlocks[currentBlockIndex];
    updateProgress();

    if (block.phase === 'masked') {
        startMaskingNoise(block.ear, block.freq);
    } else {
        stopMaskingNoise();
    }

    // Reset Hughson-Westlake trackers
    currentDb = 30; // Start at 30dB
    lastResult = null;
    ascentCount = {};
    trialsInThisBlock = 0;
    lastWasCatch = false;

    scheduleTrial();
}

function scheduleTrial() {
    // Random delay 1s to 2.5s
    const delay = 1000 + Math.random() * 1500;

    trialDelayTimeout = setTimeout(() => {
        // Decide whether this is a silent catch trial. We never lead a block
        // with one (so Hughson-Westlake gets a clean start) and never run two
        // back-to-back, which keeps catch trials unpredictable yet sparse.
        const canCatch = !lastWasCatch && trialsInThisBlock >= 1;
        if (canCatch && Math.random() < CATCH_PROBABILITY) {
            executeCatchTrial();
        } else {
            executeTrial();
        }
    }, delay);
}

function executeTrial() {
    const block = testBlocks[currentBlockIndex];
    hasRespondedThisTrial = false;
    userHeard = false;
    isResponseWindowActive = true;
    currentTrialIsCatch = false;
    lastWasCatch = false;

    playTone(block.freq, block.ear, currentDb);

    // Response window: slightly longer than the tone itself (1.5s tone + 0.5s grace)
    toneTimeout = setTimeout(() => {
        isResponseWindowActive = false;
        evaluateResponse();
    }, 2000);
}

// A catch trial is indistinguishable from a real one to the subject — same
// response window, same timing — except that no tone is ever played. Any
// response is, by definition, a false alarm.
function executeCatchTrial() {
    hasRespondedThisTrial = false;
    userHeard = false;
    isResponseWindowActive = true;
    currentTrialIsCatch = true;
    catchTrials++;

    // Deliberately play nothing.
    toneTimeout = setTimeout(() => {
        isResponseWindowActive = false;
        evaluateCatchResponse();
    }, 2000);
}

function evaluateCatchResponse() {
    lastWasCatch = true;
    if (userHeard) falseAlarms++;
    // Catch trials never alter the Hughson-Westlake state — just continue.
    scheduleTrial();
}

function handleResponse() {
    if (isResponseWindowActive) {
        DOM.btnRespond.classList.add('success-flash');
        DOM.warningMessage.classList.add('hidden');
        hasRespondedThisTrial = true;
        userHeard = true;

        // Briefly disable window to prevent double taps causing issues
        isResponseWindowActive = false;
        clearTimeout(toneTimeout);
        // Route to the right evaluator — but never reveal which trial type it
        // was, so a guesser cannot learn to avoid the catch trials.
        setTimeout(currentTrialIsCatch ? evaluateCatchResponse : evaluateResponse, 300);
    } else {
        // False positive
        DOM.warningMessage.classList.remove('hidden');
    }
}

function evaluateResponse() {
    trialsInThisBlock++;
    realTrials++;
    if (userHeard) realResponses++;

    if (userHeard) {
        // It was heard
        if (lastResult === false) {
            // This was an ascending run
            ascentCount[currentDb] = (ascentCount[currentDb] || 0) + 1;
            if (ascentCount[currentDb] >= 2) {
                // Threshold found!
                results[testBlocks[currentBlockIndex].phase][testBlocks[currentBlockIndex].ear][testBlocks[currentBlockIndex].freq] = currentDb;
                currentBlockIndex++;
                startNextBlock();
                return;
            }
        }
        currentDb -= 10;
    } else {
        // Missed
        currentDb += 5;
    }

    // Bounds check
    if (currentDb > 80) currentDb = 80;
    if (currentDb < -10) currentDb = -10;

    // Failsafe (too many trials without strong convergence)
    if (trialsInThisBlock > 12) {
        // Best guess logic: either lowest heard, or last tested
        let bestGuess = 80;
        for (let db in ascentCount) {
            if (parseInt(db) < bestGuess) bestGuess = parseInt(db);
        }
        if (bestGuess === 80) bestGuess = currentDb; // fallback

        results[testBlocks[currentBlockIndex].phase][testBlocks[currentBlockIndex].ear][testBlocks[currentBlockIndex].freq] = bestGuess;
        currentBlockIndex++;
        startNextBlock();
        return;
    }

    lastResult = userHeard;
    scheduleTrial();
}

// Drawing Logic
function drawAudiogram() {
    const ctx = DOM.canvas.getContext('2d');
    const cw = DOM.canvas.width;
    const ch = DOM.canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    const margin = 50;
    const gWidth = cw - margin * 2;
    const gHeight = ch - margin * 2;

    // Draw Grid
    ctx.beginPath();
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;

    // Frequencies (Logarithmic/Equally spaced visually)
    const xs = FREQUENCIES.map((f, i) => margin + (i / (FREQUENCIES.length - 1)) * gWidth);

    xs.forEach((x, i) => {
        ctx.moveTo(x, margin);
        ctx.lineTo(x, ch - margin);
        ctx.fillStyle = '#64748b';
        ctx.font = '12px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(FREQUENCIES[i] + ' Hz', x, margin - 15);
    });

    // decibels
    // Web test ranges -10 to 80. Lower is better. So -10 at top, 80 at bottom.
    const dbMin = -10;
    const dbMax = 80;
    const dbRange = dbMax - dbMin;
    const ys = [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80];
    ys.forEach(db => {
        let y = margin + ((db - dbMin) / dbRange) * gHeight;
        ctx.moveTo(margin, y);
        ctx.lineTo(cw - margin, y);
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(db, margin - 15, y);
    });
    ctx.stroke();

    function plotPhase(phase, ear, color, shape, isDashed) {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        if (isDashed) {
            ctx.setLineDash([5, 5]);
        } else {
            ctx.setLineDash([]);
        }

        ctx.beginPath();
        let first = true;

        FREQUENCIES.forEach((freq, i) => {
            let db = results[phase][ear][freq];
            if (db !== undefined) {
                let x = xs[i];
                let y = margin + ((db - -10) / 90) * gHeight;

                if (first) {
                    ctx.moveTo(x, y);
                    first = false;
                } else {
                    ctx.lineTo(x, y);
                }
            }
        });
        ctx.stroke();

        // Draw points
        ctx.setLineDash([]);
        FREQUENCIES.forEach((freq, i) => {
            let db = results[phase][ear][freq];
            if (db !== undefined) {
                let x = xs[i];
                let y = margin + ((db - -10) / 90) * gHeight;

                ctx.beginPath();
                if (shape === 'x') {
                    ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
                    ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
                    ctx.stroke();
                } else if (shape === 'o') {
                    ctx.arc(x, y, 5, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
        });
    }

    // Left is Blue X, Right is Red O
    plotPhase('unmasked', 'left', '#3b82f6', 'x', false);
    plotPhase('unmasked', 'right', '#ef4444', 'o', false);

    // Masked phase
    plotPhase('masked', 'left', '#3b82f6', 'x', true);
    plotPhase('masked', 'right', '#ef4444', 'o', true);
}


// Event Listeners
DOM.btnStart.addEventListener('click', () => {
    initAudio();
    generateTestBlocks();
    currentBlockIndex = 0;

    // Reset reliability tracking for a fresh run
    results = { unmasked: { left: {}, right: {} }, masked: { left: {}, right: {} } };
    catchTrials = 0;
    falseAlarms = 0;
    realTrials = 0;
    realResponses = 0;
    lastWasCatch = false;
    currentTrialIsCatch = false;

    switchScreen('test-screen');
    startNextBlock();
});

DOM.btnRespond.addEventListener('click', handleResponse);
DOM.btnRespond.addEventListener('mousedown', () => DOM.btnRespond.style.transform = 'scale(0.95)');
DOM.btnRespond.addEventListener('mouseup', () => DOM.btnRespond.style.transform = '');

DOM.btnRestart.addEventListener('click', () => {
    switchScreen('home-screen');
});
