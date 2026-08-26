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
    }
    ];

    return { list: modes, fbm: fbm };
})();
