/* Minimal zero-dependency static file server.
 * Railway sets PORT; everything else is served straight from this directory. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

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

const server = http.createServer((req, res) => {
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
            // Unknown paths fall back to the app so the OAuth redirect always lands.
            fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
                if (e2) { res.writeHead(404).end('Not found'); return; }
                res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
            });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
        }).end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('MusicFluid listening on http://0.0.0.0:' + PORT);
});
