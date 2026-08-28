/* Self-check for js/xr.js ray maths — `node scripts/test-xr-raycast.js`.
 *
 * The controller ray is the only way to touch anything in VR, and it is the one
 * piece here that cannot be eyeballed without a headset: if the screen mapping
 * is off, every click lands somewhere other than where the laser points, and if
 * the panel plane solve is off, no button is reachable at all.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, console: console, navigator: {}, WeakMap: WeakMap, Math: Math };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'xr.js'), 'utf8'), sandbox);

const T = sandbox.window.XRMode._test;
const G = T.geom;
const EYE = 1.5;
T.setEyeY(EYE);

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < (eps || 1e-6), `${msg}: ${a} !~ ${b}`);
// direction from the eye toward a world point
const toward = (o, p) => {
    const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
};
const EYE_POS = [0, EYE, 0];

// --- screen ---------------------------------------------------------------
// Dead ahead from the eye lands in the exact centre, one radius away.
let h = T.hitScreen([0, EYE, 0], [0, 0, -1]);
assert.ok(h, 'straight ahead must hit the screen');
near(h.u, 0.5, 1e-9, 'centre u');
near(h.v, 0.5, 1e-9, 'centre v');
near(h.t, G.R, 1e-6, 'distance is the sphere radius');

// A yaw of +30° is a fifth of the 150° span right of centre.
const yaw = 30 * Math.PI / 180;
h = T.hitScreen([0, EYE, 0], [Math.sin(yaw), 0, -Math.cos(yaw)]);
assert.ok(h, 'yawed ray must hit');
near(h.u, yaw / G.YAW + 0.5, 1e-9, 'yaw maps to u');
near(h.v, 0.5, 1e-9, 'pure yaw leaves v centred');

// Pitching up moves v toward 0, because texture v=0 is the top canvas row.
const pitch = 21 * Math.PI / 180;
h = T.hitScreen([0, EYE, 0], [0, Math.sin(pitch), -Math.cos(pitch)]);
near(h.v, 0.5 - pitch / G.PITCH, 1e-9, 'looking up lowers v');
assert.ok(h.v < 0.5, 'up is nearer the top of the image');

// Outside the cap, and behind the viewer, are both misses.
assert.strictEqual(T.hitScreen([0, EYE, 0], [0, 0, 1]), null, 'behind the cap is a miss');
const wide = 100 * Math.PI / 180;   // beyond YAW/2 = 75°
assert.strictEqual(T.hitScreen([0, EYE, 0], [Math.sin(wide), 0, -Math.cos(wide)]), null, 'past the edge is a miss');

// --- panel ----------------------------------------------------------------
// Aim at the panel's centre point and it should land dead centre of its canvas.
const pc = [0, EYE + G.PANEL_DY, G.PANEL_Z];
h = T.hitPanel(EYE_POS, toward(EYE_POS, pc));
assert.ok(h, 'panel centre must be reachable');
near(h.px, G.PANEL_CW / 2, 1e-6, 'panel centre px');
near(h.py, G.PANEL_CH / 2, 1e-6, 'panel centre py');

// Top-left corner of the quad maps to (0, 0) in canvas pixels.
const tl = [-G.PANEL_W / 2, EYE + G.PANEL_DY + G.PANEL_H / 2, G.PANEL_Z];
h = T.hitPanel(EYE_POS, toward(EYE_POS, tl));
assert.ok(h, 'panel corner must be reachable');
near(h.px, 0, 1e-6, 'top-left px');
near(h.py, 0, 1e-6, 'top-left py');

// Just outside the quad is a miss, so a stray ray cannot press a button.
const off = [-G.PANEL_W, EYE + G.PANEL_DY, G.PANEL_Z];
assert.strictEqual(T.hitPanel(EYE_POS, toward(EYE_POS, off)), null, 'off the quad is a miss');
assert.strictEqual(T.hitPanel([0, EYE, 0], [0, 0, 1]), null, 'facing away is a miss');

// --- mat4 -----------------------------------------------------------------
// Column-major multiply against an identity must be a no-op.
const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const M = new Float32Array([1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16]);
const out = new Float32Array(16);
T.mul(out, I, M);
for (let i = 0; i < 16; i++) near(out[i], M[i], 1e-6, 'identity * M = M');
T.mul(out, M, I);
for (let i = 0; i < 16; i++) near(out[i], M[i], 1e-6, 'M * identity = M');

console.log('xr raycast self-check: OK');
