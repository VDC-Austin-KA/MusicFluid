/* ==========================================================================
   FluidEngine — WebGL2 Navier-Stokes dye simulation.

   The solver is unchanged in spirit from the original single-file version;
   what is new is that the "driver" (what injects force and dye each frame)
   is now pluggable, which is where the extra modes come from.
   ========================================================================== */

window.FluidEngine = (function () {
    'use strict';

    let gl = null, canvas = null, extLinearFloat = null;
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
        REACTIVITY: 1.0
    };

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

    const displayShader = `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 fragColor;
        uniform sampler2D uTexture;
        uniform float uExposure;
        void main () {
            vec3 c = texture(uTexture, vUv).rgb * uExposure;
            vec3 mapped = c / (c + vec3(1.0));
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
        const filtering = extLinearFloat ? gl.LINEAR : gl.NEAREST;
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

    function splat(x, y, dx, dy, color, radiusScale) {
        if (!ready) return;
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
    }

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
        extLinearFloat = gl.getExtension('OES_texture_float_linear');

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
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(window.innerWidth * dpr));
        const h = Math.max(1, Math.floor(window.innerHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            initFramebuffers();
        }
    }

    /* ------------------------------ solver -------------------------------- */

    function solve(dt, vorticityAmount, dissipation) {
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
        renderQuad(null);
    }

    return {
        config: config,
        init: init,
        resize: resize,
        splat: splat,
        clear: clearDye,
        solve: solve,
        isReady: function () { return ready; },
        aspect: function () { return canvas ? canvas.width / canvas.height : 1; }
    };
})();


/* ==========================================================================
   Fluid modes — each `drive` injects force + dye for one frame.
   ctx: { t (ms), dt, m (metrics), pointer, k (reactivity 0..2) }
   ========================================================================== */

window.FluidModes = (function () {
    'use strict';

    const F = window.FluidEngine;
    const P = window.Palette;
    const S = {};                       // scratch state, cleared on mode change

    function col(offset, timeScale) { return P.hdr(P.flow(offset, timeScale)); }
    function TAU(x) { return x * Math.PI * 2; }

    // Mirrors a splat around the centre `n` times — used by the kaleido modes.
    function radialSplat(n, x, y, dx, dy, color, rs) {
        const cx = x - 0.5, cy = y - 0.5;
        const cdx = dx, cdy = dy;
        for (let i = 0; i < n; i++) {
            const a = TAU(i / n);
            const ca = Math.cos(a), sa = Math.sin(a);
            F.splat(
                0.5 + cx * ca - cy * sa,
                0.5 + cx * sa + cy * ca,
                cdx * ca - cdy * sa,
                cdx * sa + cdy * ca,
                color, rs
            );
        }
    }

    const modes = [

    /* ------------------------- interactive ---------------------------- */
    {
        id: 'cosmic-ink', name: 'Cosmic Ink', group: 'Fluid · Interactive',
        physics: { diss: 0.985, vort: 20, visc: 0.10, radius: 0.20 },
        interactive: true,
        drive: function (c) {
            if (c.idle) {
                const t = c.t;
                F.splat(0.5 + Math.sin(t * 0.001) * 0.3, 0.5 + Math.cos(t * 0.0015) * 0.2,
                        Math.cos(t * 0.003) * 6, Math.sin(t * 0.003) * 6, col(0));
            }
        }
    },
    {
        id: 'electric-vortex', name: 'Electric Vortex', group: 'Fluid · Interactive',
        physics: { diss: 0.940, vort: 55, visc: 0.60, radius: 0.35 },
        interactive: true,
        drive: function (c) {
            if (c.idle) {
                const a = c.t * 0.002;
                F.splat(0.5 + Math.cos(a) * 0.25, 0.5 + Math.sin(a) * 0.25,
                        -Math.sin(a) * 14, Math.cos(a) * 14, col(0.1));
            }
        }
    },
    {
        id: 'pulse-wave', name: 'Pulse Wave', group: 'Fluid · Interactive',
        physics: { diss: 0.970, vort: 30, visc: 0.20, radius: 0.45 },
        interactive: true,
        drive: function (c) {
            if (c.m.beat) {
                F.splat(0.5, 0.5, 0, 0, col(0.3), 2.2 + c.m.bass * 2);
            }
        }
    },

    /* ------------------------ automated flow --------------------------- */
    {
        id: 'lissajous', name: 'Lissajous Orbit', group: 'Fluid · Automated',
        physics: { diss: 0.982, vort: 35, visc: 0.15, radius: 0.25 },
        drive: function (c) {
            const t = c.t, sp = 1 + c.m.mid * 2.5 * c.k;
            F.splat(0.5 + Math.sin(t * 0.0015 * sp) * 0.35, 0.5 + Math.cos(t * 0.0025 * sp) * 0.25,
                    Math.cos(t * 0.0015) * 12, -Math.sin(t * 0.0025) * 12, col(0));
            F.splat(0.5 + Math.cos(t * 0.002 * sp) * 0.30, 0.5 + Math.sin(t * 0.001 * sp) * 0.30,
                    -Math.sin(t * 0.002) * 10, Math.cos(t * 0.001) * 10, col(0.5));
        }
    },
    {
        id: 'chladni', name: 'Chladni Resonance', group: 'Fluid · Automated',
        physics: { diss: 0.965, vort: 40, visc: 0.40, radius: 0.30 },
        drive: function (c) {
            const pulse = (10 + c.m.mid * 40) * c.k;
            if (c.m.beat || Math.sin(c.t * 0.005) > 0.8) {
                F.splat(0.25, 0.25,  pulse,  pulse, col(0.1));
                F.splat(0.75, 0.25, -pulse,  pulse, col(0.3));
                F.splat(0.25, 0.75,  pulse, -pulse, col(0.6));
                F.splat(0.75, 0.75, -pulse, -pulse, col(0.8));
            }
        }
    },
    {
        id: 'perlin-stream', name: 'Perlin Stream', group: 'Fluid · Automated',
        physics: { diss: 0.988, vort: 25, visc: 0.05, radius: 0.20 },
        drive: function (c) {
            const t = c.t;
            const force = (15 + c.m.treble * 30) * c.k;
            F.splat(0.5 + Math.sin(t * 0.0008) * 0.4, 0.5 + Math.cos(t * 0.0012) * 0.3,
                    Math.cos(t * 0.002) * force, Math.sin(t * 0.002) * force, col(0.25));
        }
    },
    {
        id: 'nebula-bloom', name: 'Nebula Bloom', group: 'Fluid · Automated',
        physics: { diss: 0.993, vort: 12, visc: 0.04, radius: 0.42 },
        drive: function (c) {
            const t = c.t * 0.0004;
            for (let i = 0; i < 3; i++) {
                const a = t + TAU(i / 3);
                const r = 0.16 + Math.sin(t * 2.3 + i) * 0.10;
                F.splat(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                        Math.cos(a + 1.57) * (3 + c.m.lowMid * 14 * c.k),
                        Math.sin(a + 1.57) * (3 + c.m.lowMid * 14 * c.k),
                        col(i / 3, 0.4), 1.6);
            }
        }
    },
    {
        id: 'ink-storm', name: 'Ink Storm', group: 'Fluid · Automated',
        physics: { diss: 0.955, vort: 58, visc: 0.55, radius: 0.24 },
        drive: function (c) {
            const n = c.m.beat ? 6 : (c.m.treble > 0.3 ? 2 : 1);
            for (let i = 0; i < n; i++) {
                const f = (8 + c.m.level * 45) * c.k;
                F.splat(Math.random(), Math.random(),
                        (Math.random() - 0.5) * f * 2, (Math.random() - 0.5) * f * 2,
                        col(Math.random()));
            }
        }
    },
    {
        id: 'spectrum-fountain', name: 'Spectrum Fountain', group: 'Fluid · Spectral',
        physics: { diss: 0.972, vort: 28, visc: 0.18, radius: 0.16 },
        drive: function (c) {
            const N = 20;
            const bands = c.m.bands, step = bands.length / N;
            for (let i = 0; i < N; i++) {
                let v = 0;
                for (let b = 0; b < step; b++) v += bands[Math.floor(i * step + b)];
                v /= step;
                if (v < 0.06) continue;
                const x = (i + 0.5) / N;
                F.splat(x, 0.04, (Math.random() - 0.5) * 3, v * 70 * c.k,
                        P.hdr(i / N * 0.8 + P.flow(0, 0.3), 3.2 + v * 3), 0.7 + v);
            }
        }
    },
    {
        id: 'double-helix', name: 'Double Helix', group: 'Fluid · Automated',
        physics: { diss: 0.980, vort: 42, visc: 0.22, radius: 0.20 },
        drive: function (c) {
            const t = c.t * 0.0012 * (1 + c.m.mid * c.k);
            for (let s = 0; s < 2; s++) {
                const ph = t + s * Math.PI;
                for (let i = 0; i < 3; i++) {
                    const y = ((c.t * 0.00012 + i / 3) % 1);
                    const x = 0.5 + Math.sin(ph + y * 8) * 0.22;
                    F.splat(x, y, Math.cos(ph + y * 8) * 16, 10 + c.m.bass * 24 * c.k,
                            col(s * 0.5, 0.6), 0.8);
                }
            }
        }
    },
    {
        id: 'solar-flare', name: 'Solar Flare', group: 'Fluid · Automated',
        physics: { diss: 0.976, vort: 45, visc: 0.30, radius: 0.26 },
        drive: function (c) {
            const t = c.t * 0.0006;
            const jets = 5;
            for (let i = 0; i < jets; i++) {
                const a = TAU(i / jets) + t;
                const f = (10 + c.m.bass * 55) * c.k;
                F.splat(0.5 + Math.cos(a) * 0.48, 0.5 + Math.sin(a) * 0.48,
                        -Math.cos(a) * f, -Math.sin(a) * f, col(i / jets * 0.3 + 0.05, 0.5));
            }
        }
    },
    {
        id: 'rain-curtain', name: 'Rain Curtain', group: 'Fluid · Automated',
        physics: { diss: 0.986, vort: 18, visc: 0.10, radius: 0.13 },
        drive: function (c) {
            const drops = 1 + Math.floor(c.m.treble * 6 * c.k);
            for (let i = 0; i < drops; i++) {
                F.splat(Math.random(), 1.02, (Math.random() - 0.5) * 2,
                        -(14 + c.m.level * 40) * c.k, col(Math.random() * 0.15 + 0.55, 0.2), 0.6);
            }
        }
    },
    {
        id: 'kaleidofluid', name: 'Kaleidofluid', group: 'Fluid · Symmetry',
        physics: { diss: 0.984, vort: 38, visc: 0.20, radius: 0.18 },
        drive: function (c) {
            const t = c.t * 0.0011;
            const r = 0.14 + Math.sin(t * 1.7) * 0.12 + c.m.bass * 0.1 * c.k;
            const a = t * 1.3;
            const f = (8 + c.m.mid * 26) * c.k;
            radialSplat(6, 0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                        Math.cos(a + 1.2) * f, Math.sin(a + 1.2) * f, col(0, 0.7));
        }
    },
    {
        id: 'mandala', name: 'Fluid Mandala', group: 'Fluid · Symmetry',
        physics: { diss: 0.990, vort: 30, visc: 0.14, radius: 0.15 },
        drive: function (c) {
            const t = c.t * 0.0007;
            const arms = 12;
            const r = 0.3 + Math.sin(t * 2.1) * 0.08;
            const f = (6 + c.m.highMid * 30) * c.k;
            radialSplat(arms, 0.5 + Math.cos(t * 3) * r, 0.5 + Math.sin(t * 3) * r,
                        -Math.cos(t * 3) * f, -Math.sin(t * 3) * f, col(0.15, 0.5), 0.8);
        }
    },
    {
        id: 'black-hole', name: 'Black Hole', group: 'Fluid · Automated',
        physics: { diss: 0.988, vort: 50, visc: 0.35, radius: 0.22 },
        drive: function (c) {
            const t = c.t * 0.0009;
            const n = 8;
            for (let i = 0; i < n; i++) {
                const a = TAU(i / n) + t;
                const r = 0.46;
                const pull = (14 + c.m.level * 34) * c.k;
                // Inward with a tangential kick, so it spirals rather than collapses.
                F.splat(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r,
                        -Math.cos(a) * pull - Math.sin(a) * pull * 0.8,
                        -Math.sin(a) * pull + Math.cos(a) * pull * 0.8,
                        col(i / n * 0.4, 0.35), 0.9);
            }
        }
    },
    {
        id: 'supernova', name: 'Supernova', group: 'Fluid · Beat',
        physics: { diss: 0.968, vort: 34, visc: 0.25, radius: 0.30 },
        drive: function (c) {
            if (!c.m.beat) return;
            const n = 14;
            const f = (30 + c.m.bass * 60) * c.k;
            const seed = Math.random();
            for (let i = 0; i < n; i++) {
                const a = TAU(i / n) + seed;
                F.splat(0.5 + Math.cos(a) * 0.03, 0.5 + Math.sin(a) * 0.03,
                        Math.cos(a) * f, Math.sin(a) * f, P.hdr(seed + i / n * 0.2, 5.5), 1.3);
            }
        }
    },
    {
        id: 'ripple-grid', name: 'Ripple Grid', group: 'Fluid · Beat',
        physics: { diss: 0.978, vort: 26, visc: 0.22, radius: 0.20 },
        drive: function (c) {
            if (!(c.m.beat || S.rg === undefined)) return;
            S.rg = (S.rg || 0) + 1;
            const g = 4;
            for (let x = 0; x < g; x++) {
                for (let y = 0; y < g; y++) {
                    if ((x + y + S.rg) % 2) continue;
                    const f = (6 + c.m.bass * 26) * c.k;
                    F.splat((x + 0.5) / g, (y + 0.5) / g,
                            (Math.random() - 0.5) * f, (Math.random() - 0.5) * f,
                            col((x * g + y) / (g * g) * 0.5, 0.6), 0.9);
                }
            }
        }
    },
    {
        id: 'tidal-sweep', name: 'Tidal Sweep', group: 'Fluid · Automated',
        physics: { diss: 0.987, vort: 22, visc: 0.12, radius: 0.28 },
        drive: function (c) {
            const t = c.t * 0.0005;
            const x = 0.5 + Math.sin(t) * 0.5;
            const f = (10 + c.m.lowMid * 34) * c.k;
            for (let i = 0; i < 5; i++) {
                F.splat(x, (i + 0.5) / 5, Math.cos(t) * f, Math.sin(t * 3 + i) * 6,
                        col(i / 5 * 0.25 + 0.5, 0.4), 1.1);
            }
        }
    },
    {
        id: 'firefly-swarm', name: 'Firefly Swarm', group: 'Fluid · Automated',
        physics: { diss: 0.992, vort: 44, visc: 0.08, radius: 0.09 },
        drive: function (c) {
            if (!S.ff) {
                S.ff = [];
                for (let i = 0; i < 26; i++) {
                    S.ff.push({ x: Math.random(), y: Math.random(), a: Math.random() * 6.28, h: Math.random() });
                }
            }
            const speed = 0.0016 + c.m.treble * 0.006 * c.k;
            for (let i = 0; i < S.ff.length; i++) {
                const p = S.ff[i];
                p.a += (Math.random() - 0.5) * 0.4 + Math.sin(c.t * 0.001 + i) * 0.03;
                p.x = (p.x + Math.cos(p.a) * speed + 1) % 1;
                p.y = (p.y + Math.sin(p.a) * speed + 1) % 1;
                if (c.m.beat || Math.random() < 0.14) {
                    const f = (2 + c.m.level * 12) * c.k;
                    F.splat(p.x, p.y, Math.cos(p.a) * f, Math.sin(p.a) * f,
                            P.hdr(p.h + P.flow(0, 0.4), 3.4), 0.5);
                }
            }
        }
    }
    ];

    return {
        list: modes,
        resetState: function () { for (const k in S) delete S[k]; },
        radialSplat: radialSplat
    };
})();
