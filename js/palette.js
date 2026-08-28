/* ==========================================================================
   Palette — shared colour source for both render engines.

   sample(t)  -> {r,g,b} in 0..1, t wraps around 1.
   hdr(t, k)  -> same colour scaled for the fluid sim's HDR dye buffer.
   ========================================================================== */

window.Palette = (function () {
    'use strict';

    const SETS = {
        rainbow: null, // special-cased: continuous HSL sweep
        neon:    ['#ff005c', '#b400ff', '#00e5ff', '#00ff9d', '#ff005c'],
        vapor:   ['#ff71ce', '#01cdfe', '#05ffa1', '#b967ff', '#ff71ce'],
        sunset:  ['#f72585', '#ff6d00', '#ffba08', '#ff2e63', '#f72585'],
        ice:     ['#03045e', '#0077b6', '#00b4d8', '#caf0f8', '#03045e'],
        magma:   ['#0b0014', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf', '#0b0014'],
        ember:   ['#1a0000', '#9d0208', '#dc2f02', '#f48c06', '#ffba08', '#1a0000'],
        forest:  ['#004b23', '#008000', '#38b000', '#9ef01a', '#ccff33', '#004b23'],
        mono:    ['#101014', '#4a4a55', '#9a9aa8', '#ffffff', '#101014'],
        gold:    ['#2b1700', '#7f4f00', '#d4a017', '#ffd966', '#fff4cc', '#2b1700'],
        oceanic: ['#012a4a', '#2a6f97', '#61a5c2', '#a9d6e5', '#012a4a'],
        candy:   ['#ff9ff3', '#feca57', '#48dbfb', '#1dd1a1', '#ff6b6b', '#ff9ff3'],
        aurora:  ['#011627', '#0b7a75', '#2ec4b6', '#a7f3d0', '#7b2ff7', '#011627'],
        prism:   ['#ff0040', '#ff8c00', '#ffee00', '#00ff66', '#00c3ff', '#7a00ff', '#ff0040'],
        dusk:    ['#0d1b2a', '#415a77', '#a06cd5', '#ff8fab', '#ffd6a5', '#0d1b2a'],
        toxic:   ['#020d00', '#1b998b', '#78ff00', '#d0ff14', '#f6ff8f', '#020d00'],
        royal:   ['#10002b', '#3c096c', '#7b2cbf', '#c77dff', '#e0aaff', '#10002b'],
        infrared:['#000000', '#4a0e4e', '#c9184a', '#ff4d00', '#ffd500', '#ffffff', '#000000'],
        album:   ['#00b4d8', '#90e0ef', '#0077b6', '#00b4d8'] // replaced at runtime
    };

    const state = {
        name: 'rainbow',
        speed: 1,
        stops: null,
        // Musical colouring: hue follows the dominant pitch class instead of
        // (or blended with) the wall clock, so harmony steers the palette.
        chromaDrive: 0,
        chromaOffset: 0
    };

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    }

    // Cache parsed stops so we are not re-parsing hex on every splat.
    const cache = {};
    function stopsFor(name) {
        if (name === 'album' && state.stops) return state.stops;
        if (!cache[name]) {
            const list = SETS[name] || SETS.neon;
            cache[name] = list.map(hexToRgb);
        }
        return cache[name];
    }

    function hueToRgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    }

    function hsl(h, s, l) {
        h = h - Math.floor(h);
        let r, g, b;
        if (s === 0) { r = g = b = l; }
        else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hueToRgb(p, q, h + 1 / 3);
            g = hueToRgb(p, q, h);
            b = hueToRgb(p, q, h - 1 / 3);
        }
        return { r: r, g: g, b: b };
    }

    function sample(t) {
        t = t - Math.floor(t);
        if (state.name === 'rainbow') return hsl(t, 0.85, 0.55);
        const stops = stopsFor(state.name);
        const scaled = t * (stops.length - 1);
        const i = Math.floor(scaled);
        const f = scaled - i;
        const a = stops[i];
        const b = stops[Math.min(stops.length - 1, i + 1)];
        return { r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f };
    }

    function css(t, alpha) {
        const c = sample(t);
        const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
        return alpha === undefined
            ? 'rgb(' + r + ',' + g + ',' + b + ')'
            : 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    // The fluid dye buffer is RGBA16F and tone-mapped on display, so colours
    // need to be pushed well above 1.0 to read as saturated.
    function hdr(t, k) {
        const c = sample(t);
        // 0.6 trim: six default layers all splat every frame, so the old
        // gain drove the dye buffer far past the tone-map knee and every
        // busy mode settled into flat white.
        const s = (k === undefined ? 4.5 : k) * 0.6;
        return { r: c.r * s, g: c.g * s, b: c.b * s };
    }

    // Auto-scrolling hue driven by wall clock plus a caller-supplied offset.
    // When chromaDrive is up, part of that motion comes from the music's
    // dominant pitch class instead, so the colour tracks the harmony.
    function flow(offset, timeScale) {
        const t = (Date.now() * 0.00003 * state.speed * (timeScale || 1)) + (offset || 0);
        if (state.chromaDrive <= 0) return t;
        return t * (1 - state.chromaDrive) +
               (state.chromaOffset + (offset || 0)) * state.chromaDrive;
    }

    // Called once per frame with the live metrics.
    function updateMusic(m) {
        if (!m) return;
        // Twelve pitch classes around the colour wheel, eased so key changes
        // glide rather than snap, and taking the short way round.
        let d = m.chromaPeak / 12 - state.chromaOffset;
        if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
        state.chromaOffset = (state.chromaOffset + d * 0.05 + 1) % 1;
    }

    /* Pull a small palette out of the current album cover. */
    function fromImage(img) {
        try {
            const c = document.createElement('canvas');
            const n = 40;
            c.width = n; c.height = n;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0, n, n);
            const data = g.getImageData(0, 0, n, n).data;

            // Coarse 4x4x4 colour-cube histogram, weighted toward saturation.
            const buckets = {};
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], gg = data[i + 1], b = data[i + 2];
                const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
                const sat = max === 0 ? 0 : (max - min) / max;
                const lum = (r + gg + b) / 765;
                if (lum < 0.06 || lum > 0.97) continue;
                const key = (r >> 6) + ',' + (gg >> 6) + ',' + (b >> 6);
                const w = 1 + sat * 3;
                const e = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, w: 0 });
                e.r += r * w; e.g += gg * w; e.b += b * w; e.w += w;
            }

            const list = Object.keys(buckets)
                .map(k => buckets[k])
                .sort((a, b) => b.w - a.w)
                .slice(0, 5)
                .map(e => ({ r: e.r / e.w / 255, g: e.g / e.w / 255, b: e.b / e.w / 255 }));

            if (list.length < 2) return false;
            // Close the loop so the gradient wraps seamlessly.
            list.push(list[0]);
            state.stops = list;
            return true;
        } catch (err) {
            return false; // tainted canvas or a cover that failed to load
        }
    }

    return {
        names: Object.keys(SETS),
        sample: sample,
        css: css,
        hdr: hdr,
        hsl: hsl,
        flow: flow,
        fromImage: fromImage,
        updateMusic: updateMusic,
        setChromaDrive: function (v) { state.chromaDrive = Math.max(0, Math.min(1, v)); },
        chromaDrive: function () { return state.chromaDrive; },
        set: function (name) { if (SETS[name] !== undefined) state.name = name; },
        get: function () { return state.name; },
        setSpeed: function (v) { state.speed = v; },
        hasAlbum: function () { return !!state.stops; }
    };
})();
