/* Self-check for js/spotify.js frame parsing — `node scripts/test-soloist-parse.js`.
 *
 * The Soloist Entity shape (decorations.identity / visual_identity / creators /
 * parent / playback) is the thing that silently breaks the whole UI when it is
 * parsed wrong: every track renders as "Unknown" with no art. Frames below are
 * copied from developer.spotify.com/documentation/soloist/reference/websocket-api.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Minimal browser shims — spotify.js only needs these at load time.
const store = {};
const sandbox = {
    window: {},
    console: console,
    localStorage: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
    },
    location: { hostname: 'localhost', host: 'localhost:8080', protocol: 'http:' },
    WebSocket: function () {},
    setTimeout, clearTimeout, Date
};
sandbox.WebSocket.OPEN = 1;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'spotify.js'), 'utf8'), sandbox);

const SP = sandbox.window.SpotifyClient;
const seen = { track: null, options: null, queue: null, context: null };
SP.on('track', t => { seen.track = t; });
SP.on('options', o => { seen.options = o; });
SP.on('queue', q => { seen.queue = q; });
SP.on('context', c => { seen.context = c; });

const ENTITY = {
    uri: 'spotify:track:2JRo0gjbX4GrCqBYdRohoo',
    entity_type: 'track',
    decorations: {
        identity: { name: 'My Song' },
        visual_identity: {
            cover: [
                { url: 'https://i.scdn.co/image/small', size: 'small' },
                { url: 'https://i.scdn.co/image/large', size: 'large' }
            ]
        },
        parent: {
            entity: {
                uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
                entity_type: 'album',
                decorations: { identity: { name: 'Album Name' } }
            }
        },
        creators: [
            { entity: { uri: 'spotify:artist:1', decorations: { identity: { name: 'Artist One' } } } },
            { entity: { uri: 'spotify:artist:2', decorations: { identity: { name: 'Artist Two' } } } }
        ],
        playback: { duration_ms: 210000 }
    }
};

SP._handleMessage(JSON.stringify({ type: 'auth_state', logged_in: true, is_active: true, device_name: 'MusicFluid' }));
assert.strictEqual(SP.state.loggedIn, true);
assert.strictEqual(SP.state.deviceName, 'MusicFluid');

SP._handleMessage(JSON.stringify({
    type: 'playback_state',
    status: 'playing',
    item: ENTITY,
    context: { uri: 'spotify:playlist:x', decorations: { identity: { name: 'Late Night' } } },
    position: { position_ms: 30000, timestamp_ms: Date.now(), speed: 1 },
    volume: 42,
    is_active: true,
    options: { shuffle: true, repeat: 'context' }
}));

assert.strictEqual(seen.track.name, 'My Song', 'track name from decorations.identity');
assert.strictEqual(seen.track.artists, 'Artist One, Artist Two', 'artists from decorations.creators');
assert.strictEqual(seen.track.album, 'Album Name', 'album from decorations.parent');
assert.strictEqual(seen.track.art, 'https://i.scdn.co/image/large', 'largest cover wins');
assert.strictEqual(seen.track.duration_ms, 210000, 'duration from decorations.playback');
assert.strictEqual(SP.state.playing, true);
assert.strictEqual(SP.state.volume, 42);
assert.strictEqual(seen.options.shuffle, true);
assert.strictEqual(seen.options.repeat, 'context');
assert.strictEqual(seen.context.name, 'Late Night');
assert.ok(SP.livePosition() >= 30000 && SP.livePosition() < 31000, 'position anchor drifts forward');

SP._handleMessage(JSON.stringify({ type: 'options_changed', options: { shuffle: false, repeat: 'track' } }));
assert.strictEqual(seen.options.shuffle, false);
assert.strictEqual(seen.options.repeat, 'track');

SP._handleMessage(JSON.stringify({
    type: 'queue_changed',
    previous: [],
    upcoming: [{ uid: 'q1', source: 'queue', item: ENTITY }]
}));
assert.strictEqual(seen.queue.upcoming.length, 1);
assert.strictEqual(seen.queue.upcoming[0].name, 'My Song', 'queue rows unwrap { uid, source, item }');
assert.strictEqual(seen.queue.upcoming[0].uid, 'q1');

// Legacy / partial frames must not throw or blank the UI.
SP._handleMessage(JSON.stringify({ type: 'track_changed', item: { uri: 'spotify:track:z', name: 'Flat', artists: ['A'], duration_ms: 1000 } }));
assert.strictEqual(seen.track.name, 'Flat');
assert.strictEqual(seen.track.artists, 'A');
SP._handleMessage('not json');
SP._handleMessage(JSON.stringify({ type: 'unknown_frame' }));

console.log('soloist parse self-check: OK');
