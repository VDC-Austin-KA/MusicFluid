/* ==========================================================================
   soloist-dashboard.js — the standalone Soloist control window (soloist.html).

   Reuses window.SpotifyClient (js/spotify.js): opens its own WebSocket to the
   daemon using the endpoint saved in localStorage by the main app, so this
   page works whether it is popped out from MusicFluid or opened directly.
   ========================================================================== */

(function () {
    'use strict';

    const SP = window.SpotifyClient;
    const $ = id => document.getElementById(id);

    const el = {
        dot: $('conn-dot'), device: $('device'), msg: $('msg'),
        activate: $('btn-activate'), reconnect: $('btn-reconnect'),
        art: $('art'), artPh: $('art-ph'),
        title: $('title'), artist: $('artist'), album: $('album'), context: $('context'),
        seek: $('seek'), tPos: $('t-pos'), tDur: $('t-dur'),
        play: $('btn-play'), prev: $('btn-prev'), next: $('btn-next'),
        shuffle: $('btn-shuffle'), repeat: $('btn-repeat'),
        vol: $('vol'), volVal: $('vol-val'),
        queue: $('queue'), uri: $('uri'),
        playUri: $('btn-play-uri'), queueUri: $('btn-queue-uri')
    };

    // ?ws=… lets the opener pin an endpoint without touching localStorage.
    try {
        const q = new URLSearchParams(location.search).get('ws');
        if (q) SP.setWsUrl(q);
    } catch (e) {}

    function fmtTime(ms) {
        const s = Math.max(0, Math.floor((ms || 0) / 1000));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function say(text, isError) {
        el.msg.textContent = text;
        el.msg.classList.toggle('err', !!isError);
    }

    /* ------------------------------ rendering ----------------------------- */

    let dragging = false;

    function renderTrack(track) {
        if (!track) {
            el.title.textContent = 'Nothing playing';
            el.artist.textContent = el.album.textContent = '';
            el.art.style.display = 'none';
            el.artPh.style.display = '';
            return;
        }
        el.title.textContent = track.name;
        el.artist.textContent = track.artists || '';
        el.album.textContent = track.album || '';
        document.title = track.name + ' — ' + (track.artists || 'Soloist');
        if (track.art) {
            el.art.onerror = function () { el.art.style.display = 'none'; el.artPh.style.display = ''; };
            el.art.src = track.art;
            el.art.style.display = 'block';
            el.artPh.style.display = 'none';
        } else {
            el.art.style.display = 'none';
            el.artPh.style.display = '';
        }
    }

    function renderState() {
        const s = SP.state;
        const live = SP.isConnected();

        el.dot.className = 'dot' + (live && s.loggedIn ? ' live' : live ? ' warn' : '');
        el.device.textContent = !live ? 'not connected'
            : !s.loggedIn ? 'no Spotify session — pair from the Spotify app'
            : (s.deviceName || 'Soloist') + (s.isActive ? ' · active' : ' · idle');

        el.activate.textContent = s.isActive ? 'Deactivate' : 'Activate';
        el.activate.classList.toggle('on', !!s.isActive);

        el.play.innerHTML = s.playing ? '&#10074;&#10074;' : '&#9654;';
        el.shuffle.classList.toggle('on', !!s.shuffle);
        el.repeat.classList.toggle('on', s.repeat !== 'off');
        el.repeat.textContent = s.repeat === 'track' ? '🔂' : '🔁';
        el.repeat.title = 'Repeat: ' + s.repeat;

        if (document.activeElement !== el.vol) {
            el.vol.value = Math.round(s.volume);
            el.volVal.textContent = Math.round(s.volume);
            el.vol.style.setProperty('--pct', Math.round(s.volume));
        }

        const controlsLive = live && s.loggedIn;
        [el.play, el.prev, el.next, el.shuffle, el.repeat, el.playUri, el.queueUri].forEach(b => { b.disabled = !controlsLive; });
        el.seek.disabled = !controlsLive || !s.durationMs;
    }

    function renderQueue(q) {
        const rows = (q && q.upcoming) || [];
        if (!rows.length) {
            el.queue.innerHTML = '<div class="empty">Queue is empty — start something from the Spotify app or paste a URI below.</div>';
            return;
        }
        el.queue.innerHTML = '';
        rows.forEach(t => {
            const row = document.createElement('div');
            row.className = 'qrow';
            const img = document.createElement('img');
            if (t.art) img.src = t.art;
            const txt = document.createElement('div');
            txt.className = 'qt';
            const n = document.createElement('div');
            n.className = 'qn';
            n.textContent = t.name;
            const a = document.createElement('div');
            a.className = 'qa';
            a.textContent = t.artists || '';
            txt.appendChild(n); txt.appendChild(a);
            row.appendChild(img); row.appendChild(txt);
            el.queue.appendChild(row);
        });
    }

    function tick() {
        const s = SP.state;
        if (s.durationMs) {
            const pos = SP.livePosition();
            if (!dragging) el.seek.value = Math.round(pos / s.durationMs * 1000);
            el.tPos.textContent = fmtTime(dragging ? el.seek.value / 1000 * s.durationMs : pos);
            el.tDur.textContent = fmtTime(s.durationMs);
        } else {
            if (!dragging) el.seek.value = 0;
            el.tPos.textContent = el.tDur.textContent = '0:00';
        }
        el.seek.style.setProperty('--pct', el.seek.value / 10);
    }

    /* ------------------------------- events ------------------------------- */

    SP.on('auth', () => renderState());
    SP.on('state', () => renderState());
    SP.on('track', t => { renderTrack(t); renderState(); });
    SP.on('queue', q => renderQueue(q));
    SP.on('options', () => renderState());
    SP.on('context', c => { el.context.textContent = c && c.name ? 'from ' + c.name : ''; });
    SP.on('ws-open', ep => { say('Connected to ' + ep); renderState(); });
    SP.on('error', m => { if (m) say(m, true); });
    SP.on('status', m => { if (m) say(m); });

    el.play.addEventListener('click', () => SP.transport.toggle());
    el.next.addEventListener('click', () => SP.transport.next());
    el.prev.addEventListener('click', () => SP.transport.previous());
    el.shuffle.addEventListener('click', () => SP.transport.setShuffle(!SP.state.shuffle));
    el.repeat.addEventListener('click', () => say('Repeat: ' + SP.transport.cycleRepeat()));

    el.activate.addEventListener('click', () => {
        if (SP.state.isActive) SP.transport.deactivate();
        else SP.transport.activate();
    });
    el.reconnect.addEventListener('click', () => { SP.disconnect(); setTimeout(() => SP.connect(), 150); });

    // Native range does the dragging; we only suppress live updates mid-drag.
    ['pointerdown', 'keydown'].forEach(ev => el.seek.addEventListener(ev, () => { dragging = true; }));
    el.seek.addEventListener('input', tick);
    el.seek.addEventListener('change', () => {
        dragging = false;
        if (SP.state.durationMs) SP.transport.seek(el.seek.value / 1000 * SP.state.durationMs);
    });

    el.vol.addEventListener('input', () => {
        el.volVal.textContent = el.vol.value;
        el.vol.style.setProperty('--pct', el.vol.value);
        SP.transport.setVolume(el.vol.value / 100);
    });

    function submitUri(queueIt) {
        const v = el.uri.value.trim();
        if (!v) { say('Paste a Spotify URI first (right-click a track → Share → Copy Spotify URI).', true); return; }
        if (queueIt) { SP.addToQueue(v); say('Queued ' + v); }
        else { SP.playUri(v); say('Playing ' + v); }
        el.uri.value = '';
    }
    el.playUri.addEventListener('click', () => submitUri(false));
    el.queueUri.addEventListener('click', () => submitUri(true));
    el.uri.addEventListener('keydown', e => { if (e.key === 'Enter') submitUri(e.shiftKey); });

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT') return;
        if (e.code === 'Space') { e.preventDefault(); SP.transport.toggle(); }
        else if (e.key === 'ArrowRight' && e.shiftKey) SP.transport.next();
        else if (e.key === 'ArrowLeft' && e.shiftKey) SP.transport.previous();
    });

    /* -------------------------------- boot -------------------------------- */

    say('Connecting to ' + SP.wsEndpoint() + ' …');
    renderTrack(null);
    renderState();
    SP.connect();
    setInterval(tick, 250);
    // Push-based protocol; this is only a slow resync in case a frame was missed.
    setInterval(() => { if (SP.isConnected()) SP.refreshRemoteState(); }, 30000);

    // Handy for debugging from the popup console.
    window.SP = SP;
})();
