/* Self-check for the band normaliser in js/audio.js —
 * `node scripts/test-audio-range.js`.
 *
 * The bug this guards against: dividing by a running peak that has already been
 * raised by the current sample. Every new maximum then reports exactly 1.0, so
 * on a compressed master the meters sit crushed against full scale and the
 * visualizer stops reacting. Measured on the compressed case below, that
 * implementation gave mean 0.93 / min 0.78 / spread 0.22 — the whole signal
 * squeezed into the top fifth of the scale.
 *
 * Note the assertions are about mean and spread, not about how often the value
 * touches 1.0: a signal that genuinely spends time at its own maximum *should*
 * peg there, and both implementations do.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, console: console, Math: Math, Float32Array: Float32Array, Array: Array, Date: Date };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'audio.js'), 'utf8'), sandbox);
const norm = sandbox.window.AudioEngine._rangeNorm;

function run(signal, frames, skip) {
    const r = { floor: 0, ceil: 0 };
    const out = [];
    for (let i = 0; i < (frames || 1800); i++) {
        const v = norm(r, signal(i));
        if (i >= (skip || 900)) out.push(v);   // discard settling
    }
    return out;
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const spread = a => Math.max(...a) - Math.min(...a);

// 1. A loud compressed band — the case that was broken. It must use the whole
//    scale, not sit crushed against the top.
const comp = run(i => 0.72 + 0.23 * Math.abs(Math.sin(i / 7)));
assert.ok(spread(comp) > 0.8, `compressed band must use the range (spread ${spread(comp).toFixed(2)})`);
assert.ok(Math.min(...comp) < 0.15, `compressed band must reach down (min ${Math.min(...comp).toFixed(2)})`);
assert.ok(mean(comp) < 0.72, `compressed band must not crowd the top (mean ${mean(comp).toFixed(2)})`);

// 2. A quiet band must expand to a comparable range — the point of adapting
//    per band rather than applying one global gain.
const quiet = run(i => 0.04 + 0.03 * Math.abs(Math.sin(i / 7)));
assert.ok(spread(quiet) > 0.4, `quiet band must open up (spread ${spread(quiet).toFixed(2)})`);
assert.ok(mean(quiet) > 0.15 && mean(quiet) < 0.85, `quiet band should sit mid-scale (mean ${mean(quiet).toFixed(2)})`);

// 3. A dead-steady band must read mid-scale, not full. This is the degenerate
//    case that sank the earlier floor/ceiling attempt; MIN_SPAN plus a floor
//    that closes in at the ceiling's rate is what fixes it.
const steady = run(() => 0.6);
assert.ok(Math.max(...steady) < 0.85, `steady band must not peg (max ${Math.max(...steady).toFixed(2)})`);

// 4. Silence stays silent rather than being normalised up into motion.
const silent = run(() => 0.004);
assert.strictEqual(Math.max(...silent), 0, 'near-silence must gate to 0');

// 5. Transients peg briefly then fall back, so a hit still reads as a hit.
const r = { floor: 0, ceil: 0 };
for (let i = 0; i < 600; i++) norm(r, 0.3);        // settle on a quiet bed
const hit = norm(r, 0.95);
let tail = 0;
for (let i = 0; i < 60; i++) tail = norm(r, 0.3);
assert.ok(hit > 0.9, `a transient must peg (${hit.toFixed(2)})`);
assert.ok(tail < 0.55, `and fall back afterwards (${tail.toFixed(2)})`);

console.log('audio range self-check: OK');
