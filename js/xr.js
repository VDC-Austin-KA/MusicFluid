/* ==========================================================================
   xr.js — WebXR (immersive-vr) presentation for MusicFluid.

   The visualizer engines keep doing exactly what they already do: render into
   their own canvas with their own WebGL context. This module owns a *separate*
   XR-compatible context and, each XR frame, uploads the active visualizer
   canvas as a texture, painting it onto a big curved screen wrapped around the
   viewer, plus a floating control panel.

   Why a copy instead of rendering the engines stereoscopically: every mode here
   is a full-screen 2D shader pass (fluid solve, escape-time fractal), not a 3D
   scene with a camera. There is no second eye view to render — the honest VR
   framing for a flat generative image is a very large screen you stand inside.
   A curved sphere-cap (not a full equirect dome) keeps it free of pole pinching.

   Input: each controller's target ray is intersected against the panel first,
   then the screen. A screen hit is converted back into client pixel coordinates
   and pushed through the app's normal pointerMove / fireEvent path, so the
   ripple / vortex / lens click effects and fractal hover all work in VR with no
   engine changes.
   ========================================================================== */

window.XRMode = (function () {
    'use strict';

    // Screen geometry — a sphere cap in front of the viewer.
    const R = 2.6;                     // metres
    const YAW = 150 * Math.PI / 180;   // horizontal extent
    const PITCH = 84 * Math.PI / 180;  // vertical extent
    const SEG_X = 48, SEG_Y = 28;

    // Control panel — an axis-aligned quad, so ray hits are a plane solve.
    const PANEL_W = 1.0, PANEL_H = 0.5;
    const PANEL_Z = -1.35;
    const PANEL_DY = -0.42;            // below eye height
    const PANEL_CW = 640, PANEL_CH = 320;

    let session = null;
    let gl = null, xrCanvas = null;
    let refSpace = null, eyeY = 1.5;
    let hooks = null;

    let prog = null, uMVP = null, uTex = null, uTexOn = null, uColor = null;
    let screenMesh = null, panelMesh = null, rayBuf = null;
    let screenTex = null, panelTex = null;
    let panelCanvas = null, pctx = null;

    let pendingCb = null;
    const lastSelect = new WeakMap();
    let pendingRays = [];
    let panelDirty = true;

    /* ------------------------------ mat4 ---------------------------------- */
    // Column-major, matching the Float32Array layout WebXR hands out.

    function mul(out, a, b) {
        for (let c = 0; c < 4; c++) {
            const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
            out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
            out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
            out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
        return out;
    }

    function translation(out, x, y, z) {
        out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
        out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
        out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
        out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
        return out;
    }

    const mTmp = new Float32Array(16);
    const mModel = new Float32Array(16);
    const mMVP = new Float32Array(16);

    /* ----------------------------- shaders -------------------------------- */

    const VERT = `#version 300 es
    in vec3 aPos;
    in vec2 aUV;
    uniform mat4 uMVP;
    out vec2 vUV;
    void main() {
        vUV = aUV;
        gl_Position = uMVP * vec4(aPos, 1.0);
    }`;

    const FRAG = `#version 300 es
    precision highp float;
    in vec2 vUV;
    uniform sampler2D uTex;
    uniform float uTexOn;
    uniform vec4 uColor;
    out vec4 outColor;
    void main() {
        outColor = uTexOn > 0.5 ? texture(uTex, vUV) : uColor;
    }`;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[xr] shader:', gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    }

    function buildProgram() {
        const vs = compile(gl.VERTEX_SHADER, VERT);
        const fs = compile(gl.FRAGMENT_SHADER, FRAG);
        if (!vs || !fs) return false;
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, 'aPos');
        gl.bindAttribLocation(prog, 1, 'aUV');
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('[xr] link:', gl.getProgramInfoLog(prog));
            return false;
        }
        uMVP = gl.getUniformLocation(prog, 'uMVP');
        uTex = gl.getUniformLocation(prog, 'uTex');
        uTexOn = gl.getUniformLocation(prog, 'uTexOn');
        uColor = gl.getUniformLocation(prog, 'uColor');
        return true;
    }

    /* ------------------------------ meshes -------------------------------- */

    function upload(pos, uv, idx) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const pb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        const ub = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ub);
        gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        return { vao: vao, count: idx.length };
    }

    // Sphere cap centred on -Z. Texture v runs 0 at the top row of the source
    // canvas, so v is flipped against pitch.
    function buildScreen() {
        const pos = new Float32Array((SEG_X + 1) * (SEG_Y + 1) * 3);
        const uv = new Float32Array((SEG_X + 1) * (SEG_Y + 1) * 2);
        let p = 0, q = 0;
        for (let j = 0; j <= SEG_Y; j++) {
            const fy = j / SEG_Y;
            const pitch = (fy - 0.5) * PITCH;
            for (let i = 0; i <= SEG_X; i++) {
                const fx = i / SEG_X;
                const yaw = (fx - 0.5) * YAW;
                pos[p++] = R * Math.sin(yaw) * Math.cos(pitch);
                pos[p++] = R * Math.sin(pitch);
                pos[p++] = -R * Math.cos(yaw) * Math.cos(pitch);
                uv[q++] = fx;
                uv[q++] = 1 - fy;
            }
        }
        const idx = new Uint16Array(SEG_X * SEG_Y * 6);
        let k = 0;
        for (let j = 0; j < SEG_Y; j++) {
            for (let i = 0; i < SEG_X; i++) {
                const a = j * (SEG_X + 1) + i, b = a + 1, c = a + SEG_X + 1, d = c + 1;
                idx[k++] = a; idx[k++] = c; idx[k++] = b;
                idx[k++] = b; idx[k++] = c; idx[k++] = d;
            }
        }
        return upload(pos, uv, idx);
    }

    function buildPanel() {
        const w = PANEL_W / 2, h = PANEL_H / 2;
        const pos = new Float32Array([-w, -h, 0,  w, -h, 0,  -w, h, 0,  w, h, 0]);
        const uv = new Float32Array([0, 1,  1, 1,  0, 0,  1, 0]);
        return upload(pos, uv, new Uint16Array([0, 1, 2, 2, 1, 3]));
    }

    /* ---------------------------- panel canvas ----------------------------- */

    // Hit rects in panel-canvas pixels, rebuilt whenever the panel is drawn.
    let buttons = [];
    let hoverId = null;

    function roundRect(x, y, w, h, r) {
        pctx.beginPath();
        pctx.moveTo(x + r, y);
        pctx.arcTo(x + w, y, x + w, y + h, r);
        pctx.arcTo(x + w, y + h, x, y + h, r);
        pctx.arcTo(x, y + h, x, y, r);
        pctx.arcTo(x, y, x + w, y, r);
        pctx.closePath();
    }

    function button(id, label, x, y, w, h, accent) {
        buttons.push({ id: id, x: x, y: y, w: w, h: h });
        const hot = hoverId === id;
        pctx.fillStyle = accent ? (hot ? '#2ee06a' : '#1db954') : (hot ? '#3a3a4c' : '#23232e');
        roundRect(x, y, w, h, 10);
        pctx.fill();
        if (hot) {
            pctx.strokeStyle = '#ffffff';
            pctx.lineWidth = 2;
            pctx.stroke();
        }
        pctx.fillStyle = accent ? '#06210f' : '#ececf2';
        pctx.font = '600 22px system-ui, sans-serif';
        pctx.textAlign = 'center';
        pctx.textBaseline = 'middle';
        pctx.fillText(label, x + w / 2, y + h / 2);
    }

    function clip(text, max) {
        if (!text) return '';
        let t = text;
        while (t.length > 3 && pctx.measureText(t).width > max) t = t.slice(0, -1);
        return t === text ? t : t + '…';
    }

    function drawPanel() {
        const info = hooks.ui();
        buttons = [];

        pctx.clearRect(0, 0, PANEL_CW, PANEL_CH);
        pctx.fillStyle = 'rgba(14,14,20,0.92)';
        roundRect(0, 0, PANEL_CW, PANEL_CH, 18);
        pctx.fill();

        pctx.textAlign = 'left';
        pctx.textBaseline = 'alphabetic';
        pctx.fillStyle = '#ececf2';
        pctx.font = '600 26px system-ui, sans-serif';
        pctx.fillText(clip(info.title || 'MusicFluid', 430), 24, 44);

        pctx.fillStyle = '#9a9aab';
        pctx.font = '18px system-ui, sans-serif';
        pctx.fillText(clip(info.artist || 'no Spotify session', 430), 24, 70);

        // progress
        pctx.fillStyle = '#2a2a36';
        roundRect(24, 88, PANEL_CW - 48, 6, 3);
        pctx.fill();
        if (info.progress > 0) {
            pctx.fillStyle = '#1db954';
            roundRect(24, 88, (PANEL_CW - 48) * Math.min(1, info.progress), 6, 3);
            pctx.fill();
        }

        // transport
        button('prev', '⏮', 24, 116, 92, 58);
        button('play', info.playing ? '❙❙' : '▶', 128, 116, 92, 58, true);
        button('next', '⏭', 232, 116, 92, 58);
        button('exit', 'Exit VR', PANEL_CW - 148, 116, 124, 58);

        // mode switching
        pctx.fillStyle = '#74748a';
        pctx.font = '14px system-ui, sans-serif';
        pctx.textAlign = 'left';
        pctx.fillText('MODE', 24, 208);
        pctx.fillStyle = '#ececf2';
        pctx.font = '600 20px system-ui, sans-serif';
        pctx.fillText(clip(info.mode || '', 300), 24, 236);

        button('mode-prev', '‹', PANEL_CW - 268, 196, 74, 58);
        button('mode-rand', '⤨', PANEL_CW - 186, 196, 74, 58);
        button('mode-next', '›', PANEL_CW - 104, 196, 80, 58);

        pctx.fillStyle = '#5a5a6c';
        pctx.font = '13px system-ui, sans-serif';
        pctx.fillText('Trigger on the screen paints; ' + (info.source || 'no audio source'), 24, 296);

        gl.bindTexture(gl.TEXTURE_2D, panelTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, panelCanvas);
    }

    /* ------------------------------ raycasts ------------------------------- */

    // Panel plane is axis aligned at z = PANEL_Z, centred (0, eyeY + PANEL_DY).
    function hitPanel(o, d) {
        if (Math.abs(d[2]) < 1e-6) return null;
        const t = (PANEL_Z - o[2]) / d[2];
        if (t <= 0) return null;
        const x = o[0] + d[0] * t, y = o[1] + d[1] * t;
        const cy = eyeY + PANEL_DY;
        const u = (x + PANEL_W / 2) / PANEL_W;
        const v = 0.5 - (y - cy) / PANEL_H;
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;
        return { t: t, px: u * PANEL_CW, py: v * PANEL_CH };
    }

    // We stand inside the sphere, so take the forward (larger) root.
    function hitScreen(o, d) {
        const px = o[0], py = o[1] - eyeY, pz = o[2];
        const b = 2 * (px * d[0] + py * d[1] + pz * d[2]);
        const c = px * px + py * py + pz * pz - R * R;
        const disc = b * b - 4 * c;
        if (disc < 0) return null;
        const t = (-b + Math.sqrt(disc)) / 2;
        if (t <= 0) return null;
        const hx = px + d[0] * t, hy = py + d[1] * t, hz = pz + d[2] * t;
        const pitch = Math.asin(Math.max(-1, Math.min(1, hy / R)));
        const yaw = Math.atan2(hx, -hz);
        const u = yaw / YAW + 0.5;
        const v = 0.5 - pitch / PITCH;
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;
        return { t: t, u: u, v: v };
    }

    function buttonAt(px, py) {
        for (const b of buttons) {
            if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
        }
        return null;
    }

    /* ------------------------------- input --------------------------------- */

    const rayVerts = new Float32Array(6);

    function handleInput(frame) {
        let newHover = null;
        let sawScreen = false;
        const sources = Array.from(session.inputSources);

        for (let i = 0; i < sources.length; i++) {
            const src = sources[i];
            if (!src.targetRaySpace) continue;
            const pose = frame.getPose(src.targetRaySpace, refSpace);
            if (!pose) continue;

            const m = pose.transform.matrix;
            const o = [m[12], m[13], m[14]];
            // -Z column of the rigid transform is the ray direction.
            const d = [-m[8], -m[9], -m[10]];

            const panel = hitPanel(o, d);
            const screen = panel ? null : hitScreen(o, d);
            const dist = panel ? panel.t : screen ? Math.min(screen.t, 6) : 3;

            if (panel) {
                const id = buttonAt(panel.px, panel.py);
                if (id) newHover = id;
            } else if (screen) {
                sawScreen = true;
                hooks.pointerMove(screen.u * window.innerWidth, screen.v * window.innerHeight);
            }

            // Latch the trigger ourselves: `select` fires on release, but the
            // click effects want the press.
            const pressed = !!(src.gamepad && src.gamepad.buttons[0] && src.gamepad.buttons[0].pressed);
            const slot = src.handedness === 'left' ? 1 : 0;
            const was = lastSelect.get(src) || false;
            if (pressed && !was) {
                if (panel) {
                    const id = buttonAt(panel.px, panel.py);
                    if (id) hooks.act(id);
                } else if (screen) {
                    hooks.press(slot, screen.u * window.innerWidth, screen.v * window.innerHeight);
                    hooks.setPointerDown(true, slot === 1);
                }
            } else if (!pressed && was) {
                hooks.setPointerDown(false, false);
            }
            lastSelect.set(src, pressed);

            drawRay(o, d, dist * 0.98, panel ? [0.11, 0.72, 0.33, 1] : [0.6, 0.65, 0.8, 0.7]);
        }

        if (!sawScreen) hooks.setPointerActive(false);
        if (newHover !== hoverId) { hoverId = newHover; panelDirty = true; }
    }

    function drawRay(o, d, len, colour) {
        rayVerts[0] = o[0]; rayVerts[1] = o[1]; rayVerts[2] = o[2];
        rayVerts[3] = o[0] + d[0] * len;
        rayVerts[4] = o[1] + d[1] * len;
        rayVerts[5] = o[2] + d[2] * len;
        pendingRays.push({ verts: rayVerts.slice(), colour: colour });
    }


    /* ------------------------------ session -------------------------------- */

    function available() {
        if (!navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve(false);
        try {
            return navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    async function start() {
        if (session) return session;
        session = await navigator.xr.requestSession('immersive-vr', {
            optionalFeatures: ['local-floor', 'bounded-floor']
        });

        xrCanvas = document.createElement('canvas');
        gl = xrCanvas.getContext('webgl2', {
            xrCompatible: true, alpha: false, antialias: true, depth: true
        });
        if (!gl) { await session.end(); session = null; throw new Error('WebGL2 unavailable for XR'); }
        await gl.makeXRCompatible();
        session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

        try {
            refSpace = await session.requestReferenceSpace('local-floor');
            eyeY = 1.5;
        } catch (e) {
            refSpace = await session.requestReferenceSpace('local');
            eyeY = 0;   // 'local' already sits at head height
        }

        if (!buildProgram()) { await session.end(); throw new Error('XR shader build failed'); }
        screenMesh = buildScreen();
        panelMesh = buildPanel();

        rayBuf = gl.createBuffer();

        screenTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, screenTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        panelCanvas = document.createElement('canvas');
        panelCanvas.width = PANEL_CW;
        panelCanvas.height = PANEL_CH;
        pctx = panelCanvas.getContext('2d');
        panelTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, panelTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        panelDirty = true;

        session.addEventListener('end', onEnd);
        if (hooks.onChange) hooks.onChange(true);
        return session;
    }

    function onEnd() {
        session = null;
        gl = null;
        refSpace = null;
        hooks.setPointerActive(false);
        hooks.setPointerDown(false, false);
        if (hooks.onChange) hooks.onChange(false);
        // The session's frame queue is dropped on end, so hand the pending
        // callback back to the window clock or the app stops rendering.
        const cb = pendingCb;
        pendingCb = null;
        if (cb) window.requestAnimationFrame(wrap(cb));
    }

    function stop() { if (session) session.end(); }

    /* -------------------------------- frame -------------------------------- */

    let panelTick = 0;

    function frame(xrFrame) {
        if (!session || !gl || !xrFrame) return;
        const pose = xrFrame.getViewerPose(refSpace);
        const layer = session.renderState.baseLayer;
        if (!pose || !layer) return;

        // Repaint the panel a few times a second — enough for the progress bar,
        // cheap enough not to matter. Hover changes repaint immediately.
        if (panelDirty || (panelTick++ % 12) === 0) { drawPanel(); panelDirty = false; }

        const src = hooks.canvasFor();
        if (src && src.width && src.height) {
            gl.bindTexture(gl.TEXTURE_2D, screenTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        }

        pendingRays = [];
        handleInput(xrFrame);

        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.clearColor(0, 0, 0, 1);
        gl.clearDepth(1);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(prog);
        gl.uniform1i(uTex, 0);
        gl.activeTexture(gl.TEXTURE0);

        for (const view of pose.views) {
            const vp = layer.getViewport(view);
            if (!vp) continue;
            gl.viewport(vp.x, vp.y, vp.width, vp.height);
            const viewProj = mul(mTmp, view.projectionMatrix, view.transform.inverse.matrix);
            drawView(viewProj);
        }
    }

    function drawView(viewProj) {
        // screen
        translation(mModel, 0, eyeY, 0);
        mul(mMVP, viewProj, mModel);
        gl.uniformMatrix4fv(uMVP, false, mMVP);
        gl.uniform1f(uTexOn, 1);
        gl.bindTexture(gl.TEXTURE_2D, screenTex);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(screenMesh.vao);
        gl.drawElements(gl.TRIANGLES, screenMesh.count, gl.UNSIGNED_SHORT, 0);

        // panel
        translation(mModel, 0, eyeY + PANEL_DY, PANEL_Z);
        mul(mMVP, viewProj, mModel);
        gl.uniformMatrix4fv(uMVP, false, mMVP);
        gl.bindTexture(gl.TEXTURE_2D, panelTex);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(panelMesh.vao);
        gl.drawElements(gl.TRIANGLES, panelMesh.count, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(null);

        // controller rays — world space, so the model matrix is identity
        if (pendingRays.length) {
            gl.uniformMatrix4fv(uMVP, false, viewProj);
            gl.uniform1f(uTexOn, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, rayBuf);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            for (const r of pendingRays) {
                gl.uniform4fv(uColor, r.colour);
                gl.bufferData(gl.ARRAY_BUFFER, r.verts, gl.DYNAMIC_DRAW);
                gl.drawArrays(gl.LINES, 0, 2);
            }
        }
        gl.disable(gl.BLEND);
    }

    /* ------------------------- render-loop driver --------------------------- */

    function wrap(cb) {
        return function (time, xrFrame) { pendingCb = null; cb(time, xrFrame); };
    }

    // app.js calls this instead of requestAnimationFrame so one loop serves both
    // the flat page and the headset.
    function raf(cb) {
        pendingCb = cb;
        if (session) session.requestAnimationFrame(wrap(cb));
        else window.requestAnimationFrame(wrap(cb));
    }

    function isActive() { return !!session; }

    function init(h) { hooks = h; }

    return {
        init: init,
        available: available,
        start: start,
        stop: stop,
        frame: frame,
        raf: raf,
        isActive: isActive,
        markDirty: function () { panelDirty = true; },
        // exposed for scripts/test-xr-raycast.js
        _test: {
            hitScreen: hitScreen, hitPanel: hitPanel, mul: mul,
            setEyeY: function (v) { eyeY = v; },
            geom: { R: R, YAW: YAW, PITCH: PITCH, PANEL_Z: PANEL_Z, PANEL_DY: PANEL_DY,
                    PANEL_W: PANEL_W, PANEL_H: PANEL_H, PANEL_CW: PANEL_CW, PANEL_CH: PANEL_CH }
        }
    };
})();
