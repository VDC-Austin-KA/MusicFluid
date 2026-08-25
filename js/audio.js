/* ==========================================================================
   AudioEngine — capture, spectral analysis, beat detection.

   Exposes a single `metrics` object that every visualizer reads from, so
   modes never have to know where the sound actually came from.
   ========================================================================== */

window.AudioEngine = (function () {
    'use strict';

    const BAND_COUNT = 64;      // log-spaced bands handed to the visualizers
    const WAVE_COUNT = 1024;    // time-domain samples
    const HISTORY = 60;         // ~1s of bass history for beat variance

    let ctx = null;
    let analyser = null;
    let gainTrim = null;
    let freqData = null;
    let waveData = null;
    let sourceNode = null;
    let stream = null;
    let mediaEl = null;

    let started = false;
    let sourceLabel = 'none';
    let lastSoundAt = 0;

    const bassHistory = new Array(HISTORY).fill(0);
    const beatTimes = [];
    let lastBeatAt = 0;

    // Synthetic driver state (used when no real audio is reachable).
    const synth = { enabled: false, bpm: 120, phase: 0, seedOffset: Math.random() * 1000 };

    const metrics = {
        bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
        level: 0,          // overall RMS-ish 0..1
        beat: false,       // true on the single frame a beat fires
        beatPulse: 0,      // decays 1 -> 0 after each beat
        beatCount: 0,
        bpm: 0,
        flux: 0,           // spectral flux / onset strength 0..1
        bands: new Float32Array(BAND_COUNT),
        peaks: new Float32Array(BAND_COUNT),
        wave: new Float32Array(WAVE_COUNT),
        live: false,       // real audio is connected AND audible
        synthetic: false
    };

    const prevSpectrum = new Float32Array(BAND_COUNT);

    const config = { gain: 1.2, sensitivity: 1.5, smoothing: 0.82 };

    let onStatus = function () {};

    /* --------------------------- setup ---------------------------------- */

    function ensureContext() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = config.smoothing;
        gainTrim = ctx.createGain();
        gainTrim.gain.value = 1;
        gainTrim.connect(analyser);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        waveData = new Uint8Array(analyser.fftSize);
        started = true;
        return ctx;
    }

    function resume() {
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    function disconnect() {
        if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} sourceNode = null; }
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (mediaEl) { mediaEl.pause(); mediaEl = null; }
        sourceLabel = 'none';
        metrics.live = false;
    }

    function attachStream(s, label) {
        ensureContext();
        disconnect();
        resume();
        stream = s;
        sourceNode = ctx.createMediaStreamSource(s);
        sourceNode.connect(gainTrim);
        sourceLabel = label;
        lastSoundAt = performance.now();
        // A stream track can end on its own (user hits "Stop sharing").
        s.getTracks().forEach(t => {
            t.addEventListener('ended', () => {
                if (stream === s) { disconnect(); onStatus('ended', label); }
            });
        });
        onStatus('connected', label);
    }

    /* --------------------------- sources -------------------------------- */

    async function useMicrophone() {
        try {
            const s = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                },
                video: false
            });
            attachStream(s, 'microphone');
            return true;
        } catch (err) {
            onStatus('error', 'Microphone access was denied.');
            return false;
        }
    }

    // Loopback capture. This is the only way to analyse Spotify audio: the
    // Web Playback SDK decrypts through Widevine and never exposes samples.
    async function useSystemAudio() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            onStatus('error', 'This browser cannot capture system audio.');
            return false;
        }
        try {
            const s = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            if (s.getAudioTracks().length === 0) {
                s.getTracks().forEach(t => t.stop());
                onStatus('error', 'No audio track shared — tick "Share system audio" / "Share tab audio" in the picker.');
                return false;
            }
            // The video track is only there to unlock audio sharing in Chrome.
            s.getVideoTracks().forEach(t => t.stop());
            attachStream(s, 'system audio');
            return true;
        } catch (err) {
            onStatus('error', 'System audio capture was cancelled.');
            return false;
        }
    }

    function useFile(file) {
        ensureContext();
        disconnect();
        resume();
        const el = new Audio();
        el.src = URL.createObjectURL(file);
        el.crossOrigin = 'anonymous';
        el.loop = true;
        mediaEl = el;
        sourceNode = ctx.createMediaElementSource(el);
        sourceNode.connect(gainTrim);
        // Local files should still be audible, so also route to the speakers.
        sourceNode.connect(ctx.destination);
        sourceLabel = 'file: ' + file.name;
        el.play().catch(() => onStatus('error', 'Could not play that file.'));
        lastSoundAt = performance.now();
        onStatus('connected', sourceLabel);
        return el;
    }

    function setSynthetic(on, bpm) {
        synth.enabled = !!on;
        if (bpm) synth.bpm = bpm;
        metrics.synthetic = synth.enabled;
    }

    function setBpmHint(bpm) {
        if (bpm && bpm > 40 && bpm < 220) synth.bpm = bpm;
    }

    /* ------------------------- band mapping ------------------------------ */

    // Precomputed log-spaced bin edges, rebuilt whenever the context changes.
    let bandEdges = null;

    function buildBandEdges() {
        const nyquist = ctx.sampleRate / 2;
        const bins = analyser.frequencyBinCount;
        const fMin = 30, fMax = Math.min(16000, nyquist);
        bandEdges = new Int32Array(BAND_COUNT + 1);
        for (let i = 0; i <= BAND_COUNT; i++) {
            const f = fMin * Math.pow(fMax / fMin, i / BAND_COUNT);
            bandEdges[i] = Math.min(bins - 1, Math.max(0, Math.round(f / nyquist * bins)));
        }
        // Guarantee each band owns at least one bin.
        for (let i = 1; i <= BAND_COUNT; i++) {
            if (bandEdges[i] <= bandEdges[i - 1]) bandEdges[i] = bandEdges[i - 1] + 1;
        }
    }

    function binRange(fLo, fHi) {
        const nyquist = ctx.sampleRate / 2;
        const bins = analyser.frequencyBinCount;
        return [
            Math.max(0, Math.floor(fLo / nyquist * bins)),
            Math.min(bins - 1, Math.ceil(fHi / nyquist * bins))
        ];
    }

    function averageBins(lo, hi) {
        let sum = 0;
        for (let i = lo; i <= hi; i++) sum += freqData[i];
        return sum / Math.max(1, hi - lo + 1) / 255;
    }

    /* ---------------------------- update --------------------------------- */

    function update(now) {
        if (!started || !analyser) {
            if (synth.enabled) synthesize(now);
            return metrics;
        }
        if (!bandEdges) buildBandEdges();

        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(waveData);

        const g = config.gain;

        // --- five perceptual energy bands ---
        let r;
        r = binRange(20, 140);    metrics.bass    = clamp01(averageBins(r[0], r[1]) * g);
        r = binRange(140, 400);   metrics.lowMid  = clamp01(averageBins(r[0], r[1]) * g);
        r = binRange(400, 2000);  metrics.mid     = clamp01(averageBins(r[0], r[1]) * g);
        r = binRange(2000, 6000); metrics.highMid = clamp01(averageBins(r[0], r[1]) * g);
        r = binRange(6000, 16000); metrics.treble = clamp01(averageBins(r[0], r[1]) * g);

        // --- log-spaced band array for the spectrum visualizers ---
        let flux = 0;
        for (let i = 0; i < BAND_COUNT; i++) {
            const lo = bandEdges[i], hi = bandEdges[i + 1];
            let sum = 0;
            for (let b = lo; b < hi; b++) sum += freqData[b];
            let v = sum / Math.max(1, hi - lo) / 255;
            // Gentle tilt so the highs are not visually starved.
            v = clamp01(v * g * (1 + i / BAND_COUNT * 0.9));
            const d = v - prevSpectrum[i];
            if (d > 0) flux += d;
            prevSpectrum[i] = v;
            metrics.bands[i] += (v - metrics.bands[i]) * 0.45;
            metrics.peaks[i] = Math.max(metrics.peaks[i] * 0.965, metrics.bands[i]);
        }
        metrics.flux = clamp01(flux / 6);

        // --- time domain ---
        let rms = 0;
        const step = waveData.length / WAVE_COUNT;
        for (let i = 0; i < WAVE_COUNT; i++) {
            const v = (waveData[Math.floor(i * step)] - 128) / 128;
            metrics.wave[i] = v;
            rms += v * v;
        }
        metrics.level = clamp01(Math.sqrt(rms / WAVE_COUNT) * 2.2 * g);

        detectBeat(now);

        // If the chosen source is silent for a while, tell the UI so it can
        // suggest the synthetic driver instead of showing a dead canvas.
        if (metrics.level > 0.012) lastSoundAt = now;
        const audible = (now - lastSoundAt) < 2200;
        if (audible !== metrics.live && sourceLabel !== 'none') {
            metrics.live = audible;
            onStatus(audible ? 'audible' : 'silent', sourceLabel);
        }

        if (synth.enabled && !audible) synthesize(now);
        return metrics;
    }

    function detectBeat(now) {
        bassHistory.shift();
        bassHistory.push(metrics.bass);

        let mean = 0;
        for (let i = 0; i < bassHistory.length; i++) mean += bassHistory[i];
        mean /= bassHistory.length;

        let varSum = 0;
        for (let i = 0; i < bassHistory.length; i++) {
            const d = bassHistory[i] - mean;
            varSum += d * d;
        }
        const stdDev = Math.sqrt(varSum / bassHistory.length);
        const threshold = mean + config.sensitivity * stdDev;

        const hit = metrics.bass > threshold && metrics.bass > 0.28 && (now - lastBeatAt) > 180;
        metrics.beat = hit;

        if (hit) {
            if (lastBeatAt) {
                const interval = now - lastBeatAt;
                if (interval > 250 && interval < 1500) {
                    beatTimes.push(interval);
                    if (beatTimes.length > 16) beatTimes.shift();
                    const sorted = beatTimes.slice().sort((a, b) => a - b);
                    const median = sorted[sorted.length >> 1];
                    metrics.bpm = Math.round(60000 / median);
                    synth.bpm = metrics.bpm;
                }
            }
            lastBeatAt = now;
            metrics.beatCount++;
            metrics.beatPulse = 1;
        } else {
            metrics.beatPulse *= 0.90;
        }
    }

    /* -------------------------- synthetic -------------------------------- */

    // Fabricates plausible-looking metrics from a tempo. Used when Spotify is
    // playing but the audio itself is not reachable (DRM / no loopback), so
    // the visuals still move in time with the track instead of freezing.
    function synthesize(now) {
        const t = now / 1000;
        const beatLen = 60 / synth.bpm;
        const prevPhase = synth.phase;
        synth.phase = (t % beatLen) / beatLen;
        const wrapped = synth.phase < prevPhase;

        const env = Math.pow(1 - synth.phase, 2.4);
        const o = synth.seedOffset;

        metrics.bass    = clamp01(0.28 + env * 0.62 + Math.sin(t * 0.7 + o) * 0.06);
        metrics.lowMid  = clamp01(0.22 + env * 0.34 + Math.sin(t * 1.3 + o) * 0.10);
        metrics.mid     = clamp01(0.24 + Math.sin(t * 2.1 + o) * 0.16 + env * 0.20);
        metrics.highMid = clamp01(0.20 + Math.sin(t * 3.3 + o * 1.7) * 0.15 + env * 0.16);
        metrics.treble  = clamp01(0.16 + Math.abs(Math.sin(t * 5.1 + o * 2.3)) * 0.28 + env * 0.12);
        metrics.level   = clamp01(0.25 + env * 0.4);
        metrics.flux    = env * 0.8;

        for (let i = 0; i < BAND_COUNT; i++) {
            const n = i / BAND_COUNT;
            const shape = Math.pow(1 - n, 1.15);
            const wobble = 0.5 + 0.5 * Math.sin(t * (1.2 + n * 5) + i * 0.5 + o);
            const v = clamp01(shape * (0.35 + 0.65 * wobble) * (0.55 + env * 0.75));
            metrics.bands[i] += (v - metrics.bands[i]) * 0.3;
            metrics.peaks[i] = Math.max(metrics.peaks[i] * 0.965, metrics.bands[i]);
        }

        for (let i = 0; i < WAVE_COUNT; i++) {
            const p = i / WAVE_COUNT;
            metrics.wave[i] =
                Math.sin(p * Math.PI * 2 * 3 + t * 4) * 0.4 * (0.4 + env) +
                Math.sin(p * Math.PI * 2 * 11 + t * 9) * 0.16 * metrics.treble +
                Math.sin(p * Math.PI * 2 * 27 + t * 3) * 0.06;
        }

        metrics.beat = wrapped;
        if (wrapped) { metrics.beatCount++; metrics.beatPulse = 1; }
        else metrics.beatPulse *= 0.9;
        metrics.bpm = synth.bpm;
    }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    /* ----------------------------- api ----------------------------------- */

    return {
        metrics: metrics,
        config: config,
        BAND_COUNT: BAND_COUNT,
        WAVE_COUNT: WAVE_COUNT,
        update: update,
        useMicrophone: useMicrophone,
        useSystemAudio: useSystemAudio,
        useFile: useFile,
        setSynthetic: setSynthetic,
        setBpmHint: setBpmHint,
        disconnect: disconnect,
        resume: resume,
        isStarted: function () { return started; },
        sourceLabel: function () { return sourceLabel; },
        onStatus: function (fn) { onStatus = fn; },
        setSmoothing: function (v) {
            config.smoothing = v;
            if (analyser) analyser.smoothingTimeConstant = v;
        }
    };
})();
