/* ==========================================================================
   FractalEngine — full-screen WebGL2 fragment shader.

   Escape-time and folding fractals are self-similar at every scale, so the
   image keeps resolving new detail no matter how far it is pushed: that is
   what makes them read as endless. Every parameter that shapes the geometry
   is owned by a *different* band, so the fractal is not merely tinted by the
   music — its structure is what the spectrum is drawing.

   Colour comes from a 256x1 LUT rebuilt from Palette, so all the shared
   palettes (including album art) work here unchanged.
   ========================================================================== */

window.FractalEngine = (function () {
    'use strict';

    const P = window.Palette;

    let gl = null, canvas = null, program = null, quad = null;
    let palTex = null, palData = null;
    let ready = false;
    const uniforms = {};

    const vertexSrc = `#version 300 es
        precision highp float;
        in vec2 aPosition;
        void main () { gl_Position = vec4(aPosition, 0.0, 1.0); }
    `;

    const fragmentSrc = `#version 300 es
        precision highp float;
        out vec4 fragColor;

        uniform vec2  uRes;
        uniform float uTime;
        uniform int   uKind;
        uniform vec2  uMouse;        // 0..1, y up
        uniform float uMouseDown;
        uniform float uInteract;     // 0..1 pointer influence
        uniform float uBand[7];      // subBass..air, adaptive-normalised
        uniform float uEnergy;
        uniform float uCentroid;
        uniform float uBeat;
        uniform float uDetail;       // iteration budget scale
        uniform float uZoom;
        uniform float uContrast;    // edge sharpness / banding density
        uniform sampler2D uPal;
        uniform float uPalShift;

        vec3 pal(float t) { return texture(uPal, vec2(fract(t + uPalShift), 0.5)).rgb; }

        mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

        vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }

        /* Every escape-time mode shares one rule: brightness is driven by how
           long a point resists escaping, so the open exterior falls to black
           and only the boundary — where the detail actually lives — is lit.
           Colouring without that weighting floods the whole plane and the
           image turns into pastel soup. */
        vec3 escapeShade(float n, float maxIt, vec2 z, float trap,
                         float hueShift, float trapHue, float trapGain) {
            float ni = clamp(n / maxIt, 0.0, 1.0);
            if (ni > 0.995) return vec3(0.0);      // interior stays black
            float sm = n - log2(max(log2(dot(z, z)), 1.0));
            // Cycling the palette quickly across the iteration count is what
            // produces contour bands. Cycling it slowly — as an earlier
            // version did — leaves neighbouring regions almost the same
            // colour, which is what turned the whole plane into a smooth wash.
            vec3 col = pal(sm * 0.055 * uContrast + hueShift);
            // Brightness ramps toward the boundary but keeps a floor, so the
            // open plane still reads as colour instead of going flat black
            // (which is what killed Phoenix, where nearly everything escapes
            // within a few iterations).
            float lit = 0.20 + 0.80 * pow(ni, 0.7);
            col *= lit * 1.3;
            col += pal(trapHue) * exp(-trap * 26.0) * lit * trapGain * 0.7;
            return col;
        }

        /* ---- 0: Julia. The seed walks a circle whose angle is the spectral
                 centroid and whose radius is the low end, so timbre reshapes
                 the set rather than merely recolouring it. */
        vec3 julia(vec2 uv) {
            float ang = uTime * 0.05 + uCentroid * 3.0 + uBand[3] * 1.2;
            float rad = 0.7 + uBand[1] * 0.10 + uBand[0] * 0.05;
            vec2 k = vec2(cos(ang), sin(ang)) * rad;
            k += (uMouse - 0.5) * 0.35 * uInteract;

            vec2 z = uv * (1.9 / uZoom);
            float trap = 1e9, n = 0.0;
            float maxIt = 60.0 + uDetail * 110.0;
            for (int it = 0; it < 220; it++) {
                if (float(it) >= maxIt) break;
                z = cmul(z, z) + k;
                trap = min(trap, abs(length(z) - 0.7 - uBand[5] * 0.5));
                if (dot(z, z) > 64.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap, uTime * 0.01,
                                   0.45, 0.6 + uBand[5] * 2.4);
            return col * (0.55 + uEnergy * 0.9 + uBeat * 0.4);
        }

        /* ---- 1: Mandelbrot, continuously zooming a self-similar valley. */
        vec3 mandelZoom(vec2 uv) {
            // The doublings loop, but the target is a Misiurewicz point where
            // the structure repeats, so the wrap is nearly invisible.
            float t = mod(uTime * (0.06 + uBand[1] * 0.05), 15.0);
            float zoom = pow(2.0, t) * uZoom;
            vec2 centre = vec2(-0.743643887037151, 0.131825904205330);
            centre += (uMouse - 0.5) * (0.6 / zoom) * uInteract;
            vec2 c = centre + uv * (1.6 / zoom);

            vec2 z = vec2(0.0);
            float n = 0.0, trap = 1e9;
            float maxIt = 90.0 + uDetail * 170.0;
            for (int it = 0; it < 320; it++) {
                if (float(it) >= maxIt) break;
                z = cmul(z, z) + c;
                trap = min(trap, abs(z.y) + abs(z.x) * 0.3);
                if (dot(z, z) > 256.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap,
                                   uTime * 0.02 + uCentroid * 0.3,
                                   0.5, 0.5 + uBand[6] * 2.2);
            return col * (0.6 + uEnergy * 0.9);
        }

        /* ---- 2: Kaleidoscopic IFS. Fold offset, twist and scale each belong
                 to a different band, so the geometry itself is spectral.
                 Rendered from the distance estimate so the surface stays a
                 crisp filament instead of a wash. */
        vec3 kifs(vec2 uv) {
            vec2 p = uv * (2.1 / uZoom);
            p += (uMouse - 0.5) * 0.5 * uInteract;
            float scale = 1.0;
            float twist = 0.35 + uBand[3] * 0.55 + uTime * 0.02;
            vec2 off = vec2(0.86 + uBand[2] * 0.20, 0.62 + uBand[4] * 0.18);
            float s = 1.30 + uBand[1] * 0.10;
            float trap = 1e9;
            int folds = int(5.0 + uDetail * 7.0);
            for (int i = 0; i < 13; i++) {
                if (i >= folds) break;
                p = abs(p) - off;
                p = rot(twist + float(i) * 0.13) * p;
                p *= s;
                scale *= s;
                trap = min(trap, length(p) / scale);
            }
            float d = length(p) / scale;
            // These falloff constants are scaled by uContrast because the
            // magnitude of a KIFS distance estimate depends entirely on the
            // fold parameters, and those are audio-driven — a fixed constant
            // is right at one setting and a flat wash at another.
            float shape = exp(-d * 55.0 * uContrast);   // crisp surface
            float aura  = exp(-d * 9.0 * uContrast) * 0.22;
            float fil   = exp(-trap * 38.0 * uContrast);
            vec3 col = pal(trap * 6.0 + uTime * 0.025) * (shape + aura);
            col += pal(0.55 + uBand[6] * 0.3) * fil * (0.7 + uBeat * 2.0);
            return col * (0.6 + uEnergy * 1.6);
        }

        /* ---- 3: Apollonian gasket via repeated inversion. */
        vec3 apollonian(vec2 uv) {
            vec2 p = uv * (1.25 / uZoom);
            p += (uMouse - 0.5) * 0.4 * uInteract;
            p = rot(uTime * 0.02) * p;
            float s = 1.05 + uBand[2] * 0.20;
            float k = 1.0, trap = 1e9;
            int steps = int(5.0 + uDetail * 5.0);
            for (int i = 0; i < 12; i++) {
                if (i >= steps) break;
                p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
                float r2 = dot(p, p);
                float f = s / max(r2, 0.015);
                p *= f;
                k *= f;
                trap = min(trap, abs(r2 - 0.32 - uBand[4] * 0.28));
            }
            float d = length(p) / k;
            float shape = exp(-d * 220.0 * uContrast);
            float aura  = exp(-d * 34.0 * uContrast) * 0.30;
            vec3 col = pal(log(k) * 0.10 + uTime * 0.015) * (shape + aura) * 1.8;
            col += pal(0.72) * exp(-trap * 14.0 * uContrast) * (0.35 + uBand[6] * 1.4);
            return col * (0.6 + uEnergy * 2.0);
        }

        /* ---- 4: Burning Ship, whose spires respond to the upper mids. */
        vec3 burningShip(vec2 uv) {
            float t = mod(uTime * (0.04 + uBand[2] * 0.04), 12.0);
            float zoom = pow(2.0, t) * uZoom;
            vec2 centre = vec2(-1.7549, -0.0100);
            centre += (uMouse - 0.5) * (0.5 / zoom) * uInteract;
            vec2 c = centre + uv * (1.4 / zoom);
            vec2 z = vec2(0.0);
            float n = 0.0, trap = 1e9;
            float maxIt = 70.0 + uDetail * 130.0;
            for (int it = 0; it < 260; it++) {
                if (float(it) >= maxIt) break;
                z = vec2(abs(z.x), abs(z.y));
                z = cmul(z, z) + c;
                trap = min(trap, length(z));
                if (dot(z, z) > 256.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap,
                                   uCentroid * 0.4 + uTime * 0.015,
                                   0.18, 0.5 + uBand[4] * 2.0);
            return col * (0.6 + uEnergy);
        }

        /* ---- 5: Phoenix — a second-order escape map with a soft, feathery
                 boundary that breathes with the low mids. */
        vec3 phoenix(vec2 uv) {
            vec2 p = uv * (1.7 / uZoom);
            p += (uMouse - 0.5) * 0.4 * uInteract;
            float pr = -0.5 + uBand[2] * 0.35;
            vec2 k = vec2(0.5667 + uBand[1] * 0.08, 0.0);
            vec2 z = p, zPrev = vec2(0.0);
            float n = 0.0, trap = 1e9;
            float maxIt = 60.0 + uDetail * 110.0;
            for (int it = 0; it < 200; it++) {
                if (float(it) >= maxIt) break;
                vec2 zn = cmul(z, z) + k + pr * zPrev;
                zPrev = z;
                z = zn;
                trap = min(trap, abs(z.x) + abs(z.y) * 0.4);
                if (dot(z, z) > 64.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap, uTime * 0.012,
                                   0.45 + uBand[5] * 0.3, 0.6 + uBand[6] * 2.2);
            return col * (0.55 + uEnergy * 0.95 + uBeat * 0.35);
        }

        void main () {
            vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
            vec3 col;
            if      (uKind == 0) col = julia(uv);
            else if (uKind == 1) col = mandelZoom(uv);
            else if (uKind == 2) col = kifs(uv);
            else if (uKind == 3) col = apollonian(uv);
            else if (uKind == 4) col = burningShip(uv);
            else                 col = phoenix(uv);

            // Holding the pointer blooms a soft light around it, so there is a
            // direct, tactile response in every fractal mode.
            if (uInteract > 0.0 && uMouseDown > 0.0) {
                vec2 mp = (uMouse - 0.5) * vec2(uRes.x / uRes.y, 1.0);
                col += pal(0.6) * exp(-length(uv - mp) * 7.0) * uMouseDown * 0.8 * uInteract;
            }

            col = col / (col + vec3(1.0));            // tone map
            col = pow(max(col, 0.0), vec3(1.0 / 2.2));
            fragColor = vec4(col, 1.0);
        }
    `;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('FractalEngine: ' + gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }

    function init(cnv) {
        canvas = cnv;
        gl = canvas.getContext('webgl2', {
            alpha: false, depth: false, stencil: false, antialias: false
        });
        if (!gl) return false;

        const vs = compile(gl.VERTEX_SHADER, vertexSrc);
        const fs = compile(gl.FRAGMENT_SHADER, fragmentSrc);
        if (!vs || !fs) return false;

        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'aPosition');
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('FractalEngine link: ' + gl.getProgramInfoLog(program));
            return false;
        }

        ['uRes', 'uTime', 'uKind', 'uMouse', 'uMouseDown', 'uInteract',
         'uEnergy', 'uCentroid', 'uBeat', 'uDetail', 'uZoom', 'uContrast',
         'uPal', 'uPalShift']
            .forEach(n => { uniforms[n] = gl.getUniformLocation(program, n); });
        uniforms.uBand = [];
        for (let i = 0; i < 7; i++) {
            uniforms.uBand.push(gl.getUniformLocation(program, 'uBand[' + i + ']'));
        }

        quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        // 256x1 colour ramp, refreshed from Palette when it changes.
        palData = new Uint8Array(256 * 4);
        palTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, palTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palData);

        ready = true;
        resize();
        return true;
    }

    let palKey = '';
    function updatePalette() {
        // Rebuilding 256 entries every frame is wasted work when neither the
        // palette nor the album colours have changed.
        const key = P.get() + '|' + (P.hasAlbum() ? '1' : '0');
        if (key === palKey) return;
        palKey = key;
        for (let i = 0; i < 256; i++) {
            const c = P.sample(i / 256);
            palData[i * 4] = Math.min(255, c.r * 255);
            palData[i * 4 + 1] = Math.min(255, c.g * 255);
            palData[i * 4 + 2] = Math.min(255, c.b * 255);
            palData[i * 4 + 3] = 255;
        }
        gl.bindTexture(gl.TEXTURE_2D, palTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, palData);
    }

    function resize() {
        if (!gl || !canvas) return;
        const cap = window.MF_MOBILE ? 1.25 : 1.75;
        const dpr = Math.min(window.devicePixelRatio || 1, cap);
        const cw = canvas.clientWidth || window.innerWidth;
        const ch = canvas.clientHeight || window.innerHeight;
        const w = Math.max(1, Math.floor(cw * dpr));
        const h = Math.max(1, Math.floor(ch * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }

    function render(kind, timeMs, m, pointer, opts) {
        if (!ready) return;
        const o = opts || {};
        gl.useProgram(program);
        updatePalette();

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
        gl.uniform1f(uniforms.uTime, timeMs * 0.001);
        gl.uniform1i(uniforms.uKind, kind | 0);
        gl.uniform2f(uniforms.uMouse, pointer.x, pointer.y);
        gl.uniform1f(uniforms.uMouseDown, pointer.down ? 1 : 0);
        gl.uniform1f(uniforms.uInteract, o.interact === undefined ? 1 : o.interact);
        gl.uniform1f(uniforms.uEnergy, m.energy);
        gl.uniform1f(uniforms.uCentroid, m.centroid);
        gl.uniform1f(uniforms.uBeat, m.beatPulse);
        gl.uniform1f(uniforms.uDetail, o.detail === undefined ? 0.6 : o.detail);
        gl.uniform1f(uniforms.uZoom, o.zoom === undefined ? 1 : o.zoom);
        gl.uniform1f(uniforms.uContrast, o.contrast === undefined ? 1 : o.contrast);
        gl.uniform1f(uniforms.uPalShift, P.flow(0, 0.5) % 1);

        const keys = window.AudioEngine.BAND_KEYS;
        for (let i = 0; i < 7; i++) {
            // env, not norm: the slow release keeps the geometry from
            // strobing between frames while still hitting hard on transients.
            gl.uniform1f(uniforms.uBand[i], m.band[keys[i]].env);
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, palTex);
        gl.uniform1i(uniforms.uPal, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    return {
        init: init,
        resize: resize,
        render: render,
        isReady: function () { return ready; }
    };
})();


window.FractalModes = (function () {
    'use strict';
    return {
        list: [
            { id: 'julia-bloom',  name: 'Julia Bloom',        group: 'Fractal · Endless', kind: 0, detail: 0.65 },
            { id: 'mandel-dive',  name: 'Mandelbrot Descent', group: 'Fractal · Endless', kind: 1, detail: 0.70 },
            { id: 'kifs',         name: 'Kaleido IFS',        group: 'Fractal · Endless', kind: 2, detail: 0.60 },
            { id: 'apollonian',   name: 'Apollonian Gasket',  group: 'Fractal · Endless', kind: 3, detail: 0.55 },
            { id: 'burning-ship', name: 'Burning Ship',       group: 'Fractal · Endless', kind: 4, detail: 0.60 },
            { id: 'phoenix',      name: 'Phoenix Field',      group: 'Fractal · Endless', kind: 5, detail: 0.60 }
        ]
    };
})();
