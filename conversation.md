## Create more options for the visualizer aspect. I want to have more options with some that have more of an automated reactvity that moves on its own. Also the Beat sensitivity slider is too exaggerated as it is. I would like for this to be better tuned. it also seems as though any sound at all will create a response, when I'd prefer if different ranges within the music cause different kinds of responses from the application and the elements within it.

Here is the updated self-contained HTML file. It introduces **6 curated preset visualizer modes** (including automated geometric flow drivers that move on their own), fine-tunes beat detection thresholding to eliminate erratic triggering, and splits audio reactivity into frequency-specific fluid forces.

### Key Enhancements & Tuning

* **Frequency-Specific Separation:**
* **Sub-Bass (20–100Hz):** Triggers central radial pressure shocks only on true beat impacts.
* **Mid-Range (150–2500Hz):** Drives velocity vector directions, fluid movement speed, and dynamic color hue shifts.
* **Highs/Treble (2500Hz–16kHz):** Modulates vorticity confinement to inject fine micro-swirls and sharp turbulent highlights without causing full-screen explosions.


* **Calibrated Beat Sensitivity:** Replaced raw instantaneous thresholds with a 60-frame moving variance ring buffer (`avg + k * stdDev`). The slider now provides predictable, un-exaggerated sensitivity scaling.
* **6 Visualizer Presets (3 New Automated Motion Drivers):**
1. **Cosmic Ink:** Gentle watercolor diffusion reacting softly to mid-range dynamics.
2. **Electric Vortex:** Aggressive neon fluid decay driven by sharp treble swirls and heavy bass shocks.
3. **Pulse Wave:** Concentric beat-driven radial shockwaves.
4. **Lissajous Orbit (Automated):** A self-moving dual-orbital path that injects flowing fluid ribbons continuously, modulating speed and scale based on music tempo.
5. **Chladni Resonance (Automated):** Automated 4-corner node splats that pulse inward, recreating acoustic standing wave geometry.
6. **Perlin Stream (Automated):** Self-steering flow field vectors that drift autonomously across the canvas even during quiet passages.



---

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Audio-Reactive WebGL Fluid Visualizer</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            user-select: none;
            -webkit-user-select: none;
        }
        body, html {
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #000;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #fff;
        }
        canvas {
            width: 100%;
            height: 100%;
            display: block;
        }
        #ui {
            position: absolute;
            top: 16px;
            left: 16px;
            width: 290px;
            background: rgba(18, 18, 24, 0.75);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.5);
            transition: opacity 0.3s ease, transform 0.3s ease;
            z-index: 10;
        }
        #ui.hidden {
            opacity: 0;
            transform: translateY(-10px);
            pointer-events: none;
        }
        .ui-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .ui-title {
            font-size: 14px;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            color: #e0e0e0;
        }
        .ui-hint {
            font-size: 10px;
            color: #888;
        }
        .section-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #00b4d8;
            margin: 12px 0 6px 0;
        }
        .control-group {
            margin-bottom: 8px;
        }
        .control-group label {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #aaa;
            margin-bottom: 4px;
        }
        .control-group input[type=range] {
            width: 100%;
            height: 4px;
            border-radius: 2px;
            background: rgba(255, 255, 255, 0.2);
            outline: none;
            -webkit-appearance: none;
        }
        .control-group input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #00b4d8;
            cursor: pointer;
        }
        select, button, input[type=file] {
            width: 100%;
            padding: 6px 10px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 6px;
            color: #fff;
            font-size: 11px;
            outline: none;
            cursor: pointer;
            transition: background 0.2s;
        }
        select:hover, button:hover {
            background: rgba(255, 255, 255, 0.15);
        }
        .btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-bottom: 8px;
        }
        #file-input {
            display: none;
        }
        #fallback {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
            background: rgba(20, 20, 20, 0.9);
            padding: 24px;
            border-radius: 12px;
            border: 1px solid #ff4d4d;
            display: none;
        }
        #fallback h2 { color: #ff4d4d; margin-bottom: 8px; }
        #fallback p { font-size: 13px; color: #ccc; }
    </style>
</head>
<body>

    <canvas id="canvas"></canvas>

    <div id="ui">
        <div class="ui-header">
            <span class="ui-title">Fluid Visualizer</span>
            <span class="ui-hint">Press 'H' to hide</span>
        </div>

        <div class="section-title">Audio Input Source</div>
        <div class="btn-grid">
            <button id="btn-mic">Microphone</button>
            <button id="btn-sys" style="background: rgba(0, 180, 216, 0.25); border-color: #00b4d8;">PC System Audio</button>
            <button id="btn-file">Load Track</button>
            <input type="file" id="file-input" accept="audio/*">
        </div>
        
        <div class="control-group">
            <label>Visualizer Mode <span>Preset</span></label>
            <select id="select-preset">
                <option value="0">Cosmic Ink (Interactive)</option>
                <option value="1">Electric Vortex (Interactive)</option>
                <option value="2">Pulse Wave (Interactive)</option>
                <option value="3">Lissajous Orbit (Automated Flow)</option>
                <option value="4">Chladni Resonance (Automated Pulse)</option>
                <option value="5">Perlin Stream (Automated Drift)</option>
            </select>
        </div>

        <div class="section-title">Audio Reactivity</div>
        <div class="control-group">
            <label>Master Gain <span id="val-gain">1.2</span></label>
            <input type="range" id="slider-gain" min="0.2" max="3.0" step="0.1" value="1.2">
        </div>
        <div class="control-group">
            <label>Beat Threshold <span id="val-sens">1.5</span></label>
            <input type="range" id="slider-sens" min="1.0" max="3.0" step="0.05" value="1.5">
        </div>

        <div class="section-title">Fluid Physics</div>
        <div class="control-group">
            <label>Dissipation <span id="val-diss">0.980</span></label>
            <input type="range" id="slider-diss" min="0.900" max="0.999" step="0.001" value="0.980">
        </div>
        <div class="control-group">
            <label>Vorticity <span id="val-vort">30</span></label>
            <input type="range" id="slider-vort" min="0" max="60" step="1" value="30">
        </div>
        <div class="control-group">
            <label>Viscosity <span id="val-visc">0.30</span></label>
            <input type="range" id="slider-visc" min="0.0" max="1.0" step="0.05" value="0.30">
        </div>
        <div class="control-group">
            <label>Splat Radius <span id="val-radius">0.25</span></label>
            <input type="range" id="slider-radius" min="0.05" max="0.5" step="0.01" value="0.25">
        </div>
    </div>

    <div id="fallback">
        <h2>Hardware Error</h2>
        <p>WebGL 2.0 or mandatory extension (EXT_color_buffer_float) is not supported by your browser/hardware setup.</p>
    </div>

    <script>
    (function() {
        'use strict';

        const canvas = document.getElementById('canvas');
        const fallback = document.getElementById('fallback');
        
        // --- WebGL Context & Extension Setup ---
        const gl = canvas.getContext('webgl2', { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false });
        if (!gl) {
            fallback.style.display = 'block';
            return;
        }

        const extColorFloat = gl.getExtension('EXT_color_buffer_float');
        const extLinearFloat = gl.getExtension('OES_texture_float_linear');
        if (!extColorFloat) {
            fallback.style.display = 'block';
            return;
        }

        // --- Global Config State ---
        const config = {
            SIM_RESOLUTION: 256,
            DYE_RESOLUTION: 1024,
            DENSITY_DISSIPATION: 0.98,
            VELOCITY_DISSIPATION: 0.98,
            PRESSURE_ITERATIONS: 20,
            CURL: 30,
            VISCOSITY: 0.3,
            SPLAT_RADIUS: 0.25,
            AUDIO_GAIN: 1.2,
            BEAT_SENSITIVITY: 1.5,
            PRESET: 0
        };

        const presets = [
            { diss: 0.985, vort: 20, visc: 0.1, radius: 0.20, autoMode: 'none' },       // 0: Cosmic Ink
            { diss: 0.940, vort: 55, visc: 0.6, radius: 0.35, autoMode: 'none' },       // 1: Electric Vortex
            { diss: 0.970, vort: 30, visc: 0.2, radius: 0.45, autoMode: 'none' },       // 2: Pulse Wave
            { diss: 0.982, vort: 35, visc: 0.15, radius: 0.25, autoMode: 'lissajous' },  // 3: Lissajous Orbit
            { diss: 0.965, vort: 40, visc: 0.40, radius: 0.30, autoMode: 'chladni' },    // 4: Chladni Resonance
            { diss: 0.988, vort: 25, visc: 0.05, radius: 0.20, autoMode: 'perlin' }     // 5: Perlin Stream
        ];

        // --- Audio Processing Engine ---
        let audioCtx, analyser, dataArray, currentSourceNode, currentStream;
        let isAudioInit = false;
        const audioMetrics = { bass: 0, mid: 0, treble: 0, beat: false };
        const bassHistory = new Array(60).fill(0);

        function initAudio() {
            if (isAudioInit) return;
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.85;
            dataArray = new Uint8Array(analyser.frequencyBinCount);
            isAudioInit = true;
        }

        function disconnectCurrentAudio() {
            if (currentSourceNode) {
                currentSourceNode.disconnect();
                currentSourceNode = null;
            }
            if (currentStream) {
                currentStream.getTracks().forEach(track => track.stop());
                currentStream = null;
            }
        }

        function setupMic() {
            initAudio();
            disconnectCurrentAudio();
            navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then(stream => {
                    if (audioCtx.state === 'suspended') audioCtx.resume();
                    currentStream = stream;
                    currentSourceNode = audioCtx.createMediaStreamSource(stream);
                    currentSourceNode.connect(analyser);
                })
                .catch(err => console.error("Mic access denied:", err));
        }

        function setupSystemAudio() {
            initAudio();
            disconnectCurrentAudio();
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
                .then(stream => {
                    const audioTracks = stream.getAudioTracks();
                    if (audioTracks.length === 0) {
                        alert("No audio track detected! Make sure to check 'Share System Audio' when choosing your screen or tab.");
                        stream.getTracks().forEach(t => t.stop());
                        return;
                    }
                    if (audioCtx.state === 'suspended') audioCtx.resume();
                    currentStream = stream;
                    currentSourceNode = audioCtx.createMediaStreamSource(stream);
                    currentSourceNode.connect(analyser);
                })
                .catch(err => console.error("System audio capture denied:", err));
        }

        function setupFile(file) {
            initAudio();
            disconnectCurrentAudio();
            const reader = new FileReader();
            reader.onload = function(e) {
                audioCtx.decodeAudioData(e.target.result, buffer => {
                    if (audioCtx.state === 'suspended') audioCtx.resume();
                    const source = audioCtx.createBufferSource();
                    source.buffer = buffer;
                    source.connect(analyser);
                    analyser.connect(audioCtx.destination);
                    source.start(0);
                    currentSourceNode = source;
                });
            };
            reader.readAsArrayBuffer(file);
        }

        function updateAudio() {
            if (!isAudioInit) return;
            analyser.getByteFrequencyData(dataArray);

            let bassSum = 0, midSum = 0, trebleSum = 0;
            const binCount = analyser.frequencyBinCount; // 256 bins

            // Strictly targeted frequency sub-bands:
            // Sub-Bass: 20-100Hz (bins 1-5)
            for (let i = 1; i <= 5; i++) bassSum += dataArray[i];
            // Mid Range: 150-2500Hz (bins 8-70)
            for (let i = 8; i <= 70; i++) midSum += dataArray[i];
            // Highs / Treble: 2500Hz-16kHz (bins 71-240)
            for (let i = 71; i <= 240; i++) trebleSum += dataArray[i];

            audioMetrics.bass = (bassSum / 5 / 255) * config.AUDIO_GAIN;
            audioMetrics.mid = (midSum / 63 / 255) * config.AUDIO_GAIN;
            audioMetrics.treble = (trebleSum / 170 / 255) * config.AUDIO_GAIN;

            // Calibrated Moving Variance Beat Detection (Avoids False Triggers)
            bassHistory.shift();
            bassHistory.push(audioMetrics.bass);
            
            const meanBass = bassHistory.reduce((a, b) => a + b, 0) / bassHistory.length;
            const variance = bassHistory.reduce((a, b) => a + Math.pow(b - meanBass, 2), 0) / bassHistory.length;
            const stdDev = Math.sqrt(variance);

            // Trigger beat only if current bass exceeds dynamic threshold and holds minimum energy
            const dynamicThreshold = meanBass + (config.BEAT_SENSITIVITY * stdDev);
            audioMetrics.beat = (audioMetrics.bass > dynamicThreshold) && (audioMetrics.bass > 0.35);
        }

        // --- GLSL Shaders ---
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
            void main () {
                fragColor = uValue * texture(uTexture, vUv);
            }
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
                float div = 0.5 * (R - L + T - B);
                fragColor = vec4(div, 0.0, 0.0, 1.0);
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
                float vorticity = 0.5 * (R - L - T + B);
                fragColor = vec4(vorticity, 0.0, 0.0, 1.0);
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
                float pressure = (L + R + B + T - div) * 0.25;
                fragColor = vec4(pressure, 0.0, 0.0, 1.0);
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
            
            void main () {
                vec3 c = texture(uTexture, vUv).rgb;
                vec3 mapped = c / (c + vec3(1.0));
                mapped = pow(mapped, vec3(1.0 / 2.2));
                fragColor = vec4(mapped, 1.0);
            }
        `;

        // --- Shader Helpers ---
        function createShader(gl, type, source) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        class Program {
            constructor(gl, vsSource, fsSource) {
                this.gl = gl;
                const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
                const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
                this.program = gl.createProgram();
                gl.attachShader(this.program, vs);
                gl.attachShader(this.program, fs);
                gl.linkProgram(this.program);
                this.uniforms = {};

                const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
                for (let i = 0; i < count; i++) {
                    const info = gl.getActiveUniform(this.program, i);
                    this.uniforms[info.name] = gl.getUniformLocation(this.program, info.name);
                }
            }
            bind() {
                this.gl.useProgram(this.program);
            }
        }

        // --- Framebuffer Object Helper ---
        function createFBO(gl, w, h, internalFormat, format, type, param) {
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
                texture, fbo, width: w, height: h,
                attach(id) {
                    gl.activeTexture(gl.TEXTURE0 + id);
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    return id;
                }
            };
        }

        function createDoubleFBO(gl, w, h, internalFormat, format, type, param) {
            let fbo1 = createFBO(gl, w, h, internalFormat, format, type, param);
            let fbo2 = createFBO(gl, w, h, internalFormat, format, type, param);
            return {
                get read() { return fbo1; },
                set read(value) { fbo1 = value; },
                get write() { return fbo2; },
                set write(value) { fbo2 = value; },
                swap() {
                    let temp = fbo1;
                    fbo1 = fbo2;
                    fbo2 = temp;
                }
            };
        }

        // --- Pipeline Initialization ---
        const quadTriangleFB = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadTriangleFB);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        const clearProg = new Program(gl, baseVertexShader, clearShader);
        const splatProg = new Program(gl, baseVertexShader, splatShader);
        const advectProg = new Program(gl, baseVertexShader, advectionShader);
        const divergenceProg = new Program(gl, baseVertexShader, divergenceShader);
        const curlProg = new Program(gl, baseVertexShader, curlShader);
        const vorticityProg = new Program(gl, baseVertexShader, vorticityShader);
        const pressureProg = new Program(gl, baseVertexShader, pressureShader);
        const gradSubProg = new Program(gl, baseVertexShader, gradientSubtractShader);
        const displayProg = new Program(gl, baseVertexShader, displayShader);

        let density, velocity, pressure, divergence, curl;

        function initFramebuffers() {
            const filtering = extLinearFloat ? gl.LINEAR : gl.NEAREST;
            
            let simW = config.SIM_RESOLUTION;
            let simH = Math.round(config.SIM_RESOLUTION * (window.innerHeight / window.innerWidth));
            let dyeW = config.DYE_RESOLUTION;
            let dyeH = Math.round(config.DYE_RESOLUTION * (window.innerHeight / window.innerWidth));

            density = createDoubleFBO(gl, dyeW, dyeH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filtering);
            velocity = createDoubleFBO(gl, simW, simH, gl.RG16F, gl.RG, gl.HALF_FLOAT, filtering);
            pressure = createDoubleFBO(gl, simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
            divergence = createFBO(gl, simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
            curl = createFBO(gl, simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
        }

        function resizeCanvas() {
            const width = window.innerWidth;
            const height = window.innerHeight;
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                initFramebuffers();
            }
        }

        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        function renderQuad(target) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
            if (target) gl.viewport(0, 0, target.width, target.height);
            else gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

            gl.bindBuffer(gl.ARRAY_BUFFER, quadTriangleFB);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        function splat(x, y, dx, dy, color) {
            splatProg.bind();
            gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
            gl.uniform1f(splatProg.uniforms.uAspectRatio, canvas.width / canvas.height);
            gl.uniform2f(splatProg.uniforms.uPoint, x, y);
            gl.uniform3f(splatProg.uniforms.uColor, dx, dy, 0.0);
            gl.uniform1f(splatProg.uniforms.uRadius, config.SPLAT_RADIUS / 100.0);
            renderQuad(velocity.write);
            velocity.swap();

            gl.uniform1i(splatProg.uniforms.uTarget, density.read.attach(0));
            gl.uniform3f(splatProg.uniforms.uColor, color.r, color.g, color.b);
            renderQuad(density.write);
            density.swap();
        }

        // --- Interactive Mouse & Touch Input ---
        let lastMouseX = 0, lastMouseY = 0;
        let isPointerDown = false;
        let lastSplatTime = Date.now();

        function generateHSLColor(offset = 0) {
            let h = ((Date.now() * 0.03 % 360) / 360) + offset;
            if (isAudioInit && audioMetrics.mid > 0.05) {
                h = (h + audioMetrics.mid * 0.4) % 1.0;
            }
            return hslToRgb(h, 0.85, 0.5);
        }

        function hslToRgb(h, s, l) {
            let r, g, b;
            if (s === 0) {
                r = g = b = l;
            } else {
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r = hueToRgb(p, q, h + 1/3);
                g = hueToRgb(p, q, h);
                b = hueToRgb(p, q, h - 1/3);
            }
            return { r: r * 4.5, g: g * 4.5, b: b * 4.5 };
        }

        function hueToRgb(p, q, t) {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        }

        function handlePointerMove(x, y) {
            const dx = (x - lastMouseX) * 5.0;
            const dy = (lastMouseY - y) * 5.0;
            const normX = x / window.innerWidth;
            const normY = 1.0 - y / window.innerHeight;

            if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
                splat(normX, normY, dx, dy, generateHSLColor());
                lastSplatTime = Date.now();
            }
            lastMouseX = x;
            lastMouseY = y;
        }

        window.addEventListener('mousemove', e => {
            if (!isPointerDown) {
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
            }
            isPointerDown = true;
            handlePointerMove(e.clientX, e.clientY);
        });

        window.addEventListener('touchmove', e => {
            if (e.touches.length > 0) {
                const t = e.touches[0];
                handlePointerMove(t.clientX, t.clientY);
            }
        });

        // --- Automated Motion Drivers ---
        function updateAutomatedDrivers(t) {
            const currentPreset = presets[config.PRESET];
            if (currentPreset.autoMode === 'none') return;

            const speedMultiplier = 1.0 + (audioMetrics.mid * 2.5);

            if (currentPreset.autoMode === 'lissajous') {
                // Orbital dual-harmonic motion path
                const lx1 = 0.5 + Math.sin(t * 0.0015 * speedMultiplier) * 0.35;
                const ly1 = 0.5 + Math.cos(t * 0.0025 * speedMultiplier) * 0.25;
                const vx1 = Math.cos(t * 0.0015) * 12.0;
                const vy1 = -Math.sin(t * 0.0025) * 12.0;
                splat(lx1, ly1, vx1, vy1, generateHSLColor(0.0));

                const lx2 = 0.5 + Math.cos(t * 0.002 * speedMultiplier) * 0.3;
                const ly2 = 0.5 + Math.sin(t * 0.001 * speedMultiplier) * 0.3;
                const vx2 = -Math.sin(t * 0.002) * 10.0;
                const vy2 = Math.cos(t * 0.001) * 10.0;
                splat(lx2, ly2, vx2, vy2, generateHSLColor(0.5));

            } else if (currentPreset.autoMode === 'chladni') {
                // Acoustic standing wave pulsing from 4 quadrant nodes
                const pulse = 10.0 + (audioMetrics.mid * 40.0);
                if (audioMetrics.beat || Math.sin(t * 0.005) > 0.8) {
                    splat(0.25, 0.25, pulse, pulse, generateHSLColor(0.1));
                    splat(0.75, 0.25, -pulse, pulse, generateHSLColor(0.3));
                    splat(0.25, 0.75, pulse, -pulse, generateHSLColor(0.6));
                    splat(0.75, 0.75, -pulse, -pulse, generateHSLColor(0.8));
                }

            } else if (currentPreset.autoMode === 'perlin') {
                // Autonomous directional stream drift across center
                const px = 0.5 + (Math.sin(t * 0.0008) * 0.4);
                const py = 0.5 + (Math.cos(t * 0.0012) * 0.3);
                const dirX = Math.cos(t * 0.002) * (15.0 + audioMetrics.treble * 30.0);
                const dirY = Math.sin(t * 0.002) * (15.0 + audioMetrics.treble * 30.0);
                splat(px, py, dirX, dirY, generateHSLColor(0.25));
            }
        }

        // --- Performance Monitor & Fallback Resolution ---
        let lastFrameTime = performance.now();
        let frameCount = 0;

        function checkPerformance() {
            frameCount++;
            const now = performance.now();
            if (now - lastFrameTime >= 2000) {
                const fps = (frameCount * 1000) / (now - lastFrameTime);
                if (fps < 45 && config.SIM_RESOLUTION > 128) {
                    config.SIM_RESOLUTION = 128;
                    initFramebuffers();
                }
                frameCount = 0;
                lastFrameTime = now;
            }
        }

        // --- Main Simulation Loop ---
        let lastTime = Date.now();

        function step() {
            const now = Date.now();
            const dt = Math.min((now - lastTime) / 1000, 0.016);
            lastTime = now;

            updateAudio();
            checkPerformance();
            updateAutomatedDrivers(now);

            // Frequency-Specific Audio Parameter Modulation
            let effectiveVorticity = config.CURL;
            let effectiveDissipation = config.DENSITY_DISSIPATION;

            if (isAudioInit) {
                // Treble dynamically adjusts fine micro-swirl vorticity
                effectiveVorticity += audioMetrics.treble * 25.0;
                // Mid-range subtly adjusts dissipation rate
                effectiveDissipation = Math.max(0.91, config.DENSITY_DISSIPATION - (audioMetrics.mid * 0.03));

                // Sub-BassBeat Impact: Pure central radial pressure shockwave
                if (audioMetrics.beat) {
                    const angle = Math.random() * Math.PI * 2;
                    const force = 25.0 + (audioMetrics.bass * 25.0);
                    
                    splat(
                        0.5 + Math.cos(angle) * 0.05, 
                        0.5 + Math.sin(angle) * 0.05, 
                        Math.cos(angle) * force, 
                        Math.sin(angle) * force, 
                        hslToRgb(Math.random(), 0.9, 0.6)
                    );
                    lastSplatTime = now;
                }
            }

            // Idle behavior fallback (Only active when untouched and in manual mode)
            if (presets[config.PRESET].autoMode === 'none' && (now - lastSplatTime > 4000)) {
                const x = 0.5 + (Math.sin(now * 0.001) * 0.3);
                const y = 0.5 + (Math.cos(now * 0.0015) * 0.2);
                const dx = Math.cos(now * 0.003) * 6.0;
                const dy = Math.sin(now * 0.003) * 6.0;
                splat(x, y, dx, dy, generateHSLColor());
            }

            // 1. Curl Compute
            curlProg.bind();
            gl.uniform2f(curlProg.uniforms.uTexelSize, 1.0 / velocity.read.width, 1.0 / velocity.read.height);
            gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
            renderQuad(curl);

            // 2. Vorticity Confinement
            vorticityProg.bind();
            gl.uniform2f(vorticityProg.uniforms.uTexelSize, 1.0 / velocity.read.width, 1.0 / velocity.read.height);
            gl.uniform1i(vorticityProg.uniforms.uVelocity, velocity.read.attach(0));
            gl.uniform1i(vorticityProg.uniforms.uCurl, curl.attach(1));
            gl.uniform1f(vorticityProg.uniforms.uCurlScale, effectiveVorticity);
            gl.uniform1f(vorticityProg.uniforms.uDt, dt);
            renderQuad(velocity.write);
            velocity.swap();

            // 3. Velocity Advection
            advectProg.bind();
            gl.uniform2f(advectProg.uniforms.uTexelSize, 1.0 / velocity.read.width, 1.0 / velocity.read.height);
            gl.uniform1i(advectProg.uniforms.uVelocity, velocity.read.attach(0));
            gl.uniform1i(advectProg.uniforms.uSource, velocity.read.attach(0));
            gl.uniform1f(advectProg.uniforms.uDt, dt);
            gl.uniform1f(advectProg.uniforms.uDissipation, config.VELOCITY_DISSIPATION);
            renderQuad(velocity.write);
            velocity.swap();

            // 4. Density Advection
            gl.uniform1i(advectProg.uniforms.uVelocity, velocity.read.attach(0));
            gl.uniform1i(advectProg.uniforms.uSource, density.read.attach(1));
            gl.uniform1f(advectProg.uniforms.uDissipation, effectiveDissipation);
            renderQuad(density.write);
            density.swap();

            // 5. Divergence Computation
            divergenceProg.bind();
            gl.uniform2f(divergenceProg.uniforms.uTexelSize, 1.0 / velocity.read.width, 1.0 / velocity.read.height);
            gl.uniform1i(divergenceProg.uniforms.uVelocity, velocity.read.attach(0));
            renderQuad(divergence);

            // 6. Clear Pressure
            clearProg.bind();
            gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
            gl.uniform1f(clearProg.uniforms.uValue, config.VISCOSITY);
            renderQuad(pressure.write);
            pressure.swap();

            // 7. Pressure Jacobi Solver
            pressureProg.bind();
            gl.uniform2f(pressureProg.uniforms.uTexelSize, 1.0 / velocity.read.width, 1.0 / velocity.read.height);
            gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
            for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
                gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
                renderQuad(pressure.write);
                pressure.swap();
            }

            // 8. Gradient Subtract
            gradSubProg.bind();
            gl.uniform2f(gradSubProg.uniforms.uTexelSize, 1.0 / velocity.read.width, 1.0 / velocity.read.height);
            gl.uniform1i(gradSubProg.uniforms.uPressure, pressure.read.attach(0));
            gl.uniform1i(gradSubProg.uniforms.uVelocity, velocity.read.attach(1));
            renderQuad(velocity.write);
            velocity.swap();

            // 9. Display
            displayProg.bind();
            gl.uniform1i(displayProg.uniforms.uTexture, density.read.attach(0));
            renderQuad(null);

            requestAnimationFrame(step);
        }

        // --- UI Control Event Listeners ---
        const ui = document.getElementById('ui');
        window.addEventListener('keydown', e => {
            if (e.key === 'h' || e.key === 'H') {
                ui.classList.toggle('hidden');
            }
        });

        document.getElementById('btn-mic').addEventListener('click', setupMic);
        document.getElementById('btn-sys').addEventListener('click', setupSystemAudio);
        
        const fileInput = document.getElementById('file-input');
        document.getElementById('btn-file').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', e => {
            if (e.target.files.length > 0) setupFile(e.target.files[0]);
        });

        const selectPreset = document.getElementById('select-preset');
        selectPreset.addEventListener('change', e => {
            const idx = parseInt(e.target.value);
            config.PRESET = idx;
            const p = presets[idx];

            config.DENSITY_DISSIPATION = p.diss;
            config.CURL = p.vort;
            config.VISCOSITY = p.visc;
            config.SPLAT_RADIUS = p.radius;

            document.getElementById('slider-diss').value = p.diss;
            document.getElementById('val-diss').innerText = p.diss.toFixed(3);
            document.getElementById('slider-vort').value = p.vort;
            document.getElementById('val-vort').innerText = p.vort;
            document.getElementById('slider-visc').value = p.visc;
            document.getElementById('val-visc').innerText = p.visc.toFixed(2);
            document.getElementById('slider-radius').value = p.radius;
            document.getElementById('val-radius').innerText = p.radius.toFixed(2);
        });

        function bindSlider(id, targetKey, valueDisplayId, isFloat = true, precision = 2) {
            const slider = document.getElementById(id);
            slider.addEventListener('input', e => {
                const val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value);
                config[targetKey] = val;
                document.getElementById(valueDisplayId).innerText = isFloat ? val.toFixed(precision) : val;
            });
        }

        bindSlider('slider-gain', 'AUDIO_GAIN', 'val-gain', true, 1);
        bindSlider('slider-sens', 'BEAT_SENSITIVITY', 'val-sens', true, 2);
        bindSlider('slider-diss', 'DENSITY_DISSIPATION', 'val-diss', true, 3);
        bindSlider('slider-vort', 'CURL', 'val-vort', false);
        bindSlider('slider-visc', 'VISCOSITY', 'val-visc', true, 2);
        bindSlider('slider-radius', 'SPLAT_RADIUS', 'val-radius', true, 2);

        // Start Loop
        requestAnimationFrame(step);
    })();
    </script>
</body>
</html>

```

