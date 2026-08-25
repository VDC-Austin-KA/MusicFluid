# MusicFluid

An audio-reactive visualizer: a WebGL2 fluid simulation plus a canvas-2D engine,
**47 modes**, Spotify login and playback control, and a slide-away control panel.

---

## Spotify setup

### 1. Redirect URI

Register **exactly** this URI in your Spotify app (no trailing path, no query string):

```
https://viz.up.railway.app/
```

Add these too if you want them to work:

| Where | Redirect URI |
|---|---|
| Railway (production) | `https://viz.up.railway.app/` |
| Local development | `http://127.0.0.1:8080/` |
| Replit preview | `https://<your-repl>.replit.dev/` |

Spotify matches the string character-for-character, and it now requires `https://`
for anything that is not the `127.0.0.1` loopback address. The trailing slash matters.
The app shows its own current redirect URI in the Spotify panel with a **Copy** button,
so if you deploy somewhere else, copy it from there.

### 2. Create the app

1. Go to <https://developer.spotify.com/dashboard> → **Create app**.
2. Name it anything. Under **Redirect URIs**, add the URI above.
3. Under **APIs used**, tick **Web API** and **Web Playback SDK**.
4. Save, then copy the **Client ID**.

You do **not** need the Client Secret. The app uses Authorization Code + PKCE,
which is designed for browser apps with no backend.

### 3. Log in

Paste the Client ID into the Spotify panel, hit **Save**, then **Log in with Spotify**.
The token is stored in `localStorage` and refreshed automatically.

---

## How the audio actually reaches the visualizer

This is worth understanding, because Spotify makes it less direct than you would expect.

**Spotify audio cannot be read by the browser.** Playback through the Web Playback SDK
is decrypted by Widevine DRM, and the decoded samples are never exposed to the Web Audio
API — there is no `AnalyserNode` you can attach. Spotify has declined this request for
years. Separately, the `/audio-features` and `/audio-analysis` endpoints that used to
provide a beat grid were [deprecated for new apps in November 2024](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
and now return `403`.

So MusicFluid splits the job:

| Concern | Source |
|---|---|
| Login, now-playing, cover art, transport, search | Spotify Web API |
| Playing the music | Web Playback SDK (Premium) **or** any device via Spotify Connect |
| The actual spectrum | **Loopback capture** of your system/tab audio |

To get real reactivity, click **System** under *Audio Source* and tick
**"Share system audio"** (or **"Share tab audio"**) in the browser's picker.
That routes the real waveform into the analyser, and everything reacts properly.

If you skip that step, the **"Simulated beat when silent"** switch keeps the visuals
moving on a tempo-driven synthetic envelope rather than freezing on a black screen.

Notes:
- **Chrome / Edge on Windows** can share full system audio. On macOS, Chrome can share
  *tab* audio — play Spotify in a browser tab via **Play here (Premium)** and share that tab.
- **Premium** is required for in-browser playback and for transport control via the API.
  Free accounts can still log in and see now-playing metadata.
- **Microphone** and **File** work as sources too, and need none of the above.

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
Panel state is remembered between visits. "Hide panel while idle" tucks it away
automatically after four seconds without pointer movement.

| Key | Action |
|---|---|
| `H` | Show / hide the panel |
| `F` | Fullscreen |
| `R` | Random mode |
| `C` | Clear the canvas |
| `←` `→` | Previous / next mode |
| `Space` | Spotify play / pause |

---

## Running it

**Locally**

```bash
npm start          # http://127.0.0.1:8080
```

Node 18+, no dependencies — `server.js` is a plain static file server.

**Railway**

Railway detects `package.json` and runs `npm start`; `server.js` binds `0.0.0.0:$PORT`.
Unknown paths fall back to `index.html` so the OAuth redirect always lands.
Set the service domain to `viz.up.railway.app` to match the registered redirect URI.

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
js/spotify.js     PKCE auth, Web API, Web Playback SDK
js/app.js         mode registry, render loop, UI wiring
server.js         static server for Railway
```
