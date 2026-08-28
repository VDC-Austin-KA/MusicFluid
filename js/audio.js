/* ==========================================================================
   AudioEngine — capture and full-spectrum analysis.

   The design goal here is that *every* part of the spectrum stays expressive
   regardless of the track. A single global gain cannot do that: a bass-heavy
   mix pins the low bands at 1.0 while the air band never leaves the floor.
   So each band runs its own automatic gain against a decaying running peak,
   and reports a normalised value scaled to how loud that band has recently
   been rather than to the mix as a whole.

   Everything a visualizer needs hangs off `metrics`, so modes never need to
   know where the sound came from or how it was conditioned.
   ========================================================================== */

window.AudioEngine = (function () {
    'use strict';

    const BAND_COUNT = 64;      // log-spaced bands handed to the visualizers
    const WAVE_COUNT = 1024;    // time-domain samples
    const CHROMA = 12;          // pitch classes
    const HISTORY = 60;

    let ctx = null, analyser = null, gainTrim = null;
    let freqData = null, waveData = null;
    let sourceNode = null, stream = null, mediaEl = null;
    let captureKind = 'none';   // 'display' | 'mic' | 'file' | 'none'

    let started = false;
    let sourceLabel = 'none';
    let lastSoundAt = 0;

    const beatTimes = [];
    let lastBeatAt = 0;

    const synth = { enabled: false, bpm: 120, phase: 0, seed: Math.random() * 1000 };

    /* ------------------------ band definitions --------------------------- */

    // Seven perceptual regions rather than three. Each is tracked
    // independently so a mode can bind a visual layer to any one of them.
    const BAND_DEFS = [
        { key: 'subBass',  lo: 20,   hi: 60 },
        { key: 'bass',     lo: 60,   hi: 160 },
        { key: 'lowMid',   lo: 160,  hi: 400 },
        { key: 'mid',      lo: 400,  hi: 1200 },
        { key: 'highMid',  lo: 1200, hi: 3200 },
        { key: 'presence', lo: 3200, hi: 7000 },
        { key: 'air',      lo: 7000, hi: 16000 }
    ];

    function makeBand(key) {
        return {
            key: key,
            raw: 0,      // straight measurement 0..1
            level: 0,    // smoothed raw
            norm: 0,     // adaptive-normalised 0..1  <- what modes should use
            env: 0,      // fast-attack slow-release envelope of norm
            onset: 0,    // transient strength 0..1, decays
            peak: 0,     // mirrors `ceil`, kept for older call sites
            floor: 0,    // bottom of the band's recent dynamic range
            ceil: 0,     // top of it; norm spans floor..ceil
            prev: 0,
            hit: false   // true on the frame this band fires a transient
        };
    }

    const bands = {};
    BAND_DEFS.forEach(d => { bands[d.key] = makeBand(d.key); });

    const metrics = {
        // Legacy scalars, kept so older call sites keep working. These now
        // carry the *normalised* value, which is why the visuals open up.
        bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,

        band: bands,                              // the seven-band object
        bands: new Float32Array(BAND_COUNT),      // smoothed spectrum
        bandsNorm: new Float32Array(BAND_COUNT),  // per-bin adaptive normalised
        onsets: new Float32Array(BAND_COUNT),     // per-bin transient
        peaks: new Float32Array(BAND_COUNT),
        wave: new Float32Array(WAVE_COUNT),
        chroma: new Float32Array(CHROMA),         // pitch-class energy
        chromaPeak: 0,                            // index of strongest class
        centroid: 0.5,   // spectral centre of mass, 0..1
        spread: 0.5,     // how wide the spectrum sits around the centroid
        flux: 0,         // broadband onset strength
        level: 0,
        saturation: 0,   // share of bins pinned at full scale — drives auto-level
        autoGain: 1,     // current input trim the auto-level settled on
        energy: 0,       // adaptive-normalised overall loudness
        beat: false,
        beatPulse: 0,
        beatCount: 0,
        bpm: 0,
        live: false,
        synthetic: false
    };

    // Adaptive envelopes for the per-bin normalisation.
    const binPeak = new Float32Array(BAND_COUNT);
    const binPrev = new Float32Array(BAND_COUNT);
    const binRange = Array.from({ length: BAND_COUNT }, () => ({ floor: 0, ceil: 0 }));

    const energyRange = { floor: 0, ceil: 0 };

    const config = {
        gain: 1.2,
        sensitivity: 1.5,
        smoothing: 0.82,
        adaptive: 1.0,   // 0 = raw levels, 1 = fully adaptive per-band range
        autoLevel: false, // off by default; opt in from the panel
        attack: 0.55,
        release: 0.08
    };

    // Input auto-level. The band normaliser handles *shape*; this handles
    // *placement* — a quiet stream and a mastered-loud one both need to land in
    // the analyser's usable window before any of the per-band maths can help.
    const TARGET_LEVEL = 0.34;   // broadband RMS we aim the input at
    const GAIN_MIN = 0.15, GAIN_MAX = 12;
    let autoGain = 1;

    function updateAutoLevel(rawLevel, saturation) {
        if (!config.autoLevel || !gainTrim) return;
        // Clipping is not a level error to be averaged away — back off hard and
        // immediately, or the spectrum stays pinned while the mean looks fine.
        if (saturation > 0.25) {
            autoGain *= 0.97;
        } else if (rawLevel > 0.0015) {
            autoGain *= 1 + (TARGET_LEVEL - rawLevel) * 0.06;
        } else {
            return;              // silence tells us nothing about the right gain
        }
        autoGain = Math.max(GAIN_MIN, Math.min(GAIN_MAX, autoGain));
        // Ramp rather than step, so a gain move never reads as a transient.
        const target = autoGain;
        const cur = gainTrim.gain.value;
        gainTrim.gain.value = cur + (target - cur) * 0.1;
    }

    let onStatus = function () {};

    /* ----------------------------- setup --------------------------------- */

    function ensureContext() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;             // finer resolution for chroma
        analyser.smoothingTimeConstant = config.smoothing;
        // The defaults (-100..-30) put a typical noise floor near 40% of full
        // scale. -20 dB at the top was worse: a normal master runs well above
        // that, so most bins saturated at 255 before normalisation ever ran and
        // every meter sat at full. Leave real headroom above line level and let
        // the auto-level below place the signal inside the window.
        analyser.minDecibels = -95;
        analyser.maxDecibels = -10;
        gainTrim = ctx.createGain();
        gainTrim.gain.value = 1;
        gainTrim.connect(analyser);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        waveData = new Uint8Array(analyser.fftSize);
        started = true;
        return ctx;
    }

    function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

    // iOS starts every AudioContext suspended and only lets it start from
    // inside a user gesture, so this is wired to the first touch/click.
    function unlock() {
        ensureContext();
        if (ctx.state === 'suspended') ctx.resume();
        try {
            const buf = ctx.createBuffer(1, 1, 22050);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
        } catch (e) { /* already running */ }
    }

    function disconnect() {
        if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} sourceNode = null; }
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (mediaEl) { mediaEl.pause(); mediaEl = null; }
        sourceLabel = 'none';
        captureKind = 'none';
        metrics.live = false;
    }

    // A new source has its own spectral balance, so the adaptive envelopes
    // must not carry the previous source's range over.
    function resetAdaptive() {
        for (let i = 0; i < BAND_COUNT; i++) {
            binPeak[i] = 0;
            binRange[i].floor = 0; binRange[i].ceil = 0;
        }
        BAND_DEFS.forEach(d => {
            const b = bands[d.key];
            b.peak = 0; b.floor = 0; b.ceil = 0;
        });
        energyRange.floor = 0; energyRange.ceil = 0;
        autoGain = 1;
        if (gainTrim) gainTrim.gain.value = 1;
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
        resetAdaptive();
        s.getTracks().forEach(t => {
            t.addEventListener('ended', () => {
                if (stream === s) { disconnect(); onStatus('ended', label); }
            });
        });
        onStatus('connected', label);
    }

    /* ---------------------------- sources -------------------------------- */

    async function useMicrophone() {
        try {
            const s = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                video: false
            });
            attachStream(s, 'microphone');
            captureKind = 'mic';
            return true;
        } catch (err) {
            onStatus('error', 'Microphone access was denied.');
            return false;
        }
    }

    // Loopback capture. This is the only way to analyse Spotify audio: the
    // Web Playback SDK decrypts through Widevine and never exposes samples.
    function hasLiveCapture() {
        return captureKind === 'display' && stream &&
            stream.getAudioTracks().some(function (t) { return t.readyState === 'live'; });
    }

    // `force` re-opens the picker even when a capture is already running; the
    // System button passes it so a wrong pick can be corrected.
    async function useSystemAudio(label, force) {
        // The picker is the browser's security boundary and cannot be skipped,
        // but it only has to be crossed once: an existing live capture is reused
        // rather than re-prompted for.
        if (!force && hasLiveCapture()) {
            sourceLabel = label || sourceLabel;
            resetAdaptive();
            onStatus('connected', sourceLabel + ' (already capturing)');
            return true;
        }
        if (window.MF_IOS) {
            onStatus('error', 'iOS cannot capture system audio. Play the music out loud and use Mic instead.');
            return false;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            onStatus('error', 'This browser cannot capture system audio.');
            return false;
        }
        try {
            const s = await navigator.mediaDevices.getDisplayMedia({
                // Chrome honours these to preselect THIS tab, which turns the
                // picker into a single confirm for the in-page player. Other
                // browsers ignore the unknown members.
                preferCurrentTab: true,
                systemAudio: 'include',
                video: true,
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            });
            if (s.getAudioTracks().length === 0) {
                s.getTracks().forEach(t => t.stop());
                onStatus('error', 'No audio track shared — tick "Share system audio" / "Share tab audio" in the picker.');
                return false;
            }
            s.getVideoTracks().forEach(t => t.stop());
            attachStream(s, label || 'system audio');
            captureKind = 'display';
            // A capture the user ends from the browser's own bar must not leave
            // a dead stream behind that the reuse check would trust.
            s.getAudioTracks().forEach(function (t) {
                t.addEventListener('ended', function () { captureKind = 'none'; });
            });
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
        sourceNode.connect(ctx.destination);
        sourceLabel = 'file: ' + file.name;
        captureKind = 'file';
        resetAdaptive();
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

    function setBpmHint(bpm) { if (bpm > 40 && bpm < 220) synth.bpm = bpm; }

    /* -------------------------- bin mapping ------------------------------ */

    let bandEdges = null, bandDefBins = null, chromaMap = null;

    function buildMaps() {
        const nyquist = ctx.sampleRate / 2;
        const bins = analyser.frequencyBinCount;
        const fMin = 25, fMax = Math.min(17000, nyquist);

        bandEdges = new Int32Array(BAND_COUNT + 1);
        for (let i = 0; i <= BAND_COUNT; i++) {
            const f = fMin * Math.pow(fMax / fMin, i / BAND_COUNT);
            // Bin 0 is DC; a mic offset there would read as permanent bass.
            bandEdges[i] = Math.min(bins - 1, Math.max(1, Math.round(f / nyquist * bins)));
        }
        for (let i = 1; i <= BAND_COUNT; i++) {
            if (bandEdges[i] <= bandEdges[i - 1]) bandEdges[i] = bandEdges[i - 1] + 1;
        }

        bandDefBins = BAND_DEFS.map(d => [
            Math.max(1, Math.floor(d.lo / nyquist * bins)),
            Math.min(bins - 1, Math.ceil(d.hi / nyquist * bins))
        ]);

        // Pitch-class lookup over the musical fundamental range only; above
        // ~2kHz harmonics smear the classes and the reading stops being useful.
        chromaMap = new Int8Array(bins).fill(-1);
        const binHz = nyquist / bins;
        for (let b = 1; b < bins; b++) {
            const f = b * binHz;
            if (f < 65 || f > 2100) continue;
            const midi = 69 + 12 * Math.log2(f / 440);
            chromaMap[b] = ((Math.round(midi) % 12) + 12) % 12;
        }
    }

    // Per-band automatic gain: each band is measured against how loud *it*
    // has recently been, not against the mix as a whole. That is what keeps a
    // quiet air band as expressive as a dominant kick.
    //
    // Normalisation against a per-band *dynamic range*, not a bare maximum.
    //
    // The previous version divided by a decaying running peak that had already
    // been raised by the current sample: `peak = max(v, peak*decay)` then
    // `v / peak`. Every new maximum therefore reported exactly 1.0, and on a
    // compressed master — where a band sits near its own recent peak more or
    // less permanently — the reading stayed pinned at full scale and nothing
    // moved. Dividing by the ceiling alone cannot express dynamics; you need
    // both ends of the range.
    //
    // An even earlier version did track a floor and a ceiling and was abandoned
    // because a steady band collapsed its own span to nothing and went dead.
    // That failure is real but it is not inherent — it is fixed by refusing to
    // let the span shrink below MIN_SPAN, which is what the guard below does.
    // Both envelopes close in on the signal at the same slow rate (~2 s), which
    // is what makes a *steady* band settle to mid-scale instead of pegging: with
    // a slow floor the span never shrinks, so the ceiling converges onto the
    // signal and the ratio sticks at 1 — the same trap as dividing by the peak.
    const CEIL_ATTACK = 0.3;     // ceiling jumps most of the way to a new peak
    const CEIL_RELEASE = 0.008;  // ...and sags back, so quiet passages open up
    const FLOOR_ATTACK = 0.3;    // floor drops quickly to a new minimum
    const FLOOR_RELEASE = 0.008; // ...and closes back in symmetrically
    const MIN_SPAN = 0.06;       // the anti-collapse guard
    const GATE = 0.02;           // below this a band is treated as silent

    // Pure and side-effect-free apart from `r`, so scripts/test-audio-range.js
    // can drive it directly without Web Audio.
    function rangeNorm(r, v) {
        r.ceil += (v > r.ceil ? CEIL_ATTACK : CEIL_RELEASE) * (v - r.ceil);
        r.floor += (v < r.floor ? FLOOR_ATTACK : FLOOR_RELEASE) * (v - r.floor);

        if (r.ceil < GATE) return 0;          // silence stays silence

        // A band with no real dynamics must not divide by ~0 and read full
        // scale forever; widen symmetrically around its own centre so it sits
        // mid-scale instead. The widening is local to this division — writing it
        // back would inflate the stored ceiling past the gate above and make
        // near-silence read 0.5.
        let lo = r.floor, hi = r.ceil;
        if (hi - lo < MIN_SPAN) {
            const mid = (hi + lo) * 0.5;
            lo = mid - MIN_SPAN * 0.5;
            hi = mid + MIN_SPAN * 0.5;
        }
        return clamp01((v - lo) / (hi - lo));
    }

    function adaptBand(b, value) {
        b.peak = b.ceil;                       // kept for anything reading .peak
        return value + (rangeNorm(b, value) - value) * config.adaptive;
    }

    /* ----------------------------- update -------------------------------- */

    function update(now) {
        if (!started || !analyser) {
            if (synth.enabled) synthesize(now);
            return metrics;
        }
        if (!bandEdges) buildMaps();

        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(waveData);

        const g = config.gain;

        /* --- per-bin spectrum, normalisation and transients --- */
        let flux = 0, weighted = 0, total = 0, hot = 0;
        for (let i = 0; i < BAND_COUNT; i++) {
            const lo = bandEdges[i], hi = bandEdges[i + 1];
            let sum = 0;
            for (let b = lo; b < hi; b++) { sum += freqData[b]; if (freqData[b] > 250) hot++; }
            const v = clamp01(sum / Math.max(1, hi - lo) / 255 * g);

            metrics.bands[i] += (v - metrics.bands[i]) * 0.45;

            const d = v - binPrev[i];
            if (d > 0) flux += d;
            metrics.onsets[i] = Math.max(metrics.onsets[i] * 0.86, d > 0.035 ? clamp01(d * 6) : 0);
            binPrev[i] = v;

            const n = rangeNorm(binRange[i], v);
            binPeak[i] = binRange[i].ceil;
            metrics.bandsNorm[i] = v + (n - v) * config.adaptive;

            metrics.peaks[i] = Math.max(metrics.peaks[i] * 0.965, metrics.bands[i]);

            weighted += i * v;
            total += v;
        }
        metrics.flux = clamp01(flux / 6);
        const centroidRaw = total > 0.001 ? weighted / total / BAND_COUNT : 0.5;
        metrics.centroid += (centroidRaw - metrics.centroid) * 0.12;

        // Spread: mean absolute deviation around the centroid.
        let dev = 0;
        if (total > 0.001) {
            for (let i = 0; i < BAND_COUNT; i++) {
                dev += Math.abs(i / BAND_COUNT - centroidRaw) * metrics.bands[i];
            }
            dev /= total;
        }
        metrics.spread += (clamp01(dev * 3) - metrics.spread) * 0.1;

        /* --- the seven perceptual bands --- */
        for (let k = 0; k < BAND_DEFS.length; k++) {
            const b = bands[BAND_DEFS[k].key], range = bandDefBins[k];
            let sum = 0;
            for (let i = range[0]; i <= range[1]; i++) sum += freqData[i];
            const raw = clamp01(sum / Math.max(1, range[1] - range[0] + 1) / 255 * g);

            b.raw = raw;
            b.level += (raw - b.level) * 0.4;
            b.norm = adaptBand(b, b.level);

            // Fast attack, slow release — this is what makes motion feel
            // punchy on hits without flickering out between them.
            b.env += b.norm > b.env
                ? (b.norm - b.env) * config.attack
                : (b.norm - b.env) * config.release;

            const rise = raw - b.prev;
            b.hit = rise > 0.05 && b.norm > 0.35;
            b.onset = Math.max(b.onset * 0.85, b.hit ? clamp01(rise * 7) : 0);
            b.prev = raw;
        }

        // Legacy scalars now carry normalised values.
        metrics.bass = bands.bass.norm;
        metrics.lowMid = bands.lowMid.norm;
        metrics.mid = bands.mid.norm;
        metrics.highMid = bands.highMid.norm;
        metrics.treble = bands.air.norm;

        /* --- chroma --- */
        for (let i = 0; i < CHROMA; i++) metrics.chroma[i] *= 0.82;
        let chromaTotal = 0;
        for (let b = 1; b < chromaMap.length; b++) {
            const c = chromaMap[b];
            if (c < 0) continue;
            const v = freqData[b] / 255;
            metrics.chroma[c] += v * 0.18;
            chromaTotal += v;
        }
        let best = 0;
        for (let i = 1; i < CHROMA; i++) if (metrics.chroma[i] > metrics.chroma[best]) best = i;
        if (chromaTotal > 0.5) metrics.chromaPeak = best;

        /* --- time domain --- */
        let rms = 0;
        const step = waveData.length / WAVE_COUNT;
        for (let i = 0; i < WAVE_COUNT; i++) {
            const v = (waveData[Math.floor(i * step)] - 128) / 128;
            metrics.wave[i] = v;
            rms += v * v;
        }
        const rawLevel = Math.sqrt(rms / WAVE_COUNT);
        metrics.level = clamp01(rawLevel * 2.2 * g);
        metrics.saturation = hot / Math.max(1, bandEdges[BAND_COUNT] - bandEdges[0]);
        metrics.autoGain = gainTrim ? gainTrim.gain.value : 1;
        updateAutoLevel(rawLevel, metrics.saturation);

        metrics.energy = metrics.level +
            (rangeNorm(energyRange, metrics.level) - metrics.level) * config.adaptive;

        detectBeat(now);

        if (metrics.level > 0.012) lastSoundAt = now;
        const audible = (now - lastSoundAt) < 2200;
        if (audible !== metrics.live && sourceLabel !== 'none') {
            metrics.live = audible;
            onStatus(audible ? 'audible' : 'silent', sourceLabel);
        }
        if (synth.enabled && !audible) synthesize(now);
        return metrics;
    }

    const driveHistory = new Array(HISTORY).fill(0);

    function detectBeat(now) {
        // Watch sub-bass and bass together rather than one band, so
        // kick-light material still produces beats.
        const drive = Math.max(bands.subBass.norm, bands.bass.norm);
        driveHistory.shift();
        driveHistory.push(drive);

        let mean = 0;
        for (let i = 0; i < driveHistory.length; i++) mean += driveHistory[i];
        mean /= driveHistory.length;
        let varSum = 0;
        for (let i = 0; i < driveHistory.length; i++) {
            const d = driveHistory[i] - mean;
            varSum += d * d;
        }
        const stdDev = Math.sqrt(varSum / driveHistory.length);
        const threshold = mean + config.sensitivity * stdDev;

        const onsetHit = bands.bass.hit || bands.subBass.hit;
        const hit = drive > threshold && drive > 0.25 && onsetHit && (now - lastBeatAt) > 180;
        metrics.beat = hit;

        if (hit) {
            if (lastBeatAt) {
                const interval = now - lastBeatAt;
                if (interval > 250 && interval < 1500) {
                    beatTimes.push(interval);
                    if (beatTimes.length > 16) beatTimes.shift();
                    const sorted = beatTimes.slice().sort((a, b) => a - b);
                    metrics.bpm = Math.round(60000 / sorted[sorted.length >> 1]);
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

    /* --------------------------- synthetic -------------------------------- */

    // Fabricates plausible metrics from a tempo, so the visuals still move
    // when the real waveform is unreachable (DRM, no loopback, muted source).
    function synthesize(now) {
        const t = now / 1000;
        const beatLen = 60 / synth.bpm;
        const prev = synth.phase;
        synth.phase = (t % beatLen) / beatLen;
        const wrapped = synth.phase < prev;
        const env = Math.pow(1 - synth.phase, 2.4);
        const o = synth.seed;

        const vals = {
            subBass: 0.30 + env * 0.62,
            bass: 0.26 + env * 0.60 + Math.sin(t * 0.7 + o) * 0.06,
            lowMid: 0.24 + env * 0.32 + Math.sin(t * 1.3 + o) * 0.10,
            mid: 0.26 + Math.sin(t * 2.1 + o) * 0.18 + env * 0.20,
            highMid: 0.22 + Math.sin(t * 3.3 + o * 1.7) * 0.17 + env * 0.16,
            presence: 0.20 + Math.abs(Math.sin(t * 4.2 + o * 2)) * 0.24 + env * 0.14,
            air: 0.18 + Math.abs(Math.sin(t * 5.1 + o * 2.3)) * 0.28 + env * 0.12
        };
        BAND_DEFS.forEach(d => {
            const b = bands[d.key];
            const v = clamp01(vals[d.key]);
            b.raw = v; b.level = v; b.norm = v;
            b.env += v > b.env ? (v - b.env) * config.attack : (v - b.env) * config.release;
            b.hit = wrapped && (d.key === 'bass' || d.key === 'subBass');
            b.onset = Math.max(b.onset * 0.85, b.hit ? 1 : 0);
        });

        metrics.bass = bands.bass.norm;
        metrics.lowMid = bands.lowMid.norm;
        metrics.mid = bands.mid.norm;
        metrics.highMid = bands.highMid.norm;
        metrics.treble = bands.air.norm;
        metrics.level = clamp01(0.25 + env * 0.4);
        metrics.energy = metrics.level;
        metrics.flux = env * 0.8;
        metrics.centroid = 0.4 + Math.sin(t * 0.3) * 0.15;
        metrics.spread = 0.5;

        for (let i = 0; i < BAND_COUNT; i++) {
            const n = i / BAND_COUNT;
            const shape = Math.pow(1 - n, 1.15);
            const wob = 0.5 + 0.5 * Math.sin(t * (1.2 + n * 5) + i * 0.5 + o);
            const v = clamp01(shape * (0.35 + 0.65 * wob) * (0.55 + env * 0.75));
            metrics.bands[i] += (v - metrics.bands[i]) * 0.3;
            metrics.bandsNorm[i] = clamp01(v / (shape + 0.15));
            metrics.onsets[i] = Math.max(metrics.onsets[i] * 0.86, wrapped ? Math.random() * 0.7 : 0);
            metrics.peaks[i] = Math.max(metrics.peaks[i] * 0.965, metrics.bands[i]);
        }

        for (let i = 0; i < WAVE_COUNT; i++) {
            const p = i / WAVE_COUNT;
            metrics.wave[i] =
                Math.sin(p * Math.PI * 2 * 3 + t * 4) * 0.4 * (0.4 + env) +
                Math.sin(p * Math.PI * 2 * 11 + t * 9) * 0.16 * metrics.treble +
                Math.sin(p * Math.PI * 2 * 27 + t * 3) * 0.06;
        }

        // Walk the pitch class slowly so chroma-driven colour still drifts.
        for (let i = 0; i < CHROMA; i++) metrics.chroma[i] *= 0.9;
        const pc = Math.floor((t * 0.25 + o) % 12);
        metrics.chroma[pc] = Math.min(1, metrics.chroma[pc] + 0.3);
        metrics.chromaPeak = pc;

        metrics.beat = wrapped;
        if (wrapped) { metrics.beatCount++; metrics.beatPulse = 1; }
        else metrics.beatPulse *= 0.9;
        metrics.bpm = synth.bpm;
    }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    /* ------------------------------ api ---------------------------------- */

    return {
        metrics: metrics,
        config: config,
        BAND_COUNT: BAND_COUNT,
        WAVE_COUNT: WAVE_COUNT,
        BAND_KEYS: BAND_DEFS.map(d => d.key),
        update: update,
        useMicrophone: useMicrophone,
        useSystemAudio: useSystemAudio,
        useFile: useFile,
        setSynthetic: setSynthetic,
        setBpmHint: setBpmHint,
        disconnect: disconnect,
        resume: resume,
        unlock: unlock,
        resetAdaptive: resetAdaptive,
        isStarted: function () { return started; },
        hasLiveCapture: hasLiveCapture,
        sourceLabel: function () { return sourceLabel; },
        onStatus: function (fn) { onStatus = fn; },
        setAutoLevel: function (on) {
            config.autoLevel = !!on;
            if (!on && gainTrim) { autoGain = 1; gainTrim.gain.value = 1; }
        },
        // exposed for scripts/test-audio-range.js
        _rangeNorm: rangeNorm,
        setSmoothing: function (v) {
            config.smoothing = v;
            if (analyser) analyser.smoothingTimeConstant = v;
        }
    };
})();
