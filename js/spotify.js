/* ==========================================================================
   SpotifyClient — Authorization Code + PKCE (no backend, no client secret),
   Web API calls, and the Web Playback SDK player.

   Important limitation, by design of Spotify's platform: audio played through
   the Web Playback SDK is decrypted by Widevine and is NOT reachable from the
   Web Audio API. There is no AnalyserNode you can attach to it. The
   /audio-features and /audio-analysis endpoints (which used to provide a beat
   grid) were also deprecated for new apps in Nov 2024 and return 403.

   So this module handles login, metadata and transport control, and the app
   gets its actual spectrum from a loopback capture of the system/tab audio.
   ========================================================================== */

window.SpotifyClient = (function () {
    'use strict';

    const AUTH_URL = 'https://accounts.spotify.com/authorize';
    const TOKEN_URL = 'https://accounts.spotify.com/api/token';
    const API = 'https://api.spotify.com/v1';

    const SCOPES = [
        'streaming',
        'user-read-email',
        'user-read-private',
        'user-read-playback-state',
        'user-modify-playback-state',
        'user-read-currently-playing'
    ].join(' ');

    const LS = {
        clientId: 'mf.sp.clientId',
        access: 'mf.sp.access',
        refresh: 'mf.sp.refresh',
        expires: 'mf.sp.expires',
        verifier: 'mf.sp.verifier'
    };

    const state = {
        clientId: localStorage.getItem(LS.clientId) || '',
        accessToken: localStorage.getItem(LS.access) || '',
        refreshToken: localStorage.getItem(LS.refresh) || '',
        expiresAt: parseInt(localStorage.getItem(LS.expires) || '0', 10),
        user: null,
        player: null,
        deviceId: null,
        premium: null,
        track: null,
        playing: false,
        progressMs: 0,
        durationMs: 0,
        progressStamp: 0,
        sdkLoaded: false
    };

    const listeners = {};
    function on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); }
    function emit(evt, data) { (listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

    /* ---------------------------- PKCE ----------------------------------- */

    // Spotify matches this string exactly against the dashboard entry, so it
    // deliberately excludes the query string and hash.
    function redirectUri() {
        return location.origin + location.pathname;
    }

    function randomString(len) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        const bytes = new Uint8Array(len);
        crypto.getRandomValues(bytes);
        let out = '';
        for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
        return out;
    }

    async function sha256Base64Url(input) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        let bin = '';
        const bytes = new Uint8Array(digest);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async function login() {
        if (!state.clientId) {
            emit('error', 'Add your Spotify Client ID first.');
            return;
        }
        if (!crypto.subtle) {
            emit('error', 'Spotify login needs a secure context (https:// or localhost).');
            return;
        }
        const verifier = randomString(96);
        localStorage.setItem(LS.verifier, verifier);
        const challenge = await sha256Base64Url(verifier);
        const params = new URLSearchParams({
            client_id: state.clientId,
            response_type: 'code',
            redirect_uri: redirectUri(),
            code_challenge_method: 'S256',
            code_challenge: challenge,
            scope: SCOPES,
            show_dialog: 'false'
        });
        location.assign(AUTH_URL + '?' + params.toString());
    }

    function persistTokens(data) {
        state.accessToken = data.access_token;
        state.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
        localStorage.setItem(LS.access, state.accessToken);
        localStorage.setItem(LS.expires, String(state.expiresAt));
        if (data.refresh_token) {
            state.refreshToken = data.refresh_token;
            localStorage.setItem(LS.refresh, state.refreshToken);
        }
    }

    async function exchangeCode(code) {
        const verifier = localStorage.getItem(LS.verifier);
        if (!verifier) throw new Error('Missing PKCE verifier — start the login again.');
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri(),
                client_id: state.clientId,
                code_verifier: verifier
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_description || data.error || 'Token exchange failed');
        localStorage.removeItem(LS.verifier);
        persistTokens(data);
    }

    async function refresh() {
        if (!state.refreshToken) return false;
        try {
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: state.refreshToken,
                    client_id: state.clientId
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error_description || 'refresh failed');
            persistTokens(data);
            return true;
        } catch (err) {
            logout();
            emit('error', 'Spotify session expired — please log in again.');
            return false;
        }
    }

    async function validToken() {
        if (!state.accessToken) return null;
        if (Date.now() >= state.expiresAt) {
            const ok = await refresh();
            if (!ok) return null;
        }
        return state.accessToken;
    }

    /* --------------------------- redirect -------------------------------- */

    // Runs once at boot; returns true if this page load was an auth callback.
    async function handleRedirect() {
        const params = new URLSearchParams(location.search);
        const code = params.get('code');
        const error = params.get('error');
        if (!code && !error) return false;

        // Clean the URL before anything else so a refresh cannot replay it.
        history.replaceState({}, document.title, redirectUri());

        if (error) {
            emit('error', 'Spotify denied the login: ' + error);
            return true;
        }
        try {
            await exchangeCode(code);
            await loadProfile();
            emit('auth', state.user);
        } catch (err) {
            emit('error', String(err.message || err));
        }
        return true;
    }

    /* ------------------------------ api ---------------------------------- */

    async function api(path, options) {
        const token = await validToken();
        if (!token) return null;
        const opts = options || {};
        const res = await fetch(path.startsWith('http') ? path : API + path, {
            method: opts.method || 'GET',
            headers: Object.assign({
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json'
            }, opts.headers || {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });

        if (res.status === 204) return {};             // no content (transport calls)
        if (res.status === 401) { await refresh(); return null; }
        if (res.status === 403) {
            const body = await res.text();
            emit('error', 'Spotify refused that request (403). ' +
                 (body.indexOf('Premium') >= 0 ? 'Playback control needs Spotify Premium.' : ''));
            return null;
        }
        if (res.status === 429) { emit('error', 'Spotify rate limit hit — easing off.'); return null; }
        if (!res.ok) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    async function loadProfile() {
        const me = await api('/me');
        if (!me) return null;
        state.user = me;
        state.premium = me.product === 'premium';
        return me;
    }

    /* ------------------------ web playback sdk ---------------------------- */

    function loadSDK() {
        return new Promise((resolve, reject) => {
            if (state.sdkLoaded) return resolve();
            // The Web Playback SDK is desktop-browser only; on iOS/Android the
            // right move is to play in the Spotify app and drive it via Connect.
            if (window.MF_MOBILE) {
                return reject(new Error(
                    'In-browser playback is not supported on mobile. Play in the Spotify app — ' +
                    'the controls here drive it over Spotify Connect.'));
            }
            if (!state.premium) {
                return reject(new Error('In-browser playback requires Spotify Premium.'));
            }
            window.onSpotifyWebPlaybackSDKReady = function () {
                state.sdkLoaded = true;
                resolve();
            };
            const s = document.createElement('script');
            s.src = 'https://sdk.scdn.co/spotify-player.js';
            s.async = true;
            s.onerror = () => reject(new Error('Could not load the Spotify player SDK.'));
            document.head.appendChild(s);
            setTimeout(() => { if (!state.sdkLoaded) reject(new Error('Spotify player SDK timed out.')); }, 12000);
        });
    }

    async function createPlayer() {
        if (state.player) return state.player;
        await loadSDK();
        const player = new window.Spotify.Player({
            name: 'MusicFluid Visualizer',
            getOAuthToken: async cb => { const tk = await validToken(); if (tk) cb(tk); },
            volume: 0.8
        });

        player.addListener('ready', ({ device_id }) => {
            state.deviceId = device_id;
            emit('player-ready', device_id);
        });
        player.addListener('not_ready', () => { state.deviceId = null; });
        player.addListener('player_state_changed', st => {
            if (!st) return;
            applyPlayerState(st);
        });
        ['initialization_error', 'authentication_error', 'account_error', 'playback_error']
            .forEach(evt => player.addListener(evt, ({ message }) => emit('error', 'Spotify player: ' + message)));

        const connected = await player.connect();
        if (!connected) throw new Error('The Spotify player could not connect.');
        state.player = player;
        return player;
    }

    function applyPlayerState(st) {
        const tr = st.track_window && st.track_window.current_track;
        if (tr) setTrack({
            id: tr.id,
            name: tr.name,
            artists: (tr.artists || []).map(a => a.name).join(', '),
            art: tr.album && tr.album.images && tr.album.images.length ? tr.album.images[0].url : null,
            uri: tr.uri
        });
        state.playing = !st.paused;
        state.progressMs = st.position;
        state.durationMs = st.duration;
        state.progressStamp = Date.now();
        emit('state', state);
    }

    function setTrack(track) {
        const changed = !state.track || state.track.id !== track.id;
        state.track = track;
        if (changed) emit('track', track);
    }

    /* ------------------------- remote playback ---------------------------- */

    async function refreshRemoteState() {
        const data = await api('/me/player');
        if (!data || !data.item) return;
        const it = data.item;
        setTrack({
            id: it.id,
            name: it.name,
            artists: (it.artists || []).map(a => a.name).join(', '),
            art: it.album && it.album.images && it.album.images.length ? it.album.images[0].url : null,
            uri: it.uri
        });
        state.playing = !!data.is_playing;
        state.progressMs = data.progress_ms || 0;
        state.durationMs = it.duration_ms || 0;
        state.progressStamp = Date.now();
        emit('state', state);
    }

    // Interpolated position, so the progress bar is smooth between polls.
    function livePosition() {
        if (!state.durationMs) return 0;
        const extra = state.playing ? (Date.now() - state.progressStamp) : 0;
        return Math.min(state.durationMs, state.progressMs + extra);
    }

    const transport = {
        toggle: async function () {
            if (state.player) return state.player.togglePlay();
            return api(state.playing ? '/me/player/pause' : '/me/player/play', { method: 'PUT' });
        },
        next: async function () {
            if (state.player) return state.player.nextTrack();
            return api('/me/player/next', { method: 'POST' });
        },
        previous: async function () {
            if (state.player) return state.player.previousTrack();
            return api('/me/player/previous', { method: 'POST' });
        },
        seek: async function (ms) {
            if (state.player) return state.player.seek(ms);
            return api('/me/player/seek?position_ms=' + Math.round(ms), { method: 'PUT' });
        },
        setVolume: async function (v) {
            if (state.player) return state.player.setVolume(v);
            return api('/me/player/volume?volume_percent=' + Math.round(v * 100), { method: 'PUT' });
        }
    };

    async function listDevices() {
        const d = await api('/me/player/devices');
        return (d && d.devices) || [];
    }

    async function transferTo(deviceId, startPlaying) {
        return api('/me/player', {
            method: 'PUT',
            body: { device_ids: [deviceId], play: !!startPlaying }
        });
    }

    async function search(q) {
        if (!q.trim()) return [];
        const data = await api('/search?type=track&limit=10&q=' + encodeURIComponent(q));
        if (!data || !data.tracks) return [];
        return data.tracks.items.map(it => ({
            id: it.id,
            uri: it.uri,
            name: it.name,
            artists: (it.artists || []).map(a => a.name).join(', '),
            art: it.album && it.album.images && it.album.images.length
                ? it.album.images[it.album.images.length - 1].url : null
        }));
    }

    async function playUri(uri) {
        const target = state.deviceId ? '?device_id=' + state.deviceId : '';
        const body = uri.indexOf(':track:') >= 0 ? { uris: [uri] } : { context_uri: uri };
        return api('/me/player/play' + target, { method: 'PUT', body: body });
    }

    /* ---------------------------- lifecycle ------------------------------- */

    function logout() {
        if (state.player) { try { state.player.disconnect(); } catch (e) {} }
        state.player = null;
        state.deviceId = null;
        state.accessToken = '';
        state.refreshToken = '';
        state.expiresAt = 0;
        state.user = null;
        state.track = null;
        state.playing = false;
        localStorage.removeItem(LS.access);
        localStorage.removeItem(LS.refresh);
        localStorage.removeItem(LS.expires);
        emit('auth', null);
    }

    function setClientId(id) {
        state.clientId = (id || '').trim();
        localStorage.setItem(LS.clientId, state.clientId);
    }

    function isLoggedIn() { return !!state.accessToken; }

    return {
        state: state,
        on: on,
        redirectUri: redirectUri,
        setClientId: setClientId,
        clientId: function () { return state.clientId; },
        login: login,
        logout: logout,
        handleRedirect: handleRedirect,
        loadProfile: loadProfile,
        createPlayer: createPlayer,
        refreshRemoteState: refreshRemoteState,
        livePosition: livePosition,
        listDevices: listDevices,
        transferTo: transferTo,
        search: search,
        playUri: playUri,
        transport: transport,
        isLoggedIn: isLoggedIn,
        api: api
    };
})();
