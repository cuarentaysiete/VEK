/**
 * stats.js - Color statistics computed from a set of scope points.
 *
 * A "point buffer" is a plain object:
 *   { x: Float32Array, y: Float32Array, luma: Float32Array, n: <count> }
 * Only the first `n` elements are valid.
 */
'use strict';

const HUE_BINS = 36;           // 10 degrees each
const HUE_DEAD_ZONE = 0.05;    // ignore near-gray points in hue histogram

// ycbcr.js publishes to globalThis in the UXP panel; required in Node.
const _yc = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./ycbcr.js')
  : globalThis;

/** Human-friendly hue names, one per 10-degree bin (index 0..35). */
const HUE_NAMES = Object.freeze([
  'Red', 'Red', 'Red-Orange', 'Red-Orange', 'Orange', 'Orange',
  'Yellow-Orange', 'Yellow', 'Yellow', 'Yellow-Green', 'Green', 'Green',
  'Green', 'Cyan-Green', 'Cyan', 'Cyan', 'Cyan', 'Cyan-Blue',
  'Blue', 'Blue', 'Blue-Violet', 'Violet', 'Violet', 'Violet-Magenta',
  'Magenta', 'Magenta', 'Magenta-Red', 'Magenta-Red', 'Red', 'Red',
  'Red', 'Red', 'Red', 'Red', 'Red', 'Red'
]);

/**
 * Compute peak/average saturation and dominant hues.
 * `buffers` is an array of point buffers that are merged statistically.
 * Returns { peakSat, avgSat, total, dominant: [{deg, name, pct}] }.
 */
function computeStats(buffers) {
  const hueHist = new Float64Array(HUE_BINS);
  let satSum = 0;
  let total = 0;
  let peakSat = 0;

  for (const buf of buffers) {
    const n = buf.n;
    total += n;
    for (let i = 0; i < n; i++) {
      const s = _yc.scopeSaturation(buf.x[i], buf.y[i]);
      satSum += s;
      if (s > peakSat) peakSat = s;
      if (s >= HUE_DEAD_ZONE) {
        const bin = (_yc.scopeHueDeg(buf.x[i], buf.y[i]) / 10) | 0;
        hueHist[bin < HUE_BINS ? bin : HUE_BINS - 1]++;
      }
    }
  }

  let satTotal = 0;
  for (let i = 0; i < HUE_BINS; i++) satTotal += hueHist[i];

  // Top 2 populated hue bins.
  const ranked = [];
  for (let i = 0; i < HUE_BINS; i++) ranked.push(i);
  ranked.sort((a, b) => hueHist[b] - hueHist[a]);

  const dominant = [];
  for (let k = 0; k < 2 && satTotal > 0; k++) {
    const bin = ranked[k];
    const pct = hueHist[bin] / satTotal;
    if (pct < 0.02) break;     // not a meaningful concentration
    dominant.push({
      deg: Math.round(bin * 10 + 5),
      name: HUE_NAMES[bin],
      pct
    });
  }

  return {
    total,
    peakSat,
    avgSat: total > 0 ? satSum / total : 0,
    dominant
  };
}

if (typeof module !== 'undefined') {
  module.exports = { computeStats, HUE_NAMES, HUE_BINS, HUE_DEAD_ZONE };
}
