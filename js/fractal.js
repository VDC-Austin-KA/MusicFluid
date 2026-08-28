/* ==========================================================================
   FractalEngine — full-screen WebGL2 fragment-shader scene engine.

   It started as one shader with a uKind switch and grew into a registry: each
   visual is a `vec3 scene(vec2 uv)` body in SCENES, compiled into its own
   program the first time it is selected. One switch across twenty scenes
   would be a monster to compile and would burn registers on branches the GPU
   never takes, so they are kept apart and built lazily.

   Every scene inherits, for free, from COMMON and MAIN:
     - the shared palette LUT, so album-art colour works everywhere
     - the view transform (pan / zoom / feature lock)
     - three timescales of spectrum — see the smoothing block below
     - the pointer lens, the click ripple and the hold bloom, so every scene
       is interactive whether or not its author thought about it
     - a hue-preserving tone map

   The house style, learned the hard way on Julia Bloom: audio drives
   *structure*, not the camera; nothing lurches on the beat; and the slow lane
   of the spectrum moves the geometry while the fast lane is kept for accents
   that decay on their own.
   ========================================================================== */

window.FractalEngine = (function () {
    'use strict';

    const P = window.Palette;

    let gl = null, canvas = null, quad = null;
    let palTex = null, palData = null;
    let ready = false;

    const programs = {};          // scene id -> { prog, u } | null if it failed

    const vertexSrc = `#version 300 es
        precision highp float;
        in vec2 aPosition;
        void main () { gl_Position = vec4(aPosition, 0.0, 1.0); }
    `;

    /* ======================= shared shader preamble ======================= */

    const COMMON = `#version 300 es
        precision highp float;
        out vec4 fragColor;

        uniform vec2  uRes;
        uniform float uTime;
        uniform vec2  uMouse;        // 0..1, y up
        uniform float uMouseDown;
        uniform float uInteract;     // 0..1 pointer influence
        uniform vec4  uEvtA;         // left-button event:  xy origin, z age s, w kind
        uniform vec4  uEvtB;         // right-button event: same shape
        uniform float uHover;        // pointer-follow effect id
        uniform float uWall;         // wall-clock seconds; never scene-slowed
        uniform float uRole;         // 0..1 strength of the shared band roles
        uniform float uKey;          // 1 = draw the frequency key
        uniform float uBg;           // background id
        uniform float uBgAmt;        // background strength
        uniform float uBand[7];      // ultra-lagged, ~8s: moves geometry
        uniform float uFlux[7];      // medium lag, ~0.3s: the everyday drive
        uniform float uOnset[7];     // transients, decaying: accents only
        uniform float uEnergy;       // ultra-lagged
        uniform float uEnergyFast;   // medium lag
        uniform float uCentroid;
        uniform float uBeat;
        uniform float uDetail;       // iteration / step budget scale
        uniform float uZoom;
        uniform vec2  uPan;          // view centre, in screen-uv units
        uniform vec2  uSeed;         // Julia seed, integrated on the CPU
        uniform float uContrast;
        uniform sampler2D uPal;
        uniform float uPalShift;

        #define PI  3.141592653589793
        #define TAU 6.283185307179586

        vec2 gSuv;                   // screen-uv of this pixel, after warping

        vec3 pal(float t) { return texture(uPal, vec2(fract(t + uPalShift), 0.5)).rgb; }

        mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

        vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }

        // Dynamic indexing into a uniform array is legal in GLSL ES 3.00, which
        // is what lets a scene pick its band from a hash or a ring number.
        float bnd(int i) { return uBand[i]; }
        float flx(int i) { return uFlux[i]; }
        float ons(int i) { return uOnset[i]; }

        float hash11(float p) {
            p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
        }
        float hash21(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }
        vec2 hash22(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.xx + p3.yz) * p3.zy);
        }

        float vnoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
            float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
            return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        float fbm(vec2 p, int oct) {
            float s = 0.0, a = 0.5;
            for (int i = 0; i < 8; i++) {
                if (i >= oct) break;
                s += a * vnoise(p);
                p = rot(0.5) * p * 2.02;
                a *= 0.5;
            }
            return s;
        }

        float smin(float a, float b, float k) {
            float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
            return mix(b, a, h) - k * h * (1.0 - h);
        }

        // n-fold mirror symmetry about the origin: the mandala primitive that
        // almost every psychedelic visual is built out of.
        vec2 kale(vec2 p, float n) {
            float a = atan(p.y, p.x), r = length(p);
            float seg = TAU / n;
            a = abs(mod(a + seg * 0.5, seg) - seg * 0.5);
            return vec2(cos(a), sin(a)) * r;
        }

        /* ------------------------ frequency roles -------------------------

           A real analyser is legible because each part of the spectrum does a
           visibly *different kind* of thing, not the same thing at seven sizes.
           So the seven bands are given seven fixed jobs, and every scene uses
           the same seven. Learn once that the twisting is the low mids and it
           holds everywhere.

           The lane each role reads from is part of the design, not an
           afterthought: anything that changes *shape* comes off the slow lane
           so it eases instead of pumping, anything that is meant to be a
           transient comes off the onset lane so it snaps and decays.

             0 subBass  SWELL   overall scale — the frame breathes      (slow)
             1 bass     THRUST  radial push outward from centre         (mid)
             2 lowMid   TWIST   rotation, shear, winding                (mid)
             3 mid      COUNT   how many elements exist                 (slow)
             4 highMid  EDGE    boundary sharpness, contrast            (mid)
             5 presence RIM     rim light along contours                (mid + onset)
             6 air      GRAIN   fine sparkle                            (onset-led) */

        float swell()  { return uBand[0]; }
        float thrust() { return uFlux[1]; }
        float twist()  { return uFlux[2]; }
        float countB() { return uBand[3]; }
        float edgeB()  { return uFlux[4]; }
        float rimB()   { return uFlux[5] + uOnset[5] * 0.6; }
        float grainB() { return uFlux[6] * 0.5 + uOnset[6]; }

        // The hue a band owns, in every scene. This is what makes the key in
        // the corner mean something: the colour of a thing names its band.
        float bandHue(float i) { return i / 7.0 * 0.85; }

        /* A round, sparse glint. step() on a cell hash lights the whole square
           cell, which is why speckle so often reads as dirt on the screen
           rather than as light — the dot has to have its own falloff, and it
           has to sit well inside its cell or that falloff clips square. */
        float speck(vec2 p, float scale, float rate, float thresh) {
            vec2 q = p * scale;
            vec2 g = floor(q), f = fract(q) - 0.5;
            float t = floor(uWall * rate);
            if (hash21(g + t * 13.0) < thresh) return 0.0;
            vec2 o = (hash22(g + t) - 0.5) * 0.4;
            return smoothstep(0.32, 0.0, length(f - o));
        }

        // Air, as speckle over the top. Keyed to wall time so it still glitters
        // in the scenes whose own clock is crawling.
        vec3 sparkleGrain(vec2 s) {
            // Sparse and small on purpose: at one glint per few hundred cells
            // this reads as air, and at the density it started with it read as
            // a dirty screen. The dot must also be well inside its cell or the
            // falloff clips square against the cell edge.
            vec2 q = s * 150.0;
            vec2 g = floor(q), f = fract(q) - 0.5;
            float t = floor(uWall * 7.0);
            float h = hash21(g + t * 17.0);
            if (h < 0.9965) return vec3(0.0);
            vec2 o = (hash22(g + t) - 0.5) * 0.4;
            return mix(vec3(1.0), pal(bandHue(6.0)), 0.45)
                 * smoothstep(0.30, 0.0, length(f - o)) * 1.5;
        }

        /* The frequency key: seven bars, bottom left, in the same hues the
           scenes use. The filled bar is the fast lane, the white tick is the
           slow lane, so you can see the difference between what is driving a
           size and what is driving a shape. */
        vec3 freqKey(vec2 s) {
            // Anchored to the real left edge: screen-uv x only spans +/-aspect/2,
            // and on a squarer window a fixed -0.80 puts the first bars off it.
            vec2 o = s - vec2(-uRes.x / uRes.y * 0.5 + 0.045, -0.44);
            if (o.x < 0.0 || o.x > 0.28 || o.y < -0.01 || o.y > 0.30) return vec3(0.0);
            float w = 0.28 / 7.0;
            float idx = floor(o.x / w);
            int i = int(idx);
            float x = fract(o.x / w);
            float bar = smoothstep(0.10, 0.22, x) * smoothstep(0.90, 0.78, x);
            if (bar <= 0.0) return vec3(0.0);

            float fast = uFlux[i] * 0.26;
            float slow = uBand[i] * 0.26;
            vec3 hue = pal(bandHue(idx));

            vec3 c = hue * bar * step(o.y, fast) * 0.55;
            c += hue * bar * smoothstep(0.012, 0.0, abs(o.y - fast)) * (0.9 + uOnset[i] * 4.0);
            c += vec3(0.9) * bar * smoothstep(0.005, 0.0, abs(o.y - slow)) * 0.7;
            c += vec3(0.30) * bar * step(o.y, 0.005);          // baseline rule
            return c;
        }

        /* ---------------------- pointer interaction -----------------------

           One library, shared by every scene, because interaction that lives
           inside a scene only exists in the scenes whose author remembered it.
           Each effect returns the displacement it applies to *screen* space and
           accumulates its own light into lit, so a warp and a glow can be two
           halves of the same gesture. e is (x, y, age in seconds, kind), and
           kind 0 means the slot is empty.

           There are two slots so the left and right buttons can be mid-effect
           at the same time without one cancelling the other. */
        vec2 evtWarp(vec4 e, vec2 s, inout vec3 lit) {
            int k = int(e.w + 0.5);
            if (k == 0) return vec2(0.0);
            float age = e.z;
            vec2 d = s - e.xy;
            float r = length(d) + 1e-5;
            vec2 dir = d / r;
            vec2 disp = vec2(0.0);

            if (k == 1) {                 // Ripple - an expanding ring
                float front = age * 0.75;
                float w = exp(-abs(r - front) * 7.0) * exp(-age * 1.1);
                disp = dir * w * 0.075;
                lit += pal(0.35) * exp(-abs(r - front) * 9.0) * exp(-age * 1.4) * 0.5;

            } else if (k == 2) {          // Shockwave - fast, hard-edged, brief
                float front = age * 2.2;
                float w = exp(-abs(r - front) * 22.0) * exp(-age * 3.0);
                disp = dir * w * 0.16;
                lit += pal(0.08) * exp(-abs(r - front) * 26.0) * exp(-age * 3.2) * 1.4;

            } else if (k == 3) {          // Vortex - a swirl that spins down
                float amt = exp(-r * 2.2) * exp(-age * 0.8);
                disp = rot(amt * 2.4) * d - d;
                lit += pal(0.55) * amt * 0.35;

            } else if (k == 4) {          // Flare - light only, no warp at all
                lit += pal(0.62) * exp(-r * (4.0 + age * 6.0)) * exp(-age * 1.6) * 2.2;

            } else if (k == 5) {          // Implode - suck in, then rebound out
                float pull = exp(-r * 2.0) * sin(min(age, 3.14159) * 2.0) * exp(-age * 0.9);
                disp = -dir * pull * 0.22;
                lit += pal(0.2) * exp(-r * 6.0) * max(0.0, pull) * 1.2;

            } else if (k == 6) {          // Bulge - a magnifying bubble
                float amt = exp(-r * r * 9.0) * exp(-age * 0.7);
                disp = -dir * amt * 0.28 * r;    // scaling with r is what magnifies
                lit += pal(0.48) * amt * 0.25;

            } else if (k == 7) {          // Shatter - kaleidoscopic fracture
                float amt = exp(-age * 0.9) * smoothstep(1.1, 0.0, r);
                vec2 f = kale(d, (3.0 + floor(6.0 * amt)) * 2.0);
                disp = (f - d) * amt;
                lit += pal(0.3) * exp(-abs(r - age * 0.9) * 10.0) * amt * 0.8;

            } else if (k == 8) {          // Echo - three ripples, one behind the next
                for (int i = 0; i < 3; i++) {
                    float a2 = age - float(i) * 0.35;
                    if (a2 <= 0.0) continue;
                    float front = a2 * 0.7;
                    float w = exp(-abs(r - front) * 9.0) * exp(-a2 * 1.3) / (1.0 + float(i));
                    disp += dir * w * 0.06;
                    lit += pal(0.4 + float(i) * 0.1) * w * 0.5;
                }

            } else if (k == 9) {          // Ink Drop - a stain that spreads and thins
                float rad = 0.12 + age * 0.30;
                float edge = smoothstep(rad, rad - 0.10, r) * exp(-age * 0.6);
                disp = dir * edge * 0.03 * sin(age * 3.0);
                lit += pal(0.7 + 0.1 * sin(age)) * edge * 1.1;

            } else if (k == 10) {         // Gravity Well - long, heavy, eats light
                float amt = exp(-r * 1.6) * exp(-age * 0.35);
                disp = -dir * amt * 0.30;
                lit -= vec3(0.35) * amt;
                lit += pal(0.9) * exp(-abs(r - 0.05) * 14.0) * amt * 1.2;

            } else if (k == 11) {         // Bloom Ring - a slow halo, barely warps
                float front = 0.10 + age * 0.22;
                float w = exp(-abs(r - front) * 4.0) * exp(-age * 0.6);
                disp = dir * w * 0.02;
                lit += pal(0.5 + age * 0.05) * w * 1.3;

            } else if (k == 12) {         // Spiral Throw - arms flung outward
                float amt = exp(-r * 1.4) * exp(-age * 0.7);
                float a = atan(d.y, d.x);
                float arms = 0.5 + 0.5 * cos(a * 4.0 - r * 16.0 + age * 4.0);
                disp = rot(amt * 1.6) * d - d;
                lit += pal(0.25) * arms * amt * 0.9;

            } else if (k == 13) {         // Resonance - a struck bell, not one front.
                // Several oscillations in the radial direction decaying in
                // place, so it rings rather than travelling away.
                float env = exp(-age * 1.0) * exp(-r * 1.8);
                float ring = sin(r * 34.0 - age * 9.0);
                disp = dir * ring * env * 0.045;
                lit += pal(0.42) * abs(ring) * env * 0.8;

            } else if (k == 14) {         // Warp Bubble - a true conformal inversion
                // r -> R^2/r inside the bubble turns the disc inside out, then
                // relaxes back. Nothing else here inverts topology like it.
                float R = 0.30;
                float amt = exp(-age * 1.2);
                if (r < R) {
                    vec2 inv = dir * (R * R / max(r, 0.02));
                    disp = (inv - d) * amt * smoothstep(R, R * 0.35, r);
                }
                lit += pal(0.66) * smoothstep(0.02, 0.0, abs(r - R)) * amt * 1.1;

            } else if (k == 15) {         // Rift Tear - a seam that opens and closes
                float ang = hash11(floor(e.x * 977.0 + e.y * 331.0)) * 3.14159;
                vec2 ax = vec2(cos(ang), sin(ang));
                float along = dot(d, ax), across = dot(d, vec2(-ax.y, ax.x));
                float open = sin(min(age, 3.14159) * 1.0) * exp(-age * 0.8);
                float band = exp(-across * across * 90.0) * exp(-along * along * 3.0);
                disp = vec2(-ax.y, ax.x) * sign(across) * band * open * 0.16;
                lit += pal(0.12) * band * open * 1.6;

            } else if (k == 16) {         // Comet - a streak thrown off and fading
                float ang = hash11(floor(e.x * 613.0 + e.y * 811.0)) * 6.2831853;
                vec2 hd = vec2(cos(ang), sin(ang));
                vec2 head = e.xy + hd * age * 0.55;
                vec2 dh = s - head;
                float tail = max(0.0, -dot(dh, hd));
                float off = length(dh - hd * dot(dh, hd));
                float body = exp(-off * 26.0) * exp(-tail * 3.0) * exp(-age * 0.9);
                disp = normalize(dh + 1e-5) * body * 0.05;
                lit += mix(pal(0.55), vec3(1.0), 0.4) * body * 1.8;

            } else if (k == 17) {         // Chroma Split - the channels pull apart
                float front = age * 0.8;
                vec3 off3 = vec3(0.0, 0.035, 0.07);
                vec3 c;
                c.r = exp(-abs(r - front + off3.x) * 12.0);
                c.g = exp(-abs(r - front + off3.y) * 12.0);
                c.b = exp(-abs(r - front + off3.z) * 12.0);
                float env = exp(-age * 1.3);
                disp = dir * c.g * env * 0.03;
                lit += c * env * 1.5;

            } else if (k == 18) {         // Static Burst - noise, then stillness
                float env = exp(-age * 4.0) * smoothstep(0.9, 0.0, r);
                vec2 n = vec2(hash21(s * 140.0 + floor(uWall * 30.0)),
                              hash21(s * 140.0 + 51.0 + floor(uWall * 30.0))) - 0.5;
                disp = n * env * 0.10;
                lit += vec3(0.9, 0.95, 1.0) * abs(n.x) * env * 1.2;

            } else if (k == 19) {         // Aftershock - four hard fronts, fading
                for (int i = 0; i < 4; i++) {
                    float a2 = age - float(i) * 0.22;
                    if (a2 <= 0.0) continue;
                    float front = a2 * 1.6;
                    float w = exp(-abs(r - front) * 20.0) * exp(-a2 * 2.4)
                            / (1.0 + float(i) * 1.2);
                    disp += dir * w * 0.10;
                    lit += pal(0.05 + float(i) * 0.04) * w * 1.1;
                }

            } else {                      // 20: Bloom Seed - a flower that opens
                float petals = 5.0 + floor(countB() * 5.0);
                float grow = smoothstep(0.0, 1.4, age) * exp(-age * 0.5);
                float a = atan(d.y, d.x);
                float shape = (0.06 + grow * 0.34) * (0.55 + 0.45 * cos(a * petals + age));
                float lip = exp(-abs(r - shape) * 26.0);
                disp = dir * lip * grow * 0.05;
                lit += pal(bandHue(3.0) + 0.1) * lip * grow * 1.5;
                lit += pal(0.7) * exp(-r * 26.0) * exp(-age * 1.2) * 0.9;
            }
            return disp;
        }

        // What the pointer does merely by being somewhere, no button needed.
        vec2 hoverWarp(vec2 s, vec2 mp, float down) {
            int k = int(uHover + 0.5);
            if (k == 0) return vec2(0.0);
            vec2 d = s - mp;
            float r = length(d) + 1e-5;
            vec2 dir = d / r;
            float amt = (0.045 + down * 0.22) * exp(-r * 3.2);
            if (k == 1) return -dir * amt;                    // Lens
            if (k == 2) return  dir * amt * 1.4;              // Repel
            if (k == 3) return rot(amt * 6.0) * d - d;        // Swirl
            if (k == 4) return vec2(sin(d.y * 14.0), cos(d.x * 14.0)) * amt * 0.8;  // Wobble
            if (k == 5) return vec2(-dir.x, dir.y) * amt * 1.6;          // Pinch
            if (k == 6) {                                                // Bubble
                float R = 0.26;
                if (r > R) return vec2(0.0);
                return (dir * (R * R / max(r, 0.03)) - d) * (0.10 + down * 0.25)
                       * smoothstep(R, R * 0.3, r);
            }
            return (kale(d, 6.0) - d) * amt * 3.0;                       // Kaleido
        }

        /* ----------------------- backgrounds ------------------------------

           Scenes are additive on black, so a background is simply what is
           already there when the scene starts drawing. Each is deliberately
           quiet: it has to sit behind twenty different foregrounds without
           competing with any of them. */
        vec3 background(vec2 uv) {
            int k = int(uBg + 0.5);
            if (k == 0) return vec3(0.0);

            if (k == 1) {                                  // Starfield
                // Thresholding the cell hash alone lights the whole cell, which
                // renders as square blocks; the star has to be a point *inside*
                // the cell with its own falloff.
                vec2 q = uv * 46.0;
                vec2 g = floor(q), f = fract(q) - 0.5;
                float h = hash21(g);
                if (h < 0.982) return vec3(0.0);
                vec2 o = (hash22(g) - 0.5) * 0.7;
                float d = length(f - o);
                float tw = 0.5 + 0.5 * sin(uTime * 0.6 + h * 60.0);
                float lit = smoothstep(0.17, 0.0, d) * tw;
                return mix(vec3(0.85, 0.9, 1.0), pal(fract(h * 7.0)), 0.45)
                     * (lit * 1.6 + smoothstep(0.4, 0.0, d) * lit * 0.5);
            }
            if (k == 2) {                                  // Deep haze
                float f = fbm(uv * 1.1 + vec2(uTime * 0.008, 0.0), 5);
                float d = max(0.0, f - 0.42);
                return pal(0.1 + f * 0.35) * d * d * 2.2;
            }
            if (k == 3) {                                  // Plasma
                float v = sin(uv.x * 3.0 + uTime * 0.15)
                        + sin(uv.y * 3.4 - uTime * 0.11)
                        + sin(length(uv) * 4.0 - uTime * 0.2);
                return pal(v * 0.12 + 0.5) * (0.06 + 0.06 * v * v);
            }
            if (k == 4) {                                  // Horizon grid
                float horizon = 0.28;
                if (uv.y > horizon) return pal(0.62) * exp(-(uv.y - horizon) * 5.0) * 0.10;
                float z = 1.0 / max(horizon - uv.y, 0.006);
                float gx = abs(fract(uv.x * z * 0.30 + 0.5) - 0.5);
                float gz = abs(fract(z * 0.30 - uTime * 0.05 + 0.5) - 0.5);
                float line = smoothstep(0.06, 0.0, gx) + smoothstep(0.05, 0.0, gz);
                return pal(0.55 + flx(1) * 0.1) * line * exp(-z * 0.06) * 0.5;
            }
            if (k == 5) {                                  // Caustics
                vec2 p = uv * 2.4;
                float a = 0.0;
                for (int i = 0; i < 3; i++) {
                    float fi = float(i);
                    p = rot(0.7) * p * 1.3;
                    a += abs(sin(p.x + uTime * (0.1 + fi * 0.03))
                           * sin(p.y - uTime * (0.08 + fi * 0.02))) / (1.0 + fi);
                }
                float c = pow(max(0.0, 1.0 - a * 0.5), 4.0);
                return pal(0.45 + c * 0.2) * c * 0.7;
            }
            if (k == 6) {                                  // Drifting motes
                vec3 c = vec3(0.0);
                for (int i = 0; i < 3; i++) {
                    float fi = float(i);
                    float sc = 9.0 + fi * 7.0;
                    vec2 q = uv * sc + vec2(uTime * (0.05 + fi * 0.03), uTime * 0.02);
                    vec2 g = floor(q), f = fract(q) - 0.5;
                    vec2 o = hash22(g) - 0.5;
                    float d = length(f - o * 0.7);
                    c += pal(0.2 * fi + hash21(g)) * smoothstep(0.09, 0.0, d)
                       * (0.25 / (1.0 + fi));
                }
                return c;
            }
            if (k == 7) {                                  // Palette wash
                float r = length(uv);
                return pal(0.5 + r * 0.25 + uTime * 0.005)
                     * (0.10 * exp(-r * 0.9) + 0.02);
            }
            // 8: Scan bands, drifting slowly and keyed to the low end
            float band = 0.5 + 0.5 * sin(uv.y * 26.0 + uTime * 0.25);
            return pal(0.35 + flx(0) * 0.2) * pow(band, 6.0) * (0.05 + flx(0) * 0.25);
        }

        /* Psychedelic visuals live or die on their blacks. A field that never
           quite reaches zero tone-maps to a flat pastel wash — every pixel
           lands near mid grey and the structure stops reading. deepen() raises
           the contrast *before* the tone map: below 1.0 it pushes down hard,
           above it, it lifts, so voids go black and cores stay hot. */
        vec3 deepen(vec3 c, float k) {
            float l = max(c.r, max(c.g, c.b));
            if (l <= 1e-5) return c;
            return c * (pow(l, k) / l);
        }

        // Vignette in screen space, so it holds still while the scene pans.
        float vig(float k) { return smoothstep(1.25, 0.15, length(gSuv) * k); }

        float sdBox3(vec3 p, vec3 b) {
            vec3 q = abs(p) - b;
            return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
        }

        /* Every escape-time scene shares one rule: brightness is driven by how
           long a point resists escaping, so the open exterior falls away and
           only the boundary — where the detail actually lives — is lit. */
        vec3 escapeShade(float n, float maxIt, vec2 z, float trap,
                         float hueShift, float trapHue, float trapGain) {
            float ni = clamp(n / maxIt, 0.0, 1.0);
            if (ni > 0.995) return vec3(0.0);      // interior stays black
            float sm = n - log2(max(log2(dot(z, z)), 1.0));
            vec3 col = pal(sm * 0.055 * uContrast + hueShift);
            float lit = 0.20 + 0.80 * pow(ni, 0.7);
            col *= lit * 1.3;
            // Deliberately beat-free: a filament that thickens on every hit
            // reads as the whole image throbbing, which is the jarring part.
            col += pal(trapHue) * exp(-trap * 30.0) * lit * trapGain * 0.7;
            return col;
        }
    `;

    /* ============================ scene bodies ============================ */

    const SCENES = {};

    /* ---- Julia Bloom. The seed walks a circle in the parameter plane; the
            walk itself is integrated on the CPU (see juliaSeed) so it can
            brake at the connectivity transition, and arrives here solved. --- */
    SCENES.julia = `
        vec3 scene(vec2 uv) {
            vec2 k = uSeed;
            // 0.007, down from 0.35: at full strength the smallest pointer move
            // threw the seed across the parameter plane and the whole set
            // reorganised. This is a nudge you steer with, not a lever.
            k += (uMouse - 0.5) * 0.007 * uInteract;

            vec2 z = uv * 1.9;
            float trap = 1e9, n = 0.0;
            float maxIt = 60.0 + uDetail * 110.0;
            for (int it = 0; it < 220; it++) {
                if (float(it) >= maxIt) break;
                z = cmul(z, z) + k;
                trap = min(trap, abs(length(z) - 0.7 - uBand[5] * 0.5));
                if (dot(z, z) > 64.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap, uTime * 0.006,
                                   0.45, 0.6 + uBand[5] * 2.4);
            return col * (0.55 + uEnergy * 0.9);
        }
    `;

    /* ---- Mandelbrot, creeping into a self-similar valley. ---------------- */
    SCENES.mandel = `
        vec3 scene(vec2 uv) {
            float t = mod(uTime * 0.022, 15.0);
            float zoom = pow(2.0, t);
            vec2 centre = vec2(-0.743643887037151, 0.131825904205330);
            centre += (uMouse - 0.5) * (0.6 / zoom) * uInteract;
            vec2 c = centre + uv * (1.6 / zoom);

            vec2 z = vec2(0.0);
            float n = 0.0, trap = 1e9;
            float maxIt = min(315.0, 90.0 + uDetail * 170.0 + uBand[1] * 60.0
                              + max(0.0, log2(uZoom)) * 12.0);
            for (int it = 0; it < 320; it++) {
                if (float(it) >= maxIt) break;
                z = cmul(z, z) + c;
                trap = min(trap, abs(z.y) * (1.0 + uBand[4] * 1.2) + abs(z.x) * 0.3);
                if (dot(z, z) > 256.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap, uTime * 0.010 + uCentroid * 0.3,
                                   0.5, 0.5 + uBand[6] * 2.2);
            return col * (0.6 + uEnergy * 0.9);
        }
    `;

    /* ---- Kaleidoscopic IFS: fold offset, twist and scale each belong to a
            different band, so the geometry itself is spectral. -------------- */
    SCENES.kifs = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * 2.1;
            p += (uMouse - 0.5) * 0.5 * uInteract;
            float scale = 1.0;
            float twist = 0.35 + uBand[3] * 0.55 + uTime * 0.012;
            vec2 off = vec2(0.86 + uBand[2] * 0.26, 0.62 + uBand[4] * 0.24);
            float s = 1.30 + uBand[1] * 0.12;
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
            float shape = exp(-d * 55.0 * uContrast);
            float aura  = exp(-d * 9.0 * uContrast) * 0.22;
            float fil   = exp(-trap * 38.0 * uContrast);
            vec3 col = pal(trap * 6.0 + uTime * 0.014) * (shape + aura);
            col += pal(0.55 + uBand[6] * 0.3) * fil * 0.7;
            return col * (0.6 + uEnergy * 1.6);
        }
    `;

    /* ---- Apollonian gasket via repeated inversion. ------------------------ */
    SCENES.apollonian = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * 1.25;
            p += (uMouse - 0.5) * 0.4 * uInteract;
            p = rot(uTime * 0.011) * p;
            float s = 1.05 + uBand[2] * 0.26;
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
            vec3 col = pal(log(k) * 0.10 + uTime * 0.008) * (shape + aura) * 1.8;
            col += pal(0.72) * exp(-trap * 14.0 * uContrast) * (0.35 + uBand[6] * 1.4);
            return col * (0.6 + uEnergy * 2.0);
        }
    `;

    /* ---- Burning Ship, whose spires respond to the upper mids. ------------ */
    SCENES.burningShip = `
        vec3 scene(vec2 uv) {
            float t = mod(uTime * 0.016, 12.0);
            float zoom = pow(2.0, t);
            vec2 centre = vec2(-1.7549, -0.0100);
            centre += (uMouse - 0.5) * (0.5 / zoom) * uInteract;
            vec2 c = centre + uv * (1.4 / zoom);
            vec2 z = vec2(0.0);
            float n = 0.0, trap = 1e9;
            float maxIt = min(255.0, 70.0 + uDetail * 130.0 + uBand[2] * 50.0
                              + max(0.0, log2(uZoom)) * 12.0);
            for (int it = 0; it < 260; it++) {
                if (float(it) >= maxIt) break;
                z = vec2(abs(z.x), abs(z.y));
                z = cmul(z, z) + c;
                trap = min(trap, length(z));
                if (dot(z, z) > 256.0) break;
                n += 1.0;
            }
            vec3 col = escapeShade(n, maxIt, z, trap, uCentroid * 0.4 + uTime * 0.008,
                                   0.18, 0.5 + uBand[4] * 2.0);
            return col * (0.6 + uEnergy);
        }
    `;

    /* ---- Phoenix: a second-order escape map with a feathery boundary. ----- */
    SCENES.phoenix = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * 1.7;
            p += (uMouse - 0.5) * 0.4 * uInteract;
            float pr = -0.5 + uBand[2] * 0.45;
            vec2 k = vec2(0.5667 + uBand[1] * 0.12, 0.0);
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
            vec3 col = escapeShade(n, maxIt, z, trap, uTime * 0.006,
                                   0.45 + uBand[5] * 0.3, 0.6 + uBand[6] * 2.2);
            return col * (0.55 + uEnergy * 0.95);
        }
    `;

    /* ====================================================================== */
    /* The reactive set. Each one binds a *structural* parameter to a band —  */
    /* a ring radius, a petal count, a fold depth, a wave number — so the     */
    /* spectrum is drawing the picture rather than tinting it.                */
    /* ====================================================================== */

    /* ---- Third Eye: concentric ornamental rings under n-fold symmetry, one
            ring per band. The petal count follows the spectral centroid, so a
            brighter arrangement resolves into a finer mandala. -------------- */
    SCENES.mandala = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * 1.6;
            float petals = 6.0 + floor(uCentroid * 3.0 + countB() * 5.0) * 2.0;
            p = rot(twist() * 1.4) * p;
            p = kale(p, petals);
            float r = length(p), a = atan(p.y, p.x);

            vec3 col = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float rr = 0.15 + fi * 0.125 + flx(i) * 0.055;
                float w  = mix(0.020, 0.005, edgeB()) + 0.022 * flx(i) + ons(i) * 0.014;
                // Squared falloff: the linear version leaves every ring with
                // a long tail, and seven tails add up to a haze over the
                // whole frame.
                float ring = w / (abs(r - rr) + w);
                ring *= ring;
                float orn = 0.5 + 0.5 * cos(a * (3.0 + fi * 2.0) + uTime * (0.06 + fi * 0.012));
                orn = pow(orn, 1.5 + flx(i) * 5.0);
                col += pal(bandHue(fi) + uTime * 0.012) * ring
                     * (0.05 + orn * 1.45) * (0.30 + flx(i) * 1.7);
                // Presence lights every ring's inner lip, so the whole mandala
                // gains an outline together rather than one ring reacting.
                col += pal(bandHue(5.0)) * exp(-abs(r - rr) * 150.0) * rimB() * 0.5;
            }
            float eye = 0.045 / (abs(r - 0.045 - uEnergyFast * 0.02) + 0.045);
            col += pal(0.62) * eye * eye * (0.35 + uEnergyFast * 1.1);
            return deepen(col, 1.7) * vig(0.85);
        }
    `;

    /* ---- Portal Descent: a log-polar tunnel. Depth is 1/r, so the walls
            recede forever toward the centre; four ring families travel at
            different rates and each takes its ornament from a band. --------- */
    SCENES.portal = `
        vec3 scene(vec2 uv) {
            float r = length(uv), a = atan(uv.y, uv.x);
            float petals = 5.0 + floor(uCentroid * 9.0);
            float d = 1.0 / (r + 0.05);
            float z = d * 0.30 - uTime * 0.30;

            vec3 col = vec3(0.0);
            for (int i = 0; i < 4; i++) {
                float fi = float(i);
                float ring = fract(z * (1.0 + fi * 0.45) + fi * 0.27);
                float band = smoothstep(1.0, 0.0, abs(ring - 0.5) * 2.0);
                float orn = 0.5 + 0.5 * cos(a * (petals + fi * 3.0) + z * 1.6 + uTime * 0.1);
                orn = pow(orn, 1.0 + flx(i + 2) * 5.0);
                col += pal(0.17 * fi + z * 0.04) * band * orn * (0.25 + flx(i) * 1.5);
            }
            // Depth cue: the far end gathers light instead of collapsing into
            // an aliased singularity.
            col *= smoothstep(0.0, 0.22, r);
            col += pal(0.55) * exp(-r * 9.0) * (0.3 + uEnergyFast * 1.4);
            return deepen(col, 1.5) * (0.55 + uEnergyFast * 0.8);
        }
    `;

    /* ---- Nebula Drift: Inigo Quilez domain warping, where the offset fed
            into each warp stage is owned by a different band. The cloud is
            literally folded by the spectrum. ------------------------------- */
    SCENES.nebula = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * 1.15;
            float t = uTime * 0.025;
            vec2 q = vec2(fbm(p + vec2(0.0, t), 4),
                          fbm(p + vec2(5.2, 1.3 - t), 4));
            vec2 s = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + flx(1) * 2.2, 4),
                          fbm(p + 3.0 * q + vec2(8.3, 2.8) + flx(3) * 2.2, 4));
            float f = fbm(p + 3.5 * s + t * 0.4, 5);

            // f*f alone still lights the whole plane; the extra power plus a
            // floor subtraction is what opens actual voids between the clouds.
            float dens = max(0.0, f - 0.40);
            vec3 col = pal(f * 0.9 + length(q) * 0.30 + uTime * 0.01)
                     * (dens * dens * dens * 22.0 + 0.006);
            // Bright cores where the warp field collapses; the air band lights
            // them, so cymbals read as stars inside the cloud.
            col += pal(0.74) * pow(max(0.0, 1.0 - length(q)), 3.0)
                 * (0.2 + flx(6) * 1.6);
            col += pal(0.30) * pow(max(0.0, 1.0 - length(s)), 4.0) * flx(0) * 1.1;
            return deepen(col, 1.5) * vig(1.05) * (0.5 + uEnergyFast * 1.2);
        }
    `;

    /* ---- Aurora Veil: seven curtains, one per band, each with its own noise
            phase so they drift independently instead of pumping together. --- */
    SCENES.aurora = `
        vec3 scene(vec2 uv) {
            vec3 col = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float x = uv.x * 1.1 + fi * 0.63;
                float h = fbm(vec2(x * 1.3, uTime * 0.04 + fi * 3.1), 4);
                float base = -0.5 + h * 0.45 + flx(i) * 0.5;
                float dy = uv.y - base;
                // Sharp underside, long fade upward: the shape of a real curtain.
                float glow = exp(-max(dy, 0.0) * (2.6 + edgeB() * 5.0))
                           * exp(-max(-dy, 0.0) * (10.0 + edgeB() * 22.0));
                float shimmer = 0.55 + 0.45 * sin(x * (6.0 + countB() * 10.0)
                                                  + uTime * 0.35 + fi * 1.7);
                col += pal(bandHue(fi) + uTime * 0.008) * glow * shimmer
                     * (0.20 + flx(i) * 1.5 + ons(i) * 0.8);
                col += pal(bandHue(5.0)) * exp(-abs(dy) * 70.0) * rimB() * 0.5;
            }
            // Star field behind the veil.
            col += vec3(0.9) * speck(uv, 60.0, 2.0, 0.995)
                 * (0.5 + 0.5 * sin(uTime * 2.0));
            return col * (0.55 + uEnergyFast * 0.9);
        }
    `;

    /* ---- Liquid Spectrum: seven metaballs on slow orbits, radius = band.
            The smooth field means neighbouring bands physically merge when
            both are loud, which is a nicer read of harmony than seven bars. - */
    SCENES.metaballs = `
        vec3 scene(vec2 uv) {
            float f = 0.0, wsum = 0.0;
            vec3 acc = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float a = uTime * (0.06 + fi * 0.011) + fi * TAU / 7.0;
                float orb = 0.28 + 0.10 * sin(uTime * 0.05 + fi * 2.0);
                vec2 c = vec2(cos(a), sin(a)) * orb;
                float rr = 0.055 + flx(i) * 0.15 + ons(i) * 0.03;
                float dd = dot(uv - c, uv - c) + 1e-4;
                float w = rr * rr / dd;
                f += w;
                acc += pal(bandHue(fi) + uTime * 0.01) * w;
                wsum += w;
            }
            vec3 base = wsum > 0.0 ? acc / wsum : vec3(0.0);
            // High mids decide how molten or how solid the surface reads.
            float sharp = mix(0.55, 0.06, edgeB());
            float iso  = smoothstep(1.0 - sharp, 1.0 + sharp, f);
            float edge = exp(-abs(f - 1.0) * (4.0 + edgeB() * 14.0));
            return base * (iso * 1.15 + edge * (0.7 + rimB() * 1.6))
                 * (0.55 + uEnergyFast);
        }
    `;

    /* ---- Crystal Cells: a Voronoi lattice where each cell is assigned a band
            by its own hash, so the spectrum is scattered across the plane and
            different regions breathe at different times. -------------------- */
    SCENES.crystal = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * (2.6 + uCentroid * 2.4);
            vec2 g = floor(p), fp = fract(p);
            float d1 = 8.0, d2 = 8.0;
            float cellBand = 0.0;
            vec2 cellId = vec2(0.0);
            for (int j = -1; j <= 1; j++) {
                for (int i = -1; i <= 1; i++) {
                    vec2 o = vec2(float(i), float(j));
                    vec2 h = hash22(g + o);
                    int bi = int(floor(h.x * 6.99));
                    vec2 pt = o + 0.5 + 0.40 * sin(uTime * 0.08 + TAU * h + flx(bi) * 1.6);
                    float d = length(pt - fp);
                    if (d < d1) {
                        d2 = d1; d1 = d;
                        cellBand = float(bi); cellId = g + o;
                    } else if (d < d2) {
                        d2 = d;
                    }
                }
            }
            int cb = int(cellBand);
            float lvl = flx(cb);
            float edge = smoothstep(0.0, 0.06 + lvl * 0.10, d2 - d1);
            vec3 col = pal(cellBand / 7.0 + uTime * 0.01 + hash21(cellId) * 0.08)
                     * (0.12 + lvl * 1.5) * (1.0 - edge * 0.85);
            // Facet lines flare on that cell's own transient, not the beat.
            col += pal(0.5 + cellBand / 14.0) * (1.0 - edge) * ons(cb) * 1.6;
            return col * (0.6 + uEnergyFast * 0.8);
        }
    `;

    /* ---- Hex Resonance: rings of hexagons outward from the centre, ring
            number picking the band. A bass note lights the inner rings and the
            energy travels outward through the lattice as the spectrum fills. */
    SCENES.hex = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * (3.4 + uCentroid * 1.4 + countB() * 2.4);
            p = rot(uTime * 0.02 + twist() * 1.2) * p;
            vec2 hs = vec2(1.0, 1.7320508);
            vec2 a = mod(p, hs) - hs * 0.5;
            vec2 b = mod(p - hs * 0.5, hs) - hs * 0.5;
            vec2 gv = dot(a, a) < dot(b, b) ? a : b;
            vec2 id = p - gv;

            float ring = floor(length(id) * 0.9);
            int bi = int(mod(ring, 7.0));
            float lvl = flx(bi);

            vec2 q = abs(gv);
            float hd = max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
            float size = 0.30 + lvl * 0.20 + ons(bi) * 0.06;
            float soft = mix(0.09, 0.012, edgeB());
            float cell = smoothstep(size, size - soft, hd);
            float rim  = smoothstep(size + 0.04, size, hd) - cell;

            vec3 col = pal(bandHue(float(bi)) + uTime * 0.012) * cell * (0.1 + lvl * 1.6);
            col += pal(bandHue(5.0)) * rim * (0.25 + rimB() * 2.0 + ons(bi) * 1.5);
            col *= smoothstep(6.5, 0.5, length(id));      // vignette on the lattice
            return col * (0.6 + uEnergyFast * 0.9);
        }
    `;

    /* ---- Truchet Weave: three nested scales of arc tiling. Each scale takes
            its line weight from a different band, so the weave densifies from
            the bottom of the spectrum up. ---------------------------------- */
    SCENES.truchet = `
        float arcs(vec2 p, float w) {
            vec2 id = floor(p), gv = fract(p) - 0.5;
            if (hash21(id) < 0.5) gv.x = -gv.x;
            vec2 c = vec2(0.5) * sign(gv.x + gv.y + 0.001);
            float d = abs(length(gv - c) - 0.5);
            return smoothstep(w, w * 0.35, d);
        }
        vec3 scene(vec2 uv) {
            vec2 p = uv * 2.2;
            p = rot(uTime * 0.015 + twist() * 1.0) * p;
            vec3 col = vec3(0.0);
            // Mid decides how many scales of weave exist at all, so the mesh
            // genuinely subdivides rather than merely thickening.
            float scales = 2.0 + floor(countB() * 2.99);
            for (int i = 0; i < 4; i++) {
                if (float(i) >= scales) break;
                float fi = float(i);
                float sc = pow(2.0, fi);
                int bi = i + 1;
                float w = (0.012 + flx(bi) * 0.13 + ons(bi) * 0.05)
                        * mix(1.6, 0.7, edgeB());
                float m = arcs(p * sc + vec2(fi * 0.37, fi * 0.11), w);
                col += pal(bandHue(float(bi)) + uTime * 0.012) * m
                     * (0.20 + flx(bi) * 1.5) / (1.0 + fi * 0.5);
                col += pal(bandHue(5.0)) * m * rimB() * 0.25 / (1.0 + fi);
            }
            return col * (0.6 + uEnergyFast * 1.0);
        }
    `;

    /* ---- Standing Waves: seven emitters on a circle. Each radiates at its own
            wave number with its band's amplitude, and what you see is the
            interference — so two loud bands produce a moire neither makes
            alone. ---------------------------------------------------------- */
    SCENES.interference = `
        vec3 scene(vec2 uv) {
            float sum = 0.0, wsum = 0.0;
            vec3 tint = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float a = fi * TAU / 7.0 + uTime * 0.03;
                vec2 src = vec2(cos(a), sin(a)) * (0.42 + flx(i) * 0.10);
                float d = length(uv - src);
                float kk = 14.0 + fi * 9.0 + uCentroid * 6.0;
                float amp = 0.10 + flx(i) * 1.5;
                sum += sin(d * kk - uTime * (0.6 + fi * 0.12)) * amp / (1.0 + d * 2.5);
                float w = amp / (1.0 + d * 3.0);
                tint += pal(bandHue(fi) + uTime * 0.01) * w;
                wsum += w;
            }
            vec3 base = wsum > 0.0 ? tint / wsum : vec3(0.0);
            float ridge = abs(sum);
            float crest = exp(-ridge * (1.4 + edgeB() * 6.0));   // nodal lines glow
            float body  = smoothstep(0.15, 1.4, ridge);
            return base * (crest * (0.7 + rimB() * 1.4) + body * 0.8)
                 * (0.55 + uEnergyFast * 1.1);
        }
    `;

    /* ---- Spectrum Bloom: a Vogel phyllotaxis head, the way a sunflower packs
            seeds. Seed index maps to a band by radius, so the whole spectrum
            is laid out as one flower with the low end at the core.

            Testing every seed per pixel would be thousands of iterations; the
            index of the seed nearest a point is r^2 * density, so only a
            handful of candidates around it ever need checking. -------------- */
    SCENES.bloomHead = `
        vec3 scene(vec2 uv) {
            float dens = 90.0 + uCentroid * 60.0;
            float r = length(uv);
            float n0 = r * r * dens;
            float ga = 2.399963229728653;              // golden angle
            vec3 col = vec3(0.0);
            for (int j = -5; j <= 5; j++) {
                float n = floor(n0) + float(j);
                if (n < 1.0) continue;
                float rr = sqrt(n / dens);
                float aa = n * ga + uTime * 0.03;
                vec2 pt = vec2(cos(aa), sin(aa)) * rr;
                int bi = int(mod(floor(n / 12.0), 7.0));
                float lvl = flx(bi);
                float sz = (0.012 + lvl * 0.030 + ons(bi) * 0.012) * (0.55 + rr * 1.6);
                float d = length(uv - pt);
                float dotm = smoothstep(sz, sz * 0.25, d);
                col += pal(n / dens * 0.5 + uTime * 0.01) * dotm * (0.2 + lvl * 1.8);
            }
            col *= smoothstep(1.05, 0.2, r);
            return col * (0.6 + uEnergyFast * 0.9);
        }
    `;

    /* ---- Liquid Chrome: an fbm height field shaded by its own gradient
            against a moving light. Swell comes from the bass, the fine crinkle
            from the air band, so it reads as mercury under a beam. ---------- */
    SCENES.chrome = `
        float hgt(vec2 p) {
            return fbm(p, 5) * (0.6 + flx(1) * 1.4)
                 + fbm(p * 4.0 + 11.0, 3) * (0.06 + flx(6) * 0.55);
        }
        vec3 scene(vec2 uv) {
            vec2 p = uv * 1.4 + vec2(uTime * 0.03, uTime * 0.017);
            float e = 0.0035;
            float h = hgt(p);
            vec2 grad = vec2(hgt(p + vec2(e, 0.0)) - h, hgt(p + vec2(0.0, e)) - h) / e;
            vec3 nrm = normalize(vec3(-grad, 1.0));

            float la = uTime * 0.07;
            vec3 lig = normalize(vec3(cos(la), sin(la), 0.75));
            float dif = max(dot(nrm, lig), 0.0);
            float spe = pow(max(dot(reflect(-lig, nrm), vec3(0.0, 0.0, 1.0)), 0.0),
                            18.0 + flx(5) * 60.0);
            float fres = pow(1.0 - max(nrm.z, 0.0), 3.0);

            vec3 col = pal(h * 0.55 + uTime * 0.012) * (0.18 + dif * 0.9);
            col += pal(0.15 + h * 0.2) * fres * 0.8;
            col += vec3(1.0) * spe * (0.25 + flx(6) * 1.6);
            return deepen(col, 1.5) * (0.55 + uEnergyFast * 0.9);
        }
    `;

    /* ---- Spiral Arms: a logarithmic spiral galaxy. The arm count follows the
            centroid and the wind of the spiral is a band, so the whole galaxy
            tightens and unwinds with the mix. ------------------------------- */
    SCENES.spiral = `
        vec3 scene(vec2 uv) {
            float r = length(uv) + 1e-4;
            float a = atan(uv.y, uv.x);
            float arms = 2.0 + floor(uCentroid * 5.0);
            float wind = 2.6 + flx(2) * 2.2;
            float phase = a * arms - log(r) * wind + uTime * 0.10;

            vec3 col = vec3(0.0);
            for (int i = 0; i < 5; i++) {
                float fi = float(i);
                float s = 0.5 + 0.5 * cos(phase + fi * 0.55);
                s = pow(s, 3.0 + flx(i + 1) * 8.0);
                col += pal(0.16 * fi + log(r) * 0.10 + uTime * 0.01) * s
                     * (0.12 + flx(i + 1) * 1.5) * exp(-r * 1.6);
            }
            // Core and dust. The core swells on the sub-bass without snapping.
            col += pal(0.7) * exp(-r * (13.0 - flx(0) * 5.0)) * (0.5 + flx(0) * 2.0);
            col *= 0.35 + 0.65 * fbm(uv * 3.0 + uTime * 0.02, 3);
            return deepen(col, 1.4) * (0.6 + uEnergyFast * 1.0);
        }
    `;

    /* ---- Gyroid Chamber: raymarched triply-periodic minimal surface. Sheet
            thickness is the bass, cell frequency the low mid, so the room you
            are inside physically rebuilds itself as the track moves. -------- */
    SCENES.gyroid = `
        float mapG(vec3 p) {
            float sc = 2.6 + flx(2) * 1.8;
            float g = dot(sin(p * sc), cos(p.zxy * sc));
            return (abs(g) - (0.30 + flx(1) * 0.85)) / (sc * 1.6);
        }
        vec3 scene(vec2 uv) {
            vec3 ro = vec3(0.0, 0.0, uTime * 0.20);
            vec3 rd = normalize(vec3(uv, 1.25));
            rd.xy = rot(uTime * 0.03) * rd.xy;
            rd.yz = rot(sin(uTime * 0.05) * 0.15) * rd.yz;

            float t = 0.0;
            float steps = 40.0 + uDetail * 60.0;
            bool hit = false;
            for (int i = 0; i < 100; i++) {
                if (float(i) >= steps) break;
                float d = mapG(ro + rd * t);
                if (d < 0.0015) { hit = true; break; }
                t += d * 0.85;
                if (t > 9.0) break;
            }
            if (!hit) return pal(0.05) * 0.02;

            vec3 p = ro + rd * t;
            vec2 e = vec2(0.002, 0.0);
            vec3 n = normalize(vec3(mapG(p + e.xyy) - mapG(p - e.xyy),
                                    mapG(p + e.yxy) - mapG(p - e.yxy),
                                    mapG(p + e.yyx) - mapG(p - e.yyx)));
            float dif = max(dot(n, normalize(vec3(0.5, 0.8, -0.4))), 0.0);
            float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
            vec3 col = pal(p.z * 0.09 + uTime * 0.012) * (0.15 + dif * 0.95);
            col += pal(0.6 + flx(5) * 0.2) * fres * (0.4 + flx(5) * 1.6);
            col *= exp(-t * 0.22);                       // depth fog
            return col * (0.7 + uEnergyFast * 0.8);
        }
    `;

    /* ---- Menger Bloom: raymarched sponge. The cross punched out of each cell
            is sized by the mid band, so the solid opens into lace and closes
            again with the arrangement. ------------------------------------- */
    SCENES.menger = `
        float mapM(vec3 p) {
            p = mod(p + 1.0, 2.0) - 1.0;
            float d = sdBox3(p, vec3(0.72));
            float s = 1.0;
            int it = int(2.0 + uDetail * 3.0);
            for (int i = 0; i < 5; i++) {
                if (i >= it) break;
                vec3 a = mod(p * s, 2.0) - 1.0;
                s *= 3.0;
                vec3 r = abs(1.0 - 3.0 * abs(a));
                float w = 0.55 + flx(3) * 0.55;
                float da = max(r.x, r.y), db = max(r.y, r.z), dc = max(r.z, r.x);
                float c = (min(da, min(db, dc)) - w) / s;
                d = max(d, c);
            }
            return d;
        }
        vec3 scene(vec2 uv) {
            vec3 ro = vec3(0.0, 0.0, -2.4 + uTime * 0.10);
            vec3 rd = normalize(vec3(uv, 1.3));
            rd.xz = rot(uTime * 0.025) * rd.xz;
            rd.xy = rot(uTime * 0.017) * rd.xy;

            float t = 0.0;
            float steps = 36.0 + uDetail * 54.0;
            bool hit = false;
            for (int i = 0; i < 90; i++) {
                if (float(i) >= steps) break;
                float d = mapM(ro + rd * t);
                if (d < 0.002) { hit = true; break; }
                t += d * 0.9;
                if (t > 7.0) break;
            }
            if (!hit) return pal(0.1) * 0.02;

            vec3 p = ro + rd * t;
            vec2 e = vec2(0.0025, 0.0);
            vec3 n = normalize(vec3(mapM(p + e.xyy) - mapM(p - e.xyy),
                                    mapM(p + e.yxy) - mapM(p - e.yxy),
                                    mapM(p + e.yyx) - mapM(p - e.yyx)));
            float dif = max(dot(n, normalize(vec3(0.6, 0.7, -0.5))), 0.0);
            vec3 col = pal(t * 0.10 + uTime * 0.012) * (0.16 + dif * 1.0);
            col += pal(0.45) * pow(1.0 - max(dot(n, -rd), 0.0), 4.0)
                 * (0.3 + flx(6) * 1.4);
            col *= exp(-t * 0.30);
            return col * (0.7 + uEnergyFast * 0.9);
        }
    `;

    /* ---- Julia Solid: the quaternion Julia set, raymarched. Same seed as
            Julia Bloom — same braked walk, same transition — so this is that
            mode's three-dimensional sibling rather than a new idea. --------- */
    SCENES.quatJulia = `
        vec4 qmul(vec4 a, vec4 b) {
            return vec4(a.x * b.x - dot(a.yzw, b.yzw),
                        a.x * b.yzw + b.x * a.yzw + cross(a.yzw, b.yzw));
        }
        float mapQ(vec3 pos, vec4 c) {
            vec4 z = vec4(pos, 0.18);
            float md = 1.0;
            float r2 = dot(z, z);
            for (int i = 0; i < 8; i++) {
                md *= 4.0 * r2;
                z = qmul(z, z) + c;
                r2 = dot(z, z);
                if (r2 > 36.0) break;
            }
            return 0.25 * sqrt(r2 / md) * log(max(r2, 1.0001));
        }
        vec3 scene(vec2 uv) {
            vec4 c = vec4(uSeed.x, uSeed.y, 0.12, 0.06);
            vec3 ro = vec3(0.0, 0.0, -2.6);
            vec3 rd = normalize(vec3(uv, 1.5));
            float ay = uTime * 0.04;
            ro.xz = rot(ay) * ro.xz; rd.xz = rot(ay) * rd.xz;
            ro.yz = rot(0.25) * ro.yz; rd.yz = rot(0.25) * rd.yz;

            float t = 0.0;
            float steps = 40.0 + uDetail * 60.0;
            bool hit = false;
            for (int i = 0; i < 100; i++) {
                if (float(i) >= steps) break;
                float d = mapQ(ro + rd * t, c);
                if (d < 0.0022) { hit = true; break; }
                t += d;
                if (t > 7.0) break;
            }
            if (!hit) return pal(0.08) * 0.025;

            vec3 p = ro + rd * t;
            vec2 e = vec2(0.0025, 0.0);
            vec3 n = normalize(vec3(mapQ(p + e.xyy, c) - mapQ(p - e.xyy, c),
                                    mapQ(p + e.yxy, c) - mapQ(p - e.yxy, c),
                                    mapQ(p + e.yyx, c) - mapQ(p - e.yyx, c)));
            float dif = max(dot(n, normalize(vec3(0.4, 0.8, -0.5))), 0.0);
            float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.5);
            vec3 col = pal(0.15 + t * 0.10 + uTime * 0.008) * (0.14 + dif * 1.0);
            col += pal(0.6) * fres * (0.35 + flx(5) * 1.5);
            col *= exp(-t * 0.28);
            return col * (0.7 + uEnergy * 0.9);
        }
    `;

    /* ---- Ink Membrane: a folded sine lattice whose fold count is the low mid
            and whose skin thickness is the presence band — slow, wet, and
            always dissolving. ---------------------------------------------- */
    SCENES.membrane = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * 2.0;
            float folds = 3.0 + floor(flx(2) * 4.0);
            for (int i = 0; i < 6; i++) {
                if (float(i) >= folds) break;
                p = abs(p) - 0.42 - flx(i) * 0.16;
                p = rot(0.35 + uTime * 0.02 + float(i) * 0.21) * p;
                p *= 1.16;
            }
            float v = sin(p.x * 3.0 + uTime * 0.2) * sin(p.y * 3.0 - uTime * 0.15)
                    + 0.55 * sin(length(p) * 6.0 - uTime * 0.3);
            float w = 0.06 + flx(5) * 0.22;
            float skin = w / (abs(v) + w);
            float inner = smoothstep(0.0, 0.9, v);
            vec3 col = pal(v * 0.35 + uTime * 0.012) * skin * (0.25 + flx(3) * 1.6);
            col += pal(0.42) * inner * 0.28 * (0.2 + flx(0) * 1.4);
            col *= smoothstep(2.4, 0.1, length(uv));
            return deepen(col, 1.6) * (0.6 + uEnergyFast * 1.0);
        }
    `;

    /* ---- Ancient Rift: a kaleidoscopic slice through moving noise — hard
            ornamental symmetry over a soft field, the closest thing here to
            carved stone lit from behind. ------------------------------------ */
    SCENES.rift = `
        vec3 scene(vec2 uv) {
            float n = 4.0 + floor(uCentroid * 8.0);
            vec2 p = kale(uv * 1.5, n * 2.0);
            p = rot(uTime * 0.02) * p;
            float r = length(p);

            vec3 col = vec3(0.0);
            for (int i = 0; i < 3; i++) {
                float fi = float(i);
                int b1 = i * 2 + 1, b2 = i * 2 + 2;
                vec2 q = p * (1.0 + fi * 0.9) + vec2(uTime * (0.02 + fi * 0.01), 0.0);
                float f = fbm(q * 2.2, 4);
                float band = 0.5 + 0.5 * cos((f * 6.0 + r * (7.0 + flx(b1) * 9.0))
                                             - uTime * 0.2 + fi);
                band = pow(band, 2.0 + flx(b2) * 7.0);
                col += pal(0.2 * fi + f * 0.4 + uTime * 0.01) * band
                     * (0.18 + flx(b1) * 1.5) / (1.0 + fi * 0.6);
            }
            col += pal(0.66) * exp(-r * 5.0) * (0.25 + uEnergyFast * 1.2);
            return deepen(col, 1.6) * vig(0.8) * (0.6 + uEnergyFast * 0.9);
        }
    `;

    /* ---- Lattice Rain: a vertical cascade whose columns are bands. Each falls
            at its own rate and brightens on that band's onset, so you can see
            which part of the spectrum just fired. --------------------------- */
    SCENES.cascade = `
        vec3 scene(vec2 uv) {
            vec2 p = uv * vec2(3.2, 2.2);
            float colId = floor(p.x * 2.0);
            int bi = int(mod(abs(colId), 7.0));
            float lvl = flx(bi);

            float speed = 0.10 + float(bi) * 0.035 + lvl * 0.25;
            float y = p.y + uTime * speed + hash11(colId) * 10.0;
            float cell = floor(y * 3.0);
            float f = fract(y * 3.0);

            float seedv = hash21(vec2(colId, cell));
            float on = step(0.35 - lvl * 0.25, seedv);
            float glyph = smoothstep(0.0, 0.25, f) * smoothstep(1.0, 0.7, f);
            float lane = smoothstep(0.5, 0.34, abs(fract(p.x * 2.0) - 0.5));

            vec3 col = pal(float(bi) / 7.0 + uTime * 0.01) * glyph * lane * on
                     * (0.15 + lvl * 1.8 + ons(bi) * 1.4);
            col += pal(0.5) * glyph * lane * on * ons(bi) * 0.8;
            col *= smoothstep(1.35, 0.4, abs(uv.y));
            return col * (0.6 + uEnergyFast * 0.9);
        }
    `;


    /* ====================================================================== */
    /* The analyser set. These are not effects that happen to react — they are */
    /* built the other way round, from the seven roles outward, so each band   */
    /* is doing a visibly different job in the same picture.                   */
    /* ====================================================================== */

    /* ---- Seven Suns: the role table, made literal. One body per band, and
            each one responds in its own way rather than at its own size —
            body 0 breathes, 1 lunges, 2 spins, 3 divides, 4 hardens, 5 haloes,
            6 throws sparks. The tether ring is what keeps seven separate
            behaviours reading as one instrument. --------------------------- */
    SCENES.sevenfold = `
        vec3 scene(vec2 uv) {
            vec3 col = vec3(0.0);
            float spin = uTime * 0.05 + twist() * 1.6;
            float orb = 0.34;
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float a = spin + fi * TAU / 7.0;
                vec2 c = vec2(cos(a), sin(a)) * orb;
                vec2 q = uv - c;
                float d = length(q);
                float lvl = flx(i);
                vec3 hue = pal(bandHue(fi));

                if (i == 0) {                       // SWELL
                    float rr = 0.045 + swell() * 0.095;
                    col += hue * smoothstep(rr, rr * 0.15, d) * (0.25 + lvl * 1.6);
                } else if (i == 1) {                // THRUST
                    vec2 c2 = vec2(cos(a), sin(a)) * (orb + thrust() * 0.24);
                    float d2 = length(uv - c2);
                    col += hue * smoothstep(0.055, 0.0, d2) * (0.25 + lvl * 1.8);
                    col += hue * exp(-abs(length(uv) - length(c2)) * 45.0) * lvl * 0.5;
                } else if (i == 2) {                // TWIST
                    vec2 r2 = rot(uTime * 0.4 + twist() * 8.0) * q;
                    float bar = smoothstep(0.075, 0.0, abs(r2.x) * 3.0 + abs(r2.y) * 0.6);
                    col += hue * bar * (0.2 + lvl * 1.7);
                } else if (i == 3) {                // COUNT
                    float n = 2.0 + floor(countB() * 6.0);
                    for (int j = 0; j < 8; j++) {
                        if (float(j) >= n) break;
                        float aj = TAU * float(j) / n + uTime * 0.2;
                        float dj = length(q - vec2(cos(aj), sin(aj)) * 0.055);
                        col += hue * smoothstep(0.02, 0.0, dj) * (0.25 + lvl * 1.6);
                    }
                } else if (i == 4) {                // EDGE
                    float soft = mix(0.05, 0.004, edgeB());
                    col += hue * smoothstep(0.055 + soft, 0.055 - soft, d) * (0.15 + lvl * 1.5);
                } else if (i == 5) {                // RIM
                    col += hue * exp(-abs(d - 0.06) * (65.0 - rimB() * 34.0))
                         * (0.25 + rimB() * 2.2);
                } else {                            // GRAIN
                    for (int j = 0; j < 6; j++) {
                        float t = floor(uWall * 12.0);
                        vec2 sp = q - (vec2(hash21(vec2(float(j), t)),
                                            hash21(vec2(float(j) + 9.0, t))) - 0.5) * 0.17;
                        col += hue * smoothstep(0.013, 0.0, length(sp))
                             * (0.15 + grainB() * 2.4);
                    }
                }
            }
            col += pal(0.5) * exp(-abs(length(uv) - orb) * 42.0) * 0.07;
            return col;
        }
    `;

    /* ---- Strata: a cross-section, one layer per band, read bottom to top the
            way a spectrum is. Layers are stacked rather than scattered, so the
            shape of the whole mix is legible at a glance. ------------------- */
    SCENES.strata = `
        vec3 scene(vec2 uv) {
            vec3 col = vec3(0.0);
            float top = 0.44, h = 0.88 / 7.0;
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float lvl = flx(i);
                float th = h * (0.42 + lvl * 0.55) * (i == 0 ? 1.0 + swell() * 0.8 : 1.0);
                float shift = (i == 1) ? thrust() * 0.30 : 0.0;
                float shear = (i == 2) ? twist() * 1.3 : 0.0;
                float x = uv.x + shift + uv.y * shear;
                float wob = fbm(vec2(x * 1.6, fi * 4.0 + uTime * 0.05), 4) * 0.055;
                float dy = uv.y - (top - fi * h - h * 0.5 + wob);
                float soft = mix(0.05, 0.004, (i == 4) ? edgeB() : 0.4);
                float band = smoothstep(th * 0.5 + soft, th * 0.5 - soft, abs(dy));
                vec3 hue = pal(bandHue(fi));

                float stri = 1.0;
                if (i == 3) {
                    float n = 3.0 + floor(countB() * 14.0);
                    stri = 0.45 + 0.55 * cos(x * n * 3.0);
                }
                col += hue * band * stri * (0.08 + lvl * 1.5);
                if (i == 5) {
                    col += hue * exp(-abs(abs(dy) - th * 0.5) * 95.0) * (0.25 + rimB() * 2.4);
                }
                if (i == 6) {
                    col += hue * band * speck(uv, 130.0, 10.0, 0.984) * grainB() * 3.4;
                }
            }
            return col;
        }
    `;

    /* ---- Chime Field: seven strings, each vibrating in a different mode
            shape, so two bands at the same level still look different. A band
            transient sends a pulse travelling down its own string. ---------- */
    SCENES.chimes = `
        vec3 scene(vec2 uv) {
            vec3 col = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float lvl = flx(i);
                float x0 = (fi - 3.0) * 0.20;
                float mode = 1.0 + floor(fi * 0.5) + ((i == 3) ? floor(countB() * 3.0) : 0.0);
                float amp = (0.012 + lvl * 0.10) * ((i == 0) ? 1.0 + swell() : 1.0);
                float ph = uTime * (1.2 + fi * 0.45) + ((i == 2) ? twist() * 6.0 : 0.0);
                float bend = sin(uv.y * PI * mode * 1.6 + ph) * amp
                           * smoothstep(0.55, 0.0, abs(uv.y));
                float push = (i == 1) ? thrust() * 0.07 * sign(x0 + 0.001) : 0.0;
                float x = uv.x - x0 - bend - push;
                float soft = mix(0.010, 0.0016, (i == 4) ? edgeB() : 0.4);
                vec3 hue = pal(bandHue(fi));

                col += hue * smoothstep(soft, 0.0, abs(x)) * (0.2 + lvl * 2.0);
                if (i == 5) col += hue * exp(-abs(x) * 60.0) * (0.12 + rimB() * 1.8);
                if (i == 6) {
                    col += hue * exp(-abs(x) * 90.0)
                         * speck(uv + fi, 70.0, 14.0, 0.955) * grainB() * 3.2;
                }
                // The strike: a pulse running the length of the string.
                float run = fract(uWall * 0.55 + fi * 0.13);
                col += hue * exp(-abs(x) * 70.0)
                     * exp(-abs(uv.y - (0.5 - run)) * 24.0) * ons(i) * 2.6;
            }
            return col;
        }
    `;

    /* ---- Iris: a seven-bladed aperture, one blade per band, opening and
            closing independently over a field only visible through the gap. -- */
    SCENES.iris = `
        vec3 scene(vec2 uv) {
            float r = length(uv), a = atan(uv.y, uv.x);
            float seg = TAU / 7.0;
            float k = floor((a + PI) / seg);
            int i = int(mod(k, 7.0));
            float fi = float(i);
            float lvl = flx(i);
            float la = mod(a + PI, seg) / seg;             // across this blade

            float reach = 0.42 - (0.04 + lvl * 0.30)
                        - ((i == 0) ? swell() * 0.09 : 0.0)
                        + ((i == 1) ? thrust() * 0.11 : 0.0);
            float lip = reach + 0.055 * (1.0 - abs(la - 0.5) * 2.0);
            float soft = mix(0.05, 0.005, (i == 4) ? edgeB() : 0.4);
            float blade = smoothstep(lip - soft, lip + soft, r);
            vec3 hue = pal(bandHue(fi));

            // The blade is a physical leaf, not the whole outside: it has to
            // stop somewhere or the scene is seven flat pie slices.
            float housing = smoothstep(0.92, 0.34, r);
            blade *= housing;

            vec3 col = hue * blade * (0.05 + lvl * 0.75)
                     * (0.35 + 0.65 * exp(-(r - lip) * 3.0));
            float n = 2.0 + floor(countB() * 6.0);
            col += hue * blade * (0.5 + 0.5 * cos(la * TAU * n)) * 0.18;
            // The lip is the brightest thing in the scene, so the aperture
            // reads as an edge you could cut yourself on.
            col += hue * exp(-abs(r - lip) * 75.0) * housing * (0.3 + rimB() * 2.4);
            // and a dark seam between neighbouring blades
            col *= 0.35 + 0.65 * smoothstep(0.0, 0.09, min(la, 1.0 - la));

            // The pupil: a warped field, twisting on the low mids.
            vec2 p = rot(uTime * 0.06 + twist() * 2.2) * uv * 3.0;
            float f = fbm(p + fbm(p * 1.7, 3), 4);
            col += pal(0.5 + f * 0.4) * pow(max(0.0, f - 0.30), 2.0) * 3.2
                 * smoothstep(lip, lip * 0.45, r);

            col += vec3(1.0) * speck(uv, 150.0, 9.0, 0.988) * grainB() * blade * 2.4;
            return col;
        }
    `;

    /* ---- Spectral Weave: seven ribbons crossing at seven angles. Where two
            bands are loud together their ribbons interfere, so the picture
            shows relationships between frequencies, not just seven levels. -- */
    SCENES.weave = `
        vec3 scene(vec2 uv) {
            vec3 col = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float lvl = flx(i);
                float ang = fi * PI / 7.0 + twist() * 0.8 + uTime * 0.02;
                vec2 p = rot(ang) * uv;
                float freq = 2.0 + fi * 1.4 + ((i == 3) ? countB() * 5.0 : 0.0);
                float amp = 0.10 + lvl * 0.22 + ((i == 0) ? swell() * 0.12 : 0.0);
                float y = p.y - sin(p.x * freq + uTime * (0.2 + fi * 0.05)) * amp
                              - ((i == 1) ? thrust() * 0.12 : 0.0);
                float th = 0.012 + lvl * 0.045;
                float soft = mix(0.03, 0.004, (i == 4) ? edgeB() : 0.4);
                float rib = smoothstep(th + soft, th - soft, abs(y));
                vec3 hue = pal(bandHue(fi));

                col += hue * rib * (0.12 + lvl * 1.5);
                if (i == 5) col += hue * exp(-abs(abs(y) - th) * 85.0) * (0.15 + rimB() * 1.8);
                if (i == 6) {
                    col += hue * rib * speck(p, 90.0, 11.0, 0.972) * grainB() * 3.2;
                }
            }
            return col;
        }
    `;

    /* ============================== main ================================== */

    const MAIN = `
        void main () {
            // Screen space stays fixed so the pointer effects land under the
            // cursor; the scene's own plane is what pans and scales.
            vec2 suv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
            vec2 mp = (uMouse - 0.5) * vec2(uRes.x / uRes.y, 1.0);

            // All pointer work happens in screen space, before the view
            // transform: that is what makes it land under the cursor and hold
            // its apparent size at any zoom. Warps compose by addition, so the
            // two button slots can overlap instead of one cancelling the other.
            // --- the shared band roles, applied to every scene at once ---
            // Sub bass breathes the frame and bass pushes outward from the
            // centre. Both read from the slow lane, so this is breathing, not
            // pumping — and the push tapers to nothing at the centre so the
            // middle of the image stays a fixed anchor.
            if (uRole > 0.0) {
                suv *= 1.0 - swell() * 0.085 * uRole;
                float r0 = length(suv) + 1e-5;
                suv += (suv / r0) * thrust() * 0.05 * uRole
                     * smoothstep(0.0, 0.55, r0);
            }

            vec3 lit = vec3(0.0);
            suv += hoverWarp(suv, mp, uMouseDown) * uInteract;
            suv += evtWarp(uEvtA, suv, lit) * uInteract;
            suv += evtWarp(uEvtB, suv, lit) * uInteract;

            gSuv = suv;
            vec2 uv = suv / uZoom + uPan;

            vec3 col = scene(uv);
            if (uBgAmt > 0.001) col += background(uv) * uBgAmt;
            col += lit * uInteract;

            // Air rides on top as sparkle, so the top of the spectrum is
            // visible even in the scenes with no fine detail of their own.
            if (uRole > 0.0) col += sparkleGrain(gSuv) * grainB() * uRole;

            // Holding the pointer blooms a soft light under it, on top of
            // whatever effect the button itself fired.
            if (uInteract > 0.0 && uMouseDown > 0.0) {
                col += pal(0.6) * exp(-length(gSuv - mp) * 7.0)
                     * uMouseDown * 0.55 * uInteract;
            }

            // Reinhard per channel washes to white: the brightest channel
            // saturates first and the others catch up, so every hot region
            // loses its hue. Dividing by the peak keeps the ratio intact.
            float peak = max(col.r, max(col.g, col.b));
            col = col / (1.0 + peak);
            col = pow(max(col, 0.0), vec3(1.0 / 2.2));

            // The key sits outside the tone map: it is an instrument, and it
            // should read the same however bright the scene behind it is.
            if (uKey > 0.5) col += freqKey(gSuv);
            fragColor = vec4(col, 1.0);
        }
    `;

    /* ============================= plumbing =============================== */

    const UNIFORM_NAMES = [
        'uRes', 'uTime', 'uMouse', 'uMouseDown', 'uInteract',
        'uEvtA', 'uEvtB', 'uHover', 'uBg', 'uBgAmt', 'uWall', 'uRole', 'uKey',
        'uEnergy', 'uEnergyFast', 'uCentroid', 'uBeat', 'uDetail', 'uZoom',
        'uPan', 'uSeed', 'uContrast', 'uPal', 'uPalShift'
    ];

    let vertShader = null;

    function compile(type, src, tag) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('FractalEngine [' + tag + ']: ' + gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }

    // Programs are built the first time a scene is asked for. Compiling twenty
    // of these up front would stall the first frame for a noticeable beat, and
    // most sessions never visit most of them.
    function getProgram(id) {
        if (programs[id] !== undefined) return programs[id];
        const body = SCENES[id];
        if (!body) { programs[id] = null; return null; }

        const fs = compile(gl.FRAGMENT_SHADER, COMMON + body + MAIN, id);
        if (!fs) { programs[id] = null; return null; }

        const prog = gl.createProgram();
        gl.attachShader(prog, vertShader);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, 'aPosition');
        gl.linkProgram(prog);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('FractalEngine link [' + id + ']: ' + gl.getProgramInfoLog(prog));
            programs[id] = null;
            return null;
        }

        const u = {};
        UNIFORM_NAMES.forEach(n => { u[n] = gl.getUniformLocation(prog, n); });
        u.uBand = []; u.uFlux = []; u.uOnset = [];
        for (let i = 0; i < 7; i++) {
            u.uBand.push(gl.getUniformLocation(prog, 'uBand[' + i + ']'));
            u.uFlux.push(gl.getUniformLocation(prog, 'uFlux[' + i + ']'));
            u.uOnset.push(gl.getUniformLocation(prog, 'uOnset[' + i + ']'));
        }
        programs[id] = { prog: prog, u: u };
        return programs[id];
    }

    function init(cnv) {
        canvas = cnv;
        gl = canvas.getContext('webgl2', {
            alpha: false, depth: false, stencil: false, antialias: false
        });
        if (!gl) return false;

        vertShader = compile(gl.VERTEX_SHADER, vertexSrc, 'vertex');
        if (!vertShader) return false;

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

        ready = !!getProgram('julia');
        resize();
        return ready;
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

    /* -------------------------- the three lanes ---------------------------

       The band envelopes retarget every frame. Feeding that straight into
       geometry is what made Julia Bloom churn, so the spectrum is offered at
       three speeds and a scene picks per parameter:

         uBand  (0.002, ~8s)   structure — shapes that should ease, not twitch
         uFlux  (0.05,  ~0.3s) the everyday drive — sizes, densities, weights
         uOnset (raw)          accents that decay on their own

       Nothing is wired to the beat by default. A visual that jumps on every
       kick is unwatchable for the length of a track. */

    const BAND_SMOOTH = 0.002;
    const FLUX_SMOOTH = 0.05;

    const slowBand = new Float32Array(7);
    const fluxBand = new Float32Array(7);
    const onsetBand = new Float32Array(7);
    let slowEnergy = 0, fluxEnergy = 0, slowCentroid = 0.5, fluxCentroid = 0.5;

    let audioStamp = -1;
    function updateAudio(m, stamp) {
        if (!m || stamp === audioStamp) return;
        audioStamp = stamp;
        const keys = window.AudioEngine.BAND_KEYS;
        for (let i = 0; i < 7; i++) {
            const b = m.band[keys[i]];
            slowBand[i] += (b.env - slowBand[i]) * BAND_SMOOTH;
            fluxBand[i] += (b.env - fluxBand[i]) * FLUX_SMOOTH;
            onsetBand[i] = b.onset;
        }
        slowEnergy += (m.energy - slowEnergy) * BAND_SMOOTH;
        fluxEnergy += (m.energy - fluxEnergy) * FLUX_SMOOTH;
        slowCentroid += (m.centroid - slowCentroid) * BAND_SMOOTH;
        fluxCentroid += (m.centroid - fluxCentroid) * FLUX_SMOOTH;
    }

    /* ------------------------- the Julia seed ---------------------------

       The seed walks a circle in the parameter plane. The moment worth
       watching is where that circle crosses the boundary of the Mandelbrot
       set: inside it the Julia set is connected and its interior is a solid
       filled body, outside it the body breaks apart and the black ground
       opens up between the pieces. At a constant angular rate the seed
       crosses that boundary in a frame or two, which is why the opening
       looked like a snap rather than an event.

       So the walk is integrated here instead of in the shader, and the step
       is braked near the crossing: each frame we look a fixed window ahead
       and behind, and if connectivity differs across it we bisect for the
       exact crossing angle and scale the step by how close we are. At the
       crossing itself the walk runs at SEED_BRAKE of its normal rate.

       The brake is on the walk only. The (heavily lagged) centroid and band
       terms still move the seed on their own; they are slow enough not to
       blow through the transition, but they are what keeps it from stalling
       forever exactly on the boundary. */

    const SEED_RATE = 0.022;      // radians per second of the slowed clock
    const SEED_WINDOW = 0.03;     // half-width of the braking zone, radians
    const SEED_BRAKE = 0.001;     // 1000x slower at the crossing itself

    let seedAngle = 0, seedTime = null;
    const seed = { x: 0.7, y: 0.0 };

    // Is the Julia set for this seed connected? That is exactly Mandelbrot
    // membership for k — the critical orbit stays bounded iff the interior is
    // filled — so one escape-time test answers it.
    function connectedAt(ang, rad) {
        const kx = Math.cos(ang) * rad, ky = Math.sin(ang) * rad;
        let zx = 0, zy = 0;
        for (let i = 0; i < 300; i++) {
            const nx = zx * zx - zy * zy + kx;
            zy = 2 * zx * zy + ky;
            zx = nx;
            if (zx * zx + zy * zy > 4) return false;
        }
        return true;
    }

    function juliaSeed(timeMs, m, stamp) {
        updateAudio(m, stamp === undefined ? timeMs : stamp);
        if (timeMs === seedTime) return seed;      // once per frame, whoever asks

        const dt = seedTime === null ? 0 : Math.min(Math.max(timeMs - seedTime, 0), 1000);
        seedTime = timeMs;

        const rad = 0.70 + slowBand[1] * 0.16 + slowBand[0] * 0.07;
        const drift = slowCentroid * 3.0 + slowBand[3] * 1.2;
        const a = seedAngle + drift;

        let brake = 1;
        const lo0 = connectedAt(a - SEED_WINDOW, rad);
        if (lo0 !== connectedAt(a + SEED_WINDOW, rad)) {
            let lo = a - SEED_WINDOW, hi = a + SEED_WINDOW;
            for (let i = 0; i < 16; i++) {
                const mid = (lo + hi) * 0.5;
                if (connectedAt(mid, rad) === lo0) lo = mid; else hi = mid;
            }
            // Quadratic ease so the approach tightens gradually instead of
            // dropping off a cliff at the window edge.
            const d = Math.abs(a - (lo + hi) * 0.5) / SEED_WINDOW;
            brake = SEED_BRAKE + (1 - SEED_BRAKE) * d * d;
        }

        seedAngle += SEED_RATE * (dt / 1000) * brake;
        const ang = seedAngle + drift;
        seed.x = Math.cos(ang) * rad;
        seed.y = Math.sin(ang) * rad;
        return seed;
    }

    /* ---------------------------- feature lock ---------------------------

       Pinning a pixel is useless here: the set deforms as the seed moves, so
       screen coordinates stop meaning anything within seconds. What survives
       the deformation is the point's *itinerary* — the sequence of preimage
       branches taken walking back from the repelling fixed point beta. That
       sequence names the filament, not the location, so replaying it against
       the current seed lands on the same feature after the set has changed
       shape. Inverse iteration contracts hard, so ~24 steps pins it tightly
       and the starting point washes out. */

    let lockBranches = null, lockLast = null, lockRepairing = false;

    // One frame's worth of movement for the tracked point is minute; anything
    // past this is the branch bit flipping meaning, which happens when the
    // orbit passes close to z = 0 and the two preimages swap.
    const LOCK_JUMP = 0.05;

    function csqrt(x, y) {                    // principal square root
        const r = Math.sqrt(x * x + y * y);
        const sx = Math.sqrt(Math.max(0, (r + x) * 0.5));
        let sy = Math.sqrt(Math.max(0, (r - x) * 0.5));
        if (y < 0) sy = -sy;
        return { x: sx, y: sy };
    }

    // The repelling fixed point (1 + sqrt(1 - 4k)) / 2 — a landmark that moves
    // continuously with the seed, so the replay always starts somewhere sane.
    function betaPoint(kx, ky) {
        const s = csqrt(1 - 4 * kx, -4 * ky);
        return { x: (1 + s.x) * 0.5, y: s.y * 0.5 };
    }

    function lockOn(qx, qy) {
        const ox = [qx], oy = [qy];
        for (let j = 0; j < 24; j++) {
            const zx = ox[j], zy = oy[j];
            const nx = zx * zx - zy * zy + seed.x, ny = 2 * zx * zy + seed.y;
            if (!isFinite(nx) || !isFinite(ny) || nx * nx + ny * ny > 1e8) break;
            ox.push(nx); oy.push(ny);
        }
        const n = ox.length - 1;
        if (n < 8) { lockBranches = null; return false; }   // escaped: not on the set
        const b = new Uint8Array(n);
        for (let j = 0; j < n; j++) {
            const w = csqrt(ox[j + 1] - seed.x, oy[j + 1] - seed.y);
            b[j] = (ox[j] * w.x + oy[j] * w.y) >= 0 ? 1 : 0;
        }
        lockBranches = b;
        return true;
    }

    function lockClear() { lockBranches = null; lockLast = null; }
    function isLocked() { return !!lockBranches; }

    function lockPoint() {
        if (!lockBranches) return null;
        const p = betaPoint(seed.x, seed.y);
        let zx = p.x, zy = p.y;
        for (let j = lockBranches.length - 1; j >= 0; j--) {
            const w = csqrt(zx - seed.x, zy - seed.y);
            if (lockBranches[j]) { zx = w.x; zy = w.y; } else { zx = -w.x; zy = -w.y; }
        }
        if (!isFinite(zx) || !isFinite(zy)) return lockLast;

        // A teleport means the itinerary no longer names the same filament.
        // Re-derive it from where the feature was a frame ago — that is still
        // the right place, so tracking continues instead of snapping away.
        if (lockLast && !lockRepairing &&
            Math.hypot(zx - lockLast.x, zy - lockLast.y) > LOCK_JUMP) {
            lockRepairing = true;
            const prev = { x: lockLast.x, y: lockLast.y };
            const ok = lockOn(prev.x, prev.y);
            const fixed = ok ? lockPoint() : null;
            lockRepairing = false;
            if (fixed) { lockLast = fixed; return fixed; }
            lockLast = prev;
            return prev;
        }

        lockLast = { x: zx, y: zy };
        return lockLast;
    }

    /* --------------------------- the catalogue ---------------------------

       Ids are the contract with evtWarp's switch, so they are listed once here
       and the UI builds itself from this rather than from a second hand-kept
       copy that can drift out of step. `life` is how long the effect stays on
       the wire; past it the slot uploads as empty. */

    const CLICK_EFFECTS = [
        { id: 0,  name: 'None',          life: 0 },
        { id: 1,  name: 'Ripple',        life: 6 },
        { id: 2,  name: 'Shockwave',     life: 3 },
        { id: 3,  name: 'Vortex',        life: 7 },
        { id: 4,  name: 'Flare',         life: 4 },
        { id: 5,  name: 'Implode',       life: 6 },
        { id: 6,  name: 'Bulge',         life: 7 },
        { id: 7,  name: 'Shatter',       life: 6 },
        { id: 8,  name: 'Echo',          life: 7 },
        { id: 9,  name: 'Ink Drop',      life: 8 },
        { id: 10, name: 'Gravity Well',  life: 14 },
        { id: 11, name: 'Bloom Ring',    life: 9 },
        { id: 12, name: 'Spiral Throw',  life: 7 },
        { id: 13, name: 'Resonance',     life: 7 },
        { id: 14, name: 'Warp Bubble',   life: 5 },
        { id: 15, name: 'Rift Tear',     life: 6 },
        { id: 16, name: 'Comet',         life: 7 },
        { id: 17, name: 'Chroma Split',  life: 5 },
        { id: 18, name: 'Static Burst',  life: 2 },
        { id: 19, name: 'Aftershock',    life: 4 },
        { id: 20, name: 'Bloom Seed',    life: 8 }
    ];

    const HOVER_EFFECTS = [
        { id: 0, name: 'None' },
        { id: 1, name: 'Lens' },
        { id: 2, name: 'Repel' },
        { id: 3, name: 'Swirl' },
        { id: 4, name: 'Wobble' },
        { id: 5, name: 'Pinch' },
        { id: 6, name: 'Bubble' },
        { id: 7, name: 'Kaleido' }
    ];

    const BACKGROUNDS = [
        { id: 0, name: 'None' },
        { id: 1, name: 'Starfield' },
        { id: 2, name: 'Deep Haze' },
        { id: 3, name: 'Plasma' },
        { id: 4, name: 'Horizon Grid' },
        { id: 5, name: 'Caustics' },
        { id: 6, name: 'Drifting Motes' },
        { id: 7, name: 'Palette Wash' },
        { id: 8, name: 'Scan Bands' }
    ];

    const EVENT_LIFE = CLICK_EFFECTS.map(e => e.life);

    /* ------------------------------ render -------------------------------- */

    function render(mode, m, pointer, opts) {
        if (!ready) return false;
        const o = opts || {};
        const entry = getProgram(mode.shader || 'julia');
        if (!entry) return false;
        const u = entry.u;

        gl.useProgram(entry.prog);
        updatePalette();
        updateAudio(m, o.stamp === undefined ? o.time : o.stamp);

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(u.uRes, canvas.width, canvas.height);
        gl.uniform1f(u.uTime, (o.time || 0) * 0.001);
        gl.uniform2f(u.uMouse, pointer.x, pointer.y);
        gl.uniform1f(u.uMouseDown, pointer.down ? 1 : 0);
        gl.uniform1f(u.uInteract, o.interact === undefined ? 1 : o.interact);

        // An event past its lifetime uploads as kind 0 rather than being left
        // stale, so the shader's cheap early-out actually triggers.
        const ev = o.events || [];
        for (let i = 0; i < 2; i++) {
            const e = ev[i];
            const slot = i === 0 ? u.uEvtA : u.uEvtB;
            if (e && e.kind > 0 && e.age >= 0 && e.age < EVENT_LIFE[e.kind]) {
                gl.uniform4f(slot, e.x, e.y, e.age, e.kind);
            } else {
                gl.uniform4f(slot, 0, 0, 0, 0);
            }
        }
        gl.uniform1f(u.uWall, (o.wall || 0) * 0.001);
        gl.uniform1f(u.uRole, o.role === undefined ? 1 : o.role);
        gl.uniform1f(u.uKey, o.key ? 1 : 0);
        gl.uniform1f(u.uHover, o.hover === undefined ? 1 : o.hover);
        gl.uniform1f(u.uBg, o.bg || 0);
        gl.uniform1f(u.uBgAmt, o.bgAmt === undefined ? 1 : o.bgAmt);

        gl.uniform2f(u.uSeed, seed.x, seed.y);
        gl.uniform1f(u.uEnergy, slowEnergy);
        gl.uniform1f(u.uEnergyFast, fluxEnergy);
        gl.uniform1f(u.uCentroid, fluxCentroid);
        gl.uniform1f(u.uBeat, m.beatPulse);
        gl.uniform1f(u.uDetail, o.detail === undefined ? 0.6 : o.detail);
        gl.uniform1f(u.uZoom, o.zoom === undefined ? 1 : o.zoom);
        gl.uniform2f(u.uPan, o.pan ? o.pan.x : 0, o.pan ? o.pan.y : 0);
        gl.uniform1f(u.uContrast, o.contrast === undefined ? 1 : o.contrast);
        // A colour sweep that reads as gentle elsewhere is a strobe across an
        // iteration-banded image, where every contour changes at once — so the
        // escape-time scenes ask for a far slower one than the rest.
        gl.uniform1f(u.uPalShift,
            P.flow(0, mode.palSpeed === undefined ? 0.01 : mode.palSpeed) % 1);

        for (let i = 0; i < 7; i++) {
            gl.uniform1f(u.uBand[i], slowBand[i]);
            gl.uniform1f(u.uFlux[i], fluxBand[i]);
            gl.uniform1f(u.uOnset[i], onsetBand[i]);
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, palTex);
        gl.uniform1i(u.uPal, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return true;
    }

    return {
        init: init,
        resize: resize,
        render: render,
        updateAudio: updateAudio,
        juliaSeed: juliaSeed,
        lockOn: lockOn,
        lockPoint: lockPoint,
        lockClear: lockClear,
        isLocked: isLocked,
        CLICK_EFFECTS: CLICK_EFFECTS,
        HOVER_EFFECTS: HOVER_EFFECTS,
        BACKGROUNDS: BACKGROUNDS,
        sceneIds: function () { return Object.keys(SCENES); },
        compileScene: function (id) { return !!getProgram(id); },
        isReady: function () { return ready; }
    };
})();


window.FractalModes = (function () {
    'use strict';

    // detail    — iteration / raymarch step budget (the panel slider scales it)
    // timeScale — multiplier on the app's motion clock. Julia runs at 1e-4 of
    //             everything else; a rate that reads as a drift in a fluid sim
    //             is a lurch when it is reshaping a self-similar set.
    // palSpeed  — hue drift. Escape-time images band every contour at once, so
    //             they need a far slower sweep than the soft scenes.
    // lockable  — the feature lock only means anything where uSeed does.
    // hidden    — present and compilable, just not in the mode picker.
    return {
        list: [
            { id: 'julia-bloom', name: 'Julia Bloom', group: 'Fractal · Endless',
              shader: 'julia', detail: 0.65, timeScale: 0.0001, palSpeed: 0.0002,
              lockable: true, roleMotion: 0 },
            { id: 'julia-solid', name: 'Julia Solid', group: 'Fractal · Endless',
              shader: 'quatJulia', detail: 0.45, timeScale: 0.02, palSpeed: 0.002,
              roleMotion: 0.35 },

            { id: 'third-eye', name: 'Third Eye', group: 'Reactive · Mandala',
              shader: 'mandala', detail: 0.6 },
            { id: 'rift', name: 'Ancient Rift', group: 'Reactive · Mandala',
              shader: 'rift', detail: 0.6 },
            { id: 'portal', name: 'Portal Descent', group: 'Reactive · Mandala',
              shader: 'portal', detail: 0.6 },

            { id: 'nebula', name: 'Nebula Drift', group: 'Reactive · Atmosphere',
              shader: 'nebula', detail: 0.6 },
            { id: 'aurora-veil', name: 'Aurora Veil', group: 'Reactive · Atmosphere',
              shader: 'aurora', detail: 0.6 },
            { id: 'chrome', name: 'Liquid Chrome', group: 'Reactive · Atmosphere',
              shader: 'chrome', detail: 0.6 },
            { id: 'membrane', name: 'Ink Membrane', group: 'Reactive · Atmosphere',
              shader: 'membrane', detail: 0.6 },

            { id: 'metaballs', name: 'Liquid Spectrum', group: 'Reactive · Spectral',
              shader: 'metaballs', detail: 0.6 },
            { id: 'bloom-head', name: 'Spectrum Bloom', group: 'Reactive · Spectral',
              shader: 'bloomHead', detail: 0.6 },
            { id: 'interference', name: 'Standing Waves', group: 'Reactive · Spectral',
              shader: 'interference', detail: 0.6 },
            { id: 'cascade', name: 'Lattice Rain', group: 'Reactive · Spectral',
              shader: 'cascade', detail: 0.6 },
            { id: 'spiral', name: 'Spiral Arms', group: 'Reactive · Spectral',
              shader: 'spiral', detail: 0.6 },

            { id: 'sevenfold', name: 'Seven Suns', group: 'Reactive · Analyser',
              shader: 'sevenfold', detail: 0.6 },
            { id: 'strata', name: 'Strata', group: 'Reactive · Analyser',
              shader: 'strata', detail: 0.6 },
            { id: 'chimes', name: 'Chime Field', group: 'Reactive · Analyser',
              shader: 'chimes', detail: 0.6 },
            { id: 'iris', name: 'Iris', group: 'Reactive · Analyser',
              shader: 'iris', detail: 0.6 },
            { id: 'weave', name: 'Spectral Weave', group: 'Reactive · Analyser',
              shader: 'weave', detail: 0.6 },

            { id: 'crystal', name: 'Crystal Cells', group: 'Reactive · Lattice',
              shader: 'crystal', detail: 0.6 },
            { id: 'hex', name: 'Hex Resonance', group: 'Reactive · Lattice',
              shader: 'hex', detail: 0.6 },
            { id: 'truchet', name: 'Truchet Weave', group: 'Reactive · Lattice',
              shader: 'truchet', detail: 0.6 },

            { id: 'gyroid', name: 'Gyroid Chamber', group: 'Reactive · Solid',
              shader: 'gyroid', detail: 0.5, timeScale: 0.15 },
            { id: 'menger', name: 'Menger Bloom', group: 'Reactive · Solid',
              shader: 'menger', detail: 0.45, timeScale: 0.15 },

            // Kept and still compilable; not in the picker. Drop `hidden` to
            // put any of them back.
            { id: 'mandel-dive', name: 'Mandelbrot Descent', group: 'Fractal · Endless',
              shader: 'mandel', detail: 0.70, timeScale: 0.0001, palSpeed: 0.0002,
              hidden: true },
            { id: 'kifs', name: 'Kaleido IFS', group: 'Fractal · Endless',
              shader: 'kifs', detail: 0.60, timeScale: 0.0001, palSpeed: 0.0002,
              hidden: true },
            { id: 'apollonian', name: 'Apollonian Gasket', group: 'Fractal · Endless',
              shader: 'apollonian', detail: 0.55, timeScale: 0.0001, palSpeed: 0.0002,
              hidden: true },
            { id: 'burning-ship', name: 'Burning Ship', group: 'Fractal · Endless',
              shader: 'burningShip', detail: 0.60, timeScale: 0.0001, palSpeed: 0.0002,
              hidden: true },
            { id: 'phoenix', name: 'Phoenix Field', group: 'Fractal · Endless',
              shader: 'phoenix', detail: 0.60, timeScale: 0.0001, palSpeed: 0.0002,
              hidden: true }
        ]
    };
})();
