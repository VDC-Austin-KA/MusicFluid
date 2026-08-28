/* ==========================================================================
   SpotifyClient — Spotify Soloist bridge (replaces the PKCE Client ID flow).

   Spotify Soloist is a headless Linux daemon (arm64/arm32/x86_64) that uses
   a Soloist API key at startup and appears as a Spotify Connect device.
   MusicFluid talks to the local daemon over its optional WebSocket API
   (--ws 127.0.0.1:9090), not to accounts.spotify.com or api.spotify.com.

   Key points from https://developer.spotify.com/documentation/soloist:
   - Generate the key at https://developer.spotify.com/dashboard/soloist
     (requires Premium). Do not share or embed real keys in source.
   - Launch: soloist --device-name "MusicFluid" --api-key "$SOLOIST_API_KEY" --ws 127.0.0.1:9090
   - Pair once: open the Spotify app on the same LAN → device picker → select
     "MusicFluid" → playback is owned by the daemon and stored in its data dir.
   - WebSocket has no auth/TLS/Origin checks by design (local surface only).
     Enable it only on loopback or a trusted LAN address.
   - Downloads: https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates
     Builds expire after 90 days (exit code 10) — replace the binary.
   - WebSocket reference: https://developer.spotify.com/documentation/soloist/reference/websocket-api
   - Basic integration: https://developer.spotify.com/documentation/soloist/howtos/basic-integration

   This module keeps the window.SpotifyClient name so the rest of the app
   (app.js) needs minimal changes. Legacy Client-ID / PKCE / token code is
   intentionally removed — see git history for the previous OAuth implementation.
   ========================================================================== */

window.SpotifyClient = (function () {
    'use strict';

    // ----------------------------------------------------------------------
    // Storage keys — new names; old mf.sp.clientId is migrated on boot.
    // ----------------------------------------------------------------------
    const LS = {
        soloistKey: 'mf.soloist.key',
        wsUrl: 'mf.soloist.ws',
        // legacy — we clear/migrate it
        legacyClientId: 'mf.sp.clientId',
        legacyAccess: 'mf.sp.access',
        legacyRefresh: 'mf.sp.refresh',
        legacyExpires: 'mf.sp.expires',
        legacyVerifier: 'mf.sp.verifier'
    };

    // Railway proxy is wss://<host>/soloist/ws; local dev is ws://127.0.0.1:9090
    function defaultWsForHost() {
        try {
            const h = location.hostname || '';
            // On Railway or any non-localhost host, the daemon is behind the Node proxy.
            if (h && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') {
                const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
                return proto + location.host + '/soloist/ws';
            }
        } catch (e) {}
        return '127.0.0.1:9090';
    }
    const DEFAULT_WS = defaultWsForHost();

    // Migrate any legacy Client ID if present (so we don't lose a pasted value
    // the user might want to reference), then point them at Soloist.
    let migratedNote = '';
    try {
        const legacy = localStorage.getItem(LS.legacyClientId);
        if (legacy && !localStorage.getItem(LS.soloistKey)) {
            migratedNote = legacy;
        }
    } catch (e) {}

    const state = {
        soloistKey: (function () {
            try { return localStorage.getItem(LS.soloistKey) || ''; } catch (e) { return ''; }
        })(),
        wsUrl: (function () {
            try {
                const v = localStorage.getItem(LS.wsUrl);
                // Old installs pinned 127.0.0.1:9090; on Railway auto-migrate to proxy path
                if (!v && DEFAULT_WS.indexOf('/soloist/ws') >= 0) return DEFAULT_WS;
                return v || DEFAULT_WS;
            } catch (e) { return DEFAULT_WS; }
        })(),
        ws: null,
        wsConnected: false,
        loggedIn: false,          // Soloist has a stored Connect session
        isActive: false,          // Soloist is the active Connect device
        deviceName: '',
        user: null,               // synthesized from auth_state for UI compat
        premium: null,            // Soloist requires Premium, so true when logged in
        track: null,
        playing: false,
        progressMs: 0,
        durationMs: 0,
        progressStamp: 0,
        positionAnchor: null,     // { position_ms, timestamp_ms, speed }
        volume: 80,
        deviceId: null            // kept for app.js compat (equals deviceName)
    };

    const listeners = {};
    function on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); }
    function emit(evt, data) { (listeners[evt] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }

    // ----------------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------------
    function wsEndpoint() {
        let raw = (state.wsUrl || DEFAULT_WS).trim();
        if (!raw) raw = DEFAULT_WS;
        // Already a full URL (proxy or explicit) — use as-is
        if (raw.indexOf('://') !== -1) return raw;
        // Proxy path like /soloist/ws without host
        if (raw.indexOf('/') === 0) {
            const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
            return proto + location.host + raw;
        }
        // Bare host:port
        return 'ws://' + raw;
    }

    function normalizeWsInput(v) {
        v = (v || '').trim();
        // Keep full proxy URLs and schemes intact
        if (v.indexOf('://') !== -1 || v.indexOf('/') === 0) return v || DEFAULT_WS;
        v = v.replace(/^wss?:\/\//i, '');
        return v || DEFAULT_WS;
    }

    function buildUser() {
        if (!state.loggedIn) return null;
        return {
            id: 'soloist',
            display_name: state.deviceName || 'Soloist',
            product: 'premium'
        };
    }

    function extractTrack(item) {
        if (!item) return null;
        // Defensive: Soloist entity shape has several plausible layouts.
        // Try item.*, item.track.*, and flat fields.
        const t = item.item || item.track || item;
        const uri = t.uri || t.entity_uri || t.id && ('spotify:track:' + t.id) || '';
        const id = t.id || (uri ? uri.split(':').pop() : '');
        const name = t.name || t.title || 'Unknown';
        // artists can be [{name}], ["Name"], or a string
        let artists = '';
        if (Array.isArray(t.artists)) {
            artists = t.artists.map(function (a) { return typeof a === 'string' ? a : (a.name || ''); }).filter(Boolean).join(', ');
        } else if (typeof t.artists === 'string') {
            artists = t.artists;
        } else if (t.artist) {
            artists = typeof t.artist === 'string' ? t.artist : (t.artist.name || '');
        }
        // album art: try every known field
        let art = null;
        const album = t.album || t.cover || null;
        if (album) {
            if (Array.isArray(album.images) && album.images.length) art = album.images[0].url;
            else if (album.image) art = album.image;
            else if (typeof album === 'string') art = album;
        }
        if (!art) {
            if (Array.isArray(t.images) && t.images.length) art = t.images[0].url || t.images[0];
            else if (t.image) art = t.image;
            else if (t.art) art = t.art;
            else if (t.cover_url) art = t.cover_url;
        }
        const duration = t.duration_ms || t.duration || t.length_ms || 0;
        return { id: id, name: name, artists: artists, art: art, uri: uri, duration_ms: duration };
    }

    function setTrack(track) {
        if (!track) { state.track = null; return; }
        const changed = !state.track || state.track.id !== track.id;
        state.track = track;
        if (changed) emit('track', track);
    }

    function updatePositionAnchor(pos) {
        if (!pos) return;
        state.positionAnchor = {
            position_ms: pos.position_ms || 0,
            timestamp_ms: pos.timestamp_ms || Date.now(),
            speed: typeof pos.speed === 'number' ? pos.speed : (state.playing ? 1 : 0)
        };
        state.progressMs = state.positionAnchor.position_ms;
        state.progressStamp = state.positionAnchor.timestamp_ms;
        // duration stays in state.durationMs from playback_state/item
    }

    function livePosition() {
        if (!state.durationMs) return 0;
        if (!state.positionAnchor) return state.progressMs;
        const extra = state.positionAnchor.speed ? (Date.now() - state.positionAnchor.timestamp_ms) * state.positionAnchor.speed : 0;
        return Math.min(state.durationMs, Math.max(0, state.positionAnchor.position_ms + extra));
    }

    // ----------------------------------------------------------------------
    // WebSocket command helpers
    // ----------------------------------------------------------------------
    function wsSend(obj) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            emit('error', 'Not connected to Soloist — hit Connect.');
            return false;
        }
        try { state.ws.send(JSON.stringify(obj)); return true; }
        catch (e) { emit('error', String(e.message || e)); return false; }
    }

    function cmd(name, extra) {
        const msg = { type: 'command', command: name };
        if (extra) for (const k in extra) msg[k] = extra[k];
        return wsSend(msg);
    }

    // ----------------------------------------------------------------------
    // Message handlers
    // ----------------------------------------------------------------------
    function handleAuthState(data) {
        state.loggedIn = !!data.logged_in;
        state.isActive = !!data.is_active;
        state.deviceName = data.device_name || state.deviceName || 'Soloist';
        state.deviceId = state.deviceName;
        state.premium = state.loggedIn ? true : null;
        state.user = buildUser();
        emit('auth', state.user);
        if (!state.loggedIn) {
            emit('error', 'Soloist has no stored session — open the Spotify app on the same network and select "' + state.deviceName + '" to pair.');
        }
    }

    function handlePlaybackState(data) {
        // Full snapshot
        if (typeof data.is_active === 'boolean') state.isActive = data.is_active;
        if (data.device_name) { state.deviceName = data.device_name; state.deviceId = data.device_name; }

        const status = data.status || data.playback_status || '';
        state.playing = status === 'playing';

        // Volume
        if (typeof data.volume === 'number') state.volume = data.volume;

        // Item / track
        const item = data.item || data.track || null;
        if (item) {
            const track = extractTrack(item);
            if (track) {
                setTrack(track);
                state.durationMs = track.duration_ms || data.duration_ms || state.durationMs;
            }
        } else if (data.item === null) {
            // No track
            state.track = null;
        }

        // Position
        const pos = data.position || data.progress || null;
        if (pos) updatePositionAnchor(pos);
        else if (typeof data.position_ms === 'number') {
            state.progressMs = data.position_ms;
            state.progressStamp = Date.now();
        }
        if (typeof data.duration_ms === 'number') state.durationMs = data.duration_ms;

        emit('state', state);
        // Keep polling-style remote state fresh
        if (state.track) emit('track', state.track);
    }

    function handleMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        const t = msg.type;

        switch (t) {
            case 'auth_state':
                handleAuthState(msg);
                break;
            case 'playback_state':
                handlePlaybackState(msg);
                break;
            case 'track_changed':
                if (msg.item) {
                    const tr = extractTrack(msg.item);
                    if (tr) {
                        setTrack(tr);
                        if (tr.duration_ms) state.durationMs = tr.duration_ms;
                    }
                }
                break;
            case 'playback_changed':
                state.playing = msg.status === 'playing' || msg.playing === true;
                emit('state', state);
                break;
            case 'position_sync':
                if (msg.position) updatePositionAnchor(msg.position);
                break;
            case 'volume_changed':
                if (typeof msg.volume === 'number') state.volume = msg.volume;
                break;
            case 'device_changed':
                if (typeof msg.is_active === 'boolean') state.isActive = msg.is_active;
                if (msg.device_name) { state.deviceName = msg.device_name; state.deviceId = msg.device_name; }
                break;
            case 'context_changed':
            case 'options_changed':
            case 'queue_changed':
                // Not surfaced yet, but could be forwarded
                break;
            case 'command_result':
                // Ack — nothing to do; playback changes arrive as events.
                break;
            case 'error':
                emit('error', msg.message || 'Soloist error');
                break;
            default:
                // Unknown frame — ignore.
                break;
        }
    }

    // ----------------------------------------------------------------------
    // Connection lifecycle
    // ----------------------------------------------------------------------
    function connect() {
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
            emit('error', 'Already connecting/connected to Soloist.');
            return;
        }

        const endpoint = wsEndpoint();
        emit('error', ''); // clear

        let ws;
        try {
            ws = new WebSocket(endpoint);
        } catch (e) {
            emit('error', 'Invalid Soloist address: ' + String(e.message || e));
            return;
        }

        state.ws = ws;

        ws.onopen = function () {
            state.wsConnected = true;
            emit('ws-open', endpoint);
            // Query current states — server also pushes auth_state + playback_state on connect.
            try { ws.send(JSON.stringify({ type: 'command', command: 'get_auth_state' })); } catch (e) {}
            try { ws.send(JSON.stringify({ type: 'command', command: 'get_state' })); } catch (e) {}
        };

        ws.onmessage = function (ev) { handleMessage(ev.data); };

        ws.onclose = function (ev) {
            const wasConnected = state.wsConnected;
            state.wsConnected = false;
            state.ws = null;
            // Keep loggedIn/user so the panel still shows last known device name,
            // but isLoggedIn() will return false while disconnected.
            if (wasConnected) {
                emit('error', 'Soloist disconnected' + (ev.code ? ' (code ' + ev.code + ')' : '') + '. Reconnect if the daemon restarted.');
                emit('auth', null);
            }
        };

        ws.onerror = function () {
            // onerror is followed by onclose — avoid double toast.
            // Only toast if we never reached open.
            if (!state.wsConnected) {
                emit('error', 'Could not reach Soloist at ' + endpoint + '. Is it running with --ws ' + state.wsUrl + ' ?');
            }
        };
    }

    function disconnect() {
        const ws = state.ws;
        state.ws = null;
        state.wsConnected = false;
        state.loggedIn = false;
        state.isActive = false;
        state.user = null;
        state.track = null;
        state.playing = false;
        state.progressMs = 0;
        state.durationMs = 0;
        state.progressStamp = 0;
        state.positionAnchor = null;
        if (ws) { try { ws.close(); } catch (e) {} }
        emit('auth', null);
        emit('state', state);
    }

    // Legacy alias so existing callers (logout button) still work.
    function logout() { disconnect(); }

    // ----------------------------------------------------------------------
    // Public configuration
    // ----------------------------------------------------------------------
    function setApiKey(key) {
        state.soloistKey = (key || '').trim();
        try { localStorage.setItem(LS.soloistKey, state.soloistKey); } catch (e) {}
    }

    function apiKey() { return state.soloistKey; }

    function setWsUrl(url) {
        state.wsUrl = normalizeWsInput(url);
        try { localStorage.setItem(LS.wsUrl, state.wsUrl); } catch (e) {}
    }

    function getWsUrl() { return state.wsUrl; }

    function isLoggedIn() { return state.wsConnected && state.loggedIn; }
    function isConnected() { return state.wsConnected; }

    function isConfigured() { return !!state.soloistKey; }

    // Compat shims — app.js boot previously called these for the PKCE flow.
    function redirectUri() { return wsEndpoint(); }
    function handleRedirect() { return Promise.resolve(false); }
    function loadProfile() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            cmd('get_auth_state');
            cmd('get_state');
        }
        return Promise.resolve(buildUser());
    }
    function createPlayer() {
        // Soloist is the player — just ensure we're connected and try to activate.
        if (!state.wsConnected) connect();
        // Give the socket a moment, then ask Soloist to become active.
        setTimeout(function () { cmd('activate'); }, 400);
        return Promise.resolve({ soloist: true });
    }

    function refreshRemoteState() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            cmd('get_state');
            cmd('get_auth_state');
        }
    }

    // Transport maps to Soloist commands.
    const transport = {
        toggle: function () { return cmd(state.playing ? 'pause' : 'play'); },
        next: function () { return cmd('skip_next'); },
        previous: function () { return cmd('skip_prev'); },
        seek: function (ms) { return cmd('seek', { position_ms: Math.round(ms) }); },
        setVolume: function (v) {
            // v is 0..1 in app.js (Web API) vs 0..100 in Soloist.
            const vol = Math.max(0, Math.min(100, Math.round(v * 100)));
            return cmd('set_volume', { volume: vol });
        }
    };

    function playUri(uri) {
        // Soloist `play` accepts a single uri (track/album/playlist).
        return cmd('play', uri ? { uri: uri } : {});
    }

    // Soloist has no search over WebSocket — surface a clear error so the UI
    // can toast. We keep the method for app.js compat but always return [].
    async function search(q) {
        if (!q || !q.trim()) return [];
        emit('error', 'Search is not available over Soloist WebSocket — queue from the Spotify app, or hit Play on a URI.');
        return [];
    }

    // Legacy PKCE compat — no-ops but keep the symbols so other code that
    // checks SP.setClientId / SP.clientId / SP.login doesn't throw.
    function setClientId(id) { setApiKey(id); }
    function clientId() { return apiKey(); }
    function login() { connect(); }

    // Cleanup legacy storage once (don't break if storage is blocked)
    try {
        localStorage.removeItem(LS.legacyAccess);
        localStorage.removeItem(LS.legacyRefresh);
        localStorage.removeItem(LS.legacyExpires);
        localStorage.removeItem(LS.legacyVerifier);
        // Keep legacyClientId if it held a value and we migrated — but clear the others.
        // We do NOT auto-delete migratedNote so the user can still see it once.
    } catch (e) {}

    return {
        state: state,
        on: on,
        // Soloist primary
        setApiKey: setApiKey,
        apiKey: apiKey,
        isConfigured: isConfigured,
        setWsUrl: setWsUrl,
        wsUrl: getWsUrl,
        wsEndpoint: wsEndpoint,
        connect: connect,
        disconnect: disconnect,
        isConnected: isConnected,
        isLoggedIn: isLoggedIn,
        refreshRemoteState: refreshRemoteState,
        livePosition: livePosition,
        transport: transport,
        playUri: playUri,
        search: search,
        // compat shims
        redirectUri: redirectUri,
        handleRedirect: handleRedirect,
        loadProfile: loadProfile,
        createPlayer: createPlayer,
        logout: logout,
        // legacy aliases
        setClientId: setClientId,
        clientId: clientId,
        login: login,
        // legacy api() — not available over Soloist; warn and return null
        api: async function () {
            emit('error', 'Direct Web API calls are not available in Soloist mode. Use the Soloist WebSocket or the Spotify app.');
            return null;
        },
        // optional: expose internals for debugging
        _handleMessage: handleMessage,
        _migratedLegacyClientId: migratedNote
    };
})();
