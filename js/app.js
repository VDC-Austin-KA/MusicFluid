/* ==========================================================================
   app.js — mode registry, render loop and all UI wiring.
   ========================================================================== */

(function () {
    'use strict';

    const A = window.AudioEngine;
    const F = window.FluidEngine;
    const FL = window.FluidLayers;
    const FR = window.FractalEngine;
    const P = window.Palette;
    const V = window.Viz2D;
    const SP = window.SpotifyClient;
    const XR = window.XRMode;

    const $ = id => document.getElementById(id);

    const fluidCanvas = $('fluid-canvas');
    const canvas2d = $('viz2d');
    const fractalCanvas = $('fractal-canvas');

    /* --------------------------- platform -------------------------------- */

    // iPadOS 13+ reports itself as a Mac, so the touch-point check is needed
    // on top of the user-agent test.
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
        (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent) ||
        (IS_TOUCH && Math.min(screen.width, screen.height) < 900);

    window.MF_IOS = IS_IOS;
    window.MF_MOBILE = IS_MOBILE;
    window.MF_TOUCH = IS_TOUCH;

    if (IS_IOS) document.body.classList.add('is-ios');
    if (IS_MOBILE) document.body.classList.add('is-mobile');

    /* ------------------------- mode registry ----------------------------- */

    const MODES = [];
    let fluidAvailable = false, fractalAvailable = false;

    // The shader scenes, plus the one fluid mode built on the same Julia seed.
    // The rest of the fluid and 2D libraries still load; they are simply not
    // registered. Add an id to FLUID_KEEP, or drop `hidden` from a fractal
    // mode, to put one back.
    const FLUID_KEEP = ['julia-flow'];

    function buildRegistry() {
        window.FluidModes.list
            .filter(m => FLUID_KEEP.indexOf(m.id) >= 0)
            .forEach(m => MODES.push(Object.assign({ engine: 'fluid' }, m)));
        window.FractalModes.list
            .filter(m => !m.hidden)
            .forEach(m => MODES.push(Object.assign({ engine: 'fractal' }, m)));
    }

    const state = {
        modeIndex: 0,
        reactivity: 1.0,
        motion: 0.55,        // global animation-clock scale; see the loop

        layerDepth: 1.0,
        interact: 1.0,
        fractalFold: -1,     // -1 = use the mode's own value
        detail: 0.6,
        zoom: 1.0,
        pan: { x: 0, y: 0 },   // fractal view centre, screen-uv units
        // Two pointer-event slots, one per mouse button, each carrying its
        // own effect id. Separate slots are what lets a right-button gesture
        // land while a left-button one is still playing out.
        evt: [{ x: 0, y: 0, at: -1e9, kind: 0 },
              { x: 0, y: 0, at: -1e9, kind: 0 }],
        clickLeft: 1,        // Ripple
        clickRight: 3,       // Vortex
        hover: 1,            // Lens
        bg: 1,               // Starfield
        bgAmt: 1.0,
        freqKey: false,      // the seven-band readout in the corner
        layerOn: { sub: true, mid: true, high: true, air: true },
        cycle: false,
        cycleSeconds: 30,
        lastCycleAt: 0,
        autoHide: false,
        modeFlash: true,
        albumColour: true,
        lastPointerAt: Date.now(),
        panelOpen: true
    };

    /* ---------------------------- pointer -------------------------------- */

    // y is stored GL-style (0 at the bottom) because both the fluid splats and
    // the fractal shader work that way; `sy` is the screen-space counterpart
    // for the canvas-2D mode.
    const pointer = {
        x: 0.5, y: 0.5, sy: 0.5,
        vx: 0, vy: 0,
        down: false, active: false, moving: false, repel: false
    };
    let lastPx = 0, lastPy = 0, havePointer = false, moveFrames = 0;

    // Event targets are not always Elements — an event dispatched on `window`
    // has target === window, which has no .closest — so every panel check goes
    // through here rather than calling .closest on a raw target.
    function inPanel(target, selector) {
        if (!target || typeof target.closest !== 'function') return false;
        return !!target.closest(selector || '#panel, #panel-toggle');
    }

    function pointerMove(x, y) {
        state.lastPointerAt = Date.now();
        const el = activeCanvas();
        const cw = el.clientWidth || window.innerWidth;
        const ch = el.clientHeight || window.innerHeight;
        const nx = x / cw, ny = 1 - y / ch;

        if (!havePointer) { lastPx = nx; lastPy = ny; havePointer = true; }
        pointer.vx = nx - lastPx;
        pointer.vy = ny - lastPy;
        lastPx = nx; lastPy = ny;
        pointer.x = nx;
        pointer.y = ny;
        pointer.sy = y / ch;
        pointer.active = true;
        if (Math.abs(pointer.vx) > 0.0008 || Math.abs(pointer.vy) > 0.0008) moveFrames = 6;

        // Dragging inside a fractal pans the view. The delta is divided by the
        // zoom so a drag moves the image the same number of pixels however far
        // in you are — otherwise panning is unusable past a few doublings.
        if (pointer.down && !FR.isLocked() && currentMode().engine === 'fractal') {
            state.pan.x -= pointer.vx * (cw / ch) / state.zoom;
            state.pan.y -= pointer.vy / state.zoom;
        }
    }

    // Matches `vec2 z = uv * 1.9` in the shader's julia(): screen-uv -> the
    // complex plane the set actually lives in.
    const JULIA_UV_SCALE = 1.9;

    // Screen-uv under a client point, matching the shader's own mapping.
    function screenUv(clientX, clientY) {
        const el = activeCanvas();
        const cw = el.clientWidth || window.innerWidth;
        const ch = el.clientHeight || window.innerHeight;
        return { x: (clientX - cw / 2) / ch, y: (ch / 2 - clientY) / ch };
    }

    // Zoom anchored on the cursor: solve pan so the fractal point currently
    // under the pointer is still under it afterwards.
    function zoomAt(clientX, clientY, sliderDelta) {
        const s = $('slider-zoom');
        const before = state.zoom;
        const v = Math.max(+s.min, Math.min(+s.max, +s.value + sliderDelta));
        if (v === +s.value) return;
        s.value = v;
        s.dispatchEvent(new Event('input'));      // updates state.zoom + label
        if (FR.isLocked()) return;       // locked feature stays centred
        const u = screenUv(clientX, clientY);
        state.pan.x += u.x * (1 / before - 1 / state.zoom);
        state.pan.y += u.y * (1 / before - 1 / state.zoom);
    }

    function resetView() {
        FR.lockClear();
        state.pan.x = 0; state.pan.y = 0;
        const s = $('slider-zoom');
        s.value = 0;
        s.dispatchEvent(new Event('input'));
    }

    window.addEventListener('wheel', e => {
        if (currentMode().engine !== 'fractal') return;
        if (e.target.closest && e.target.closest('#panel')) return;   // let the panel scroll
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? -12 : 12);
    }, { passive: false });

    // Shift-click locks the camera onto the feature under the cursor; the
    // engine then reports where that feature has moved to on every frame.
    // A press anywhere on the canvas fires the effect bound to that button
    // into that button's slot.
    function fireEvent(slot, kind, clientX, clientY) {
        if (currentMode().engine !== 'fractal' || !kind) return;
        const u = screenUv(clientX, clientY);
        const s = state.evt[slot];
        s.x = u.x; s.y = u.y; s.kind = kind;
        s.at = performance.now();
    }
    window.addEventListener('mousedown', e => {
        if (e.target.closest && e.target.closest('#panel')) return;
        // Button 2 is the right button; everything else (including the middle
        // one) counts as the primary gesture.
        if (e.button === 2) fireEvent(1, state.clickRight, e.clientX, e.clientY);
        else fireEvent(0, state.clickLeft, e.clientX, e.clientY);
    });
    window.addEventListener('touchstart', e => {
        if (e.target.closest && e.target.closest('#panel')) return;
        if (!e.touches.length) return;
        // Two fingers stand in for the right button on touch.
        const slot = e.touches.length > 1 ? 1 : 0;
        const kind = slot ? state.clickRight : state.clickLeft;
        fireEvent(slot, kind, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    window.addEventListener('mousedown', e => {
        if (!e.shiftKey || currentMode().engine !== 'fractal') return;
        if (e.target.closest && e.target.closest('#panel')) return;
        if (!currentMode().lockable) {
            toast('Lock only applies to the Julia modes.', true);
            return;
        }
        if (FR.isLocked()) { FR.lockClear(); toast('Camera unlocked.'); return; }
        const u = screenUv(e.clientX, e.clientY);
        const q = {
            x: (u.x / state.zoom + state.pan.x) * JULIA_UV_SCALE,
            y: (u.y / state.zoom + state.pan.y) * JULIA_UV_SCALE
        };
        toast(FR.lockOn(q.x, q.y)
            ? 'Camera locked on that filament. Shift-click again to release.'
            : 'Nothing to lock onto there — aim at the set, not the open plane.',
            !FR.isLocked());
    });

    window.addEventListener('dblclick', e => {
        if (currentMode().engine !== 'fractal') return;
        if (e.target.closest && e.target.closest('#panel')) return;
        resetView();
        toast('View reset.');
    });

    function updatePointer() {
        // `moving` lingers a few frames so a fast flick still paints a stroke
        // rather than a single dot.
        if (moveFrames > 0) { moveFrames--; pointer.moving = true; }
        else { pointer.moving = false; pointer.vx *= 0.85; pointer.vy *= 0.85; }
    }

    window.addEventListener('mousemove', e => pointerMove(e.clientX, e.clientY));
    window.addEventListener('mousedown', e => {
        if (inPanel(e.target)) return;
        pointer.down = true;
        pointer.repel = e.shiftKey || e.button === 2;
    });
    window.addEventListener('mouseup', () => { pointer.down = false; });
    window.addEventListener('mouseleave', () => { pointer.active = false; pointer.down = false; });
    window.addEventListener('contextmenu', e => {
        if (!inPanel(e.target)) e.preventDefault();
    });

    window.addEventListener('touchstart', e => {
        if (inPanel(e.target)) return;
        if (e.touches.length) {
            pointer.down = true;
            // Two fingers repel instead of attract — a second gesture with
            // no extra UI.
            pointer.repel = e.touches.length > 1;
            pointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: true });
    window.addEventListener('touchmove', e => {
        if (e.touches.length) pointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener('touchend', () => {
        pointer.down = false;
        havePointer = false;
        // Keep `active` on briefly so the release still reads as a gesture.
        setTimeout(() => { if (!pointer.down) pointer.active = false; }, 1200);
    }, { passive: true });

    /* --------------------------- frame context ---------------------------- */

    // Allocated once and mutated, so the render loop does not churn garbage.
    const ctx = {
        t: 0, dt: 0, m: null,
        k: 1, depth: 1, interact: 1,
        layerOn: state.layerOn,
        pointer: pointer,
        band: function (key) { return ctx.m.band[key]; },
        n: function (key) { return ctx.m.band[key].norm; },
        e: function (key) { return ctx.m.band[key].env; }
    };

    /* ----------------------------- toast --------------------------------- */

    let toastTimer = null;
    function toast(msg, isError) {
        const el = $('toast');
        el.textContent = msg;
        el.className = 'show' + (isError ? ' err' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = ''; }, isError ? 6500 : 3800);
    }

    /* --------------------------- mode switch ------------------------------ */

    function currentMode() { return MODES[state.modeIndex]; }

    function activeCanvas() {
        const e = currentMode() ? currentMode().engine : 'fluid';
        return e === '2d' ? canvas2d : e === 'fractal' ? fractalCanvas : fluidCanvas;
    }

    function engineAvailable(mode) {
        if (mode.engine === 'fluid') return fluidAvailable;
        if (mode.engine === 'fractal') return fractalAvailable;
        return true;
    }

    function applyMode(index, announce) {
        if (index < 0) index = MODES.length - 1;
        if (index >= MODES.length) index = 0;

        // Skip modes whose engine this device cannot run.
        if (!engineAvailable(MODES[index])) {
            const dir = index >= state.modeIndex ? 1 : -1;
            let probe = index;
            for (let i = 0; i < MODES.length; i++) {
                probe = (probe + dir + MODES.length) % MODES.length;
                if (engineAvailable(MODES[probe])) break;
            }
            index = probe;
        }

        state.modeIndex = index;
        const m = MODES[index];
        $('select-mode').value = String(index);
        state.lastCycleAt = Date.now();

        fluidCanvas.classList.toggle('inactive', m.engine !== 'fluid');
        canvas2d.classList.toggle('inactive', m.engine !== '2d');
        fractalCanvas.classList.toggle('inactive', m.engine !== 'fractal');

        if (m.engine === 'fluid') {
            // The canvas was display:none and reported zero size, so
            // re-measure now that it is laid out again.
            F.resize();
            window.FluidModes.resetState();
            if (m.physics) {
                F.config.DENSITY_DISSIPATION = m.physics.diss;
                F.config.CURL = m.physics.vort;
                F.config.VISCOSITY = m.physics.visc;
                F.config.SPLAT_RADIUS = m.physics.radius;
                syncPhysicsSliders();
            }
            F.clear();
        } else if (m.engine === '2d') {
            V.resize();
            V.setMode(m);
        } else {
            FR.resize();
        }

        document.querySelectorAll('[data-engine-only]').forEach(el => {
            el.classList.toggle('dimmed', el.dataset.engineOnly !== m.engine);
        });

        if (announce !== false && state.modeFlash) flashMode(m);
        localStorage.setItem('mf.mode', m.id);
    }

    let flashTimer = null;
    function flashMode(m) {
        const el = $('mode-flash');
        el.querySelector('.mf-name').textContent = m.name;
        el.querySelector('.mf-group').textContent = m.group;
        el.classList.add('show');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => el.classList.remove('show'), 2000);
    }

    function stepMode(delta) { applyMode(state.modeIndex + delta); }
    function randomMode() {
        let i, guard = 0;
        do { i = Math.floor(Math.random() * MODES.length); guard++; }
        while ((i === state.modeIndex || !engineAvailable(MODES[i])) && guard < 60);
        applyMode(i);
    }

    function populateModeSelect() {
        const sel = $('select-mode');
        sel.innerHTML = '';
        const groups = {};
        MODES.forEach((m, i) => {
            if (!groups[m.group]) {
                const og = document.createElement('optgroup');
                og.label = m.group;
                sel.appendChild(og);
                groups[m.group] = og;
            }
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = m.name;
            groups[m.group].appendChild(opt);
        });
        $('mode-count').textContent = MODES.length + ' modes';
    }

    /* --------------------------- render loop ------------------------------ */

    let lastTime = performance.now();
    // Every mode animates off this clock rather than wall time, so one knob
    // slows the whole app down to something the eye can actually follow.
    // Wall time is still used for scheduling (cycle, FPS, auto-hide).
    let vt = 0;
    let frameCount = 0, fpsWindowStart = performance.now();
    let pendingSnapshot = false;

    function loop(now, xrFrame) {
        const dt = Math.min((now - lastTime) / 1000, 0.033) * state.motion;
        lastTime = now;
        vt += dt * 1000;

        const m = A.update(now);
        P.updateMusic(m);
        updatePointer();

        const mode = currentMode();
        ctx.t = vt; ctx.dt = dt; ctx.m = m;
        ctx.k = state.reactivity;
        ctx.depth = state.layerDepth;
        ctx.interact = state.interact;

        if (mode.engine === 'fluid' && fluidAvailable) {
            F.beginFrame();
            mode.drive(ctx);
            FL.run(ctx, mode.layers);
            FL.REGISTRY.pointer(ctx);

            // Global beat kick, shared by every fluid mode that wants it.
            if (m.beat && !mode.noBeatKick) {
                const a = Math.random() * Math.PI * 2;
                const force = (14 + m.band.bass.norm * 26) * ctx.k;
                F.splat(0.5 + Math.cos(a) * 0.05, 0.5 + Math.sin(a) * 0.05,
                        Math.cos(a) * force, Math.sin(a) * force,
                        P.hdr(P.flow(Math.random() * 0.2), 5.0));
            }

            const vort = F.config.CURL + m.band.presence.env * 25 * ctx.k;
            const diss = Math.max(0.90, F.config.DENSITY_DISSIPATION - m.band.mid.env * 0.03 * ctx.k);
            const fold = state.fractalFold >= 0 ? state.fractalFold : (mode.fractal || 0);
            F.solve(dt, vort, diss, fold, vt);
        } else if (mode.engine === '2d') {
            V.frame(vt, m, ctx);
        } else if (mode.engine === 'fractal' && fractalAvailable) {
            // Fractals read their own clock 10000x slower than everything
            // else: a rate that looks like a gentle drift in a fluid sim is a
            // lurch when it is reshaping a self-similar set. Audio drive is
            // untouched — only the autonomous motion is slowed.
            // Each scene reads the motion clock at its own rate: Julia at a
            // ten-thousandth, the soft scenes at full speed.
            const ft = vt * (mode.timeScale === undefined ? 1 : mode.timeScale);
            // The seed walk is shared by both Julia modes and must advance
            // whichever is on screen, so it keeps its own fixed rate.
            FR.juliaSeed(vt * 0.0001, m, vt);
            if (mode.lockable && FR.isLocked()) {
                const q = FR.lockPoint();
                if (q) {
                    state.pan.x = q.x / JULIA_UV_SCALE;
                    state.pan.y = q.y / JULIA_UV_SCALE;
                }
            }
            FR.render(mode, m, pointer, {
                time: ft,
                stamp: vt,
                interact: state.interact,
                detail: state.detail * (mode.detail === undefined ? 1 : mode.detail / 0.6),
                zoom: state.zoom,
                pan: state.pan,
                hover: state.hover,
                bg: state.bg,
                bgAmt: state.bgAmt,
                wall: now,
                key: state.freqKey,
                // Julia opts out of the shared breathing: its whole point is
                // that nothing moves the frame but the seed.
                role: mode.roleMotion === undefined ? 1 : mode.roleMotion,
                events: state.evt.map(e => ({
                    x: e.x, y: e.y, kind: e.kind, age: (now - e.at) / 1000
                }))
            });
        }

        if (pendingSnapshot) { pendingSnapshot = false; captureFrame(); }

        // The engines have just drawn into their own canvas; in a headset the
        // XR module paints that canvas onto the curved screen for both eyes.
        if (xrFrame) XR.frame(xrFrame);

        updateMeters(m);
        updateSpotifyProgress();
        handleAutoCycle();
        handleAutoHide();
        checkPerformance(now);

        XR.raf(loop);
    }

    function checkPerformance(now) {
        frameCount++;
        if (now - fpsWindowStart < 2500) return;
        const fps = frameCount * 1000 / (now - fpsWindowStart);
        frameCount = 0;
        fpsWindowStart = now;
        const mode = currentMode();
        if (fps >= 40) return;
        if (mode.engine === 'fluid' && F.config.SIM_RESOLUTION > 128) {
            F.config.SIM_RESOLUTION = 128;
            F.resize();
            F.clear();
            toast('Dropped simulation resolution to keep the framerate up.');
        } else if (mode.engine === 'fractal' && state.detail > 0.3) {
            state.detail = 0.3;
            $('slider-detail').value = 30;
            $('val-detail').textContent = '30%';
            toast('Reduced fractal detail to keep the framerate up.');
        }
    }

    let meterTick = 0;
    function updateMeters(m) {
        if ((meterTick++ % 3) !== 0) return;
        document.querySelectorAll('#meters i').forEach(el => {
            const b = m.band[el.dataset.band];
            el.style.height = Math.min(100, (b ? b.env : 0) * 100) + '%';
        });
        const ag = $('val-autogain');
        if (ag) {
            ag.textContent = m.live
                ? '×' + m.autoGain.toFixed(2) + (m.saturation > 0.25 ? ' · clipping' : '')
                : '';
        }
        if (m.bpm) {
            $('bpm-readout').innerHTML = 'Tempo <strong>' + m.bpm + ' BPM</strong>' +
                (m.synthetic && !m.live ? ' (simulated)' : '') +
                ' · centroid ' + Math.round(m.centroid * 100) + '%';
        }
    }

    function handleAutoCycle() {
        if (!state.cycle) return;
        if (Date.now() - state.lastCycleAt < state.cycleSeconds * 1000) return;
        randomMode();
    }

    function handleAutoHide() {
        if (!state.autoHide || !state.panelOpen) return;
        if (Date.now() - state.lastPointerAt > 4000) setPanel(false);
    }

    // Touch devices produce no mousemove, so without this the idle timer would
    // hide the panel out from under someone actively tapping its controls.
    ['touchstart', 'pointerdown', 'click', 'input'].forEach(evt => {
        document.addEventListener(evt, () => { state.lastPointerAt = Date.now(); }, true);
    });

    /* ------------------------------ panel -------------------------------- */

    function setPanel(open) {
        state.panelOpen = open;
        $('panel').classList.toggle('collapsed', !open);
        const tog = $('panel-toggle');
        tog.classList.toggle('collapsed', !open);
        tog.innerHTML = open ? '&#8249;' : '&#8250;';
        tog.title = (open ? 'Hide' : 'Show') + ' controls (H)';
        localStorage.setItem('mf.panel', open ? '1' : '0');
    }
    function togglePanel() { setPanel(!state.panelOpen); }

    /* ------------------------------- UI ---------------------------------- */

    function bindSwitch(id, initial, onChange) {
        const el = $(id);
        let on = initial;
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', String(on));
        el.addEventListener('click', () => {
            on = !on;
            el.classList.toggle('on', on);
            el.setAttribute('aria-checked', String(on));
            onChange(on);
        });
    }

    function bindSlider(id, labelId, onChange, format) {
        const el = $(id);
        const label = labelId ? $(labelId) : null;
        const apply = () => {
            const v = parseFloat(el.value);
            if (label) label.textContent = format ? format(v) : v.toFixed(2);
            onChange(v);
        };
        el.addEventListener('input', apply);
        apply();
    }

    function syncPhysicsSliders() {
        $('slider-diss').value = F.config.DENSITY_DISSIPATION;
        $('val-diss').textContent = F.config.DENSITY_DISSIPATION.toFixed(3);
        $('slider-vort').value = F.config.CURL;
        $('val-vort').textContent = F.config.CURL;
        $('slider-visc').value = F.config.VISCOSITY;
        $('val-visc').textContent = F.config.VISCOSITY.toFixed(2);
        $('slider-radius').value = F.config.SPLAT_RADIUS;
        $('val-radius').textContent = F.config.SPLAT_RADIUS.toFixed(2);
    }

    function setupUI() {
        populateModeSelect();

        $('panel-toggle').addEventListener('click', togglePanel);
        $('select-mode').addEventListener('change', e => applyMode(parseInt(e.target.value, 10)));
        $('btn-next-mode').addEventListener('click', () => stepMode(1));
        $('btn-prev-mode').addEventListener('click', () => stepMode(-1));
        $('btn-random-mode').addEventListener('click', randomMode);

        document.querySelectorAll('.section-head').forEach(head => {
            head.addEventListener('click', () => head.parentElement.classList.toggle('collapsed'));
        });

        // --- audio sources ---
        // System always re-opens the picker, so a wrong pick can be corrected;
        // the Spotify buttons reuse whatever capture is already running.
        $('btn-sys').addEventListener('click', async () => {
            if (await A.useSystemAudio(null, true)) toast('System audio linked. Play something and it will react.');
        });
        $('btn-mic').addEventListener('click', async () => {
            if (await A.useMicrophone()) toast('Microphone linked.');
        });
        // Spotify as a source: Soloist decodes on the daemon's own output, so
        // there is no browser-side Spotify stream to tap. This links the
        // Connect device and then opens the capture path that actually carries
        // its sound — display capture on desktop, the room mic on phones.
        $('btn-spotify').addEventListener('click', async () => {
            if (!SP.isConnected()) SP.connect();
            const viaMic = IS_IOS || IS_MOBILE;
            const already = !viaMic && A.hasLiveCapture();
            const ok = viaMic ? await A.useMicrophone() : await A.useSystemAudio('Soloist output');
            if (ok) toast(viaMic
                ? 'Soloist linked. Play it out loud — the mic drives the visuals.'
                : already ? 'Soloist linked, using the capture already running.'
                          : 'Soloist linked. Tick “Share system audio” in the picker.');
        });

        $('btn-file').addEventListener('click', () => $('file-input').click());
        $('file-input').addEventListener('change', e => {
            if (e.target.files.length) {
                A.useFile(e.target.files[0]);
                toast('Playing ' + e.target.files[0].name);
            }
        });

        A.onStatus((kind, detail) => {
            const dot = $('source-status').querySelector('.dot');
            const text = $('source-status-text');
            if (kind === 'connected' || kind === 'audible') {
                dot.className = 'dot live';
                text.textContent = 'Listening to ' + detail;
            } else if (kind === 'silent') {
                dot.className = 'dot warn';
                text.textContent = 'Connected but silent — ' + detail;
            } else if (kind === 'ended') {
                dot.className = 'dot';
                text.textContent = 'Capture stopped';
            } else if (kind === 'error') {
                dot.className = 'dot err';
                text.textContent = detail;
                toast(detail, true);
            }
        });

        // --- palette ---
        $('select-palette').addEventListener('change', e => {
            if (e.target.value === 'album' && !P.hasAlbum()) {
                toast('Play a Spotify track first so there is cover art to sample.');
            }
            P.set(e.target.value);
            localStorage.setItem('mf.palette', e.target.value);
        });
        bindSlider('slider-colspeed', 'val-colspeed', v => P.setSpeed(v), v => v.toFixed(1));
        bindSlider('slider-chroma', 'val-chroma', v => P.setChromaDrive(v / 100),
                   v => Math.round(v) + '%');

        // --- spectrum layers ---
        bindSlider('slider-depth', 'val-depth', v => { state.layerDepth = v / 100; },
                   v => Math.round(v) + '%');
        bindSlider('slider-adaptive', 'val-adaptive', v => { A.config.adaptive = v / 100; },
                   v => Math.round(v) + '%');
        ['sub', 'mid', 'high', 'air'].forEach(gkey => {
            const btn = $('layer-' + gkey);
            btn.classList.add('active');
            btn.addEventListener('click', () => {
                state.layerOn[gkey] = !state.layerOn[gkey];
                btn.classList.toggle('active', state.layerOn[gkey]);
            });
        });
        bindSlider('slider-attack', 'val-attack', v => { A.config.attack = v / 100; },
                   v => Math.round(v) + '%');
        bindSlider('slider-release', 'val-release', v => { A.config.release = v / 100; },
                   v => Math.round(v) + '%');

        // --- reactivity ---
        bindSlider('slider-gain', 'val-gain', v => { A.config.gain = v; }, v => v.toFixed(1));
        bindSlider('slider-sens', 'val-sens', v => { A.config.sensitivity = v; });
        bindSlider('slider-motion', 'val-motion', v => { state.motion = v; },
                   v => v.toFixed(2) + '×');
        bindSlider('slider-react', 'val-react', v => { state.reactivity = v; }, v => v.toFixed(1));
        bindSlider('slider-smooth', 'val-smooth', v => A.setSmoothing(v));

        // --- interaction ---
        bindSlider('slider-interact', 'val-interact', v => { state.interact = v / 100; },
                   v => Math.round(v) + '%');

        // --- fluid physics ---
        bindSlider('slider-diss', 'val-diss', v => { F.config.DENSITY_DISSIPATION = v; }, v => v.toFixed(3));
        bindSlider('slider-vort', 'val-vort', v => { F.config.CURL = v; }, v => String(Math.round(v)));
        bindSlider('slider-visc', 'val-visc', v => { F.config.VISCOSITY = v; });
        bindSlider('slider-radius', 'val-radius', v => { F.config.SPLAT_RADIUS = v; });
        bindSlider('slider-bloom', 'val-bloom', v => { F.config.BLOOM = v; }, v => v.toFixed(1));
        bindSlider('slider-fold', 'val-fold', v => {
            state.fractalFold = v < 0 ? -1 : v / 100;
        }, v => v < 0 ? 'auto' : Math.round(v) + '%');
        // The pickers are built from the engine's own catalogue, so adding an
        // effect there puts it in the menu with no second list to update.
        function fillSelect(id, list, initial, apply) {
            const el = $(id);
            list.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.id;
                opt.textContent = o.name;
                el.appendChild(opt);
            });
            el.value = initial;
            el.addEventListener('change', () => apply(parseInt(el.value, 10)));
        }
        fillSelect('select-click-left', FR.CLICK_EFFECTS, state.clickLeft,
                   v => { state.clickLeft = v; });
        fillSelect('select-click-right', FR.CLICK_EFFECTS, state.clickRight,
                   v => { state.clickRight = v; });
        fillSelect('select-hover', FR.HOVER_EFFECTS, state.hover,
                   v => { state.hover = v; });
        fillSelect('select-bg', FR.BACKGROUNDS, state.bg,
                   v => { state.bg = v; });
        bindSlider('slider-bg-amt', 'val-bg-amt', v => { state.bgAmt = v / 100; },
                   v => Math.round(v) + '%');
        bindSwitch('sw-freq-key', false, on => { state.freqKey = on; });

        // Scrolling the panel with the cursor over a <select> or a range input
        // makes the browser hand the wheel to that control instead, silently
        // changing a setting the user only meant to scroll past. Swallow it and
        // scroll the panel by hand.
        $('panel').addEventListener('wheel', e => {
            const t = e.target;
            if (!t) return;
            if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type === 'range')) {
                e.preventDefault();
                $('panel').scrollTop += e.deltaY;
            }
        }, { passive: false });

        $('btn-reset-view').addEventListener('click', resetView);
        $('btn-clear').addEventListener('click', () => { F.clear(); toast('Canvas cleared.'); });

        // --- fractal ---
        bindSlider('slider-detail', 'val-detail', v => { state.detail = v / 100; },
                   v => Math.round(v) + '%');
        // Logarithmic: the slider carries the exponent, so one control spans
        // 0.1x to 1,000,000x instead of the old linear 0.3..3.
        bindSlider('slider-zoom', 'val-zoom', v => { state.zoom = Math.pow(10, v / 100); },
                   v => {
                       const z = Math.pow(10, v / 100);
                       return (z < 1000 ? z.toFixed(z < 10 ? 2 : 0)
                                        : z.toExponential(1)) + '×';
                   });

        // --- cycling / display ---
        bindSwitch('sw-cycle', false, on => {
            state.cycle = on;
            state.lastCycleAt = Date.now();
            toast(on ? 'Auto-cycling modes every ' + state.cycleSeconds + 's.' : 'Auto-cycle off.');
        });
        bindSlider('slider-cycle', 'val-cycle', v => { state.cycleSeconds = v; }, v => Math.round(v) + 's');
        bindSwitch('sw-autohide', false, on => { state.autoHide = on; });
        bindSwitch('sw-modeflash', true, on => { state.modeFlash = on; });
        bindSwitch('sw-autolevel', false, on => {
            A.setAutoLevel(on);
            toast(on ? 'Auto-level on — input gain adapts to the track.'
                     : 'Auto-level off — set Master gain by hand.');
        });
        bindSwitch('sw-synthetic', true, on => {
            A.setSynthetic(on);
            toast(on ? 'Simulated beat will fill in when no sound is detected.'
                     : 'Simulated beat disabled.');
        });
        A.setSynthetic(true);

        bindSlider('slider-quality', 'val-quality', v => {
            const q = v / 100;
            F.config.DYE_RESOLUTION = Math.round(1024 * q);
            F.config.SIM_RESOLUTION = Math.round(256 * q);
            F.resize();
            F.clear();
        }, v => Math.round(v) + '%');

        $('btn-fullscreen').addEventListener('click', toggleFullscreen);
        $('btn-snapshot').addEventListener('click', () => { pendingSnapshot = true; });

        applyPlatformUI();
        setupSpotifyUI();
    }

    const CAN_FULLSCREEN = !!(document.documentElement.requestFullscreen ||
                              document.documentElement.webkitRequestFullscreen);

    function toggleFullscreen() {
        if (!CAN_FULLSCREEN) {
            toast(IS_IOS
                ? 'iOS Safari has no fullscreen API — use Share → Add to Home Screen instead.'
                : 'Fullscreen is not available in this browser.', true);
            return;
        }
        const el = document.documentElement;
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else {
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            const r = req.call(el);
            if (r && r.catch) r.catch(() => toast('Fullscreen was blocked.', true));
        }
    }

    // The WebGL contexts have no preserved drawing buffer, so a snapshot is
    // only valid in the same tick as the draw — hence the queued flag.
    function captureFrame() {
        const src = activeCanvas();
        try {
            const out = document.createElement('canvas');
            out.width = src.width;
            out.height = src.height;
            out.getContext('2d').drawImage(src, 0, 0);
            out.toBlob(blob => {
                if (!blob) { toast('Could not capture the frame.', true); return; }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'musicfluid-' + currentMode().id + '-' + Date.now() + '.png';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                toast('Frame saved.');
            });
        } catch (err) {
            toast('Could not capture the frame.', true);
        }
    }

    // Fold away the controls the current platform cannot honour, rather than
    // leaving buttons that silently do nothing.
    function applyPlatformUI() {
        if (!CAN_FULLSCREEN) {
            $('btn-fullscreen').disabled = true;
            $('btn-fullscreen').textContent = 'Add to Home Screen';
            $('btn-fullscreen').title = 'iOS has no fullscreen API — install to the Home Screen instead';
        }

        if (IS_IOS) {
            const sys = $('btn-sys');
            sys.disabled = true;
            sys.textContent = 'System n/a';
            sys.title = 'iOS gives browsers no access to system audio — use Mic';
            sys.classList.remove('primary');
            $('btn-mic').classList.add('primary');
            // Soloist is a Connect device, so iOS can still control it — no disable.
            $('btn-sp-connect').title = 'Activate the Soloist Connect device';
        }

        if (IS_MOBILE) {
            $('slider-quality').value = 70;
            $('slider-quality').dispatchEvent(new Event('input'));
            $('slider-detail').value = 40;
            $('slider-detail').dispatchEvent(new Event('input'));
        }

        if (IS_TOUCH) setupGestures();
        setupAudioUnlock();
    }

    /* --------------------------- gestures --------------------------------- */

    function setupGestures() {
        let sx = 0, sy = 0, st = 0, tracking = false, fromPanel = false;

        window.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) { tracking = false; return; }
            const target = e.target;
            if (inPanel(target, 'input, select, button')) { tracking = false; return; }
            fromPanel = inPanel(target, '#panel');
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            st = Date.now();
            tracking = true;
        }, { passive: true });

        window.addEventListener('touchend', e => {
            if (!tracking) return;
            tracking = false;
            const touch = e.changedTouches[0];
            if (!touch) return;
            const dx = touch.clientX - sx, dy = touch.clientY - sy;
            if (Date.now() - st > 800) return;
            const adx = Math.abs(dx), ady = Math.abs(dy);

            if (adx > 70 && adx > ady * 1.6) {
                if (dx < 0 && state.panelOpen) setPanel(false);
                else if (dx > 0 && !state.panelOpen) setPanel(true);
                return;
            }
            // Vertical swipes only count on the canvas, never inside the panel.
            if (!fromPanel && ady > 90 && ady > adx * 1.6) stepMode(dy < 0 ? 1 : -1);
        }, { passive: true });

        // Safari-only pinch events; without this the whole page zooms.
        ['gesturestart', 'gesturechange', 'gestureend'].forEach(evt => {
            document.addEventListener(evt, e => e.preventDefault());
        });

        // Block rubber-band scrolling everywhere except inside the panel.
        document.addEventListener('touchmove', e => {
            if (!inPanel(e.target, '#panel') && e.cancelable) e.preventDefault();
        }, { passive: false });
    }

    // iOS will not start an AudioContext outside a user gesture.
    function setupAudioUnlock() {
        const unlock = () => {
            A.unlock();
            window.removeEventListener('touchend', unlock);
            window.removeEventListener('mousedown', unlock);
            window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('touchend', unlock, { passive: true });
        window.addEventListener('mousedown', unlock);
        window.addEventListener('keydown', unlock);
    }

    /* ---------------------------- keyboard -------------------------------- */

    window.addEventListener('keydown', e => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

        switch (e.key) {
            case 'h': case 'H': togglePanel(); break;
            case 'f': case 'F': toggleFullscreen(); break;
            case 'r': case 'R': randomMode(); break;
            case 'c': case 'C': F.clear(); break;
            case '1': case '2': case '3': case '4': {
                const keys = ['sub', 'mid', 'high', 'air'];
                const gkey = keys[parseInt(e.key, 10) - 1];
                $('layer-' + gkey).click();
                break;
            }
            case 'ArrowRight': stepMode(1); e.preventDefault(); break;
            case 'ArrowLeft': stepMode(-1); e.preventDefault(); break;
            case ' ':
                if (SP.isLoggedIn()) { SP.transport.toggle(); e.preventDefault(); }
                break;
        }
    });

    /* ----------------------------- Spotify Soloist --------------------------- */

    let spotifyPollTimer = null;
    let dashWin = null;

    // The dashboard is its own page with its own WebSocket, so it keeps working
    // even if this tab is backgrounded or the panel is hidden.
    function openDashboard() {
        if (dashWin && !dashWin.closed) { dashWin.focus(); return dashWin; }
        dashWin = window.open('soloist.html?ws=' + encodeURIComponent(SP.wsUrl()),
            'mf-soloist', 'width=1040,height=760,menubar=no,toolbar=no,location=no');
        if (!dashWin) toast('Dashboard popup was blocked — allow popups for this site, or open /soloist.html directly.', true);
        return dashWin;
    }

    function setupSpotifyUI() {
        // New Soloist fields — fall back to legacy IDs if the HTML hasn't reloaded.
        const wsInput = $('sp-ws-url');
        const keyInput = $('sp-soloist-key');
        if (wsInput) wsInput.value = SP.wsUrl();
        if (keyInput) keyInput.value = SP.apiKey();

        const wsHint = $('sp-ws-hint');
        if (wsHint) {
            try {
                const isRailway = location.hostname && location.hostname.indexOf('railway') >= 0 || location.hostname === 'viz.up.railway.app';
                wsHint.textContent = isRailway
                    ? 'Railway proxy: ' + SP.wsEndpoint() + '  ·  check /soloist/status'
                    : 'Local daemon: soloist --ws ' + SP.wsUrl() + '  ·  browser connects to ' + SP.wsEndpoint();
            } catch (e) {}
        }

        const saveKeyBtn = $('btn-save-soloist');
        if (saveKeyBtn) saveKeyBtn.addEventListener('click', () => {
            const v = ($('sp-soloist-key') ? $('sp-soloist-key').value : '').trim();
            if (!v) { toast('Paste your Soloist API key first.', true); return; }
            // Soloist keys are opaque; no strict format — just non-empty.
            SP.setApiKey(v);
            toast('Soloist API key saved locally. On Railway, also set SOLOIST_API_KEY in Variables and redeploy.');
        });

        const saveWsBtn = $('btn-save-ws');
        if (saveWsBtn) saveWsBtn.addEventListener('click', () => {
            const v = ($('sp-ws-url') ? $('sp-ws-url').value : '').trim();
            if (!v) { toast('Enter a WebSocket address.', true); return; }
            SP.setWsUrl(v);
            if (wsHint) wsHint.textContent = 'WebSocket → ' + SP.wsEndpoint();
            toast('WebSocket address saved. Hit Connect.');
        });

        const connectBtn = $('btn-soloist-connect');
        if (connectBtn) connectBtn.addEventListener('click', () => {
            const typedKey = keyInput ? keyInput.value.trim() : '';
            if (typedKey && typedKey !== SP.apiKey()) SP.setApiKey(typedKey);
            const typedWs = wsInput ? wsInput.value.trim() : '';
            if (typedWs && typedWs !== SP.wsUrl()) SP.setWsUrl(typedWs);
            if (!SP.isConnected()) {
                toast('Connecting to Soloist at ' + SP.wsEndpoint() + '…');
                SP.connect();
            }
            // Popups only survive a user gesture, so open the dashboard here
            // rather than waiting for auth_state to arrive.
            openDashboard();
        });

        if ($('btn-open-dashboard')) $('btn-open-dashboard').addEventListener('click', openDashboard);

        const statusBtn = $('btn-soloist-status');
        if (statusBtn) statusBtn.addEventListener('click', () => {
            window.open('/soloist/status', '_blank');
        });

        // Keep legacy login/logout buttons working if old HTML is cached
        const legacyLogin = $('btn-sp-login');
        if (legacyLogin) legacyLogin.addEventListener('click', () => SP.connect());
        if ($('btn-copy-redirect')) $('btn-copy-redirect').addEventListener('click', () => {
            navigator.clipboard.writeText(SP.wsEndpoint()).then(() => toast('WebSocket address copied.')).catch(() => {});
        });
        if ($('btn-save-client')) $('btn-save-client').addEventListener('click', () => {
            const id = ($('sp-client-id') ? $('sp-client-id').value : '').trim();
            SP.setApiKey(id);
            toast('Saved as Soloist key (legacy field).');
        });

        $('btn-sp-logout').addEventListener('click', () => {
            SP.disconnect();
            toast('Disconnected from Soloist.');
        });

        $('btn-play').addEventListener('click', () => SP.transport.toggle());
        $('btn-next').addEventListener('click', () => SP.transport.next());
        $('btn-prev').addEventListener('click', () => SP.transport.previous());

        $('np-progress').addEventListener('click', e => {
            if (!SP.state.durationMs) return;
            const rect = e.currentTarget.getBoundingClientRect();
            SP.transport.seek((e.clientX - rect.left) / rect.width * SP.state.durationMs);
        });

        $('btn-sp-connect').addEventListener('click', async () => {
            try {
                toast('Activating Soloist device…');
                await SP.createPlayer();
                toast('Soloist activated — it should now be the active Connect device.');
            } catch (err) {
                toast(String(err.message || err), true);
            }
        });

        // --- embedded Spotify player (open.spotify.com iframe) ---
        // A source in its own right, and the one that does not depend on the
        // Soloist daemon being reachable: it plays in this tab, so tab-audio
        // capture reaches the analyser directly.
        const embed = $('sp-embed');
        const embedInput = $('sp-embed-url');
        function loadEmbed(ref) {
            if (!embed) return;
            embed.src = SP.embedUrl(ref);
            if (embedInput) embedInput.value = SP.embedRef();
        }
        async function captureEmbed() {
            const sec = document.querySelector('[data-section="player"]');
            if (sec) {
                sec.classList.remove('collapsed');
                sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            if (IS_IOS || IS_MOBILE) {
                if (await A.useMicrophone()) toast('Mic linked — play the player out loud.');
                return;
            }
            const already = A.hasLiveCapture();
            if (await A.useSystemAudio('Spotify player')) {
                toast(already ? 'Using the capture already running. Hit play above.'
                              : 'Listening. Hit play in the player above.');
            } else {
                toast('Confirm THIS tab in the picker and tick “Share tab audio”.', true);
            }
        }
        if (embed) {
            loadEmbed();
            $('btn-embed-capture').addEventListener('click', captureEmbed);
            $('btn-src-embed').addEventListener('click', captureEmbed);
            $('btn-embed-load').addEventListener('click', () => {
                const v = embedInput.value.trim();
                if (!v) { toast('Paste a Spotify playlist, album or track link.', true); return; }
                const uri = SP.setEmbed(v);
                if (!uri) { toast('That does not look like a Spotify link or URI.', true); return; }
                loadEmbed(uri);
                toast('Loaded ' + uri.split(':')[1] + ' into the player.');
            });
            embedInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); $('btn-embed-load').click(); }
            });
            $('btn-embed-reset').addEventListener('click', () => {
                try { localStorage.removeItem('mf.spotify.embed'); } catch (err) {}
                loadEmbed();
                toast('Player reset to the default playlist.');
            });
        }

        bindSwitch('sw-albumcolor', true, on => { state.albumColour = on; });

        // Quiet connection chatter goes to the hint line, not to toasts.
        SP.on('status', msg => {
            const hint = $('sp-ws-hint');
            if (hint && msg) hint.textContent = msg;
        });
        SP.on('error', msg => { if (msg) toast(msg, true); });
        SP.on('auth', user => renderSpotifySession(user));
        SP.on('track', track => onTrackChanged(track));
        // Keep compat with old 'player-ready' if a future shim emits it
        SP.on('player-ready', async () => {
            toast('Soloist is ready — pick it in the Spotify app to pair.');
            const b = $('btn-sp-connect');
            if (b) { b.classList.add('active'); b.textContent = 'Soloist active'; }
        });
        // New: wire ws-open for a success toast
        SP.on('ws-open', endpoint => {
            toast('Soloist WebSocket connected: ' + endpoint);
        });
    }

    function renderSpotifySession(user) {
        const loggedIn = !!user;
        const connected = SP.isConnected();
        // Show session when Soloist is paired; keep setup visible until then
        $('sp-setup').hidden = loggedIn;
        $('sp-session').hidden = !loggedIn;
        $('sp-drm-note').hidden = !loggedIn;

        clearInterval(spotifyPollTimer);
        if (!loggedIn) {
            if (connected) {
                $('sp-setup').hidden = false;
                const hint = $('sp-ws-hint');
                if (hint) hint.textContent = 'Connected to Soloist — pair via Spotify app → Connect → ' + (SP.state.deviceName || 'MusicFluid');
            }
            return;
        }

        $('sp-status-text').textContent = (user.display_name || user.id) +
            (user.product === 'premium' ? ' · Premium' : ' · Free') +
            (SP.state.isActive ? ' · Active' : ' · Idle');
        // Soloist always needs Premium, but allow button regardless — it just activates.
        const connBtn = $('btn-sp-connect');
        if (connBtn) {
            connBtn.disabled = false;
            connBtn.textContent = SP.state.isActive ? 'Soloist active' : 'Activate Soloist';
            connBtn.classList.toggle('active', !!SP.state.isActive);
        }

        SP.refreshRemoteState();
        spotifyPollTimer = setInterval(() => SP.refreshRemoteState(), 4000);
    }

    function onTrackChanged(track) {
        $('spotify-now').classList.add('visible');
        $('np-title').textContent = track.name;
        $('np-artist').textContent = track.artists;

        const img = $('np-art');
        if (track.art) {
            img.onload = function () {
                V.setArt(img);
                if (state.albumColour && P.fromImage(img)) {
                    if ($('select-palette').value === 'album') P.set('album');
                }
            };
            img.src = track.art;
        }
        toast('♪ ' + track.name + ' — ' + track.artists);
    }

    function fmtTime(ms) {
        const s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    let spTick = 0;
    function updateSpotifyProgress() {
        if (!SP.isLoggedIn() || !SP.state.durationMs) return;
        if ((spTick++ % 6) !== 0) return;
        const pos = SP.livePosition();
        $('np-progress-fill').style.width = (pos / SP.state.durationMs * 100) + '%';
        $('btn-play').innerHTML = SP.state.playing ? '&#10074;&#10074;' : '&#9654;';
        $('np-artist').title = fmtTime(pos) + ' / ' + fmtTime(SP.state.durationMs);
    }

    /* -------------------------------- VR ----------------------------------- */

    function setupXR() {
        XR.init({
            // The engines already drew this frame; hand the XR module whichever
            // canvas the active mode painted into.
            canvasFor: activeCanvas,

            // Controller rays land as ordinary client coordinates, so every
            // existing pointer effect works untouched.
            pointerMove: pointerMove,
            press: (slot, cx, cy) => fireEvent(slot, slot ? state.clickRight : state.clickLeft, cx, cy),
            setPointerDown: (down, repel) => { pointer.down = down; pointer.repel = !!repel; },
            setPointerActive: on => { pointer.active = on; if (!on) pointer.down = false; },

            ui: () => ({
                title: SP.state.track ? SP.state.track.name : 'MusicFluid',
                artist: SP.state.track ? SP.state.track.artists : (SP.isConnected() ? 'nothing playing' : 'Soloist not connected'),
                progress: SP.state.durationMs ? SP.livePosition() / SP.state.durationMs : 0,
                playing: SP.state.playing,
                mode: currentMode() ? currentMode().name : '',
                source: A.sourceLabel() || 'no audio source'
            }),

            act: id => {
                if (id === 'play') SP.transport.toggle();
                else if (id === 'next') SP.transport.next();
                else if (id === 'prev') SP.transport.previous();
                else if (id === 'mode-next') stepMode(1);
                else if (id === 'mode-prev') stepMode(-1);
                else if (id === 'mode-rand') randomMode();
                else if (id === 'exit') XR.stop();
                XR.markDirty();
            },

            onChange: active => {
                const b = $('btn-vr');
                if (b) b.textContent = active ? 'Exit VR' : 'Enter VR';
                if (!active) toast('Left VR.');
            }
        });

        const btn = $('btn-vr');
        if (!btn) return;
        XR.available().then(ok => {
            if (!ok) return;   // stays hidden on machines with no headset
            btn.hidden = false;
            btn.addEventListener('click', async () => {
                if (XR.isActive()) { XR.stop(); return; }
                try {
                    await XR.start();
                    toast('In VR: trigger on the screen paints, aim at the panel for controls.');
                } catch (err) {
                    toast('Could not start VR: ' + String(err.message || err), true);
                }
            });
        });
    }

    /* ------------------------------ boot ---------------------------------- */

    async function boot() {
        buildRegistry();

        fluidAvailable = F.init(fluidCanvas);
        fractalAvailable = FR.init(fractalCanvas);
        V.init(canvas2d);

        if (!fluidAvailable && !fractalAvailable) $('fallback').style.display = 'block';

        setupUI();
        setupXR();

        const savedPalette = localStorage.getItem('mf.palette');
        if (savedPalette) { P.set(savedPalette); $('select-palette').value = savedPalette; }

        const savedModeId = localStorage.getItem('mf.mode');
        let startIndex = MODES.findIndex(m => m.id === savedModeId);
        if (startIndex < 0) startIndex = 0;
        applyMode(startIndex, false);

        const savedPanel = localStorage.getItem('mf.panel');
        if (savedPanel === null) {
            // On a phone the panel covers most of the screen, so first-time
            // visitors should see the visualizer, not the controls.
            setPanel(!IS_MOBILE);
            if (IS_MOBILE) setTimeout(() => toast('Tap the handle on the left edge for controls.'), 900);
        } else {
            setPanel(savedPanel !== '0');
        }

        const onViewportChange = () => { F.resize(); V.resize(); FR.resize(); };
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 250));
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', onViewportChange);
        }

        // Soloist has no OAuth redirect — handleRedirect is a compat no-op.
        await SP.handleRedirect();
        // If the daemon was already paired, show the session; otherwise keep setup.
        if (SP.isLoggedIn()) {
            const me = await SP.loadProfile();
            if (me) renderSpotifySession(me);
        } else if (SP.isConnected() && SP.state.user) {
            renderSpotifySession(SP.state.user);
        } else {
            // Check Railway daemon status in the background and hint the user.
            fetch('/soloist/status').then(r => r.json()).then(j => {
                const hint = $('sp-ws-hint');
                if (!hint) return;
                if (j.enabled && j.running) {
                    hint.textContent = 'Railway Soloist running (device: ' + (j.deviceName || 'MusicFluid') + ') — hit Connect.';
                } else if (!j.enabled) {
                    hint.textContent = 'Soloist daemon not enabled — set SOLOIST_API_KEY in Railway Variables to run it on the server. Local use still works via 127.0.0.1:9090.';
                } else if (j.enabled && !j.running) {
                    hint.textContent = 'Soloist daemon enabled but not running (exit ' + (j.exitCode ?? '?') + ') — check /soloist/status';
                }
            }).catch(() => {});
        }

        XR.raf(loop);
    }

    boot();
})();
