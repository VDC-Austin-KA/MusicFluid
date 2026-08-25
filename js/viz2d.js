/* ==========================================================================
   Viz2D — canvas-2D render engine and its mode library.

   These modes exist alongside the fluid sim so the app is not limited to one
   visual language. Each mode gets a scratch state object it owns outright,
   wiped whenever the mode changes.
   ========================================================================== */

window.Viz2D = (function () {
    'use strict';

    const P = window.Palette;

    let canvas = null, g = null;
    let W = 0, H = 0, dpr = 1;
    let art = null;              // current album cover, if any
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
        S.__resized = true;
    }

    function setMode(mode) {
        current = mode;
        S = {};
        if (g) { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    }

    function setArt(img) { art = img; }

    function frame(t, m, k) {
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

        current.draw(g, W, H, t, m, S, k === undefined ? 1 : k, art);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
    }

    /* --------------------------- shared helpers -------------------------- */

    // Collapse the 64 analysis bands down to `n` groups.
    function group(m, n, out) {
        const b = m.bands, len = b.length;
        const res = out || new Float32Array(n);
        const step = len / n;
        for (let i = 0; i < n; i++) {
            let s = 0, c = 0;
            for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) { s += b[j]; c++; }
            res[i] = c ? s / c : 0;
        }
        return res;
    }

    function lineGlow(ctx, colour, blur) {
        ctx.shadowColor = colour;
        ctx.shadowBlur = blur;
    }
    function noGlow(ctx) { ctx.shadowBlur = 0; }

    return {
        init: init, resize: resize, setMode: setMode, setArt: setArt, frame: frame,
        group: group, lineGlow: lineGlow, noGlow: noGlow,
        size: function () { return { w: W, h: H }; }
    };
})();


/* ========================================================================== */

window.Viz2DModes = (function () {
    'use strict';

    const P = window.Palette;
    const V = window.Viz2D;
    const group = V.group;
    const TAU = Math.PI * 2;

    function rgba(t, a) { return P.css(t, a); }

    const modes = [

    /* =========================== SPECTRUM ============================== */
    {
        id: 'bars', name: 'Spectrum Bars', group: 'Spectrum', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const N = 56;
            if (!S.peak) S.peak = new Float32Array(N);
            const b = group(m, N, S.buf || (S.buf = new Float32Array(N)));
            const gap = 2;
            const bw = (W - gap * (N - 1)) / N;
            const base = H * 0.94;

            for (let i = 0; i < N; i++) {
                const v = Math.min(1, b[i] * k);
                const h = v * H * 0.72;
                S.peak[i] = Math.max(S.peak[i] * 0.965, h);
                const x = i * (bw + gap);
                const tone = i / N * 0.75 + P.flow(0, 0.4);

                const grad = g.createLinearGradient(0, base, 0, base - h);
                grad.addColorStop(0, rgba(tone, 0.25));
                grad.addColorStop(1, rgba(tone + 0.08, 1));
                g.fillStyle = grad;
                g.fillRect(x, base - h, bw, h);

                // Mirrored reflection under the baseline.
                g.globalAlpha = 0.18;
                g.fillStyle = rgba(tone, 1);
                g.fillRect(x, base + 2, bw, h * 0.28);
                g.globalAlpha = 1;

                g.fillStyle = rgba(tone + 0.15, 0.95);
                g.fillRect(x, base - S.peak[i] - 3, bw, 2.5);
            }
        }
    },
    {
        id: 'mirror-bars', name: 'Mirror Bars', group: 'Spectrum', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const N = 64;
            const b = group(m, N, S.buf || (S.buf = new Float32Array(N)));
            const bw = W / N;
            const cy = H / 2;
            for (let i = 0; i < N; i++) {
                const v = Math.min(1, b[i] * k);
                const h = v * H * 0.44 + 1.5;
                const tone = i / N * 0.7 + P.flow(0, 0.5);
                const grad = g.createLinearGradient(0, cy - h, 0, cy + h);
                grad.addColorStop(0, rgba(tone + 0.1, 0.95));
                grad.addColorStop(0.5, rgba(tone, 0.35));
                grad.addColorStop(1, rgba(tone + 0.1, 0.95));
                g.fillStyle = grad;
                g.fillRect(i * bw + 0.5, cy - h, bw - 1, h * 2);
            }
            g.fillStyle = rgba(P.flow(0.5, 0.5), 0.5 + m.beatPulse * 0.5);
            g.fillRect(0, cy - 0.5, W, 1);
        }
    },
    {
        id: 'radial-bars', name: 'Radial Spectrum', group: 'Spectrum', fade: 0.22,
        draw: function (g, W, H, t, m, S, k) {
            const N = 96;
            const b = group(m, N, S.buf || (S.buf = new Float32Array(N)));
            const cx = W / 2, cy = H / 2;
            const r0 = Math.min(W, H) * (0.14 + m.bass * 0.05 * k);
            const maxLen = Math.min(W, H) * 0.33;
            const rot = t * 0.00008;
            g.lineCap = 'round';
            for (let i = 0; i < N; i++) {
                const a = TAU * (i / N) + rot;
                const v = Math.min(1, b[i] * k);
                const len = 4 + v * maxLen;
                const ca = Math.cos(a), sa = Math.sin(a);
                g.strokeStyle = rgba(i / N * 0.8 + P.flow(0, 0.4), 0.35 + v * 0.65);
                g.lineWidth = 2 + v * 3;
                g.beginPath();
                g.moveTo(cx + ca * r0, cy + sa * r0);
                g.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
                g.stroke();
            }
            g.strokeStyle = rgba(P.flow(0.3, 0.4), 0.6);
            g.lineWidth = 1.5 + m.beatPulse * 4;
            g.beginPath();
            g.arc(cx, cy, r0 - 6, 0, TAU);
            g.stroke();
        }
    },
    {
        id: 'ring-spectrum', name: 'Ring Bloom', group: 'Spectrum', fade: 0.14,
        draw: function (g, W, H, t, m, S, k) {
            const N = 128;
            const b = group(m, N, S.buf || (S.buf = new Float32Array(N)));
            const cx = W / 2, cy = H / 2;
            const base = Math.min(W, H) * 0.2;
            const rot = t * 0.00012;
            for (let layer = 0; layer < 3; layer++) {
                g.beginPath();
                for (let i = 0; i <= N; i++) {
                    const idx = i % N;
                    const a = TAU * (i / N) + rot * (layer + 1);
                    const r = base * (1 + layer * 0.36) +
                              Math.min(1, b[idx] * k) * Math.min(W, H) * (0.11 - layer * 0.02);
                    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
                    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.closePath();
                g.strokeStyle = rgba(P.flow(layer * 0.18, 0.5), 0.8 - layer * 0.2);
                g.lineWidth = 2.5 - layer * 0.6;
                V.lineGlow(g, rgba(P.flow(layer * 0.18, 0.5), 1), 14);
                g.stroke();
            }
            V.noGlow(g);
        }
    },
    {
        id: 'spectrogram', name: 'Spectrogram', group: 'Spectrum', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const N = m.bands.length;
            const COLS = 420;
            // Two small offscreen buffers, ping-ponged: scrolling a canvas onto
            // itself is unreliable, so each frame is copied one column left into
            // the spare buffer and the newest column is drawn on the right edge.
            if (!S.a) {
                S.a = document.createElement('canvas'); S.a.width = COLS; S.a.height = N;
                S.b = document.createElement('canvas'); S.b.width = COLS; S.b.height = N;
                S.ga = S.a.getContext('2d'); S.gb = S.b.getContext('2d');
                S.ga.fillStyle = '#000'; S.ga.fillRect(0, 0, COLS, N);
                S.gb.fillStyle = '#000'; S.gb.fillRect(0, 0, COLS, N);
            }
            S.gb.globalCompositeOperation = 'copy';
            S.gb.drawImage(S.a, -1, 0);
            S.gb.globalCompositeOperation = 'source-over';
            for (let i = 0; i < N; i++) {
                const v = Math.min(1, m.bands[i] * k);
                S.gb.fillStyle = P.css(v * 0.85 + P.flow(0, 0.15), Math.min(1, 0.08 + v * 1.7));
                S.gb.fillRect(COLS - 1, N - 1 - i, 1, 1);
            }
            // Swap so the freshly written buffer becomes the history.
            const ta = S.a, tga = S.ga;
            S.a = S.b; S.ga = S.gb;
            S.b = ta; S.gb = tga;

            g.imageSmoothingEnabled = true;
            g.drawImage(S.a, 0, 0, W, H);
        }
    },
    {
        id: 'terrain', name: 'Spectrum Terrain', group: 'Spectrum', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const N = 48, ROWS = 34;
            if (!S.hist) { S.hist = []; }
            S.hist.unshift(Float32Array.from(group(m, N, new Float32Array(N))));
            if (S.hist.length > ROWS) S.hist.pop();

            const horizon = H * 0.34;
            for (let r = S.hist.length - 1; r >= 0; r--) {
                const row = S.hist[r];
                const d = r / ROWS;                 // 0 = nearest
                const scale = 1 - d * 0.72;
                const y0 = horizon + (H - horizon) * Math.pow(1 - d, 1.7);
                const spanX = W * 1.25 * scale;
                const x0 = W / 2 - spanX / 2;
                g.beginPath();
                for (let i = 0; i < N; i++) {
                    const v = Math.min(1, row[i] * k);
                    const x = x0 + (i / (N - 1)) * spanX;
                    const y = y0 - v * H * 0.3 * scale;
                    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.lineTo(x0 + spanX, y0 + 4);
                g.lineTo(x0, y0 + 4);
                g.closePath();
                g.fillStyle = P.css(P.flow(d * 0.4, 0.3), 0.1 + (1 - d) * 0.35);
                g.fill();
                g.strokeStyle = P.css(P.flow(d * 0.4, 0.3), 0.25 + (1 - d) * 0.7);
                g.lineWidth = 1.2;
                g.stroke();
            }
        }
    },

    /* =========================== WAVEFORM ============================== */
    {
        id: 'scope', name: 'Oscilloscope', group: 'Waveform', fade: 0.2,
        draw: function (g, W, H, t, m, S, k) {
            const w = m.wave, N = w.length;
            const cy = H / 2, amp = H * 0.32 * k;
            for (let pass = 0; pass < 2; pass++) {
                g.beginPath();
                for (let i = 0; i < N; i++) {
                    const x = (i / (N - 1)) * W;
                    const y = cy + w[i] * amp;
                    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.strokeStyle = rgba(P.flow(pass * 0.12, 0.4), pass ? 0.95 : 0.3);
                g.lineWidth = pass ? 2 : 9;
                g.lineJoin = 'round';
                g.stroke();
            }
        }
    },
    {
        id: 'ribbon', name: 'Ribbon Wave', group: 'Waveform', fade: 0.1,
        draw: function (g, W, H, t, m, S, k) {
            const w = m.wave, N = w.length;
            const layers = 5;
            for (let L = 0; L < layers; L++) {
                const cy = H / 2 + Math.sin(t * 0.0004 + L) * H * 0.08;
                const amp = H * (0.06 + L * 0.045) * (0.5 + m.level * 1.4) * k;
                g.beginPath();
                g.moveTo(0, cy);
                for (let i = 0; i < N; i += 4) {
                    const x = (i / (N - 1)) * W;
                    const y = cy + w[i] * amp + Math.sin(i * 0.02 + t * 0.001 + L) * 6;
                    g.lineTo(x, y);
                }
                g.lineTo(W, cy);
                g.strokeStyle = rgba(P.flow(L * 0.14, 0.35), 0.55 - L * 0.07);
                g.lineWidth = 2 + L;
                g.stroke();
            }
        }
    },
    {
        id: 'lissajous-scope', name: 'XY Scope', group: 'Waveform', fade: 0.11,
        draw: function (g, W, H, t, m, S, k) {
            const w = m.wave, N = w.length;
            const cx = W / 2, cy = H / 2;
            const r = Math.min(W, H) * 0.36 * k;
            const off = 90;
            g.beginPath();
            for (let i = 0; i < N - off; i += 2) {
                const x = cx + w[i] * r;
                const y = cy + w[i + off] * r;
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.strokeStyle = rgba(P.flow(0, 0.3), 0.8);
            g.lineWidth = 1.4;
            V.lineGlow(g, rgba(P.flow(0, 0.3), 1), 12 + m.beatPulse * 20);
            g.stroke();
            V.noGlow(g);
        }
    },
    {
        id: 'wave-tunnel', name: 'Wave Tunnel', group: 'Waveform', fade: 0.13,
        draw: function (g, W, H, t, m, S, k) {
            if (!S.rings) S.rings = [];
            const w = m.wave;
            const N = 72;
            if (!S.acc) S.acc = 0;
            S.acc++;
            if (S.acc % 2 === 0) {
                const snap = new Float32Array(N);
                for (let i = 0; i < N; i++) snap[i] = w[Math.floor(i / N * w.length)];
                S.rings.unshift({ w: snap, r: 0, hue: P.flow(0, 0.4) });
                if (S.rings.length > 26) S.rings.pop();
            }
            const cx = W / 2, cy = H / 2;
            const maxR = Math.max(W, H) * 0.62;
            for (let j = S.rings.length - 1; j >= 0; j--) {
                const ring = S.rings[j];
                ring.r += 3.2 + m.level * 5 * k;
                if (ring.r > maxR) { S.rings.splice(j, 1); continue; }
                const fadeAmt = 1 - ring.r / maxR;
                g.beginPath();
                for (let i = 0; i <= N; i++) {
                    const idx = i % N;
                    const a = TAU * (i / N) + t * 0.0002;
                    const rr = ring.r * (1 + ring.w[idx] * 0.28 * k);
                    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
                    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.closePath();
                g.strokeStyle = P.css(ring.hue, fadeAmt * 0.75);
                g.lineWidth = 1 + fadeAmt * 2.4;
                g.stroke();
            }
        }
    },
    {
        id: 'dna', name: 'DNA Strand', group: 'Waveform', fade: 0.17,
        draw: function (g, W, H, t, m, S, k) {
            const N = 90;
            const cy = H / 2;
            const amp = H * 0.22 * (0.5 + m.level * 1.3) * k;
            const phase = t * 0.0016;
            const pts = [[], []];
            for (let i = 0; i < N; i++) {
                const p = i / (N - 1);
                const x = p * W;
                const s = Math.sin(p * 9 + phase);
                const c = Math.sin(p * 9 + phase + Math.PI);
                pts[0].push([x, cy + s * amp]);
                pts[1].push([x, cy + c * amp]);
            }
            for (let i = 0; i < N; i += 3) {
                const v = m.bands[Math.floor(i / N * m.bands.length)];
                g.strokeStyle = rgba(i / N * 0.6 + P.flow(0, 0.4), 0.25 + v * 0.75);
                g.lineWidth = 1 + v * 3;
                g.beginPath();
                g.moveTo(pts[0][i][0], pts[0][i][1]);
                g.lineTo(pts[1][i][0], pts[1][i][1]);
                g.stroke();
            }
            for (let s = 0; s < 2; s++) {
                g.beginPath();
                pts[s].forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
                g.strokeStyle = rgba(P.flow(s * 0.5, 0.4), 0.9);
                g.lineWidth = 2.4;
                g.stroke();
            }
        }
    },

    /* =========================== PARTICLES ============================= */
    {
        id: 'particles', name: 'Particle Storm', group: 'Particles', fade: 0.15,
        draw: function (g, W, H, t, m, S, k) {
            if (!S.p) {
                S.p = [];
                for (let i = 0; i < 380; i++) {
                    S.p.push({
                        x: Math.random() * W, y: Math.random() * H,
                        vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6,
                        r: 1 + Math.random() * 2.4, h: Math.random()
                    });
                }
            }
            const cx = W / 2, cy = H / 2;
            const push = m.beatPulse * 9 * k;
            for (let i = 0; i < S.p.length; i++) {
                const p = S.p[i];
                const dx = p.x - cx, dy = p.y - cy;
                const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
                p.vx += (dx / d) * push * 0.09 + (Math.random() - 0.5) * 0.12;
                p.vy += (dy / d) * push * 0.09 + (Math.random() - 0.5) * 0.12;
                // Weak inward pull keeps the field from emptying out.
                p.vx -= (dx / d) * 0.035;
                p.vy -= (dy / d) * 0.035;
                p.vx *= 0.975; p.vy *= 0.975;
                p.x += p.vx * (1 + m.level * 2.5); p.y += p.vy * (1 + m.level * 2.5);
                if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
                if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;
                g.fillStyle = rgba(p.h + P.flow(0, 0.3), 0.35 + m.level * 0.6);
                g.beginPath();
                g.arc(p.x, p.y, p.r * (1 + m.beatPulse * 0.9), 0, TAU);
                g.fill();
            }
        }
    },
    {
        id: 'starfield', name: 'Starfield Warp', group: 'Particles', fade: 0.28,
        draw: function (g, W, H, t, m, S, k) {
            if (!S.s) {
                S.s = [];
                for (let i = 0; i < 480; i++) {
                    S.s.push({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random(), h: Math.random() });
                }
            }
            const cx = W / 2, cy = H / 2;
            const speed = (0.0032 + m.level * 0.02 + m.beatPulse * 0.02) * k;
            const scale = Math.min(W, H) * 0.9;
            for (let i = 0; i < S.s.length; i++) {
                const s = S.s[i];
                const pz = s.z;
                s.z -= speed;
                if (s.z <= 0.02) {
                    s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2;
                    s.z = 1; s.h = Math.random();
                    continue;
                }
                const x = cx + (s.x / s.z) * scale * 0.5;
                const y = cy + (s.y / s.z) * scale * 0.5;
                const px = cx + (s.x / pz) * scale * 0.5;
                const py = cy + (s.y / pz) * scale * 0.5;
                if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
                const a = Math.min(1, (1 - s.z) * 1.3);
                g.strokeStyle = rgba(s.h * 0.4 + P.flow(0, 0.2), a);
                g.lineWidth = Math.max(0.6, (1 - s.z) * 3);
                g.beginPath();
                g.moveTo(px, py);
                g.lineTo(x, y);
                g.stroke();
            }
        }
    },
    {
        id: 'constellation', name: 'Constellation', group: 'Particles', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const N = 68;
            if (!S.n) {
                S.n = [];
                for (let i = 0; i < N; i++) {
                    S.n.push({
                        x: Math.random() * W, y: Math.random() * H,
                        vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
                        b: i % m.bands.length
                    });
                }
            }
            const spd = 0.5 + m.level * 3 * k;
            for (let i = 0; i < S.n.length; i++) {
                const p = S.n[i];
                p.x += p.vx * spd; p.y += p.vy * spd;
                if (p.x < 0 || p.x > W) p.vx *= -1;
                if (p.y < 0 || p.y > H) p.vy *= -1;
                p.x = Math.max(0, Math.min(W, p.x));
                p.y = Math.max(0, Math.min(H, p.y));
            }
            const link = 150 + m.bass * 90 * k;
            g.lineWidth = 1;
            for (let i = 0; i < S.n.length; i++) {
                for (let j = i + 1; j < S.n.length; j++) {
                    const a = S.n[i], b = S.n[j];
                    const dx = a.x - b.x, dy = a.y - b.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > link * link) continue;
                    const alpha = (1 - Math.sqrt(d2) / link) * 0.55;
                    g.strokeStyle = rgba(P.flow(0, 0.3), alpha);
                    g.beginPath();
                    g.moveTo(a.x, a.y);
                    g.lineTo(b.x, b.y);
                    g.stroke();
                }
            }
            for (let i = 0; i < S.n.length; i++) {
                const p = S.n[i];
                const v = m.bands[p.b % m.bands.length];
                g.fillStyle = rgba(i / S.n.length * 0.5 + P.flow(0, 0.3), 0.6 + v);
                g.beginPath();
                g.arc(p.x, p.y, 1.6 + v * 7 * k, 0, TAU);
                g.fill();
            }
        }
    },
    {
        id: 'fireworks', name: 'Beat Fireworks', group: 'Particles', fade: 0.13,
        draw: function (g, W, H, t, m, S, k) {
            if (!S.f) S.f = [];
            if (m.beat && S.f.length < 26) {
                const hue = Math.random();
                const ox = W * (0.2 + Math.random() * 0.6);
                const oy = H * (0.2 + Math.random() * 0.55);
                const n = 26 + Math.floor(m.bass * 34);
                for (let i = 0; i < n; i++) {
                    const a = TAU * (i / n) + Math.random() * 0.2;
                    const sp = (1.6 + Math.random() * 3.6) * (1 + m.bass * 1.6) * k;
                    S.f.push({ x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, h: hue });
                }
            }
            for (let i = S.f.length - 1; i >= 0; i--) {
                const p = S.f[i];
                p.x += p.vx; p.y += p.vy;
                p.vy += 0.045;
                p.vx *= 0.985; p.vy *= 0.985;
                p.life -= 0.011;
                if (p.life <= 0) { S.f.splice(i, 1); continue; }
                g.fillStyle = rgba(p.h, p.life);
                g.beginPath();
                g.arc(p.x, p.y, 1.4 + p.life * 2.2, 0, TAU);
                g.fill();
            }
        }
    },

    /* =========================== GEOMETRY ============================== */
    {
        id: 'orbit-rings', name: 'Orbit Rings', group: 'Geometry', fade: 0.16,
        draw: function (g, W, H, t, m, S, k) {
            const cx = W / 2, cy = H / 2;
            const rings = 9;
            const base = Math.min(W, H) * 0.06;
            for (let i = 0; i < rings; i++) {
                const v = m.bands[Math.floor(i / rings * m.bands.length)] * k;
                const r = base + i * Math.min(W, H) * 0.042 + v * 26;
                const span = 0.7 + v * 2.6;
                const rot = t * 0.0004 * (i % 2 ? 1 : -1) * (1 + i * 0.25) + i;
                g.strokeStyle = rgba(i / rings * 0.6 + P.flow(0, 0.35), 0.35 + v * 0.65);
                g.lineWidth = 2 + v * 6;
                g.lineCap = 'round';
                g.beginPath();
                g.arc(cx, cy, r, rot, rot + span);
                g.stroke();
                g.beginPath();
                g.arc(cx, cy, r, rot + Math.PI, rot + Math.PI + span);
                g.stroke();
            }
        }
    },
    {
        id: 'polygon', name: 'Polygon Pulse', group: 'Geometry', fade: 0.12,
        draw: function (g, W, H, t, m, S, k) {
            const cx = W / 2, cy = H / 2;
            const layers = 7;
            const sides = 3 + Math.floor(((t * 0.00006) % 6));
            for (let L = layers - 1; L >= 0; L--) {
                const v = m.bands[Math.floor(L / layers * m.bands.length)] * k;
                const r = Math.min(W, H) * (0.07 + L * 0.055) * (1 + v * 0.35 + m.beatPulse * 0.14);
                const rot = t * 0.00035 * (L % 2 ? 1 : -1) + L * 0.3;
                g.beginPath();
                for (let i = 0; i <= sides; i++) {
                    const a = TAU * (i / sides) + rot;
                    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
                    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.closePath();
                g.strokeStyle = rgba(L / layers * 0.5 + P.flow(0, 0.4), 0.4 + v * 0.6);
                g.lineWidth = 1.5 + v * 4;
                g.stroke();
            }
        }
    },
    {
        id: 'kaleidoscope', name: 'Kaleidoscope', group: 'Geometry', fade: 0.1,
        draw: function (g, W, H, t, m, S, k) {
            const cx = W / 2, cy = H / 2;
            const seg = 10;
            const R = Math.min(W, H) * 0.5;
            g.save();
            g.translate(cx, cy);
            for (let s = 0; s < seg; s++) {
                g.save();
                g.rotate(TAU * (s / seg));
                if (s % 2) g.scale(1, -1);
                const strokes = 7;
                for (let i = 0; i < strokes; i++) {
                    const v = m.bands[Math.floor(i / strokes * m.bands.length)] * k;
                    const a1 = t * 0.0004 + i * 0.6;
                    const r1 = R * (0.12 + i * 0.1);
                    const r2 = r1 + v * R * 0.3 + 8;
                    g.strokeStyle = rgba(i / strokes * 0.5 + P.flow(0, 0.5), 0.25 + v * 0.7);
                    g.lineWidth = 1.5 + v * 4;
                    g.beginPath();
                    g.moveTo(Math.cos(a1) * r1, Math.sin(a1) * r1 * 0.5);
                    g.quadraticCurveTo(
                        Math.cos(a1 + 0.5) * r2, Math.sin(a1 + 0.5) * r2 * 0.4,
                        Math.cos(a1 + 1.0) * r1, Math.sin(a1 + 1.0) * r1 * 0.5
                    );
                    g.stroke();
                }
                g.restore();
            }
            g.restore();
        }
    },
    {
        id: 'ripples', name: 'Ripple Rings', group: 'Geometry', fade: 0.16,
        draw: function (g, W, H, t, m, S, k) {
            if (!S.r) S.r = [];
            if (m.beat) S.r.push({ r: 0, a: 1, h: P.flow(0, 0.4), w: 2 + m.bass * 7 });
            if (S.r.length === 0 && Math.random() < 0.02) S.r.push({ r: 0, a: 0.6, h: P.flow(0, 0.4), w: 2 });
            const cx = W / 2, cy = H / 2;
            const maxR = Math.hypot(W, H) * 0.55;
            for (let i = S.r.length - 1; i >= 0; i--) {
                const ring = S.r[i];
                ring.r += (3.5 + m.level * 8) * k;
                ring.a = 1 - ring.r / maxR;
                if (ring.a <= 0) { S.r.splice(i, 1); continue; }
                g.strokeStyle = P.css(ring.h, ring.a * 0.85);
                g.lineWidth = ring.w * ring.a;
                g.beginPath();
                g.arc(cx, cy, ring.r, 0, TAU);
                g.stroke();
            }
        }
    },
    {
        id: 'tunnel', name: 'Neon Tunnel', group: 'Geometry', fade: 0.2,
        draw: function (g, W, H, t, m, S, k) {
            const cx = W / 2 + Math.sin(t * 0.0004) * W * 0.06;
            const cy = H / 2 + Math.cos(t * 0.0005) * H * 0.06;
            const steps = 22;
            const speed = (t * 0.0006) % 1;
            for (let i = steps; i >= 0; i--) {
                const z = ((i + speed) / steps);
                const r = Math.pow(z, 2.1) * Math.max(W, H) * 0.85 * (1 + m.beatPulse * 0.12);
                const rot = z * 2.4 + t * 0.0003;
                const v = m.bands[Math.floor(z * (m.bands.length - 1))] * k;
                g.beginPath();
                const sides = 6;
                for (let j = 0; j <= sides; j++) {
                    const a = TAU * (j / sides) + rot;
                    const rr = r * (1 + v * 0.16);
                    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
                    if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.closePath();
                g.strokeStyle = rgba(z * 0.6 + P.flow(0, 0.35), (1 - z) * 0.9);
                g.lineWidth = 1 + (1 - z) * 4;
                g.stroke();
            }
        }
    },
    {
        id: 'bloom-grid', name: 'Bloom Grid', group: 'Geometry', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const cols = 26;
            const rows = Math.max(8, Math.round(cols * H / W));
            const cw = W / cols, ch = H / rows;
            const b = group(m, cols, S.buf || (S.buf = new Float32Array(cols)));
            for (let x = 0; x < cols; x++) {
                const lit = Math.round(Math.min(1, b[x] * k) * rows);
                for (let y = 0; y < rows; y++) {
                    const on = (rows - y) <= lit;
                    const tone = x / cols * 0.6 + (1 - y / rows) * 0.25 + P.flow(0, 0.3);
                    g.fillStyle = on
                        ? rgba(tone, 0.55 + 0.45 * ((rows - y) / rows))
                        : 'rgba(255,255,255,0.035)';
                    g.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
                }
            }
        }
    },
    {
        id: 'hexpulse', name: 'Hex Pulse', group: 'Geometry', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const R = 26;
            const hw = R * Math.sqrt(3);
            const cx = W / 2, cy = H / 2;
            const maxD = Math.hypot(W, H) / 2;
            const wave = (t * 0.0011);
            for (let row = -1; row * R * 1.5 < H + R; row++) {
                for (let col = -1; col * hw < W + hw; col++) {
                    const x = col * hw + (row % 2 ? hw / 2 : 0);
                    const y = row * R * 1.5;
                    const d = Math.hypot(x - cx, y - cy) / maxD;
                    const idx = Math.floor(d * (m.bands.length - 1));
                    const v = Math.min(1, m.bands[idx] * k);
                    const pulse = 0.5 + 0.5 * Math.sin(wave - d * 7);
                    const a = v * pulse;
                    if (a < 0.03) continue;
                    g.beginPath();
                    for (let i = 0; i < 6; i++) {
                        const ang = TAU * (i / 6) + Math.PI / 6;
                        const px = x + Math.cos(ang) * R * 0.86 * (0.5 + a * 0.6);
                        const py = y + Math.sin(ang) * R * 0.86 * (0.5 + a * 0.6);
                        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
                    }
                    g.closePath();
                    g.fillStyle = rgba(d * 0.6 + P.flow(0, 0.3), a * 0.75);
                    g.fill();
                }
            }
        }
    },
    {
        id: 'fractal-tree', name: 'Fractal Tree', group: 'Geometry', fade: 0.2,
        draw: function (g, W, H, t, m, S, k) {
            const maxDepth = 9;
            const sway = Math.sin(t * 0.0008) * 0.12 + m.mid * 0.35 * k;
            function branch(x, y, len, ang, depth) {
                if (depth > maxDepth || len < 3) return;
                const v = m.bands[Math.floor(depth / maxDepth * (m.bands.length - 1))] * k;
                const x2 = x + Math.cos(ang) * len;
                const y2 = y + Math.sin(ang) * len;
                g.strokeStyle = rgba(depth / maxDepth * 0.55 + P.flow(0, 0.25), 0.35 + v * 0.65);
                g.lineWidth = Math.max(0.5, (maxDepth - depth) * 0.75);
                g.beginPath();
                g.moveTo(x, y);
                g.lineTo(x2, y2);
                g.stroke();
                const spread = 0.42 + v * 0.5 + sway * 0.3;
                const shrink = 0.72 + v * 0.06;
                branch(x2, y2, len * shrink, ang - spread + sway, depth + 1);
                branch(x2, y2, len * shrink, ang + spread + sway, depth + 1);
            }
            const len = H * 0.16 * (1 + m.bass * 0.35 * k);
            branch(W / 2, H * 0.98, len, -Math.PI / 2, 0);
        }
    },

    /* ============================ ATMOSPHERE =========================== */
    {
        id: 'aurora', name: 'Aurora Curtains', group: 'Atmosphere', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            const bands = 6;
            for (let L = 0; L < bands; L++) {
                const off = L * 1.7;
                const amp = H * (0.06 + L * 0.02) * (0.6 + m.level * 1.6 * k);
                const yBase = H * (0.26 + L * 0.09);
                g.beginPath();
                g.moveTo(0, H);
                for (let x = 0; x <= W; x += 12) {
                    const p = x / W;
                    const y = yBase
                        + Math.sin(p * 5 + t * 0.0006 + off) * amp
                        + Math.sin(p * 13 - t * 0.0009 + off) * amp * 0.4
                        + m.bands[Math.floor(p * (m.bands.length - 1))] * 40 * k;
                    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.lineTo(W, H);
                g.lineTo(0, H);
                g.closePath();
                const grad = g.createLinearGradient(0, yBase - amp, 0, H);
                grad.addColorStop(0, P.css(P.flow(L * 0.1, 0.25), 0.42));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = grad;
                g.fill();
            }
        }
    },
    {
        id: 'matrix', name: 'Matrix Rain', group: 'Atmosphere', fade: 0.11,
        draw: function (g, W, H, t, m, S, k) {
            const size = 15;
            const cols = Math.floor(W / size);
            if (!S.y || S.cols !== cols) {
                S.cols = cols;
                S.y = new Float32Array(cols);
                for (let i = 0; i < cols; i++) S.y[i] = Math.random() * H;
            }
            g.font = size + 'px ui-monospace, Menlo, monospace';
            g.textBaseline = 'top';
            for (let i = 0; i < cols; i++) {
                const v = m.bands[Math.floor(i / cols * (m.bands.length - 1))] * k;
                const ch = String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96));
                g.fillStyle = rgba(i / cols * 0.35 + P.flow(0, 0.2), 0.35 + v * 0.65);
                g.fillText(ch, i * size, S.y[i]);
                S.y[i] += size * (0.4 + v * 2.4 + m.level);
                if (S.y[i] > H && Math.random() > 0.975) S.y[i] = -size;
                else if (S.y[i] > H + size * 4) S.y[i] = -size;
            }
        }
    },
    {
        id: 'plasma', name: 'Plasma Field', group: 'Atmosphere', fade: 1,
        draw: function (g, W, H, t, m, S, k) {
            // Rendered at low res into an offscreen buffer, then upscaled.
            const RES = 64;
            if (!S.buf) {
                S.buf = document.createElement('canvas');
                S.buf.width = RES; S.buf.height = RES;
                S.bg = S.buf.getContext('2d');
                S.img = S.bg.createImageData(RES, RES);
            }
            const d = S.img.data;
            const tt = t * 0.0006;
            const boost = 1 + m.level * 1.8 * k;
            for (let y = 0; y < RES; y++) {
                for (let x = 0; x < RES; x++) {
                    const u = x / RES, v = y / RES;
                    let n = Math.sin(u * 9 + tt) + Math.sin(v * 8 - tt * 1.3)
                          + Math.sin((u + v) * 6 + tt * 0.7)
                          + Math.sin(Math.hypot(u - 0.5, v - 0.5) * 18 - tt * 2.2) * boost;
                    n = (n + 4) / 8;
                    const c = P.sample(n * 0.9 + P.flow(0, 0.3));
                    const i = (y * RES + x) * 4;
                    const gainAmt = 0.35 + m.level * 1.1;
                    d[i] = Math.min(255, c.r * 255 * gainAmt * 1.6);
                    d[i + 1] = Math.min(255, c.g * 255 * gainAmt * 1.6);
                    d[i + 2] = Math.min(255, c.b * 255 * gainAmt * 1.6);
                    d[i + 3] = 255;
                }
            }
            S.bg.putImageData(S.img, 0, 0);
            g.imageSmoothingEnabled = true;
            g.drawImage(S.buf, 0, 0, W, H);
        }
    },
    {
        id: 'vinyl', name: 'Vinyl Spin', group: 'Atmosphere', fade: 1,
        draw: function (g, W, H, t, m, S, k, art) {
            const cx = W / 2, cy = H / 2;
            const R = Math.min(W, H) * 0.28 * (1 + m.beatPulse * 0.05);
            if (!S.ang) S.ang = 0;
            S.ang += 0.004 + m.level * 0.012 * k;

            // Reactive halo behind the record.
            const rings = 40;
            for (let i = rings; i > 0; i--) {
                const v = m.bands[Math.floor(i / rings * (m.bands.length - 1))] * k;
                const rr = R * (1 + i * 0.028) + v * 60;
                g.strokeStyle = rgba(i / rings * 0.6 + P.flow(0, 0.3), 0.04 + v * 0.35);
                g.lineWidth = 1 + v * 4;
                g.beginPath();
                g.arc(cx, cy, rr, 0, TAU);
                g.stroke();
            }

            g.save();
            g.translate(cx, cy);
            g.rotate(S.ang);
            g.beginPath();
            g.arc(0, 0, R, 0, TAU);
            g.closePath();
            g.save();
            g.clip();
            if (art && art.complete && art.naturalWidth) {
                g.drawImage(art, -R, -R, R * 2, R * 2);
            } else {
                const grad = g.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
                grad.addColorStop(0, P.css(P.flow(0, 0.3), 1));
                grad.addColorStop(1, P.css(P.flow(0.4, 0.3), 1));
                g.fillStyle = grad;
                g.fillRect(-R, -R, R * 2, R * 2);
            }
            g.restore();
            // Groove lines.
            g.strokeStyle = 'rgba(0,0,0,0.22)';
            g.lineWidth = 1;
            for (let r = R * 0.3; r < R; r += 5) {
                g.beginPath();
                g.arc(0, 0, r, 0, TAU);
                g.stroke();
            }
            g.fillStyle = '#111';
            g.beginPath();
            g.arc(0, 0, R * 0.07, 0, TAU);
            g.fill();
            g.restore();
        }
    },
    {
        id: 'strobe-grid', name: 'Strobe Grid', group: 'Atmosphere', fade: 0.34,
        draw: function (g, W, H, t, m, S, k) {
            const cols = 9, rows = 6;
            const cw = W / cols, ch = H / rows;
            if (!S.cells) S.cells = new Float32Array(cols * rows);
            if (m.beat) {
                const hits = 3 + Math.floor(m.bass * 8);
                for (let i = 0; i < hits; i++) {
                    S.cells[Math.floor(Math.random() * S.cells.length)] = 1;
                }
            }
            for (let i = 0; i < S.cells.length; i++) {
                S.cells[i] *= 0.90;
                if (S.cells[i] < 0.02) continue;
                const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
                g.fillStyle = rgba(i / S.cells.length * 0.7 + P.flow(0, 0.5), S.cells[i] * 0.75);
                g.fillRect(x + 2, y + 2, cw - 4, ch - 4);
            }
        }
    }
    ];

    return { list: modes };
})();
