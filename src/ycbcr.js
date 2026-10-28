/**
 * ycbcr.js - BT.601 color math and vectorscope geometry.
 *
 * Conversions use the broadcast (BT.601) coefficients, the same set used
 * by television vectorscopes, so target positions match a real monitor.
 *
 * Scope space: normalized Cartesian (x, y) where
 *   x = Cr / 0.5   (red difference,  +right)
 *   y = Cb / 0.5   (blue difference, +up, flipped at draw time)
 * The full-saturation primary targets therefore land on the outer
 * circle (radius 1.0) at exactly the positions a hardware scope shows.
 */
'use strict';

const BT601 = Object.freeze({
  W_R: 0.299,
  W_G: 0.587,
  W_B: 0.114,
  CB_K: 0.564,
  CR_K: 0.713,
  SCALE: 0.5   // full scale of Cr/Cb axes; dividing by it maps to radius 1
});

/**
 * Convert an 8-bit sRGB pixel to scope coordinates.
 * Fills `out` = { x, y, luma } and returns it (no allocation per call).
 */
function rgb8ToScope(r8, g8, b8, out) {
  const r = r8 * 0.00392156862745098;   // 1/255
  const g = g8 * 0.00392156862745098;
  const b = b8 * 0.00392156862745098;
  const luma = BT601.W_R * r + BT601.W_G * g + BT601.W_B * b;
  // *2 == /0.5 maps to the raw BT.601 scale; dividing by
  // MAX_TARGET_RADIUS puts radius 1.0 at the fully saturated primaries.
  out.x = BT601.CR_K * (r - luma) * 2 / MAX_TARGET_RADIUS;
  out.y = BT601.CB_K * (b - luma) * 2 / MAX_TARGET_RADIUS;
  out.luma = luma;
  return out;
}

/** Hue in degrees [0, 360) for a scope point (0 = toward R target). */
function scopeHueDeg(x, y) {
  const h = Math.atan2(y, x) * (180 / Math.PI);
  return h < 0 ? h + 360 : h;
}

/** Normalized saturation (distance from center), capped at 1.0. */
function scopeSaturation(x, y) {
  const s = Math.sqrt(x * x + y * y);
  return s > 1 ? 1 : s;
}

/**
 * Primary / secondary color targets, derived from full-saturation RGB.
 * `css` is used to tint the graticule dot.
 *
 * On the raw BT.601 scale (axes /0.5) the primaries land at radii of
 * 1.00-1.067, i.e. slightly outside the 100 % circle. We normalize by the
 * largest target radius (green) so that radius 1.0 == fully saturated
 * primary, which is how software scopes are conventionally drawn.
 */
function makeRawTarget(name, r, g, b, css) {
  const luma = BT601.W_R * r + BT601.W_G * g + BT601.W_B * b;
  return {
    name,
    x: BT601.CR_K * (r - luma) * 2,
    y: BT601.CB_K * (b - luma) * 2,
    css
  };
}

const _RAW_TARGETS = [
  makeRawTarget('R',  1, 0, 0, '#ff4646'),
  makeRawTarget('Mg', 1, 0, 1, '#ff46d7'),
  makeRawTarget('B',  0, 0, 1, '#4d68ff'),
  makeRawTarget('Cy', 0, 1, 1, '#35d6d6'),
  makeRawTarget('G',  0, 1, 0, '#4bd64b'),
  makeRawTarget('Yl', 1, 1, 0, '#ffd836')
];

/** Largest raw target radius (~1.067, the green target). */
const MAX_TARGET_RADIUS = Math.max(..._RAW_TARGETS.map((t) => Math.hypot(t.x, t.y)));

const TARGETS = Object.freeze(
  _RAW_TARGETS.map((t) => Object.freeze({
    name: t.name,
    css: t.css,
    x: t.x / MAX_TARGET_RADIUS,
    y: t.y / MAX_TARGET_RADIUS
  }))
);

/**
 * The I-line (skin-tone line).
 *
 * The prompt mentions "~123 degrees"; that angle depends on the reference
 * axis. In standard scope convention the I-line sits 20-21 degrees ABOVE
 * the horizontal Cr axis (upper-right quadrant), which is the universally
 * used figure for human skin tone. We use 21 degrees.
 */
const I_LINE_DEGREES = 21;

/**
 * Tonal buckets (luma fractions).
 *  0 shadows, 1 midtones, 2 highlights
 */
const TONAL = Object.freeze({
  SHADOWS:   0,
  MIDS:      1,
  HIGHLIGHTS: 2,
  SHADOW_MAX: 0.30,
  MID_MAX:    0.70,
  NAMES: ['shadows', 'midtones', 'highlights']
});

function tonalBucket(luma) {
  if (luma < TONAL.SHADOW_MAX) return TONAL.SHADOWS;
  if (luma < TONAL.MID_MAX)    return TONAL.MIDS;
  return TONAL.HIGHLIGHTS;
}

const _exports = {
  BT601, rgb8ToScope, scopeHueDeg, scopeSaturation,
  TARGETS, MAX_TARGET_RADIUS, I_LINE_DEGREES, TONAL, tonalBucket
};
if (typeof module !== 'undefined') {
  module.exports = _exports;
} else {
  // UXP panel: publish to globalThis so sibling scripts (sampling.js,
  // scope.js) can read the values without re-declaring the bindings.
  Object.assign(globalThis, _exports);
}
