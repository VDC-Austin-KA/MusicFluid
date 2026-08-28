/* ==========================================================================
   Viz2D — canvas-2D render engine.

   Only Aurora Curtains lives here now, but it is a full citizen of the layer
   system: one curtain per frequency band, each with its own height, drift and
   colour, so the sky separates into distinct spectral sheets rather than
   pulsing as a single mass.
   ========================================================================== */

window.Viz2D = (function () {
    'use strict';

    let canvas = null, g = null;
    let W = 0, H = 0, dpr = 1;
    let art = null;
    let current = null;
    let S = {};

    function init(cnv) {
        canvas = cnv;
        g = canvas.getContext('2d', { alpha: false });
        resize();
        return !!g;
    }

    function resize() {
        if (!canvas) return;
        dpr = Math.min(window.devicePixelRatio || 1, window.MF_MOBILE ? 1.5 : 2);
        // Element-measured, so iOS toolbar collapse cannot leave a stale size.
        W = canvas.clientWidth || window.innerWidth;
        H = canvas.clientHeight || window.innerHeight;
        canvas.width = Math.max(1, Math.floor(W * dpr));
        canvas.height = Math.max(1, Math.floor(H * dpr));
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
    }

    function setMode(mode) {
        current = mode;
        S = {};
        if (g) {
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.fillStyle = '#000';
            g.fillRect(0, 0, W, H);
        }
    }

    function setArt(img) { art = img; }

    function frame(t, m, env) {
        if (!g || !current) return;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;

        const fade = current.fade === undefined ? 0.16 : current.fade;
        if (fade >= 1) {
            g.fillStyle = current.bg || '#000';
            g.fillRect(0, 0, W, H);
        } else if (fade > 0) {
            g.fillStyle = 'rgba(0,0,0,' + fade + ')';
            g.fillRect(0, 0, W, H);
        }

        current.draw(g, W, H, t, m, S, env, art);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
    }

    return {
        init: init, resize: resize, setMode: setMode, setArt: setArt, frame: frame,
        size: function () { return { w: W, h: H }; }
    };
})();


window.Viz2DModes = (function () {
    'use strict';

    const P = window.Palette;
    const BANDS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'air'];
    // Which UI layer toggle each curtain belongs to.
    const GROUP_OF = ['sub', 'sub', 'mid', 'mid', 'high', 'high', 'air'];

    // Fractional Brownian motion from stacked sines: each octave doubles the
    // frequency and halves the weight, so the curtain edge carries detail at
    // every scale and never resolves into a plain wave.
    function fbm(x, t, octaves, seed) {
        let sum = 0, amp = 1, freq = 1, norm = 0;
        for (let i = 0; i < octaves; i++) {
            sum += Math.sin(x * freq + t * (0.6 + i * 0.35) + seed + i * 2.399) * amp;
            norm += amp;
            amp *= 0.52;
            freq *= 2.03;    // slightly off 2.0 so octaves never phase-lock
        }
        return sum / norm;
    }

    const modes = [
    {
        id: 'aurora', name: 'Aurora Curtains', group: 'Atmosphere', fade: 1,
        draw: function (g, W, H, t, m, S, env) {
            const k = env.k, depth = env.depth, p = env.pointer;
            const time = t * 0.001;

            /* --- stars, twinkled by presence transients --- */
            if (!S.stars) {
                S.stars = [];
                for (let i = 0; i < 90; i++) {
                    S.stars.push({ x: Math.random(), y: Math.random() * 0.7, s: Math.random() });
                }
            }
            const twinkle = m.band.presence.onset;
            for (let i = 0; i < S.stars.length; i++) {
                const s = S.stars[i];
                const a = 0.12 + s.s * 0.35 +
                          Math.abs(Math.sin(time * (0.5 + s.s * 2) + i)) * 0.25 +
                          twinkle * 0.5;
                g.fillStyle = P.css(0.15 + s.s * 0.2, Math.min(1, a));
                g.fillRect(s.x * W, s.y * H, 1.4 + s.s * 1.2, 1.4 + s.s * 1.2);
            }

            /* --- one curtain per band, back to front --- */
            const px = p.active ? p.x * W : -1e9;
            for (let L = 0; L < BANDS.length; L++) {
                if (env.layerOn[GROUP_OF[L]] === false) continue;
                const band = m.band[BANDS[L]];
                const n = L / (BANDS.length - 1);

                // Low bands sit low and wide, high bands ride high and tight.
                const yBase = H * (0.78 - n * 0.42);
                const amp = H * (0.05 + n * 0.05) * (0.35 + band.env * 1.9) * k * depth;
                const octaves = 3 + Math.round(n * 4);   // more detail up top
                const speed = 0.25 + n * 0.85;
                const seed = L * 4.7;

                g.beginPath();
                g.moveTo(0, H);
                const stepPx = W < 700 ? 10 : 7;
                for (let x = 0; x <= W; x += stepPx) {
                    const u = x / W;
                    let y = yBase + fbm(u * 5.5, time * speed, octaves, seed) * amp;

                    // Per-band spectral bump: the slice of the spectrum this
                    // curtain owns lifts the exact part of it that is loud.
                    const bi = Math.floor((u * 0.85 + n * 0.1) * (m.bandsNorm.length - 1));
                    y -= m.bandsNorm[bi] * amp * 0.85;

                    // Pointer bends nearby curtain upward — direct and local.
                    if (p.active && env.interact > 0) {
                        const d = Math.abs(x - px) / (W * 0.22);
                        if (d < 3) {
                            y -= Math.exp(-d * d) * H * 0.1 * env.interact *
                                 (p.down ? 2.2 : 1);
                        }
                    }
                    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.lineTo(W, H);
                g.lineTo(0, H);
                g.closePath();

                const grad = g.createLinearGradient(0, yBase - amp * 2, 0, H);
                const tone = P.flow(L * 0.11, 0.3);
                grad.addColorStop(0, P.css(tone, 0.03));
                grad.addColorStop(0.18, P.css(tone, 0.34 + band.env * 0.4));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = grad;
                g.fill();

                // A bright rim on the leading edge reads as the curtain's
                // "ribbon" and is what makes the aurora look lit rather than
                // painted; air transients make it crackle.
                g.strokeStyle = P.css(tone + 0.06, 0.12 + band.env * 0.5 + m.band.air.onset * 0.3);
                g.lineWidth = 1 + band.env * 2.2;
                g.stroke();
            }

            /* --- beat bloom across the horizon --- */
            if (m.beatPulse > 0.02) {
                const grad = g.createLinearGradient(0, H * 0.55, 0, H);
                grad.addColorStop(0, P.css(P.flow(0.4, 0.3), m.beatPulse * 0.22));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = grad;
                g.fillRect(0, H * 0.55, W, H * 0.45);
            }

            /* --- pointer glow --- */
            if (p.active && env.interact > 0) {
                const r = H * 0.16 * (p.down ? 1.6 : 1);
                const gx = p.x * W, gy = p.sy * H;
                const rg = g.createRadialGradient(gx, gy, 0, gx, gy, r);
                rg.addColorStop(0, P.css(P.flow(0.55, 0.4), 0.30 * env.interact));
                rg.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = rg;
                g.fillRect(gx - r, gy - r, r * 2, r * 2);
            }
        }
    },

    /* ----------------------------------------------------------------------
       Spectrogram - the waterfall every serious analyser draws (audioMotion,
       Chrome Music Lab's spectrogram). Time scrolls left, frequency runs up
       the screen, brightness is energy. It is the one view where a song's
       *structure* is legible: verses, drops and risers all have a shape.
       fade:0 because the history IS the image - it must not be cleared.
       ---------------------------------------------------------------------- */
    {
        id: 'spectrogram', name: 'Spectrogram', group: 'Analysis', fade: 0,
        draw: function (g, W, H, t, m, S, env) {
            const cv = g.canvas;
            const dpr = cv.width / Math.max(1, W);
            const step = Math.max(1, Math.round(2 * dpr));

            // Scroll by blitting the canvas onto itself one step left. 'copy'
            // avoids compositing the old frame with itself into mush.
            g.save();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.globalCompositeOperation = 'copy';
            g.drawImage(cv, -step, 0);
            g.globalCompositeOperation = 'source-over';

            const x = cv.width - step;
            g.fillStyle = '#000';
            g.fillRect(x, 0, step, cv.height);

            const n = m.bandsNorm.length;
            for (let i = 0; i < n; i++) {
                const v = Math.min(1, m.bandsNorm[i] * env.k);
                if (v < 0.02) continue;
                const y0 = cv.height * (1 - (i + 1) / n);
                const y1 = cv.height * (1 - i / n);
                // Energy drives hue offset as well as alpha, so loud bins read
                // hotter and not merely brighter.
                g.fillStyle = P.css(P.flow(0.02, 0.25) + v * 0.3, 0.05 + v * 1.1);
                g.fillRect(x, y0, step, y1 - y0 + 1);
            }

            // A beat lays a faint full-height tick, so the pulse of the track
            // stays visible in the scrolled history.
            if (m.beat) {
                g.fillStyle = P.css(P.flow(0.5, 0.3), 0.28);
                g.fillRect(x, 0, step, cv.height);
            }
            g.restore();
        }
    },

    /* ----------------------------------------------------------------------
       Radial Spectrum - the polar bar analyser (audioMotion's radial mode).
       Bars run outward from a ring, mirrored across the vertical so the
       spectrum closes into a symmetric bloom that pulses on the beat.
       ---------------------------------------------------------------------- */
    {
        id: 'radial-bars', name: 'Radial Spectrum', group: 'Analysis', fade: 0.3,
        draw: function (g, W, H, t, m, S, env) {
            const cx = W / 2, cy = H / 2;
            const n = m.bandsNorm.length;
            const base = Math.min(W, H) * (0.16 + m.energy * 0.05 * env.k);
            const reach = Math.min(W, H) * 0.3 * env.depth;
            const spin = t * 0.00004 * (0.4 + m.centroid);

            g.lineCap = 'round';
            // Mirrored: each bin is drawn at +a and -a about the vertical.
            for (let side = 0; side < 2; side++) {
                const dir = side ? -1 : 1;
                for (let i = 0; i < n; i++) {
                    const v = Math.min(1, m.bandsNorm[i] * env.k);
                    const a = -Math.PI / 2 + dir * (i / n) * Math.PI + spin;
                    const r1 = base + reach * (0.06 + v * v * 1.5);
                    const ca = Math.cos(a), sa = Math.sin(a);
                    g.strokeStyle = P.css(P.flow(i / n * 0.5, 0.4), 0.25 + v * 0.75);
                    g.lineWidth = Math.max(1.2, (Math.PI * base / n) * 0.8);
                    g.beginPath();
                    g.moveTo(cx + ca * base, cy + sa * base);
                    g.lineTo(cx + ca * r1, cy + sa * r1);
                    g.stroke();

                    // Onset caps - a bright dot that lingers past the bar.
                    const o = m.onsets[i];
                    if (o > 0.08) {
                        g.fillStyle = P.css(P.flow(0.6, 0.5), Math.min(1, o));
                        g.beginPath();
                        g.arc(cx + ca * r1, cy + sa * r1, 1.5 + o * 4, 0, 6.2832);
                        g.fill();
                    }
                }
            }

            // Inner ring, breathing with the beat.
            g.strokeStyle = P.css(P.flow(0.3, 0.3), 0.3 + m.beatPulse * 0.5);
            g.lineWidth = 1 + m.beatPulse * 4;
            g.beginPath();
            g.arc(cx, cy, base * (0.86 - m.beatPulse * 0.1), 0, 6.2832);
            g.stroke();
        }
    },

    /* ----------------------------------------------------------------------
       Vectorscope - the Lissajous/XY figure an oscilloscope draws (osci-render
       and every scope-art demo). Plotting the waveform against a delayed copy
       of itself turns timbre into a shape: a pure tone is an ellipse, a rich
       one knots up, percussion scribbles.
       ---------------------------------------------------------------------- */
    {
        id: 'vectorscope', name: 'Vectorscope', group: 'Waveform', fade: 0.14,
        draw: function (g, W, H, t, m, S, env) {
            const cx = W / 2, cy = H / 2;
            const R = Math.min(W, H) * 0.36 * env.depth;
            const wave = m.wave;
            const N = wave.length;
            // The lag sets how open the figure is; tying it to the centroid
            // means brighter material draws a wider knot.
            const lag = Math.max(4, Math.round(N * (0.02 + m.centroid * 0.06)));

            g.lineWidth = 1 + m.energy * 2 * env.k;
            g.strokeStyle = P.css(P.flow(0.1, 0.4), 0.5 + m.energy * 0.45);
            g.beginPath();
            for (let i = 0; i < N - lag; i += 2) {
                const x = cx + wave[i] * R * env.k;
                const y = cy + wave[i + lag] * R * env.k;
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();

            // A second trace at a wider lag gives the figure depth for far less
            // than the cost of drawing the first one twice.
            g.lineWidth = 0.8;
            g.strokeStyle = P.css(P.flow(0.45, 0.4), 0.18 + m.band.air.env * 0.4);
            g.beginPath();
            for (let i = 0; i < N - lag * 3; i += 4) {
                const x = cx + wave[i] * R * 0.72 * env.k;
                const y = cy + wave[i + lag * 3] * R * 0.72 * env.k;
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();

            if (m.beatPulse > 0.02) {
                g.strokeStyle = P.css(P.flow(0.7, 0.3), m.beatPulse * 0.4);
                g.lineWidth = 1 + m.beatPulse * 3;
                g.beginPath();
                g.arc(cx, cy, R * (1.05 + m.beatPulse * 0.12), 0, 6.2832);
                g.stroke();
            }
        }
    },

    /* ----------------------------------------------------------------------
       Chroma Wheel - the twelve pitch classes around the circle of fifths.
       The engine already computes a chroma vector and a dominant class; this
       is the mode that actually shows them, so what you watch tracks *harmony*
       rather than loudness. Fifths order rather than chromatic, so related
       keys sit adjacent and a progression sweeps instead of jumping.
       ---------------------------------------------------------------------- */
    {
        id: 'chroma-wheel', name: 'Chroma Wheel', group: 'Harmony', fade: 0.2,
        draw: function (g, W, H, t, m, S, env) {
            const NOTES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F'];
            const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];   // pitch class per slot
            const cx = W / 2, cy = H / 2;
            const R = Math.min(W, H) * 0.34 * env.depth;

            let total = 0;
            for (let i = 0; i < 12; i++) total += m.chroma[i];
            const scale = total > 0.001 ? 1 / Math.max(0.15, total / 4) : 0;

            for (let slot = 0; slot < 12; slot++) {
                const pc = FIFTHS[slot];
                const v = Math.min(1, m.chroma[pc] * scale * env.k);
                const a0 = (slot / 12) * 6.2832 - Math.PI / 2;
                const a1 = ((slot + 1) / 12) * 6.2832 - Math.PI / 2;
                const rr = R * (0.32 + v * 0.68);
                const lead = pc === m.chromaPeak;

                g.beginPath();
                g.moveTo(cx, cy);
                g.arc(cx, cy, rr, a0 + 0.012, a1 - 0.012);
                g.closePath();
                g.fillStyle = P.css(P.flow(slot / 12, 0.25), 0.12 + v * 0.6 + (lead ? 0.2 : 0));
                g.fill();
                if (lead) {
                    g.strokeStyle = P.css(P.flow(slot / 12 + 0.1, 0.25), 0.85);
                    g.lineWidth = 2;
                    g.stroke();
                }

                // Note names ride just outside the wheel.
                const am = (a0 + a1) / 2;
                g.fillStyle = P.css(P.flow(slot / 12, 0.25), lead ? 0.95 : 0.34);
                g.font = (lead ? '600 ' : '') + Math.round(Math.min(W, H) * 0.032) + 'px system-ui, sans-serif';
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText(NOTES[slot], cx + Math.cos(am) * R * 1.16, cy + Math.sin(am) * R * 1.16);
            }

            // Chords read as chords: join the classes currently sounding.
            g.beginPath();
            let drawn = 0;
            for (let slot = 0; slot < 12; slot++) {
                const v = m.chroma[FIFTHS[slot]] * scale;
                if (v < 0.45) continue;
                const am = ((slot + 0.5) / 12) * 6.2832 - Math.PI / 2;
                const rr = R * (0.32 + Math.min(1, v) * 0.68);
                const x = cx + Math.cos(am) * rr, y = cy + Math.sin(am) * rr;
                if (drawn++ === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            if (drawn > 1) {
                g.closePath();
                g.strokeStyle = P.css(P.flow(0.5, 0.3), 0.5);
                g.lineWidth = 1.5;
                g.stroke();
                g.fillStyle = P.css(P.flow(0.5, 0.3), 0.10);
                g.fill();
            }

            g.beginPath();
            g.arc(cx, cy, R * 0.3 * (1 + m.beatPulse * 0.16), 0, 6.2832);
            g.fillStyle = P.css(P.flow(0.8, 0.3), 0.18 + m.beatPulse * 0.5);
            g.fill();
        }
    },

    /* ----------------------------------------------------------------------
       Onset Bursts - the Patatap idea: every transient throws a shape, and the
       shape's family is fixed by which band fired it, so a kit becomes
       legible (kick low and central, hats small and scattered high).
       ---------------------------------------------------------------------- */
    {
        id: 'bursts', name: 'Onset Bursts', group: 'Rhythm', fade: 0.12,
        draw: function (g, W, H, t, m, S, env) {
            if (!S.shapes) S.shapes = [];
            const shapes = S.shapes;
            const CAP = 90;

            for (let L = 0; L < BANDS.length; L++) {
                if (env.layerOn[GROUP_OF[L]] === false) continue;
                const band = m.band[BANDS[L]];
                if (!band.hit || shapes.length >= CAP) continue;
                const n = L / (BANDS.length - 1);
                shapes.push({
                    // Low bands land centrally and large, high ones scatter.
                    x: 0.5 + (Math.random() - 0.5) * (0.15 + n * 0.85),
                    y: 0.72 - n * 0.5 + (Math.random() - 0.5) * 0.22,
                    r: (0.03 + (1 - n) * 0.11) * (0.6 + band.onset),
                    sides: 3 + L,               // triangle up to nonagon
                    spin: (Math.random() - 0.5) * 2,
                    tone: L / BANDS.length,
                    life: 1
                });
            }
            if (m.beat && shapes.length < CAP) {
                shapes.push({ x: 0.5, y: 0.5, r: 0.2, sides: 0, spin: 0,
                              tone: 0.6, life: 1, ring: true });
            }

            for (let i = shapes.length - 1; i >= 0; i--) {
                const s = shapes[i];
                s.life *= 0.965;
                if (s.life < 0.02) { shapes.splice(i, 1); continue; }

                const grow = 1 + (1 - s.life) * (s.ring ? 2.2 : 0.8);
                const rr = s.r * Math.min(W, H) * grow * env.depth;
                const alpha = s.life * (s.ring ? 0.5 : 0.8);

                g.save();
                g.translate(s.x * W, s.y * H);
                g.rotate(s.spin * (1 - s.life) * 3);
                g.beginPath();
                if (s.ring) {
                    g.arc(0, 0, rr, 0, 6.2832);
                    g.strokeStyle = P.css(P.flow(s.tone, 0.3), alpha);
                    g.lineWidth = 1 + s.life * 4;
                    g.stroke();
                } else {
                    for (let k = 0; k < s.sides; k++) {
                        const a = (k / s.sides) * 6.2832;
                        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
                        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
                    }
                    g.closePath();
                    g.fillStyle = P.css(P.flow(s.tone, 0.3), alpha * 0.35);
                    g.fill();
                    g.strokeStyle = P.css(P.flow(s.tone + 0.08, 0.3), alpha);
                    g.lineWidth = 1.5;
                    g.stroke();
                }
                g.restore();
            }

            // The pointer throws its own shape, so the mode is playable.
            const p = env.pointer;
            if (p.active && p.down && env.interact > 0 && shapes.length < CAP) {
                shapes.push({ x: p.x, y: p.sy, r: 0.07, sides: 6,
                              spin: 1, tone: 0.45, life: 1 });
            }
        }
    },

    /* ----------------------------------------------------------------------
       Waveform Ribbon - successive waveform traces stacked into depth, the
       scrolling-oscilloscope-in-perspective look. Recent history stays on
       screen, so a phrase reads as a landscape rather than a single line.
       ---------------------------------------------------------------------- */
    {
        id: 'ribbon', name: 'Waveform Ribbon', group: 'Waveform', fade: 1,
        draw: function (g, W, H, t, m, S, env) {
            const ROWS = 46;
            const STRIDE = 64;              // samples per drawn point
            if (!S.rows) S.rows = [];

            // One new trace per frame, oldest dropped - a fixed-length history.
            const pts = [];
            for (let i = 0; i < m.wave.length; i += STRIDE) pts.push(m.wave[i]);
            S.rows.unshift({ pts: pts, beat: m.beat });
            if (S.rows.length > ROWS) S.rows.length = ROWS;

            for (let r = S.rows.length - 1; r >= 0; r--) {
                const row = S.rows[r];
                const d = r / ROWS;                 // 0 = newest, 1 = furthest
                // Perspective: older rows sit higher, narrower and dimmer.
                const y = H * (0.9 - d * 0.62);
                const squeeze = 1 - d * 0.55;
                const amp = H * 0.15 * (1 - d * 0.5) * env.k * env.depth;
                const x0 = W * (1 - squeeze) / 2;

                g.beginPath();
                for (let i = 0; i < row.pts.length; i++) {
                    const x = x0 + (i / (row.pts.length - 1)) * W * squeeze;
                    const yy = y - row.pts[i] * amp;
                    if (i === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
                }
                g.strokeStyle = P.css(P.flow(d * 0.4, 0.3), (1 - d) * 0.75 + 0.05);
                g.lineWidth = (1 - d) * 2 + 0.4;
                g.stroke();

                if (row.beat) {
                    g.strokeStyle = P.css(P.flow(0.6, 0.3), (1 - d) * 0.3);
                    g.lineWidth = 0.8;
                    g.beginPath();
                    g.moveTo(x0, y);
                    g.lineTo(x0 + W * squeeze, y);
                    g.stroke();
                }
            }
        }
    }
    ];

    return { list: modes, fbm: fbm };
})();
