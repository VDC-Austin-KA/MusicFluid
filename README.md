# MusicFluid

An audio-reactive visualizer: a WebGL2 fluid simulation plus a canvas-2D engine,
**47 modes**, Spotify Soloist playback control, and a slide-away control panel.

---

## Spotify Soloist setup

MusicFluid now uses **Spotify Soloist** — a headless Linux daemon that appears as a
Spotify Connect device — instead of the browser PKCE Client ID flow. The previous
`Client ID + Redirect URI + PKCE` code has been removed (see git history).

### 1. Get a Soloist API key

1. Open **https://developer.spotify.com/dashboard/soloist** → generate an API key.
   The account that generates it must have **Premium**.
2. Treat it like a secret: don't commit it, don't embed it in client code, don't
   paste it in public issues. Each user generates their own. It is passed to the
   `soloist` binary at startup via `--api-key "$SOLOIST_API_KEY"`.

Docs:
- Overview: https://developer.spotify.com/documentation/soloist
- Getting started: https://developer.spotify.com/documentation/soloist/tutorials/getting-started
- Authentication: https://developer.spotify.com/documentation/soloist/concepts/authentication
- Downloads (arm64/arm32/x86_64, builds expire after 90 days, exit 10): https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates
- WebSocket API: https://developer.spotify.com/documentation/soloist/reference/websocket-api
- Basic integration: https://developer.spotify.com/documentation/soloist/howtos/basic-integration
- CLI: https://developer.spotify.com/documentation/soloist/reference/command-line

### 2. Railway (hosted — viz.up.railway.app)

The Railway service runs the daemon **inside the same container** as the Node static
server. The server downloads the x86_64 binary on boot from the URL above, spawns

```
soloist --device-name "$SOLOIST_DEVICE_NAME" --api-key "$SOLOIST_API_KEY" \
        --ws 127.0.0.1:9090 --data-dir /tmp/soloist-data --cache-dir /tmp/soloist-cache
```

and proxies its WebSocket at `wss://viz.up.railway.app/soloist/ws` → `ws://127.0.0.1:9090`.

The browser never sends the API key to Spotify — the daemon did at startup.

Setup:

1. In Railway → your project (`proactive-youthfulness` / `MusicFluid`) → **Variables**, add:
   | Variable | Example | Required |
   |---|---|---|
   | `SOLOIST_API_KEY` | `abc123…` | Yes |
   | `SOLOIST_DEVICE_NAME` | `MusicFluid Railway` | No (defaults) |
   | `SOLOIST_WS` | `127.0.0.1:9090` | No |
   | `SOLOIST_DATA_DIR` | `/tmp/soloist-data` | No |
   | `SOLOIST_CACHE_DIR` | `/tmp/soloist-cache` | No |

2. Redeploy. Check **https://viz.up.railway.app/soloist/status** — it should show
   `running: true`, `ws: 127.0.0.1:9090`, `publicWsUrl: wss://viz.up.railway.app/soloist/ws`.

3. In MusicFluid open the **Spotify Soloist** panel → the WebSocket field will
   auto-default to `wss://viz.up.railway.app/soloist/ws`; hit **Connect & open dashboard**.

4. **Pair once:** open the Spotify app on the same account → device picker →
   select `MusicFluid Railway`. The session is stored in the daemon's data dir.

5. Use transport (play/pause/next/prev/seek) from MusicFluid; the daemon is the
   active Connect device. `/soloist/status` streams the daemon's log.

Notes:
- The daemon's WebSocket has no auth/TLS/Origin checks by design (local surface only).
  The Railway proxy adds no extra auth either — protect it via Railway private
  networking if needed.
- Data is in `/tmp` (ephemeral). To persist the Connect session across deploys,
  attach a Railway volume and set `SOLOIST_DATA_DIR` to its mount.
- Builds expire 90 days after their date. The server restarts and re-downloads on
  exit code 10. Otherwise check the build with `soloist --version`.
- `npm start` still serves `wss://viz.up.railway.app/soloist/ws` locally; unknown
  paths fall back to `index.html`.

### 3. Local Linux / Raspberry Pi

```bash
# Pick arch: arm64 (aarch64), arm32 (armv7l), x86_64
curl --fail --location -o soloist.tar.gz https://soloist-builds.spotifycdn.com/soloist_release_arm64.tar.gz
tar -xzf soloist.tar.gz
sudo install -m 755 soloist /usr/local/bin/soloist

# Run with key and WebSocket:
soloist --device-name "MusicFluid" --api-key "$SOLOIST_API_KEY" --ws 127.0.0.1:9090

# Or let MusicFluid's server launch it:
SOLOIST_API_KEY=... npm start   # serves http://127.0.0.1:8080 + proxies /soloist/ws
```

Then in MusicFluid set the WebSocket to `127.0.0.1:9090` (default) or a LAN IP
if the daemon is on another box, and hit Connect. Pair via Connect as above.
`ws.addr` / `ws.port` are written in the data dir for discovery; `soloist ctl`
also uses them.

### 4. Browser panel

- **Soloist API key** — saved in `localStorage mf.soloist.key` for reference only.
  On Railway the real value is `SOLOIST_API_KEY` env; the browser field is just a reminder.
- **Soloist WebSocket** — `mf.soloist.ws`. Railway auto-detects `wss://<host>/soloist/ws`; local defaults to `127.0.0.1:9090`.
- **Connect & open dashboard** → opens the WebSocket *and* pops the dashboard window.
- **Status** → opens `/soloist/status`. Setup notes live behind the collapsed
  *Setup & daemon notes* summary so the panel stays a control surface, not a manual.
- Soloist connection failures are reported **once**, then retried quietly with backoff;
  the state shows in the hint line rather than as a stream of red toasts.

### 5. The dashboard window — `/soloist.html`

The full control surface, in its own window (the panel keeps a mini transport).
It runs the same `js/spotify.js` client over its own WebSocket, so it keeps
working when the visualizer tab is backgrounded, and reconnects with backoff if
the daemon restarts.

Cover art · title / artist / album / context · draggable seek · play, pause,
next, prev · shuffle · repeat (off → context → track) · volume · live **Up next**
queue · **Play** / **Queue** by Spotify URI · **Activate** / **Deactivate** the
Connect device. `Space` toggles playback, `Shift+←/→` skip.

Open it directly at `/soloist.html`, or `/soloist.html?ws=<host:port>` to pin an
endpoint. There is no search — Soloist's WebSocket API has none; paste a URI
(Spotify app → track → Share → Copy Spotify URI) or queue from the app.

Parsing of the daemon's `Entity` frames is covered by
`node scripts/test-soloist-parse.js`.

---

## How the audio actually reaches the visualizer

This is worth understanding, because Soloist makes it less direct than you would expect.

**Soloist audio stays on the daemon's output** (HDMI/DAC/Bluetooth on the Pi or Railway host) and is not exposed to the browser's Web Audio API. The browser cannot attach an `AnalyserNode` to it.

So MusicFluid splits the job:

| Concern | Source |
|---|---|
| Login, now-playing, cover art, transport | Soloist WebSocket (`auth_state`, `playback_state`, `position_sync`, `play`/`pause`/`seek`/`set_volume`/…) |
| Playing the music | Soloist daemon as a Connect device (or any device via Connect) |
| The actual spectrum | **Loopback capture** of your system/tab audio |

To get real reactivity, click **Spotify (Soloist)** under *Audio Source* and tick
**“Share system audio”** (or **“Share tab audio”**) in the browser's picker. That one
button connects the Connect device *and* opens the capture path in the right order —
it is **System** capture on desktop and **Mic** on phones, chosen for you. **System**,
**Mic** and **File** are still there if you want to pick the path yourself.

If you skip that step, the **“Simulated beat when silent”** switch keeps the visuals
moving on a tempo-driven synthetic envelope rather than freezing on a black screen.

Notes:
- **Chrome / Edge on Windows** can share full system audio. On macOS, Chrome can share
  *tab* audio — play Soloist in a browser tab via **Activate Soloist** and share that tab.
- **Premium** is required (Soloist key generation needs Premium, and Connect control does).
- **Microphone** and **File** work as sources too, and need none of the above.
- On Railway the daemon's audio comes out of the *server*, so there is nothing local to
  capture. Play to a Connect device on your own machine, or use Mic / the simulated beat.

---

## Spotify Player — paste a playlist, listen to it

A source in its own right, in its own panel section, with **no dependency on Soloist** —
use it when the daemon is unreachable or you just want something that works.

1. Paste any Spotify link into the field under the player and hit **Load**. Share links
   (`https://open.spotify.com/playlist/<id>?si=…`), `/intl-xx/` paths, embed URLs and
   `spotify:playlist:<id>` URIs all parse; playlists, albums, tracks, artists, shows and
   episodes are all accepted. The choice is remembered in `localStorage mf.spotify.embed`,
   and *reset to default* restores the built-in playlist.
2. Hit **Listen to this player** (or **Spotify Player** in *Audio Source*). Pick **this
   tab** in the browser's picker and tick **“Share tab audio”**.
3. Press play in the embed. The visualizer is now reacting to it.

Because the embed plays in *this tab* rather than on the daemon's output, tab capture
reaches the analyser directly — which is why this is the reliable path. Full tracks need
a Premium session on `open.spotify.com` in the same browser; without one it previews 30 s.

---

## VR (WebXR)

**Enter VR** appears in the *Visualizer* section when the browser reports an
`immersive-vr` device (Quest browser, or a tethered headset in Chrome/Edge). WebXR
needs a secure context, so use the Railway URL or `localhost` — plain-HTTP LAN
addresses will not offer it.

Inside, the visualizer is painted onto a curved 150°×84° screen at 2.6 m, with a
floating control panel below it: track, artist, progress, transport, mode prev /
random / next, and **Exit VR**.

Point a controller and pull the trigger:

- **at the screen** — fires the same click effect the mouse does (ripple, vortex, …)
  at that point, and moving the ray drives the hover effect. Right hand uses the
  primary click binding, left hand the secondary one.
- **at the panel** — presses the button under the laser.

How it works: the engines are full-screen 2D shader passes, not 3D scenes, so there
is no second eye to render. `js/xr.js` runs a separate XR-compatible WebGL context
and, each XR frame, uploads whichever canvas the active mode just drew as a texture
for the screen mesh. The app's one render loop is driven through `XRMode.raf`, which
routes to `session.requestAnimationFrame` while presenting and back to the window
clock when the session ends. Ray maths is covered by
`node scripts/test-xr-raycast.js`.

Audio still comes from the page, so the source you picked keeps working — but note a
standalone Quest browser has no system-audio capture, leaving **Mic** or the
simulated beat.

---

## On iPhone / iPad

The app is built for touch, but iOS removes one thing the desktop flow depends on,
so the route is different.

**There is no system audio capture on iOS.** Safari's `getDisplayMedia` does not
deliver audio, and no iOS browser exposes a loopback device — every browser on iOS
runs on WebKit, so Chrome and Firefox behave identically here. The **System** button
is therefore disabled on iOS rather than left to fail silently.

What works instead, and works well:

1. Start the track in the **Spotify app**, playing out of the **speaker** (not headphones).
2. Open MusicFluid in Safari and tap **Mic**, then allow microphone access.
3. The visuals now react to the room — which is the real audio, not an approximation.
4. Connect to Soloist here as well: the transport controls and now-playing panel
   drive the Soloist daemon over its WebSocket, so you can skip tracks from
   the visualizer without leaving it.

Raise **Master gain** if the level meters read low — a phone mic across a room is
quieter than a line input. If iOS reroutes audio when the mic opens (it switches to
the play-and-record session, which can pull output away from Bluetooth headphones),
that is expected OS behaviour, and it is why speaker playback is the recommendation.

Other iOS specifics handled:

- The panel is driven by an on-screen handle, sized to 40×108 px for thumbs — no
  keyboard needed. Swipe left/right to slide it, swipe up/down to change mode.
- Layout uses `dvh` and `env(safe-area-inset-*)`, so toolbar collapse and the notch
  do not clip anything.
- Pinch-zoom, double-tap zoom and rubber-band scrolling are suppressed over the canvas.
- The AudioContext is unlocked from a real user gesture, as iOS requires.
- Device pixel ratio is capped at 1.5 and render scale defaults to 70% on phones.
- Fluid textures use `LINEAR` filtering, which is core in WebGL2 — the old check for
  `OES_texture_float_linear` would have forced blocky `NEAREST` sampling on iOS.
- Fullscreen is feature-detected; iPhone Safari has no fullscreen API, so the button
  points at **Share → Add to Home Screen**, which launches chrome-free instead.

---

## Modes

47 in total, grouped in the picker.

**Fluid — WebGL2 Navier-Stokes (19)**
Cosmic Ink · Electric Vortex · Pulse Wave · Lissajous Orbit · Chladni Resonance ·
Perlin Stream · Nebula Bloom · Ink Storm · Spectrum Fountain · Double Helix ·
Solar Flare · Rain Curtain · Kaleidofluid · Fluid Mandala · Black Hole ·
Supernova · Ripple Grid · Tidal Sweep · Firefly Swarm

The first three respond to the mouse; the rest drive themselves from the audio.

**Spectrum (6)** — Spectrum Bars · Mirror Bars · Radial Spectrum · Ring Bloom · Spectrogram · Spectrum Terrain

**Waveform (5)** — Oscilloscope · Ribbon Wave · XY Scope · Wave Tunnel · DNA Strand

**Particles (4)** — Particle Storm · Starfield Warp · Constellation · Beat Fireworks

**Geometry (8)** — Orbit Rings · Polygon Pulse · Kaleidoscope · Ripple Rings ·
Neon Tunnel · Bloom Grid · Hex Pulse · Fractal Tree

**Atmosphere (5)** — Aurora Curtains · Matrix Rain · Plasma Field · Vinyl Spin · Strobe Grid

*Vinyl Spin* spins the current album cover; the **Album Art** palette samples its colours
and applies them to every other mode.

---

## Controls

The panel slides fully off-screen; the tab on its edge stays reachable and slides with it.
Panel state is remembered between visits, and starts closed on phones so the first
thing you see is the visualizer. "Hide panel while idle" tucks it away automatically
after four seconds of no input.

| Key | Touch | Action |
|---|---|---|
| `H` | Tap the edge handle, or swipe left / right | Show / hide the panel |
| `←` `→` | Swipe up / down on the visualizer | Previous / next mode |
| `F` | — | Fullscreen (desktop only) |
| `R` | — | Random mode |
| `C` | — | Clear the canvas |
| `Space` | Transport buttons | Soloist play / pause (when connected) |

---

## Running it

**Locally**

```bash
npm start          # http://127.0.0.1:8080 (+ /soloist/ws proxy if SOLOIST_API_KEY is set)
# With daemon:
SOLOIST_API_KEY=... SOLOIST_DEVICE_NAME="MusicFluid" npm start
# Check status:
curl http://127.0.0.1:8080/soloist/status | jq
```

Node 18+, `ws` for the proxy, `soloist` binary downloaded on demand from
`https://soloist-builds.spotifycdn.com/soloist_release_<arch>.tar.gz`.
`server.js` binds `0.0.0.0:$PORT`.

**Railway**

Railway detects `package.json` and runs `npm start`; `server.js` binds `0.0.0.0:$PORT`.
Unknown paths fall back to `index.html`. Add `SOLOIST_API_KEY` in **Variables**;
the server downloads the x86_64 build and exposes `wss://<domain>/soloist/ws`.

**Replit** — the existing static config still serves `index.html` directly.

---

## Layout

```
index.html        markup
style.css         all styling
js/palette.js     colour ramps + album-art sampling
js/audio.js       capture, FFT, 64-band analysis, beat/BPM, synthetic fallback
js/fluid.js       WebGL2 solver + the 19 fluid modes
js/viz2d.js       canvas-2D engine + the 28 2D modes
js/spotify.js     Soloist WebSocket bridge (replaces PKCE/Web API)
js/app.js         mode registry, render loop, UI wiring
server.js         static server + Soloist daemon + /soloist/ws proxy + /soloist/status
scripts/ensure-soloist.js  arch-aware binary download
```
