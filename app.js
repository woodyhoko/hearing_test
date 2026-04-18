const DOM = {
    screens: document.querySelectorAll('.screen'),
    btnStart: document.getElementById('btn-start'),
    btnRespond: document.getElementById('btn-respond'),
    btnRestart: document.getElementById('btn-restart'),
    testPhase: document.getElementById('test-phase'),
    testPhaseOutof: document.getElementById('test-phase-out-of'),
    testProgress: document.getElementById('test-progress'),
    warningMessage: document.getElementById('warning-message'),
    canvas: document.getElementById('audiogram')
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
    drawAudiogram();
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

    scheduleTrial();
}

function scheduleTrial() {
    // Random delay 1s to 2.5s
    const delay = 1000 + Math.random() * 1500;

    trialDelayTimeout = setTimeout(() => {
        executeTrial();
    }, delay);
}

function executeTrial() {
    const block = testBlocks[currentBlockIndex];
    hasRespondedThisTrial = false;
    userHeard = false;
    isResponseWindowActive = true;

    playTone(block.freq, block.ear, currentDb);

    // Response window: slightly longer than the tone itself (1.5s tone + 0.5s grace)
    toneTimeout = setTimeout(() => {
        isResponseWindowActive = false;
        evaluateResponse();
    }, 2000);
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
        setTimeout(evaluateResponse, 300); // Small delay before evaluation
    } else {
        // False positive
        DOM.warningMessage.classList.remove('hidden');
    }
}

function evaluateResponse() {
    trialsInThisBlock++;

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
    switchScreen('test-screen');
    startNextBlock();
});

DOM.btnRespond.addEventListener('click', handleResponse);
DOM.btnRespond.addEventListener('mousedown', () => DOM.btnRespond.style.transform = 'scale(0.95)');
DOM.btnRespond.addEventListener('mouseup', () => DOM.btnRespond.style.transform = '');

DOM.btnRestart.addEventListener('click', () => {
    switchScreen('home-screen');
});
