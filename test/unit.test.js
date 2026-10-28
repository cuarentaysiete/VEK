/**
 * unit.test.js - Node unit tests for the vectorscope core.
 *
 * Covers the UXP-independent parts: color math, target geometry, sampling,
 * tonal/selection filtering, statistics, and a stubbed ScopeView render
 * path. Run with: npm test   (or: node --test)
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------
// Minimal DOM stubs so scope.js loads outside the UXP host.
// ---------------------------------------------------------------------
function makeCtx() {
  const target = {
    createImageData(w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    }
  };
  return new Proxy(target, {
    get(t, p) { return (p in t) ? t[p] : () => undefined; },
    set() { return true; }
  });
}
function makeCanvas() {
  const ctx = makeCtx();
  return { width: 0, height: 0, clientWidth: 300, clientHeight: 300, getContext: () => ctx };
}
globalThis.document = { createElement: () => makeCanvas() };
globalThis.window = { devicePixelRatio: 1 };

const ycbcr = require('../src/ycbcr.js');
const { sampleInto, channelLayout } = require('../src/sampling.js');
const { computeStats } = require('../src/stats.js');
const { ScopeView } = require('../src/scope.js');

// ---------------------------------------------------------------------
// ycbcr
// ---------------------------------------------------------------------
test('all six targets land at ~94-100% of the outer circle', () => {
  // After normalizing by the largest raw radius (green = 1.0), the other
  // primaries sit slightly inside: ~0.94 (blue) to 1.0 (green).
  for (const t of ycbcr.TARGETS) {
    const r = Math.hypot(t.x, t.y);
    assert.ok(Math.abs(r - 1) < 0.06, `${t.name} radius is ${r}`);
  }
});

test('red target sits right, slightly below center', () => {
  const R = ycbcr.TARGETS.find((t) => t.name === 'R');
  const { BT601, MAX_TARGET_RADIUS } = ycbcr;
  const expX = BT601.CR_K * (1 - 0.299) * 2 / MAX_TARGET_RADIUS;
  const expY = BT601.CB_K * (0 - 0.299) * 2 / MAX_TARGET_RADIUS;
  assert.ok(Math.abs(R.x - expX) < 1e-12);
  assert.ok(Math.abs(R.y - expY) < 1e-12);
  assert.ok(expY < -0.2 && expY > -0.45); // ~21 deg below the Cr axis
});

test('gray maps to the center, pure green maps to the green target', () => {
  const o = { x: 0, y: 0, luma: 0 };
  ycbcr.rgb8ToScope(128, 128, 128, o);
  assert.ok(Math.hypot(o.x, o.y) < 1e-9);
  const G = ycbcr.TARGETS.find((t) => t.name === 'G');
  ycbcr.rgb8ToScope(0, 255, 0, o);
  assert.ok(Math.abs(o.x - G.x) < 1e-9);
  assert.ok(Math.abs(o.y - G.y) < 1e-9);
});

test('luma of primaries matches BT.601', () => {
  const o = {};
  ycbcr.rgb8ToScope(255, 0, 0, o);
  assert.ok(Math.abs(o.luma - 0.299) < 1e-6);
  ycbcr.rgb8ToScope(255, 255, 255, o);
  assert.ok(Math.abs(o.luma - 1) < 1e-6);
});

test('tonal bucket boundaries', () => {
  const o = {};
  ycbcr.rgb8ToScope(20, 20, 20, o);
  assert.equal(ycbcr.tonalBucket(o.luma), ycbcr.TONAL.SHADOWS);
  ycbcr.rgb8ToScope(128, 128, 128, o);
  assert.equal(ycbcr.tonalBucket(o.luma), ycbcr.TONAL.MIDS);
  ycbcr.rgb8ToScope(240, 240, 240, o);
  assert.equal(ycbcr.tonalBucket(o.luma), ycbcr.TONAL.HIGHLIGHTS);
});

// ---------------------------------------------------------------------
// sampling
// ---------------------------------------------------------------------
function makeImageData(w, h, order, fill) {
  const step = order === 'bgra' ? 4 : order === 'rgb' ? 3 : 1;
  const data = new Int32Array(w * h * step);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) fill(x, y, data, (y * w + x) * step, step);
  }
  return { width: w, height: h, channelOrder: order, data };
}

const opts = (o = {}) => Object.assign(
  { sampleSize: 100, tonal: 'global', layout: 'single' }, o);

function freshBuffers(n) {
  return [0, 1, 2].map(() => ({
    x: new Float32Array(n), y: new Float32Array(n),
    luma: new Float32Array(n), n: 0
  }));
}

test('channel layout table', () => {
  assert.deepEqual(channelLayout('bgra'), { r: 2, g: 1, b: 0, step: 4 });
  assert.deepEqual(channelLayout('rgba'), { r: 0, g: 1, b: 2, step: 4 });
  assert.deepEqual(channelLayout('gray'), { r: 0, g: 0, b: 0, step: 1 });
});

test('stride downsample halves a 100px image at sampleSize 50', () => {
  const img = makeImageData(100, 100, 'bgra', (x, y, d, o) => {
    d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 255;
  });
  const bufs = freshBuffers(10000);
  const total = sampleInto(img, null, 100, 100, opts({ sampleSize: 50 }), bufs);
  assert.equal(total, 2500); // 50x50
});

test('left red / right white image splits into shadows and highlights', () => {
  const img = makeImageData(100, 100, 'bgra', (x, y, d, o) => {
    if (x < 50) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 255; }      // red
    else        { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; }  // white
    d[o + 3] = 255;
  });
  const bufs = freshBuffers(10000);
  sampleInto(img, null, 100, 100, opts(), bufs);
  assert.equal(bufs[ycbcr.TONAL.SHADOWS].n, 5000);   // red luma 29.9%
  assert.equal(bufs[ycbcr.TONAL.MIDS].n, 0);
  assert.equal(bufs[ycbcr.TONAL.HIGHLIGHTS].n, 5000); // white luma 100%
});

test('selection bounds restrict the sampled region', () => {
  const img = makeImageData(100, 100, 'bgra', (x, y, d, o) => {
    d[o] = d[o + 1] = d[o + 2] = (x < 50) ? 255 : 0; d[o + 3] = 255;
  });
  const bufs = freshBuffers(10000);
  const sel = { left: 50, top: 0, right: 100, bottom: 100 }; // right half only
  const total = sampleInto(img, sel, 100, 100, opts({ sampleSize: 50 }), bufs);
  // stride is 2 at sampleSize 50: the 50x100 selection yields 25 x 50 samples
  assert.equal(total, 1250);
  // every sampled point comes from the black right half -> all shadows
  assert.equal(bufs[ycbcr.TONAL.SHADOWS].n, total);
});

test('tonal filter limits which buckets fill', () => {
  const img = makeImageData(100, 100, 'bgra', (x, y, d, o) => {
    if (x < 50) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 255; }
    else        { d[o] = d[o + 1] = d[o + 2] = 255; }
    d[o + 3] = 255;
  });
  const bufs = freshBuffers(10000);
  sampleInto(img, null, 100, 100, opts({ tonal: 'shadows' }), bufs);
  assert.ok(bufs[ycbcr.TONAL.SHADOWS].n > 0);
  assert.equal(bufs[ycbcr.TONAL.HIGHLIGHTS].n, 0);
});

// ---------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------
test('single red point: ~99% peak saturation, hue near 0 deg', () => {
  const buf = { x: new Float32Array([0.9996]), y: new Float32Array([-0.3372]), luma: new Float32Array([0.299]), n: 1 };
  // normalized by MAX_TARGET_RADIUS in rgb8ToScope; recompute for this fixture:
  const { MAX_TARGET_RADIUS } = ycbcr;
  buf.x[0] /= MAX_TARGET_RADIUS; buf.y[0] /= MAX_TARGET_RADIUS;
  const s = computeStats([buf]);
  assert.ok(Math.abs(s.peakSat - 0.988) < 0.01);
  assert.equal(s.dominant[0].name, 'Red');
  const d = s.dominant[0].deg;
  assert.ok(Math.min(d, 360 - d) <= 15, `hue ${d} should wrap near 0`);
});

test('neutral gray: zero saturation, no dominant hue', () => {
  const buf = { x: new Float32Array(4), y: new Float32Array(4), luma: new Float32Array(4), n: 4 };
  const s = computeStats([buf]);
  assert.equal(s.peakSat, 0);
  assert.equal(s.dominant.length, 0);
});

// ---------------------------------------------------------------------
// scope rendering (stubbed canvas)
// ---------------------------------------------------------------------
test('ScopeView render/plot/heatmap do not throw and respect empty state', () => {
  const v = new ScopeView(makeCanvas());
  const n = 1000;
  const x = new Float32Array(n), y = new Float32Array(n), l = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    x[i] = Math.cos(a) * 0.8; y[i] = Math.sin(a) * 0.8; l[i] = 0.5;
  }
  v.setZoom(2); v.setIline(true); v.setMode('trace');
  v.render(x, y, l, n);                       // single pass
  v.render(x, y, l, 0);                       // empty -> note path
  v.setMode('heatmap');
  v.beginFrame();                             // multi-pass merged frame
  v.plot(x, y, l, n, false);
  v.plot(x, y, l, n, false);
  v.plot(0, 0, 0, 0);                         // flush
  v.emptyNote();
  v.setZoom(4); v.render(x, y, l, n);         // resize + graticule rebuild
});

test('heatmap grid accumulates and stays within bounds', () => {
  const v = new ScopeView(makeCanvas());
  v.setMode('heatmap');
  const x = new Float32Array([0.5, 0.5, 0.5, 999]); // one point out of range
  const y = new Float32Array([0.5, 0.5, 0.5, -999]);
  const l = new Float32Array(4).fill(0.5);
  v.render(x, y, l, 4);
  assert.equal(v._heatMax, 3);                 // same cell, out-of-range skipped
});
