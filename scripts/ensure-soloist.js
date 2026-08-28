/* scripts/ensure-soloist.js — download the correct soloist binary for this arch.
   Run at postinstall and at Railway startup. Builds expire after 90 days
   (exit code 10), so this script should be re-runnable.
   Downloads from https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'soloist');
const ARCH_MAP = {
    x64: 'x86_64',
    arm64: 'arm64',
    arm: 'arm32'
};

function arch() {
    const a = ARCH_MAP[process.arch] || 'x86_64';
    // Railway is x86_64; local dev on ARM Mac will get arm64 binary.
    return a;
}

function urlForArch(a) {
    return `https://soloist-builds.spotifycdn.com/soloist_release_${a}.tar.gz`;
}

function existsAndFresh(bin) {
    try {
        if (!fs.existsSync(bin)) return false;
        // Check if executable and not zero bytes
        const st = fs.statSync(bin);
        if (st.size < 100000) return false; // soloist is ~ few MB
        return true;
    } catch { return false; }
}

async function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close(); fs.unlinkSync(dest);
                return download(res.headers.location, dest).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                file.close(); fs.unlinkSync(dest);
                return reject(new Error(`Download failed: ${res.statusCode} for ${url}`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

async function main() {
    const a = arch();
    const url = urlForArch(a);
    const tgz = path.join(ROOT, `soloist_${a}.tar.gz`);
    const bin = BIN + (process.platform === 'win32' ? '.exe' : '');

    if (existsAndFresh(bin)) {
        try {
            const out = execSync(`"${bin}" --version`, { timeout: 4000, encoding: 'utf8' });
            console.log(`[soloist] already present: ${out.trim().split('\n')[0]}`);
            return;
        } catch (e) {
            console.log(`[soloist] present but --version failed, re-downloading: ${e.message}`);
        }
    }

    console.log(`[soloist] downloading ${url} for arch ${process.arch} (${a})...`);
    // Prefer curl/tar if available (more robust for gzip), else Node https
    let usedCurl = false;
    try {
        execSync(`curl --fail --location -o "${tgz}" "${url}"`, { stdio: 'inherit', timeout: 60000 });
        usedCurl = true;
        console.log('[soloist] downloaded via curl');
    } catch (e) {
        console.log('[soloist] curl failed or not available, falling back to Node https');
        await download(url, tgz);
    }

    console.log('[soloist] extracting...');
    try {
        execSync(`tar -xzf "${tgz}" -C "${ROOT}"`, { stdio: 'inherit', timeout: 30000 });
    } catch (e) {
        // Fallback: Node zlib/tar if system tar missing
        console.error('[soloist] tar extraction failed:', e.message);
        throw e;
    }
    // Archive contains ./soloist
    const extracted = path.join(ROOT, 'soloist');
    const target = bin;
    if (extracted !== target && fs.existsSync(extracted)) {
        fs.renameSync(extracted, target);
    }
    try { fs.chmodSync(target, 0o755); } catch {}
    try { fs.unlinkSync(tgz); } catch {}
    try { fs.unlinkSync(path.join(ROOT, 'soloist.tar.gz')); } catch {}
    try {
        const out = execSync(`"${target}" --version`, { timeout: 4000, encoding: 'utf8' });
        console.log(`[soloist] installed: ${out.trim().split('\n')[0]}`);
    } catch (e) {
        console.log('[soloist] installed but --version check failed:', e.message);
    }
}

main().catch(err => {
    console.error('[soloist] ensure failed:', err.message);
    console.error('[soloist] MusicFluid will still start; set SOLOIST_API_KEY to enable daemon.');
    process.exit(0); // don't fail install
});
