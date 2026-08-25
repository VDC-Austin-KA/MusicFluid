/* ==========================================================================
   app.js — mode registry, render loop and all UI wiring.
   ========================================================================== */

(function () {
    'use strict';

    const A = window.AudioEngine;
    const F = window.FluidEngine;
    const P = window.Palette;
    const V = window.Viz2D;
    const SP = window.SpotifyClient;

    const $ = id => document.getElementById(id);

    const fluidCanvas = $('fluid-canvas');
    const canvas2d = $('viz2d');

    /* --------------------------- platform -------------------------------- */

    // iPadOS 13+ reports itself as a Mac, so the touch-point check is needed
    // on top of the user-agent test.
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
        (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent) ||
        (IS_TOUCH && Math.min(screen.width, screen.height) < 900);

    // Published globally so the other modules can branch without re-sniffing.
    window.MF_IOS = IS_IOS;
    window.MF_MOBILE = IS_MOBILE;
    window.MF_TOUCH = IS_TOUCH;

    if (IS_IOS) document.body.classList.add('is-ios');
    if (IS_MOBILE) document.body.classList.add('is-mobile');

    /* ------------------------- mode registry ----------------------------- */

    const MODES = [];
    let fluidAvailable = false;

    function buildRegistry() {
        window.FluidModes.list.forEach(m => MODES.push(Object.assign({ engine: 'fluid' }, m)));
        window.Viz2DModes.list.forEach(m => MODES.push(Object.assign({ engine: '2d' }, m)));
    }

    const state = {
        modeIndex: 0,
        reactivity: 1.0,
        cycle: false,
        cycleSeconds: 30,
        lastCycleAt: 0,
        autoHide: false,
        modeFlash: true,
        albumColour: true,
        quality: 1.0,
        lastPointerAt: Date.now(),
        lastSplatAt: Date.now(),
        panelOpen: true
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

    function applyMode(index, announce) {
        if (index < 0) index = MODES.length - 1;
        if (index >= MODES.length) index = 0;

        const mode = MODES[index];
        if (mode.engine === 'fluid' && !fluidAvailable) {
            // Skip fluid modes entirely when WebGL2 is not usable.
            const dir = index > state.modeIndex ? 1 : -1;
            let probe = index;
            for (let i = 0; i < MODES.length; i++) {
                probe = (probe + dir + MODES.length) % MODES.length;
                if (MODES[probe].engine === '2d') break;
            }
            index = probe;
        }

        state.modeIndex = index;
        const m = MODES[index];
        $('select-mode').value = String(index);
        state.lastCycleAt = Date.now();

        if (m.engine === 'fluid') {
            fluidCanvas.classList.remove('inactive');
            canvas2d.classList.add('inactive');
            // The canvas was display:none and reported zero size, so re-measure
            // now that it is laid out again.
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
            $('physics-note').textContent = 'Live — this mode uses the fluid solver.';
        } else {
            canvas2d.classList.remove('inactive');
            fluidCanvas.classList.add('inactive');
            V.resize();
            V.setMode(m);
            $('physics-note').textContent = 'Inactive — the current mode is a 2D mode.';
        }

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
        let i;
        do { i = Math.floor(Math.random() * MODES.length); }
        while (i === state.modeIndex || (MODES[i].engine === 'fluid' && !fluidAvailable));
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
        $('mode-count').textContent = MODES.length + ' total';
    }

    /* --------------------------- render loop ------------------------------ */

    let lastTime = performance.now();
    let frameCount = 0, fpsWindowStart = performance.now();

    function loop(now) {
        const dt = Math.min((now - lastTime) / 1000, 0.033);
        lastTime = now;

        const m = A.update(now);
        const mode = currentMode();
        const k = state.reactivity;

        if (mode.engine === 'fluid' && fluidAvailable) {
            const ctx = {
                t: now, dt: dt, m: m, k: k,
                idle: (Date.now() - state.lastSplatAt) > 3500
            };
            mode.drive(ctx);

            // Global audio modulation shared by every fluid mode.
            let vort = F.config.CURL + m.treble * 25 * k;
            let diss = Math.max(0.90, F.config.DENSITY_DISSIPATION - m.mid * 0.03 * k);
            if (mode.id !== 'supernova' && m.beat) {
                const a = Math.random() * Math.PI * 2;
                const force = (18 + m.bass * 26) * k;
                F.splat(0.5 + Math.cos(a) * 0.05, 0.5 + Math.sin(a) * 0.05,
                        Math.cos(a) * force, Math.sin(a) * force,
                        P.hdr(Math.random(), 5.0));
            }
            F.solve(dt, vort, diss);
        } else if (mode.engine === '2d') {
            V.frame(now, m, k);
        }

        if (pendingSnapshot) { pendingSnapshot = false; captureFrame(); }

        updateMeters(m);
        updateSpotifyProgress();
        handleAutoCycle(now);
        handleAutoHide();
        checkPerformance(now);

        requestAnimationFrame(loop);
    }

    function checkPerformance(now) {
        frameCount++;
        if (now - fpsWindowStart < 2500) return;
        const fps = frameCount * 1000 / (now - fpsWindowStart);
        frameCount = 0;
        fpsWindowStart = now;
        if (fps < 40 && F.config.SIM_RESOLUTION > 128 && currentMode().engine === 'fluid') {
            F.config.SIM_RESOLUTION = 128;
            F.resize();
            F.clear();
            toast('Dropped simulation resolution to keep the framerate up.');
        }
    }

    let meterTick = 0;
    function updateMeters(m) {
        if ((meterTick++ % 3) !== 0) return;
        document.querySelectorAll('#meters i').forEach(el => {
            const v = m[el.dataset.meter] || 0;
            el.style.height = Math.min(100, v * 100) + '%';
        });
        if (m.bpm) {
            $('bpm-readout').innerHTML = 'Detected tempo: <strong>' + m.bpm + ' BPM</strong>' +
                (m.synthetic && !m.live ? ' (simulated)' : '');
        }
    }

    function handleAutoCycle(now) {
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

    /* ---------------------------- pointer -------------------------------- */

    let lastX = 0, lastY = 0, havePointer = false;

    function pointerMove(x, y) {
        state.lastPointerAt = Date.now();
        if (!havePointer) { lastX = x; lastY = y; havePointer = true; return; }
        const mode = currentMode();
        if (mode.engine !== 'fluid' || !mode.interactive || !fluidAvailable) {
            lastX = x; lastY = y;
            return;
        }
        const dx = (x - lastX) * 5.0;
        const dy = (lastY - y) * 5.0;
        lastX = x; lastY = y;
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;
        const cw = fluidCanvas.clientWidth || window.innerWidth;
        const ch = fluidCanvas.clientHeight || window.innerHeight;
        F.splat(x / cw, 1 - y / ch, dx, dy, P.hdr(P.flow(0)));
        state.lastSplatAt = Date.now();
    }

    window.addEventListener('mousemove', e => pointerMove(e.clientX, e.clientY));
    window.addEventListener('touchmove', e => {
        if (e.touches.length) pointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    // A lifted finger leaves a stale origin, which would fire one huge splat on
    // the next touch; forget it so the next gesture starts clean.
    window.addEventListener('touchend', () => { havePointer = false; }, { passive: true });

    /* --------------------------- gestures --------------------------------- */

    // Swipe on the visualizer: horizontal slides the panel, vertical changes
    // mode. The panel itself only accepts a horizontal close-swipe, so its
    // vertical scrolling is untouched.
    function setupGestures() {
        let sx = 0, sy = 0, st = 0, tracking = false, fromPanel = false;

        const panel = $('panel');

        window.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) { tracking = false; return; }
            const target = e.target;
            if (target.closest('input, select, button, #search-results')) { tracking = false; return; }
            fromPanel = !!target.closest('#panel');
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
            const dx = touch.clientX - sx;
            const dy = touch.clientY - sy;
            const dt = Date.now() - st;
            if (dt > 800) return;

            const adx = Math.abs(dx), ady = Math.abs(dy);

            if (adx > 70 && adx > ady * 1.6) {
                if (dx < 0 && state.panelOpen) setPanel(false);
                else if (dx > 0 && !state.panelOpen) setPanel(true);
                return;
            }
            // Vertical swipes only count on the canvas, never inside the panel.
            if (!fromPanel && ady > 90 && ady > adx * 1.6) {
                stepMode(dy < 0 ? 1 : -1);
            }
        }, { passive: true });

        // Safari-only pinch events; without this the whole page zooms.
        ['gesturestart', 'gesturechange', 'gestureend'].forEach(evt => {
            document.addEventListener(evt, e => e.preventDefault());
        });

        // Block the rubber-band scroll everywhere except inside the panel.
        document.addEventListener('touchmove', e => {
            if (!e.target.closest('#panel') && e.cancelable) e.preventDefault();
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
        return { set: v => { on = v; el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); } };
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
        return el;
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
        $('btn-sys').addEventListener('click', async () => {
            const ok = await A.useSystemAudio();
            if (ok) toast('System audio linked. Play something and it will react.');
        });
        $('btn-mic').addEventListener('click', async () => {
            const ok = await A.useMicrophone();
            if (ok) toast('Microphone linked.');
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
            if (kind === 'connected') {
                dot.className = 'dot live';
                text.textContent = 'Listening to ' + detail;
            } else if (kind === 'silent') {
                dot.className = 'dot warn';
                text.textContent = 'Connected but silent — ' + detail;
            } else if (kind === 'audible') {
                dot.className = 'dot live';
                text.textContent = 'Listening to ' + detail;
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

        // --- reactivity ---
        bindSlider('slider-gain', 'val-gain', v => { A.config.gain = v; }, v => v.toFixed(1));
        bindSlider('slider-sens', 'val-sens', v => { A.config.sensitivity = v; });
        bindSlider('slider-react', 'val-react', v => { state.reactivity = v; }, v => v.toFixed(1));
        bindSlider('slider-smooth', 'val-smooth', v => A.setSmoothing(v));

        // --- fluid physics ---
        bindSlider('slider-diss', 'val-diss', v => { F.config.DENSITY_DISSIPATION = v; }, v => v.toFixed(3));
        bindSlider('slider-vort', 'val-vort', v => { F.config.CURL = v; }, v => String(Math.round(v)));
        bindSlider('slider-visc', 'val-visc', v => { F.config.VISCOSITY = v; });
        bindSlider('slider-radius', 'val-radius', v => { F.config.SPLAT_RADIUS = v; });
        bindSlider('slider-bloom', 'val-bloom', v => { F.config.BLOOM = v; }, v => v.toFixed(1));
        $('btn-clear').addEventListener('click', () => { F.clear(); toast('Canvas cleared.'); });

        // --- cycling / display ---
        bindSwitch('sw-cycle', false, on => {
            state.cycle = on;
            state.lastCycleAt = Date.now();
            toast(on ? 'Auto-cycling modes every ' + state.cycleSeconds + 's.' : 'Auto-cycle off.');
        });
        bindSlider('slider-cycle', 'val-cycle', v => { state.cycleSeconds = v; }, v => Math.round(v) + 's');
        bindSwitch('sw-autohide', false, on => { state.autoHide = on; });
        bindSwitch('sw-modeflash', true, on => { state.modeFlash = on; });
        bindSwitch('sw-synthetic', true, on => {
            A.setSynthetic(on);
            toast(on ? 'Simulated beat will fill in when no sound is detected.'
                     : 'Simulated beat disabled.');
        });
        A.setSynthetic(true);

        bindSlider('slider-quality', 'val-quality', v => {
            state.quality = v / 100;
            F.config.DYE_RESOLUTION = Math.round(1024 * state.quality);
            F.config.SIM_RESOLUTION = Math.round(256 * state.quality);
            F.resize();
            F.clear();
        }, v => Math.round(v) + '%');

        $('btn-fullscreen').addEventListener('click', toggleFullscreen);
        $('btn-snapshot').addEventListener('click', saveFrame);

        applyPlatformUI();
        setupSpotifyUI();
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
            const mic = $('btn-mic');
            mic.classList.add('primary');
            mic.textContent = 'Mic';

            $('btn-sp-connect').disabled = true;
            $('btn-sp-connect').textContent = 'Play in the Spotify app';
            $('btn-sp-connect').title = 'The Web Playback SDK does not run on iOS; these controls drive Spotify Connect';
        }

        if (IS_MOBILE) {
            // Smaller buffers by default; a phone can still be raised manually.
            $('slider-quality').value = 70;
            $('slider-quality').dispatchEvent(new Event('input'));
        }

        if (IS_TOUCH) setupGestures();
        setupAudioUnlock();
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

    // The WebGL context has no preserved drawing buffer, so a snapshot is only
    // valid in the same tick as the draw. Queue it and let the loop take it.
    let pendingSnapshot = false;
    function saveFrame() { pendingSnapshot = true; }

    function captureFrame() {
        const src = currentMode().engine === 'fluid' ? fluidCanvas : canvas2d;
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

    /* ---------------------------- keyboard -------------------------------- */

    window.addEventListener('keydown', e => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

        switch (e.key) {
            case 'h': case 'H': togglePanel(); break;
            case 'f': case 'F': toggleFullscreen(); break;
            case 'r': case 'R': randomMode(); break;
            case 'c': case 'C': F.clear(); break;
            case 'ArrowRight': stepMode(1); e.preventDefault(); break;
            case 'ArrowLeft': stepMode(-1); e.preventDefault(); break;
            case ' ':
                if (SP.isLoggedIn()) { SP.transport.toggle(); e.preventDefault(); }
                break;
        }
    });

    /* ----------------------------- Spotify -------------------------------- */

    let spotifyPollTimer = null;

    function setupSpotifyUI() {
        $('sp-redirect').value = SP.redirectUri();
        $('sp-client-id').value = SP.clientId();

        $('btn-copy-redirect').addEventListener('click', () => {
            const input = $('sp-redirect');
            input.select();
            navigator.clipboard.writeText(input.value)
                .then(() => toast('Redirect URI copied — paste it into your Spotify app settings.'))
                .catch(() => toast('Copy failed — select the text and copy manually.', true));
        });

        $('btn-save-client').addEventListener('click', () => {
            const id = $('sp-client-id').value.trim();
            if (!/^[0-9a-f]{32}$/i.test(id)) {
                toast('That does not look like a Spotify Client ID (32 hex characters).', true);
                return;
            }
            SP.setClientId(id);
            toast('Client ID saved. Now hit "Log in with Spotify".');
        });

        $('btn-sp-login').addEventListener('click', () => {
            if (!SP.clientId()) {
                const typed = $('sp-client-id').value.trim();
                if (typed) SP.setClientId(typed);
            }
            SP.login();
        });

        $('btn-sp-logout').addEventListener('click', () => {
            SP.logout();
            toast('Logged out of Spotify.');
        });

        $('btn-play').addEventListener('click', () => SP.transport.toggle());
        $('btn-next').addEventListener('click', () => SP.transport.next());
        $('btn-prev').addEventListener('click', () => SP.transport.previous());

        $('np-progress').addEventListener('click', e => {
            if (!SP.state.durationMs) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            SP.transport.seek(ratio * SP.state.durationMs);
        });

        $('btn-sp-connect').addEventListener('click', async () => {
            try {
                toast('Starting the in-browser Spotify player…');
                await SP.createPlayer();
            } catch (err) {
                toast(String(err.message || err), true);
            }
        });

        const doSearch = async () => {
            const q = $('sp-search').value;
            const box = $('search-results');
            box.innerHTML = '';
            if (!q.trim()) return;
            const results = await SP.search(q);
            if (!results.length) { toast('No results.'); return; }
            results.forEach(r => {
                const el = document.createElement('div');
                el.className = 'result';
                el.innerHTML =
                    '<img src="' + (r.art || '') + '" alt="">' +
                    '<div class="r-meta"><div class="r-title"></div><div class="r-sub"></div></div>';
                el.querySelector('.r-title').textContent = r.name;
                el.querySelector('.r-sub').textContent = r.artists;
                el.addEventListener('click', async () => {
                    await SP.playUri(r.uri);
                    box.innerHTML = '';
                    $('sp-search').value = '';
                });
                box.appendChild(el);
            });
        };
        $('btn-sp-search').addEventListener('click', doSearch);
        $('sp-search').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        });

        bindSwitch('sw-albumcolor', true, on => { state.albumColour = on; });

        SP.on('error', msg => toast(msg, true));
        SP.on('auth', user => renderSpotifySession(user));
        SP.on('track', track => onTrackChanged(track));
        SP.on('player-ready', async deviceId => {
            await SP.transferTo(deviceId, false);
            toast('Playing in this browser tab. Use "System" capture and share this tab\'s audio to make it react.');
            $('btn-sp-connect').classList.add('active');
            $('btn-sp-connect').textContent = 'Playing in this tab';
        });
    }

    function renderSpotifySession(user) {
        const loggedIn = !!user;
        $('sp-setup').hidden = loggedIn;
        $('sp-session').hidden = !loggedIn;
        $('sp-drm-note').hidden = !loggedIn;

        clearInterval(spotifyPollTimer);
        if (!loggedIn) return;

        $('sp-status-text').textContent = (user.display_name || user.id) +
            (user.product === 'premium' ? ' · Premium' : ' · Free');
        if (user.product !== 'premium') {
            $('btn-sp-connect').disabled = true;
            $('btn-sp-connect').textContent = 'In-tab playback needs Premium';
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
                    // Only switch the active palette if the user asked for it.
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

    /* ------------------------------ boot ---------------------------------- */

    async function boot() {
        buildRegistry();

        fluidAvailable = F.init(fluidCanvas);
        if (!fluidAvailable) $('fallback').style.display = 'block';
        V.init(canvas2d);

        setupUI();

        // Restore preferences.
        const savedPalette = localStorage.getItem('mf.palette');
        if (savedPalette) { P.set(savedPalette); $('select-palette').value = savedPalette; }

        const savedModeId = localStorage.getItem('mf.mode');
        let startIndex = MODES.findIndex(m => m.id === savedModeId);
        if (startIndex < 0) startIndex = fluidAvailable ? 0 : MODES.findIndex(m => m.engine === '2d');
        applyMode(startIndex, false);

        const savedPanel = localStorage.getItem('mf.panel');
        if (savedPanel === null) {
            // On a phone the panel covers most of the screen, so first-time
            // visitors should see the visualizer, not the controls.
            setPanel(!IS_MOBILE);
            if (IS_MOBILE) {
                setTimeout(() => toast('Tap the handle on the left edge for controls.'), 900);
            }
        } else {
            setPanel(savedPanel !== '0');
        }

        const onViewportChange = () => { F.resize(); V.resize(); };
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 250));
        // iOS resizes the visual viewport as the toolbars collapse without
        // always firing a window resize.
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', onViewportChange);
        }

        // Spotify: finish an in-flight login, or restore an existing session.
        const wasRedirect = await SP.handleRedirect();
        if (!wasRedirect && SP.isLoggedIn()) {
            const me = await SP.loadProfile();
            if (me) renderSpotifySession(me);
        }
        if (wasRedirect && SP.isLoggedIn()) {
            toast('Spotify connected. Tip: hit "System" and share your system audio so the visuals track the music.');
        }

        requestAnimationFrame(loop);
    }

    boot();
})();
