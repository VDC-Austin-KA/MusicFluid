/* MusicFluid server + optional Spotify Soloist daemon.
 *
 * Zero-dependency static file server (http) plus:
 * - On boot, if SOLOIST_API_KEY is set, ensures the `soloist` binary is present
 *   (postinstall also does this) and spawns it:
 *     soloist --device-name "$SOLOIST_DEVICE_NAME" --api-key "$SOLOIST_API_KEY"
 *             --ws 127.0.0.1:9090 --data-dir /tmp/soloist-data --cache-dir /tmp/soloist-cache
 *   Binary source: https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates
 *   Builds expire after 90 days (exit code 10).
 *
 * - WebSocket proxy at /soloist/ws -> 127.0.0.1:9090 so the browser can reach
 *   the daemon through the Railway public URL (wss://viz.up.railway.app/soloist/ws).
 *   The daemon's own WebSocket has no auth/TLS/Origin checks (local surface by
 *   design); this proxy adds no extra auth either — treat the endpoint as trusted
 *   network. If you need restriction, put the app behind Railway private networking
 *   or add your own token check in upgrade handling.
 *
 * - Status endpoint at /soloist/status for health checks / UI.
 *
 * Env:
 *   PORT=8080 (Railway sets)
 *   SOLOIST_API_KEY=...           (required to run daemon; generate at https://developer.spotify.com/dashboard/soloist)
 *   SOLOIST_DEVICE_NAME=MusicFluid
 *   SOLOIST_WS=127.0.0.1:9090
 *   SOLOIST_DATA_DIR=/tmp/soloist-data
 *   SOLOIST_CACHE_DIR=/tmp/soloist-cache
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execSync } = require('child_process');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const SOLOIST_WS = process.env.SOLOIST_WS || '127.0.0.1:9090';
const SOLOIST_API_KEY = process.env.SOLOIST_API_KEY || '';
const SOLOIST_DEVICE_NAME = process.env.SOLOIST_DEVICE_NAME || 'MusicFluid Railway';
const SOLOIST_DATA_DIR = process.env.SOLOIST_DATA_DIR || path.join(require('os').tmpdir(), 'soloist-data');
const SOLOIST_CACHE_DIR = process.env.SOLOIST_CACHE_DIR || path.join(require('os').tmpdir(), 'soloist-cache');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

// ---------------------------------------------------------------------
// Soloist binary management
// ---------------------------------------------------------------------
let soloistProc = null;
let soloistStatus = { running: false, pid: null, exitCode: null, lastLog: '' };

function logSoloist(msg) {
    const line = `[soloist] ${msg}`;
    console.log(line);
    soloistStatus.lastLog = line + '\n' + soloistStatus.lastLog.slice(0, 4000);
}

function findBinary() {
    const candidates = [
        path.join(ROOT, 'soloist'),
        path.join(ROOT, 'soloist.exe'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p) && fs.statSync(p).size > 100000) return p; } catch {}
    }
    return null;
}

function ensureDataDirs() {
    for (const d of [SOLOIST_DATA_DIR, SOLOIST_CACHE_DIR]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch {}
    }
}

async function ensureSoloistBinary() {
    let bin = findBinary();
    if (bin) {
        try {
            const out = execSync(`"${bin}" --version`, { timeout: 4000, encoding: 'utf8' });
            logSoloist(`binary present: ${out.trim().split('\n')[0]}`);
            return bin;
        } catch (e) {
            logSoloist(`binary --version failed (${e.message}), will re-download`);
        }
    }
    // Try to download via scripts/ensure-soloist.js
    const script = path.join(ROOT, 'scripts', 'ensure-soloist.js');
    if (fs.existsSync(script)) {
        try {
            logSoloist('downloading binary via scripts/ensure-soloist.js ...');
            execSync(`node "${script}"`, { stdio: 'inherit', timeout: 120000 });
            bin = findBinary();
            if (bin) return bin;
        } catch (e) {
            logSoloist(`download script failed: ${e.message}`);
        }
    }
    // Fallback: inline curl
    try {
        const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm32' : 'x86_64';
        const url = `https://soloist-builds.spotifycdn.com/soloist_release_${arch}.tar.gz`;
        const tgz = path.join(ROOT, `soloist_${arch}.tar.gz`);
        logSoloist(`fallback curl ${url}`);
        execSync(`curl --fail --location -o "${tgz}" "${url}"`, { stdio: 'inherit', timeout: 60000 });
        execSync(`tar -xzf "${tgz}" -C "${ROOT}"`, { stdio: 'inherit', timeout: 30000 });
        try { fs.unlinkSync(tgz); } catch {}
        bin = findBinary();
        if (bin) {
            try { fs.chmodSync(bin, 0o755); } catch {}
            return bin;
        }
    } catch (e) {
        logSoloist(`curl fallback failed: ${e.message}`);
    }
    return null;
}

async function startSoloist() {
    if (!SOLOIST_API_KEY) {
        logSoloist('SOLOIST_API_KEY not set — daemon disabled. Set it in Railway Variables to enable.');
        logSoloist('Generate at https://developer.spotify.com/dashboard/soloist (Premium required).');
        return;
    }
    ensureDataDirs();
    const bin = await ensureSoloistBinary();
    if (!bin) {
        logSoloist('ERROR: could not obtain soloist binary — daemon not started.');
        soloistStatus = { running: false, pid: null, exitCode: null, lastLog: soloistStatus.lastLog, error: 'binary missing' };
        return;
    }
    const args = [
        '--device-name', SOLOIST_DEVICE_NAME,
        '--api-key', SOLOIST_API_KEY,
        '--ws', SOLOIST_WS,
        '--data-dir', SOLOIST_DATA_DIR,
        '--cache-dir', SOLOIST_CACHE_DIR,
    ];
    logSoloist(`starting: ${bin} ${args.join(' ').replace(SOLOIST_API_KEY, '***')}`);
    logSoloist(`data: ${SOLOIST_DATA_DIR} cache: ${SOLOIST_CACHE_DIR} ws: ${SOLOIST_WS}`);
    soloistStatus = { running: false, pid: null, exitCode: null, lastLog: soloistStatus.lastLog };

    try {
        soloistProc = spawn(bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });
    } catch (e) {
        logSoloist(`spawn failed: ${e.message}`);
        return;
    }
    soloistStatus.running = true;
    soloistStatus.pid = soloistProc.pid;
    soloistProc.stdout.on('data', d => logSoloist(`out: ${d.toString().trim()}`));
    soloistProc.stderr.on('data', d => logSoloist(`err: ${d.toString().trim()}`));
    soloistProc.on('exit', (code, sig) => {
        soloistStatus.running = false;
        soloistStatus.exitCode = code;
        soloistStatus.pid = null;
        logSoloist(`exited code=${code} signal=${sig}`);
        if (code === 10) {
            logSoloist('Exit 10 = build expired (>90 days). Re-downloading and restarting in 5s...');
            setTimeout(async () => {
                try {
                    const script = path.join(ROOT, 'scripts', 'ensure-soloist.js');
                    if (fs.existsSync(script)) {
                        // force re-download by removing binary
                        try { fs.unlinkSync(bin); } catch {}
                        await ensureSoloistBinary();
                    }
                } catch {}
                startSoloist();
            }, 5000);
        } else if (code !== 0 && code !== null) {
            logSoloist('Restarting soloist in 5s...');
            setTimeout(startSoloist, 5000);
        }
    });
    soloistProc.on('error', err => {
        logSoloist(`proc error: ${err.message}`);
        soloistStatus.running = false;
    });
}

// ---------------------------------------------------------------------
// HTTP server (+ WebSocket proxy)
// ---------------------------------------------------------------------
let wssProxy = null;
let WebSocket = null;
try {
    WebSocket = require('ws');
} catch (e) {
    logSoloist('ws package not yet installed — WebSocket proxy disabled until `npm install`');
}

const server = http.createServer((req, res) => {
    // Soloist status endpoint
    if (req.url.startsWith('/soloist/status')) {
        const status = {
            enabled: !!SOLOIST_API_KEY,
            running: soloistStatus.running,
            pid: soloistStatus.pid,
            exitCode: soloistStatus.exitCode,
            ws: SOLOIST_WS,
            proxy: '/soloist/ws',
            deviceName: SOLOIST_DEVICE_NAME,
            dataDir: SOLOIST_DATA_DIR,
            hasKey: !!SOLOIST_API_KEY,
            lastLog: soloistStatus.lastLog.slice(0, 2000),
            publicWsUrl: `wss://${req.headers.host}/soloist/ws`,
            directWsUrl: `ws://${SOLOIST_WS}`,
            downloads: 'https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates',
            dashboard: 'https://developer.spotify.com/dashboard/soloist',
            hint: SOLOIST_API_KEY ? 'Daemon should be running; pair via Spotify app → Connect → "MusicFluid Railway"' : 'Set SOLOIST_API_KEY env var (Railway → Variables) to enable daemon'
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(status, null, 2));
        return;
    }
    // Health
    if (req.url === '/health' || req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, soloist: soloistStatus.running }));
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
        res.writeHead(400).end('Bad request');
        return;
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Resolve inside ROOT only — blocks ../ traversal.
    const filePath = path.join(ROOT, pathname);
    if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            // Unknown paths fall back to the app so the SPA routing still lands.
            fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
                if (e2) { res.writeHead(404).end('Not found'); return; }
                res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
            });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const source = ext === '.html' || ext === '.js' || ext === '.css';
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': source ? 'no-cache' : 'public, max-age=86400'
        }).end(data);
    });
});

// WebSocket proxy: /soloist/ws <-> 127.0.0.1:9090
if (WebSocket) {
    const { WebSocketServer } = WebSocket;
    wssProxy = new WebSocketServer({ noServer: true });

    // Intercept upgrade for our path only; other upgrades (if any) fall through.
    server.on('upgrade', (req, socket, head) => {
        const url = req.url || '';
        if (!url.startsWith('/soloist/ws')) {
            // Not ours — destroy (no other upgrade handler).
            socket.destroy();
            return;
        }
        wssProxy.handleUpgrade(req, socket, head, wsClient => {
            wssProxy.emit('connection', wsClient, req);
        });
    });

    wssProxy.on('connection', (clientWs, req) => {
        const target = `ws://${SOLOIST_WS}`;
        let soloistWs;
        try {
            soloistWs = new WebSocket(target);
        } catch (e) {
            logSoloist(`proxy: failed to create WebSocket to ${target}: ${e.message}`);
            clientWs.close(1011, 'soloist not reachable');
            return;
        }

        let clientClosed = false, soloistClosed = false;

        function cleanup() {
            try { clientWs.close(); } catch {}
            try { soloistWs.close(); } catch {}
        }

        soloistWs.on('open', () => {
            logSoloist(`proxy: client ${req.socket.remoteAddress} <-> ${target} connected`);
        });

        soloistWs.on('message', data => {
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
        });
        clientWs.on('message', data => {
            if (soloistWs.readyState === WebSocket.OPEN) soloistWs.send(data);
        });

        const onClose = (who) => {
            return () => {
                if (who === 'client') clientClosed = true;
                else soloistClosed = true;
                if (clientWs.readyState === WebSocket.OPEN) try { clientWs.close(); } catch {}
                if (soloistWs.readyState === WebSocket.OPEN) try { soloistWs.close(); } catch {}
            };
        };
        clientWs.on('close', onClose('client'));
        soloistWs.on('close', onClose('soloist'));
        clientWs.on('error', err => logSoloist(`proxy client error: ${err.message}`));
        soloistWs.on('error', err => {
            logSoloist(`proxy soloist error: ${err.message}`);
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'soloist unreachable');
        });
    });

    logSoloist(`WebSocket proxy listening at /soloist/ws -> ws://${SOLOIST_WS}`);
} else {
    logSoloist('WebSocket proxy not installed (ws missing). Run `npm install` to enable /soloist/ws.');
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('MusicFluid listening on http://0.0.0.0:' + PORT);
    if (SOLOIST_API_KEY) console.log(`[soloist] status at http://0.0.0.0:${PORT}/soloist/status`);
    // Start daemon after server is listening
    startSoloist().catch(e => logSoloist(`start failed: ${e.message}`));
});

process.on('SIGTERM', () => {
    logSoloist('SIGTERM — shutting down');
    if (soloistProc) try { soloistProc.kill('SIGTERM'); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000);
});
process.on('SIGINT', () => {
    if (soloistProc) try { soloistProc.kill('SIGINT'); } catch {}
    process.exit(0);
});
