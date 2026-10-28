/**
 * sampling.js - the pixel sampling core.
 *
 * Pure logic (no UXP, no DOM): takes an ImData-shaped object and strides it
 * down, converts RGB to scope space, filters by selection and tonal bucket.
 * Isolated from main.js so it can be unit-tested in Node.
 *
 * An "ImData-shaped" object is anything with:
 *   { width, height, channelOrder, data: Int32Array }
 */
'use strict';

// In the UXP panel, ycbcr.js publishes its API to globalThis; in Node we
// require it. Kept as a single _yc handle to avoid top-level re-declaration
// of the const bindings that live in ycbcr.js's shared script scope.
const _yc = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./ycbcr.js')
  : globalThis;

/** Channel byte offsets for the channelOrder strings Photoshop may report. */
function channelLayout(order) {
  const c = (order || 'rgba').toLowerCase();
  if (c === 'bgra')   return { r: 2, g: 1, b: 0, step: 4 };
  if (c === 'bgr')    return { r: 2, g: 1, b: 0, step: 3 };
  if (c === 'argb')   return { r: 2, g: 1, b: 0, step: 4 };
  if (c === 'abgr')   return { r: 1, g: 0, b: 3, step: 4 };
  if (c === 'gray')   return { r: 0, g: 0, b: 0, step: 1 };
  if (c === 'graya')  return { r: 0, g: 0, b: 0, step: 2 };
  if (c === 'rgba')   return { r: 0, g: 1, b: 2, step: 4 };
  if (c === 'rgb')    return { r: 0, g: 1, b: 2, step: 3 };
  return { r: 0, g: 1, b: 2, step: c.length >= 4 ? 4 : 3 };
}

/**
 * Stride-sample imData into the three tonal point buffers.
 *
 * @param {object} imData   ImData-shaped (see header).
 * @param {?object} sel     selection rect in ORIGINAL doc pixels, or null.
 * @param {number} srcW     width of the document the selection was read from.
 * @param {number} srcH     height of same.
 * @param {object} opts     { sampleSize, tonal, layout } - the panel state.
 * @param {Array}  buffers  three { x, y, luma: Float32Array, n } buckets,
 *                          pre-allocated (caller guarantees capacity).
 * @returns {number}        total number of points written.
 */
function sampleInto(imData, sel, srcW, srcH, opts, buffers) {
  const w = imData.width;
  const h = imData.height;
  const data = imData.data; // Int32Array
  if (!w || !h || !data) return 0;

  const ch = channelLayout(imData.channelOrder);
  const stride = Math.max(1, Math.ceil(Math.max(w, h) / opts.sampleSize));

  // Selection in imData coordinates (data may be a downscaled proxy or a
  // layer whose extent differs from the document).
  const sx = w / srcW, sy = h / srcH;
  let x0 = 0, x1 = w, y0 = 0, y1 = h;
  if (sel) {
    x0 = Math.max(0, Math.floor(sel.left * sx));
    y0 = Math.max(0, Math.floor(sel.top * sy));
    x1 = Math.min(w, Math.ceil(sel.right * sx));
    y1 = Math.min(h, Math.ceil(sel.bottom * sy));
  }

  // Which buckets does the current view need?
  const need = [false, false, false];
  if (opts.layout === 'split' || opts.tonal === 'global') {
    need[0] = need[1] = need[2] = true;
  } else if (opts.tonal === 'shadows') need[_yc.TONAL.SHADOWS] = true;
  else if (opts.tonal === 'mids') need[_yc.TONAL.MIDS] = true;
  else need[_yc.TONAL.HIGHLIGHTS] = true;
  for (let i = 0; i < 3; i++) buffers[i].n = 0;

  const out = { x: 0, y: 0, luma: 0 }; // reused, zero allocation per pixel
  const { r: cr, g: cg, b: cb, step } = ch;
  for (let py = y0; py < y1; py += stride) {
    let off = py * w * step;
    for (let px = x0; px < x1; px += stride) {
      const o = off + px * step;
      const o2 = _yc.rgb8ToScope(data[o + cr], data[o + cg], data[o + cb], out);
      const bucket = _yc.tonalBucket(o2.luma);
      if (need[bucket]) {
        const buf = buffers[bucket];
        const n = buf.n++;
        buf.x[n] = o2.x;
        buf.y[n] = o2.y;
        buf.luma[n] = o2.luma;
      }
    }
  }
  return buffers[0].n + buffers[1].n + buffers[2].n;
}

if (typeof module !== 'undefined') {
  module.exports = { channelLayout, sampleInto };
}
