/**
 * scope.js - Canvas renderer for one vectorscope view.
 *
 * One ScopeView owns:
 *   - the visible <canvas>
 *   - a cached offscreen graticule (rebuilt only on resize/zoom/iline change)
 *   - a false-color density accumulator for "heatmap" plot mode
 *
 * Plot modes:
 *   'trace'   - phosphor-green dots, low alpha, luma-mapped brightness/size
 *   'heatmap' - false-color (ironbow) density LUT over pixel accumulation
 *
 * Geometry is expressed in "scope units": the outer circle is radius 1.0.
 * Zoom magnifies the whole render around the scope center (white-balance
 * mode): both graticule and plotted data are scaled by `zoom`.
 */
(function (g) {
'use strict';

/** Ironbow lookup table, 256 entries, RGB triplets. */
function buildHeatLut() {
  const stops = [
    [0.00,   6,  10,   8],   // near black
    [0.15,  12,  60,  28],   // deep green
    [0.40,  46, 190,  70],   // green
    [0.60, 220, 210,  40],   // yellow
    [0.80, 255, 130,  25],   // orange
    [1.00, 255,  60, 210]    // hot magenta-red
  ];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    }
    const f = (t - a[0]) / (b[0] - a[0] || 1);
    lut[i * 3]     = Math.round(a[1] + (b[1] - a[1]) * f);
    lut[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * f);
    lut[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * f);
  }
  return lut;
}

const HEAT_LUT = buildHeatLut();

// Target/I-line constants: published to globalThis by ycbcr.js in the UXP
// panel, required in Node tests (IIFE rationale: see sampling.js).
const _isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
const _yc = _isNode && typeof require === 'function' ? require('./ycbcr.js') : g;

const GRID_MARGIN = 1.15;   // scope-space half-extent covered by the heat grid
const TRACE_LUMA_BUCKETS = 8;
const BG = '#131418';

class ScopeView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.zoom = 1;
    this.mode = 'trace';      // 'trace' | 'heatmap'
    this.showIline = true;
    this._gratDirty = true;

    // graticule cache
    this._grat = document.createElement('canvas');
    this._gratCtx = this._grat.getContext('2d');

    // size (device px)
    this._w = 0;
    this._h = 0;
    this._dpr = 1;

    // heat accumulator
    this._heatN = 96;
    this._heat = new Float32Array(this._heatN * this._heatN);
    this._heatMax = 0;
    this._heatCanvas = document.createElement('canvas');
    this._heatCanvas.width = this._heatN;
    this._heatCanvas.height = this._heatN;
    this._heatCtx = this._heatCanvas.getContext('2d');
    this._heatImg = this._heatCtx.createImageData(this._heatN, this._heatN);
    this._heatMax = 0;
    this._heatPending = false;

    // trace bucket index buffers (point indices, reused)
    this._bucketMax = 0;
    this._buckets = [];
    this._bucketN = null;
  }

  /** Re-allocate trace buckets when the expected sample count grows. */
  _ensureBuckets(maxN) {
    if (maxN <= this._bucketMax) return;
    this._bucketMax = maxN;
    this._buckets = [];
    for (let i = 0; i < TRACE_LUMA_BUCKETS; i++) this._buckets.push(new Uint32Array(maxN));
    this._bucketN = new Uint32Array(TRACE_LUMA_BUCKETS);
  }

  /** Synchronize the canvas with its CSS box. Returns true if it changed. */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, Math.floor((this.canvas.clientWidth || 100) * dpr));
    const h = Math.max(60, Math.floor((this.canvas.clientHeight || 100) * dpr));
    if (w === this._w && h === this._h && dpr === this._dpr) return false;
    this._w = w; this._h = h; this._dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    this._gratDirty = true;
    return true;
  }

  setZoom(z) { this.zoom = z; this._gratDirty = true; }
  setMode(m) { this.mode = m; }
  setIline(v) { this.showIline = v; this._gratDirty = true; }

  /** Center and pixel radius of the outer (1.0) circle. */
  _geometry() {
    const R = Math.min(this._w, this._h) * 0.46;
    return { cx: this._w / 2, cy: this._h / 2, R };
  }
}

// ---------------------------------------------------------------------------
// Graticule
// ---------------------------------------------------------------------------

/** (Re)draw the cached graticule: circles, axes, targets, I-line. */
ScopeView.prototype._buildGraticule = function () {
  const c = this._gratCtx;
  const w = this._w, h = this._h;
  this._grat.width = w;
  this._grat.height = h;
  c.clearRect(0, 0, w, h);
  c.fillStyle = BG;
  c.fillRect(0, 0, w, h);

  const { cx, cy, R } = this._geometry();
  const z = this.zoom;
  const dpr = this._dpr;

  // concentric circles
  const ring = (f, style, width) => {
    c.beginPath();
    c.arc(cx, cy, Math.max(0.5, R * f * z), 0, Math.PI * 2);
    c.strokeStyle = style;
    c.lineWidth = width * dpr;
    c.stroke();
  };
  ring(0.25, 'rgba(255,255,255,0.10)', 1);
  ring(0.50, 'rgba(255,255,255,0.10)', 1);
  ring(0.75, 'rgba(255,255,255,0.10)', 1);
  ring(1.00, 'rgba(255,255,255,0.32)', 1.5);

  // center axes
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.lineWidth = 1 * dpr;
  c.beginPath();
  c.moveTo(0, cy); c.lineTo(w, cy);
  c.moveTo(cx, 0); c.lineTo(cx, h);
  c.stroke();

  // I-line (skin tone), 21 deg above the Cr axis
  if (this.showIline) {
    const a = _yc.I_LINE_DEGREES * Math.PI / 180;
    c.strokeStyle = 'rgba(255,178,87,0.9)';
    c.lineWidth = 1.5 * dpr;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(a) * R * 1.0 * z, cy - Math.sin(a) * R * 1.0 * z);
    c.stroke();
  }

  // color targets
  c.font = `${11 * dpr}px sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const dotR = 2.5 * dpr;
  for (const t of _yc.TARGETS) {
    const tx = cx + t.x * R * z;
    const ty = cy - t.y * R * z;
    if (tx < -10 || tx > w + 10 || ty < -10 || ty > h + 10) continue;
    c.fillStyle = t.css;
    c.beginPath();
    c.arc(tx, ty, dotR, 0, Math.PI * 2);
    c.fill();
    const ly = t.y > 0 ? ty - 11 * dpr : ty + 11 * dpr;
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fillText(t.name, tx, ly);
  }
  this._gratDirty = false;
};

// ---------------------------------------------------------------------------
// Plot: trace mode
// ---------------------------------------------------------------------------

/**
 * Phosphor trace: luma-bucketed dots (brightness + size follow luma).
 * x/y/luma are Float32Arrays; n = valid count.
 */
ScopeView.prototype._drawTrace = function (x, y, luma, n) {
  this._ensureBuckets(n);
  const bucketN = this._bucketN;
  bucketN.fill(0);
  for (let i = 0; i < n; i++) {
    let b = (luma[i] * TRACE_LUMA_BUCKETS) | 0;
    if (b >= TRACE_LUMA_BUCKETS) b = TRACE_LUMA_BUCKETS - 1;
    this._buckets[b][bucketN[b]++] = i;
  }
  const ctx = this.ctx;
  const { cx, cy, R } = this._geometry();
  const z = this.zoom;
  const scale = R * z;
  for (let b = 0; b < TRACE_LUMA_BUCKETS; b++) {
    const cnt = bucketN[b];
    if (cnt === 0) continue;
    const l = (b + 0.5) / TRACE_LUMA_BUCKETS;
    const size = Math.max(1, (1 + l * 2.2) * this._dpr);
    ctx.fillStyle = `rgba(109,255,160,${(0.035 + l * 0.4).toFixed(3)})`;
    const idx = this._buckets[b];
    const half = size / 2;
    for (let k = 0; k < cnt; k++) {
      const i = idx[k];
      const px = cx + x[i] * scale;
      const py = cy - y[i] * scale;
      if (px < 0 || px >= this._w || py < 0 || py >= this._h) continue;
      ctx.fillRect(px - half, py - half, size, size);
    }
  }
};

// ---------------------------------------------------------------------------
// Plot: heatmap (false-color density)
// ---------------------------------------------------------------------------

/** Accumulate points into the density grid (call once or more, then _flushHeat). */
ScopeView.prototype._accumulateHeat = function (x, y, luma, n) {
  const N = this._heatN;
  const heat = this._heat;
  if (!this._heatPending) {
    heat.fill(0);
    this._heatMax = 0;
    this._heatPending = true;
  }
  let max = this._heatMax;
  const inv = N / (2 * GRID_MARGIN);
  for (let i = 0; i < n; i++) {
    let gx = ((x[i] + GRID_MARGIN) * inv) | 0;
    let gy = ((-y[i] + GRID_MARGIN) * inv) | 0;   // y flipped for row order
    if (gx < 0 || gx >= N || gy < 0 || gy >= N) continue;
    const c = ++heat[gy * N + gx];
    if (c > max) max = c;
  }
  this._heatMax = max;
};

/** Render the accumulated density grid with the false-color LUT. */
ScopeView.prototype._flushHeat = function () {
  if (!this._heatPending) return;
  this._heatPending = false;
  const N = this._heatN;
  const heat = this._heat;
  const max = this._heatMax;

  const img = this._heatImg.data;
  const lut = HEAT_LUT;
  for (let i = 0; i < N * N; i++) {
    let t = max > 0 ? heat[i] / max : 0;
    t = Math.pow(t, 0.55);                     // open up mid densities
    const j = (t * 255) | 0;
    const o = i * 4;
    img[o]     = lut[j * 3];
    img[o + 1] = lut[j * 3 + 1];
    img[o + 2] = lut[j * 3 + 2];
    img[o + 3] = heat[i] > 0 ? 235 : 0;
  }
  this._heatCtx.putImageData(this._heatImg, 0, 0);

  const { cx, cy, R } = this._geometry();
  const size = 2 * GRID_MARGIN * R * this.zoom;
  this.ctx.imageSmoothingEnabled = true;
  this.ctx.drawImage(this._heatCanvas, cx - size / 2, cy - size / 2, size, size);
  heat.fill(0);
};

// ---------------------------------------------------------------------------
// Public render
// ---------------------------------------------------------------------------

/** Begin a frame: resize + graticule + clear. Call before one or more plot() passes. */
ScopeView.prototype.beginFrame = function () {
  this.resize();
  if (this._gratDirty) this._buildGraticule();
  this._heatPending = false;
  const ctx = this.ctx;
  ctx.clearRect(0, 0, this._w, this._h);
  ctx.drawImage(this._grat, 0, 0);
};

/**
 * Plot one point set on the current frame.
 * @param {Float32Array} x     scope X (normalized Cr)
 * @param {Float32Array} y     scope Y (normalized Cb)
 * @param {Float32Array} luma  BT.601 luma 0..1
 * @param {number} n           valid point count
 * @param {boolean} [flush]    when false, a heatmap pass is accumulated but
 *                             not rendered yet (caller merges passes).
 */
ScopeView.prototype.plot = function (x, y, luma, n, flush) {
  if (n > 0) {
    if (this.mode === 'heatmap') this._accumulateHeat(x, y, luma, n);
    else this._drawTrace(x, y, luma, n);
  }
  // flush is false lets the caller merge several passes (e.g. three tonal
  // buckets) into one heat grid; default flushes after each pass.
  if (this.mode === 'heatmap' && flush !== false) this._flushHeat();
};

/** Overlay hint for frames that received no points. */
ScopeView.prototype.emptyNote = function () {
  const ctx = this.ctx;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = `${12 * this._dpr}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('no samples', this._w / 2, this._h / 2);
};

/** Convenience: full frame with a single point set. */
ScopeView.prototype.render = function (x, y, luma, n) {
  this.beginFrame();
  this.plot(x, y, luma, n);
};

const _exports = { ScopeView, HEAT_LUT, GRID_MARGIN, TRACE_LUMA_BUCKETS };
g.VSscope = _exports;
if (!_isNode) Object.assign(g, _exports);
if (typeof module !== 'undefined') module.exports = _exports;
})(typeof globalThis !== 'undefined' ? globalThis : this);
