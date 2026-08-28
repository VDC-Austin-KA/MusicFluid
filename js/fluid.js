/* ==========================================================================
   FluidEngine — WebGL2 Navier-Stokes dye simulation.

   The solver itself is unchanged. What sits on top of it is a *layer* system:
   a mode no longer reacts to one scalar, it stacks emitters that are each
   bound to a different part of the spectrum, so sub-bass, mids, presence and
   air all put something distinct on screen at the same time.
   ========================================================================== */

window.FluidEngine = (function () {
    'use strict';

    let gl = null, canvas = null;
    let ready = false;

    const config = {
        SIM_RESOLUTION: 256,
        DYE_RESOLUTION: 1024,
        DENSITY_DISSIPATION: 0.98,
        VELOCITY_DISSIPATION: 0.98,
        PRESSURE_ITERATIONS: 20,
        CURL: 30,
        VISCOSITY: 0.3,
        SPLAT_RADIUS: 0.25,
        BLOOM: 1.0,
        SPLAT_BUDGET: 26      // per frame; layers degrade gracefully past it
    };

    let splatsThisFrame = 0;

    /* ----------------------------- shaders -------------------------------- */

    const baseVertexShader = `#version 300 es
        precision highp float;
        in vec2 aPosition;
        out vec2 vUv;
        void main () {
            vUv = aPosition * 0.5 + 0.5;
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    `;

    const clearShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uTexture;
        uniform float uValue;
        void main () { fragColor = uValue * texture(uTexture, vUv); }
    `;

    const splatShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uTarget;
        uniform float uAspectRatio;
        uniform vec3 uColor;
        uniform vec2 uPoint;
        uniform float uRadius;
        void main () {
            vec2 p = vUv - uPoint;
            p.x *= uAspectRatio;
            vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
            vec3 base = texture(uTarget, vUv).xyz;
            fragColor = vec4(base + splat, 1.0);
        }
    `;

    const advectionShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 uTexelSize;
        uniform float uDt;
        uniform float uDissipation;
        void main () {
            vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexelSize;
            fragColor = uDissipation * texture(uSource, coord);
        }
    `;

    const divergenceShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uVelocity;
        uniform vec2 uTexelSize;
        void main () {
            float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).x;
            float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).x;
            float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize.y)).y;
            float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize.y)).y;
            fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
        }
    `;

    const curlShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uVelocity;
        uniform vec2 uTexelSize;
        void main () {
            float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
            float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
            float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
            float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
            fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
        }
    `;

    const vorticityShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform vec2 uTexelSize;
        uniform float uCurlScale;
        uniform float uDt;
        void main () {
            float L = texture(uCurl, vUv - vec2(uTexelSize.x, 0.0)).x;
            float R = texture(uCurl, vUv + vec2(uTexelSize.x, 0.0)).x;
            float T = texture(uCurl, vUv + vec2(0.0, uTexelSize.y)).x;
            float B = texture(uCurl, vUv - vec2(0.0, uTexelSize.y)).x;
            float C = texture(uCurl, vUv).x;
            vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
            float l = length(force) + 0.00001;
            force = (force / l) * uCurlScale * C;
            force.y *= -1.0;
            vec2 vel = texture(uVelocity, vUv).xy;
            fragColor = vec4(vel + force * uDt, 0.0, 1.0);
        }
    `;

    const pressureShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        uniform vec2 uTexelSize;
        void main () {
            float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
            float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
            float T = texture(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
            float B = texture(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
            float div = texture(uDivergence, vUv).x;
            fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
        }
    `;

    const gradientSubtractShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;
        uniform vec2 uTexelSize;
        void main () {
            float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
            float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
            float T = texture(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
            float B = texture(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
            vec2 velocity = texture(uVelocity, vUv).xy;
            velocity -= vec2(R - L, T - B) * 0.5;
            fragColor = vec4(velocity, 0.0, 1.0);
        }
    `;

    // Display carries an optional fractal fold, so the fluid modes can gain
    // endless self-similar detail without the solver knowing about it.
    const displayShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uTexture;
        uniform float uExposure;
        uniform float uFractal;    // 0 = off
        uniform float uTime;
        uniform float uAspect;

        // Iterated mirror-fold-and-scale: a cheap IFS that turns the dye field
        // into a self-similar tiling which keeps resolving as it moves.
        vec2 fold(vec2 p, float amt, float t) {
            for (int i = 0; i < 4; i++) {
                p = abs(p) - 0.42 * amt;
                float a = t * 0.05 + float(i) * 0.7;
                float c = cos(a), s = sin(a);
                p = mat2(c, -s, s, c) * p;
                p *= 1.0 + 0.26 * amt;
            }
            return p;
        }

        void main () {
            vec2 uv = vUv;
            if (uFractal > 0.001) {
                vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
                vec2 f = fold(p, uFractal, uTime);
                vec2 folded = f / vec2(uAspect, 1.0) + 0.5;
                uv = mix(vUv, fract(folded), uFractal);
            }
            vec3 c = texture(uTexture, uv).rgb * uExposure;
            // Reinhard per channel washes to white: the brightest channel
            // saturates first and the others catch up, so every hot region
            // loses its hue. Dividing by the *peak* channel keeps the ratio
            // between channels intact, so bright dye stays coloured.
            float peak = max(c.r, max(c.g, c.b));
            vec3 mapped = c / (1.0 + peak);
            mapped = pow(mapped, vec3(1.0 / 2.2));
            fragColor = vec4(mapped, 1.0);
        }
    `;

    /* ---------------------------- plumbing -------------------------------- */

    function createShader(type, source) {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }

    function Program(vsSource, fsSource) {
        const vs = createShader(gl.VERTEX_SHADER, vsSource);
        const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.bindAttribLocation(this.program, 0, 'aPosition');
        gl.linkProgram(this.program);
        this.uniforms = {};
        const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(this.program, i);
            this.uniforms[info.name] = gl.getUniformLocation(this.program, info.name);
        }
    }
    Program.prototype.bind = function () { gl.useProgram(this.program); };

    function createFBO(w, h, internalFormat, format, type, param) {
        gl.activeTexture(gl.TEXTURE0);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return {
            texture: texture, fbo: fbo, width: w, height: h,
            attach: function (id) {
                gl.activeTexture(gl.TEXTURE0 + id);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return id;
            }
        };
    }

    function createDoubleFBO(w, h, internalFormat, format, type, param) {
        let a = createFBO(w, h, internalFormat, format, type, param);
        let b = createFBO(w, h, internalFormat, format, type, param);
        return {
            get read() { return a; }, set read(v) { a = v; },
            get write() { return b; }, set write(v) { b = v; },
            swap: function () { const t = a; a = b; b = t; }
        };
    }

    let quadBuffer, programs = {}, density, velocity, pressure, divergence, curl;

    function initFramebuffers() {
        // Half-float is filterable in core WebGL2, so LINEAR is safe without
        // OES_texture_float_linear (which iOS does not expose).
        const filtering = gl.LINEAR;
        const aspect = canvas.height / canvas.width;
        const simW = config.SIM_RESOLUTION;
        const simH = Math.max(1, Math.round(config.SIM_RESOLUTION * aspect));
        const dyeW = config.DYE_RESOLUTION;
        const dyeH = Math.max(1, Math.round(config.DYE_RESOLUTION * aspect));

        density = createDoubleFBO(dyeW, dyeH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filtering);
        velocity = createDoubleFBO(simW, simH, gl.RG16F, gl.RG, gl.HALF_FLOAT, filtering);
        pressure = createDoubleFBO(simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
        divergence = createFBO(simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
        curl = createFBO(simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    }

    function renderQuad(target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
        if (target) gl.viewport(0, 0, target.width, target.height);
        else gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* ------------------------------ splat --------------------------------- */

    // Every splat is two full-screen passes, so a busy layer stack could
    // starve the framerate. The budget lets layers emit freely and simply
    // stop being drawn once the frame is full, instead of each layer having
    // to self-censor and guess what the others are doing.
    function splat(x, y, dx, dy, color, radiusScale) {
        if (!ready) return false;
        if (splatsThisFrame >= config.SPLAT_BUDGET) return false;
        splatsThisFrame++;

        const p = programs.splat;
        p.bind();
        const radius = (config.SPLAT_RADIUS * (radiusScale || 1)) / 100.0;
        gl.uniform1f(p.uniforms.uAspectRatio, canvas.width / canvas.height);
        gl.uniform2f(p.uniforms.uPoint, x, y);
        gl.uniform1f(p.uniforms.uRadius, radius);

        gl.uniform1i(p.uniforms.uTarget, velocity.read.attach(0));
        gl.uniform3f(p.uniforms.uColor, dx, dy, 0.0);
        renderQuad(velocity.write);
        velocity.swap();

        gl.uniform1i(p.uniforms.uTarget, density.read.attach(0));
        gl.uniform3f(p.uniforms.uColor, color.r, color.g, color.b);
        renderQuad(density.write);
        density.swap();
        return true;
    }

    function beginFrame() { splatsThisFrame = 0; }
    function splatsUsed() { return splatsThisFrame; }

    function clearDye() {
        if (!ready) return;
        const p = programs.clear;
        p.bind();
        gl.uniform1i(p.uniforms.uTexture, density.read.attach(0));
        gl.uniform1f(p.uniforms.uValue, 0);
        renderQuad(density.write);
        density.swap();
        gl.uniform1i(p.uniforms.uTexture, velocity.read.attach(0));
        gl.uniform1f(p.uniforms.uValue, 0);
        renderQuad(velocity.write);
        velocity.swap();
    }

    /* ------------------------------- init --------------------------------- */

    function init(cnv) {
        canvas = cnv;
        gl = canvas.getContext('webgl2', {
            alpha: false, depth: false, stencil: false,
            antialias: false, preserveDrawingBuffer: false
        });
        if (!gl) return false;
        if (!gl.getExtension('EXT_color_buffer_float')) return false;

        quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        programs.clear = new Program(baseVertexShader, clearShader);
        programs.splat = new Program(baseVertexShader, splatShader);
        programs.advect = new Program(baseVertexShader, advectionShader);
        programs.divergence = new Program(baseVertexShader, divergenceShader);
        programs.curl = new Program(baseVertexShader, curlShader);
        programs.vorticity = new Program(baseVertexShader, vorticityShader);
        programs.pressure = new Program(baseVertexShader, pressureShader);
        programs.gradSub = new Program(baseVertexShader, gradientSubtractShader);
        programs.display = new Program(baseVertexShader, displayShader);

        ready = true;
        resize();
        return true;
    }

    function resize() {
        if (!gl) return;
        const cap = window.MF_MOBILE ? 1.5 : 2;
        const dpr = Math.min(window.devicePixelRatio || 1, cap);
        const cw = canvas.clientWidth || window.innerWidth;
        const ch = canvas.clientHeight || window.innerHeight;
        const w = Math.max(1, Math.floor(cw * dpr));
        const h = Math.max(1, Math.floor(ch * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            initFramebuffers();
        }
    }

    /* ------------------------------ solver -------------------------------- */

    function solve(dt, vorticityAmount, dissipation, fractalAmount, time) {
        const texel = [1.0 / velocity.read.width, 1.0 / velocity.read.height];

        programs.curl.bind();
        gl.uniform2f(programs.curl.uniforms.uTexelSize, texel[0], texel[1]);
        gl.uniform1i(programs.curl.uniforms.uVelocity, velocity.read.attach(0));
        renderQuad(curl);

        programs.vorticity.bind();
        gl.uniform2f(programs.vorticity.uniforms.uTexelSize, texel[0], texel[1]);
        gl.uniform1i(programs.vorticity.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(programs.vorticity.uniforms.uCurl, curl.attach(1));
        gl.uniform1f(programs.vorticity.uniforms.uCurlScale, vorticityAmount);
        gl.uniform1f(programs.vorticity.uniforms.uDt, dt);
        renderQuad(velocity.write);
        velocity.swap();

        programs.advect.bind();
        gl.uniform2f(programs.advect.uniforms.uTexelSize, texel[0], texel[1]);
        gl.uniform1i(programs.advect.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(programs.advect.uniforms.uSource, velocity.read.attach(0));
        gl.uniform1f(programs.advect.uniforms.uDt, dt);
        gl.uniform1f(programs.advect.uniforms.uDissipation, config.VELOCITY_DISSIPATION);
        renderQuad(velocity.write);
        velocity.swap();

        gl.uniform1i(programs.advect.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(programs.advect.uniforms.uSource, density.read.attach(1));
        gl.uniform1f(programs.advect.uniforms.uDissipation, dissipation);
        renderQuad(density.write);
        density.swap();

        programs.divergence.bind();
        gl.uniform2f(programs.divergence.uniforms.uTexelSize, texel[0], texel[1]);
        gl.uniform1i(programs.divergence.uniforms.uVelocity, velocity.read.attach(0));
        renderQuad(divergence);

        programs.clear.bind();
        gl.uniform1i(programs.clear.uniforms.uTexture, pressure.read.attach(0));
        gl.uniform1f(programs.clear.uniforms.uValue, config.VISCOSITY);
        renderQuad(pressure.write);
        pressure.swap();

        programs.pressure.bind();
        gl.uniform2f(programs.pressure.uniforms.uTexelSize, texel[0], texel[1]);
        gl.uniform1i(programs.pressure.uniforms.uDivergence, divergence.attach(0));
        for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(programs.pressure.uniforms.uPressure, pressure.read.attach(1));
            renderQuad(pressure.write);
            pressure.swap();
        }

        programs.gradSub.bind();
        gl.uniform2f(programs.gradSub.uniforms.uTexelSize, texel[0], texel[1]);
        gl.uniform1i(programs.gradSub.uniforms.uPressure, pressure.read.attach(0));
        gl.uniform1i(programs.gradSub.uniforms.uVelocity, velocity.read.attach(1));
        renderQuad(velocity.write);
        velocity.swap();

        programs.display.bind();
        gl.uniform1i(programs.display.uniforms.uTexture, density.read.attach(0));
        gl.uniform1f(programs.display.uniforms.uExposure, config.BLOOM);
        gl.uniform1f(programs.display.uniforms.uFractal, fractalAmount || 0);
        gl.uniform1f(programs.display.uniforms.uTime, (time || 0) * 0.001);
        gl.uniform1f(programs.display.uniforms.uAspect, canvas.width / canvas.height);
        renderQuad(null);
    }

    return {
        config: config,
        init: init,
        resize: resize,
        splat: splat,
        beginFrame: beginFrame,
        splatsUsed: splatsUsed,
        clear: clearDye,
        solve: solve,
        isReady: function () { return ready; },
        aspect: function () { return canvas ? canvas.width / canvas.height : 1; }
    };
})();


/* ==========================================================================
   FluidLayers — reusable emitters, each bound to one part of the spectrum.

   A mode picks a stack of these on top of its own signature motion, which is
   what gives every mode a low end, a midrange and an air response at once.
   ========================================================================== */

window.FluidLayers = (function () {
    'use strict';

    const F = window.FluidEngine;
    const P = window.Palette;
    const TAU = Math.PI * 2;

    // Per-layer scratch, cleared on mode change.
    const S = {};
    function st(key, init) {
        if (S[key] === undefined) S[key] = init;
        return S[key];
    }
    function reset() { for (const k in S) delete S[k]; }

    function col(offset, scale) { return P.hdr(P.flow(offset, scale)); }

    /* --- sub-bass: one huge slow swell, the "body" of the image --- */
    function swell(c, o) {
        const b = c.band(o.band || 'subBass');
        if (b.env < 0.06) return;
        // Slow enough that it reads as breathing rather than pulsing.
        const t = c.t * 0.00018;
        const r = 0.10 + b.env * 0.22;
        const f = (2 + b.env * 26) * c.k * c.depth;
        F.splat(0.5 + Math.cos(t) * r * 0.7, 0.5 + Math.sin(t * 0.83) * r * 0.5,
                Math.cos(t * 1.7) * f, Math.sin(t * 1.3) * f,
                col(0.02, 0.25), 2.6 + b.env * 2.4);
    }

    /* --- midrange: emitters orbiting at mid scale --- */
    function orbiters(c, o) {
        const b = c.band(o.band || 'mid');
        if (b.env < 0.05) return;
        const n = o.count || 3;
        const t = c.t * 0.0009 * (0.5 + b.env * 1.6);
        for (let i = 0; i < n; i++) {
            const a = t + TAU * (i / n);
            const r = (o.radius || 0.26) + b.env * 0.12;
            const f = (4 + b.env * 24) * c.k * c.depth;
            F.splat(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                    -Math.sin(a) * f, Math.cos(a) * f,
                    col(0.33 + i / n * 0.1, 0.6), 0.9);
        }
    }

    /* --- upper mids: thin fast streaks that give the image structure --- */
    function filaments(c, o) {
        const b = c.band(o.band || 'highMid');
        if (b.onset < 0.12 && b.env < 0.25) return;
        const n = 1 + Math.floor(b.onset * 3);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU;
            const r = 0.2 + Math.random() * 0.28;
            const f = (10 + b.env * 34) * c.k * c.depth;
            F.splat(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                    Math.cos(a + 1.57) * f, Math.sin(a + 1.57) * f,
                    col(0.62, 0.8), 0.36);
        }
    }

    /* --- air: fine sparkle, fires on transients only --- */
    function sparkle(c, o) {
        const b = c.band(o.band || 'air');
        if (b.onset < 0.1) return;
        const n = 1 + Math.floor(b.onset * 5);
        for (let i = 0; i < n; i++) {
            const f = (3 + b.onset * 16) * c.k * c.depth;
            F.splat(Math.random(), Math.random(),
                    (Math.random() - 0.5) * f, (Math.random() - 0.5) * f,
                    P.hdr(P.flow(0.8, 1.2), 5.5), 0.22);
        }
    }

    /* --- the whole spectrum at once, as a rotating radial injection --- */
    function spectrumRing(c, o) {
        const bands = c.m.bandsNorm;
        const N = bands.length;
        // Only a slice per frame, advancing each time, so all 64 bins get
        // represented over ~8 frames without blowing the splat budget.
        const per = o.perFrame || 8;
        const idx = st('srIdx', 0);
        const r0 = o.radius || 0.30;
        for (let i = 0; i < per; i++) {
            const bi = (idx + i) % N;
            const v = bands[bi];
            if (v < 0.18) continue;
            const a = TAU * (bi / N) + c.t * 0.00012;
            const rr = r0 + v * 0.14;
            const f = (4 + v * 30) * c.k * c.depth;
            F.splat(0.5 + Math.cos(a) * rr, 0.5 + Math.sin(a) * rr,
                    Math.cos(a) * f, Math.sin(a) * f,
                    P.hdr(bi / N * 0.75 + P.flow(0, 0.3), 3.6 + v * 3), 0.4 + v * 0.5);
        }
        S.srIdx = (idx + per) % N;
    }

    /* --- musical: twelve petals, one per pitch class --- */
    function chromaPetals(c, o) {
        const ch = c.m.chroma;
        const idx = st('cpIdx', 0);
        // Two classes per frame keeps it cheap and makes the petals shimmer.
        for (let k = 0; k < 2; k++) {
            const i = (idx + k) % 12;
            const v = ch[i];
            if (v < 0.25) continue;
            const a = TAU * (i / 12) - Math.PI / 2 + c.t * 0.00005;
            const r = (o.radius || 0.38) + v * 0.06;
            const f = (3 + v * 18) * c.k * c.depth;
            F.splat(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                    -Math.cos(a) * f, -Math.sin(a) * f,
                    P.hdr(i / 12, 4.0 + v * 2), 0.5);
        }
        S.cpIdx = (idx + 2) % 12;
    }

    /* --- fractal: a Clifford strange attractor seeded by the spectrum.
       The orbit never repeats and never leaves its basin, so it lays down
       endless self-similar filigree that reshapes as the music moves. --- */
    function attractor(c, o) {
        const drive = c.band(o.band || 'presence');
        if (drive.env < 0.05) return;
        let x = st('atX', 0.1), y = st('atY', 0.1);
        const a = -1.6 + c.n('mid') * 1.1;
        const b = 1.5 + c.n('lowMid') * 0.9;
        const cc = 1.0 + c.n(o.band || 'presence') * 0.9;
        const d = 0.7 + c.n('air') * 1.1;
        const steps = o.steps || 5;
        for (let i = 0; i < steps; i++) {
            const nx = Math.sin(a * y) + cc * Math.cos(a * x);
            const ny = Math.sin(b * x) + d * Math.cos(b * y);
            x = nx; y = ny;
            const px = 0.5 + x * 0.17, py = 0.5 + y * 0.17;
            if (px < 0 || px > 1 || py < 0 || py > 1) continue;
            const f = (2 + drive.env * 14) * c.k * c.depth;
            F.splat(px, py, x * f, y * f,
                    P.hdr(P.flow(0.45 + (x + 2) * 0.06, 0.5), 3.8), 0.3);
        }
        S.atX = x; S.atY = y;
    }

    /* --- interaction: the pointer as a force, available in every mode --- */
    function pointer(c) {
        const p = c.pointer;
        if (!p.active || c.interact <= 0) return;
        const strength = c.interact;

        // Dragging paints directly; holding pushes or pulls a ring of force,
        // so there is something to play with in automated modes too.
        if (p.moving) {
            F.splat(p.x, p.y, p.vx * 5 * strength, p.vy * 5 * strength,
                    col(0, 1), 1.0);
        }
        if (p.down) {
            const n = 5;
            const push = (p.repel ? -1 : 1) * 26 * strength;
            for (let i = 0; i < n; i++) {
                const a = TAU * (i / n) + c.t * 0.004;
                F.splat(p.x + Math.cos(a) * 0.04, p.y + Math.sin(a) * 0.04,
                        Math.cos(a) * push, Math.sin(a) * push,
                        col(0.5, 1), 0.7);
            }
        }
    }

    const REGISTRY = {
        swell: swell,
        orbiters: orbiters,
        filaments: filaments,
        sparkle: sparkle,
        spectrumRing: spectrumRing,
        chromaPetals: chromaPetals,
        attractor: attractor,
        pointer: pointer
    };

    // Applied to every mode unless it names its own stack. Each entry is
    // gated by the band toggles in the UI, so a layer can be muted live.
    const DEFAULT = [
        { fn: 'swell',        band: 'subBass',  group: 'sub' },
        { fn: 'orbiters',     band: 'mid',      group: 'mid' },
        { fn: 'filaments',    band: 'highMid',  group: 'high' },
        { fn: 'sparkle',      band: 'air',      group: 'air' },
        { fn: 'chromaPetals',                   group: 'mid' },
        { fn: 'attractor',    band: 'presence', group: 'high' }
    ];

    function run(c, stack) {
        const list = stack || DEFAULT;
        for (let i = 0; i < list.length; i++) {
            const spec = list[i];
            if (spec.group && c.layerOn[spec.group] === false) continue;
            const fn = REGISTRY[spec.fn];
            if (fn) fn(c, spec);
        }
    }

    return { run: run, reset: reset, REGISTRY: REGISTRY, DEFAULT: DEFAULT };
})();


/* ==========================================================================
   FluidModes — the curated set. Each mode's own motion binds to one band;
   the shared layers cover the rest of the spectrum around it.
   ========================================================================== */

window.FluidModes = (function () {
    'use strict';

    const F = window.FluidEngine;
    const P = window.Palette;
    const TAU = Math.PI * 2;
    const S = {};

    function col(offset, scale) { return P.hdr(P.flow(offset, scale)); }

    // Mirrors a splat around the centre n times — the symmetry modes use this.
    function radial(n, x, y, dx, dy, color, rs) {
        const cx = x - 0.5, cy = y - 0.5;
        for (let i = 0; i < n; i++) {
            const a = TAU * (i / n);
            const ca = Math.cos(a), sa = Math.sin(a);
            F.splat(0.5 + cx * ca - cy * sa, 0.5 + cx * sa + cy * ca,
                    dx * ca - dy * sa, dx * sa + dy * ca, color, rs);
        }
    }

    const modes = [
    {
        /* Julia Bloom, painted into the fluid instead of rasterised.

           The seed walk is the same one the shader uses, on the same slow
           clock and the same heavily-lagged bands, so the set drifts at the
           pace you can actually follow. Points on the boundary come from
           inverse iteration — z <- +/-sqrt(z - k) lands on the Julia set within
           a few steps from anywhere — and each one is splatted as dye with a
           little outward velocity. The solver then advects the filaments, so
           the fractal is drawn and immediately smeared into flow.

           Layers are empty on purpose: the six default spectrum layers would
           bury the set under unrelated dye. */
        id: 'julia-flow', name: 'Julia Bloom Flow', group: 'Fluid · Fractal',
        noBeatKick: true,
        physics: { diss: 0.988, vort: 16, visc: 0.10, radius: 0.055 },
        layers: [],
        drive: function (c) {
            // One seed for both modes: FractalEngine owns the walk, including
            // its brake at the connectivity transition, so the fluid version
            // deforms in step with the shader one. c.t is the motion-scaled
            // clock in ms; x0.0001 is the fractal engine's own slowdown.
            const k = window.FractalEngine.juliaSeed(c.t * 0.0001, c.m);
            const kx = k.x, ky = k.y;

            let x = S.jfX === undefined ? 0.3 : S.jfX;
            let y = S.jfY === undefined ? 0.2 : S.jfY;
            // Energy is lagged, and the beat is not used at all: a per-hit
            // kick in the splat force pumps the whole set.
            const en = S.jfEn = (S.jfEn || 0) + (c.m.energy - (S.jfEn || 0)) * 0.002;
            const force = (2.5 + en * 9) * c.k;

            // The first few steps are transient — they are still falling onto
            // the set — so they move the orbit without laying down dye.
            for (let i = 0; i < 16; i++) {
                const rx = x - kx, ry = y - ky;
                const r = Math.sqrt(Math.sqrt(rx * rx + ry * ry));
                const a = Math.atan2(ry, rx) * 0.5;
                const sgn = Math.random() < 0.5 ? 1 : -1;
                x = r * Math.cos(a) * sgn;
                y = r * Math.sin(a) * sgn;
                if (i < 4) continue;

                const px = 0.5 + x * 0.30, py = 0.5 + y * 0.30;
                if (px < 0.02 || px > 0.98 || py < 0.02 || py > 0.98) continue;
                F.splat(px, py, x * force, y * force,
                        P.hdr(P.flow(0.45 + a * 0.15, 0.25), 3.4),
                        0.32);
            }
            S.jfX = x; S.jfY = y;
        }
    },
    {
        id: 'spectrum-fountain', name: 'Spectrum Fountain', group: 'Fluid · Spectral',
        physics: { diss: 0.972, vort: 28, visc: 0.18, radius: 0.16 },
        drive: function (c) {
            // The signature layer here *is* the spectrum: 24 columns, each
            // owning its own slice of the band array, half refreshed a frame.
            const N = 24;
            const bands = c.m.bandsNorm;
            const step = bands.length / N;
            const idx = S.sfIdx || 0;
            for (let j = 0; j < 12; j++) {
                const i = (idx + j) % N;
                let v = 0;
                for (let b = 0; b < step; b++) v += bands[Math.floor(i * step + b)];
                v /= step;
                if (v < 0.12) continue;
                F.splat((i + 0.5) / N, 0.03, (Math.random() - 0.5) * 3, v * 78 * c.k,
                        P.hdr(i / N * 0.8 + P.flow(0, 0.3), 3.2 + v * 3.5), 0.6 + v);
            }
            S.sfIdx = (idx + 12) % N;
        }
    },
    {
        id: 'chladni', name: 'Chladni Resonance', group: 'Fluid · Resonance',
        physics: { diss: 0.965, vort: 40, visc: 0.40, radius: 0.30 },
        drive: function (c) {
            // The node grid tightens as the spectral centroid rises, so
            // brighter passages resolve into finer plate patterns.
            const b = c.band('bass');
            if (!(b.hit || c.m.beat || Math.sin(c.t * 0.005) > 0.85)) return;
            const gridN = 2 + Math.round(c.m.centroid * 3);
            const pulse = (8 + b.env * 42) * c.k;
            for (let gx = 0; gx < gridN; gx++) {
                for (let gy = 0; gy < gridN; gy++) {
                    const sx = (gx % 2 ? 1 : -1), sy = (gy % 2 ? 1 : -1);
                    F.splat((gx + 0.5) / gridN, (gy + 0.5) / gridN, sx * pulse, sy * pulse,
                            col((gx * gridN + gy) / (gridN * gridN) * 0.5, 0.5), 0.9);
                }
            }
        }
    },
    {
        id: 'nebula-bloom', name: 'Nebula Bloom', group: 'Fluid · Ambient',
        physics: { diss: 0.993, vort: 12, visc: 0.04, radius: 0.42 },
        drive: function (c) {
            const b = c.band('lowMid');
            const t = c.t * 0.0004;
            for (let i = 0; i < 3; i++) {
                const a = t + TAU * (i / 3);
                const r = 0.16 + Math.sin(t * 2.3 + i) * 0.10 + b.env * 0.08;
                const f = (3 + b.env * 18) * c.k;
                F.splat(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                        Math.cos(a + 1.57) * f, Math.sin(a + 1.57) * f,
                        col(i / 3, 0.4), 1.6 + b.env);
            }
        }
    },
    {
        id: 'double-helix', name: 'Double Helix', group: 'Fluid · Structured',
        physics: { diss: 0.980, vort: 42, visc: 0.22, radius: 0.20 },
        drive: function (c) {
            const b = c.band('mid');
            const t = c.t * 0.0012 * (1 + b.env * 1.6);
            // Rung spacing tracks the centroid: brighter mixes braid tighter.
            const twist = 6 + c.m.centroid * 8;
            for (let s = 0; s < 2; s++) {
                const ph = t + s * Math.PI;
                for (let i = 0; i < 3; i++) {
                    const y = (c.t * 0.00012 + i / 3) % 1;
                    const x = 0.5 + Math.sin(ph + y * twist) * (0.18 + b.env * 0.1);
                    F.splat(x, y, Math.cos(ph + y * twist) * 16,
                            10 + c.n('bass') * 26 * c.k, col(s * 0.5, 0.6), 0.8);
                }
            }
        }
    },
    {
        id: 'solar-flare', name: 'Solar Flare', group: 'Fluid · Structured',
        physics: { diss: 0.976, vort: 45, visc: 0.30, radius: 0.26 },
        drive: function (c) {
            const b = c.band('bass');
            const t = c.t * 0.0006;
            const jets = 5;
            for (let i = 0; i < jets; i++) {
                const a = TAU * (i / jets) + t;
                const f = (8 + b.env * 60) * c.k;
                F.splat(0.5 + Math.cos(a) * 0.48, 0.5 + Math.sin(a) * 0.48,
                        -Math.cos(a) * f, -Math.sin(a) * f,
                        col(i / jets * 0.3 + 0.05, 0.5));
            }
        }
    },
    {
        id: 'kaleidofluid', name: 'Kaleidofluid', group: 'Fluid · Symmetry',
        physics: { diss: 0.984, vort: 38, visc: 0.20, radius: 0.18 },
        fractal: 0.35,
        drive: function (c) {
            const b = c.band('mid');
            const t = c.t * 0.0011;
            const r = 0.14 + Math.sin(t * 1.7) * 0.12 + c.n('bass') * 0.1 * c.k;
            const a = t * 1.3;
            const f = (6 + b.env * 30) * c.k;
            // Fold count rises with brightness, so the symmetry itself is
            // spectrally reactive rather than fixed.
            const folds = 6 + Math.round(c.m.centroid * 6);
            radial(folds, 0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                   Math.cos(a + 1.2) * f, Math.sin(a + 1.2) * f, col(0, 0.7));
        }
    },
    {
        id: 'mandala', name: 'Fluid Mandala', group: 'Fluid · Symmetry',
        physics: { diss: 0.990, vort: 30, visc: 0.14, radius: 0.15 },
        fractal: 0.45,
        drive: function (c) {
            const b = c.band('highMid');
            const t = c.t * 0.0007;
            const arms = 8 + Math.round(c.n('presence') * 8);
            const r = 0.3 + Math.sin(t * 2.1) * 0.08;
            const f = (5 + b.env * 32) * c.k;
            radial(arms, 0.5 + Math.cos(t * 3) * r, 0.5 + Math.sin(t * 3) * r,
                   -Math.cos(t * 3) * f, -Math.sin(t * 3) * f, col(0.15, 0.5), 0.8);
        }
    },
    {
        id: 'black-hole', name: 'Black Hole', group: 'Fluid · Ambient',
        physics: { diss: 0.988, vort: 50, visc: 0.35, radius: 0.22 },
        drive: function (c) {
            const b = c.band('subBass');
            const t = c.t * 0.0009;
            const n = 8;
            for (let i = 0; i < n; i++) {
                const a = TAU * (i / n) + t;
                // Inward with a tangential kick, so it spirals rather than
                // collapsing straight to the centre.
                const pull = (10 + b.env * 40 + c.m.energy * 14) * c.k;
                F.splat(0.5 + Math.cos(a) * 0.46, 0.5 + Math.sin(a) * 0.46,
                        -Math.cos(a) * pull - Math.sin(a) * pull * 0.8,
                        -Math.sin(a) * pull + Math.cos(a) * pull * 0.8,
                        col(i / n * 0.4, 0.35), 0.9);
            }
        }
    },
    {
        id: 'tidal-sweep', name: 'Tidal Sweep', group: 'Fluid · Ambient',
        physics: { diss: 0.987, vort: 22, visc: 0.12, radius: 0.28 },
        drive: function (c) {
            const b = c.band('lowMid');
            const t = c.t * 0.0005;
            const x = 0.5 + Math.sin(t) * 0.5;
            const f = (8 + b.env * 40) * c.k;
            // Each slice is driven by its own band, so the wall of fluid has
            // a vertical frequency gradient instead of moving as one block.
            const rows = 5;
            for (let i = 0; i < rows; i++) {
                const v = c.m.bandsNorm[Math.floor((i / rows) * c.m.bandsNorm.length)];
                F.splat(x, (i + 0.5) / rows, Math.cos(t) * f * (0.5 + v),
                        Math.sin(t * 3 + i) * 6, col(i / rows * 0.25 + 0.5, 0.4), 1.1);
            }
        }
    },
    {
        id: 'attractor-bloom', name: 'Attractor Bloom', group: 'Fluid · Fractal',
        physics: { diss: 0.991, vort: 34, visc: 0.10, radius: 0.10 },
        fractal: 0.2,
        layers: [
            { fn: 'swell', band: 'subBass', group: 'sub' },
            { fn: 'spectrumRing', group: 'mid', radius: 0.42, perFrame: 6 },
            { fn: 'sparkle', band: 'air', group: 'air' },
            { fn: 'chromaPetals', group: 'mid' }
        ],
        drive: function (c) {
            // A de Jong attractor: an endless non-repeating orbit whose four
            // parameters are each owned by a different band, so the shape of
            // the fractal itself is what the spectrum is drawing.
            let x = S.djX === undefined ? 0.1 : S.djX;
            let y = S.djY === undefined ? 0.1 : S.djY;
            const a = 1.4 + c.n('bass') * 1.4;
            const b = -2.3 + c.n('mid') * 1.2;
            const cc = 2.4 - c.n('highMid') * 1.1;
            const d = -2.1 + c.n('presence') * 1.3;
            for (let i = 0; i < 8; i++) {
                const nx = Math.sin(a * y) - Math.cos(b * x);
                const ny = Math.sin(cc * x) - Math.cos(d * y);
                x = nx; y = ny;
                const px = 0.5 + x * 0.21, py = 0.5 + y * 0.21;
                if (px < 0 || px > 1 || py < 0 || py > 1) continue;
                const f = (3 + c.m.energy * 20) * c.k;
                F.splat(px, py, x * f, y * f,
                        P.hdr(P.flow(0.3 + (x + 2) * 0.08, 0.5), 4.2), 0.28);
            }
            S.djX = x; S.djY = y;
        }
    },
    {
        id: 'fractal-flow', name: 'Fractal Flow', group: 'Fluid · Fractal',
        physics: { diss: 0.986, vort: 46, visc: 0.16, radius: 0.13 },
        fractal: 0.6,
        drive: function (c) {
            // Dye injected along the boundary of a Julia set whose seed is
            // steered by the spectrum. Inverse iteration — z -> sqrt(z - k)
            // with a random branch — lands points directly on that boundary,
            // which is fractal at every scale, so detail never bottoms out.
            const ang = c.t * 0.0002 + c.m.centroid * 2;
            const rad = 0.7 + c.n('bass') * 0.12;
            const kr = Math.cos(ang) * rad, ki = Math.sin(ang) * rad;
            let zr = S.ffZr === undefined ? 0.3 : S.ffZr;
            let zi = S.ffZi === undefined ? 0.2 : S.ffZi;
            const v = c.band('highMid').env;
            for (let s = 0; s < 7; s++) {
                const dr = zr - kr, di = zi - ki;
                const mod = Math.sqrt(Math.sqrt(dr * dr + di * di));
                const arg = Math.atan2(di, dr) / 2 + (Math.random() < 0.5 ? 0 : Math.PI);
                zr = mod * Math.cos(arg);
                zi = mod * Math.sin(arg);
                const px = 0.5 + zr * 0.34, py = 0.5 + zi * 0.34;
                if (px < 0.01 || px > 0.99 || py < 0.01 || py > 0.99) continue;
                const f = (4 + v * 26 + c.m.energy * 10) * c.k;
                F.splat(px, py, zi * f, -zr * f,
                        P.hdr(P.flow(0.55 + zr * 0.1, 0.6), 4.0 + v * 2), 0.26);
            }
            S.ffZr = zr; S.ffZi = zi;
        }
    }
    ];

    return {
        list: modes,
        radial: radial,
        resetState: function () {
            for (const k in S) delete S[k];
            window.FluidLayers.reset();
        }
    };
})();
