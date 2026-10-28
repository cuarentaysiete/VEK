# VEK, a vectorscope for Photoshop

A  **vectorscope** panel for Adobe Photoshop, built on the **UXP**
extension platform. It gives still-image colorists the circular color-space
view that video engineers have had for decades: the whole image (or a
selection, or one tonal range) plotted as Cr/Cb cloud, with phosphor-trace
or false-color density rendering, a skin-tone I-line, center zoom for
white-balance work, and a live statistics HUD.

---

## Features

| Area | What it does |
|---|---|
| **Graticule** | Standard six-target scope (R, Mg, B, Cy, G, Yl) with 25/50/75/100 % rings, rendered on HTML5 Canvas 2D. |
| **Trace plot** | Phosphor-green dots at low opacity. Dot brightness and size follow BT.601 luma, giving a pseudo-3D color-volume read (prompt item 6). |
| **Heatmap plot** | False-color (ironbow) density map built from a per-cell pixel accumulation buffer, revealing dominant palette volumes (prompt item 5). |
| **I-line** | Toggleable 21-degree skin-tone reference line (see "Design decisions"). |
| **Center zoom** | 1x / 2x / 4x magnification of the scope center for detecting micro color casts in near-neutral pixels (white-balance mode). |
| **Tonal separation** | Luma buckets: shadows (< 30 %), midtones (30-70 %), highlights (> 70 %). View one, or a **split view** with three scopes side by side. |
| **Data source** | Composite (entire image) or active layer only. |
| **Selection awareness** | If a marquee / lasso / magic-wand / object selection is active, only pixels inside its bounds are processed. |
| **Stats HUD** | Peak saturation (warns above 95 % = clipping at the scope edge), average saturation, top two dominant hues. |
| **Pseudo real-time** | Subscribes to `eventNotifier` document/history/selection events; leading-edge throttle of 300 ms keeps brush strokes and adjustment tweaks smooth without blocking the host. Manual **REFRESH** button as fallback. |

## Requirements

* Adobe Photoshop 2022 (v23.0) or newer, desktop. UXP is required;
  this plugin does **not** run in Photoshop on the web or in CC Classic/ExtendScript panels.
* Windows or macOS.

## Installation

**Development (recommended): Adobe UXP Developer Tool.**

1. Open the UXP Developer Tool (ships with the Creative Cloud app, or download
   it from the Adobe UXP site) and select **Adobe Photoshop** as the host.
   Photoshop must be running (or will be launched).
2. **Action: Add Plugin** and pick this repository's folder - the one that
   contains `manifest.json`.
3. The panel appears under **Window > Extensions > VEK**.
   Remove it again with **Action: Remove Plugin** when iterating.

**Production-style load:** in Photoshop, **Window > Extensions > Other Scripts /
Plugins** (naming varies by version), select the folder, and the panel opens
under *Window > Extensions*. To uninstall, remove the entry in the same dialog.

> Development tip: with the Developer Tool attached you can open the panel's
> DevTools console (the UXP inspector) - the panel reports its error state in
> the HUD status line and to that console.

## Usage

1. Open an image. The panel samples it automatically on load.
2. Make adjustments (curves, color balance, white point, brush work). The
   scope re-samples within 300 ms of each committed change.
3. Typical workflows:
   * **White balance** - Zoom 2x/4x, Trace mode, watch the cloud center drift
     off the crosshair; pull it back to center.
   * **Skin check** - I-line on, zoom 2x; skin should cluster on or near the
     line, slightly below for warm lighting.
   * **Palette audit** - Heatmap mode, Global or Split view: see where your
     color volume actually lives and which ranges are dead.
   * **Selection grading** - Select a subject; the scope then shows only that
     region, so local adjustments do not hide behind the global average.

## Architecture

```
index.html        panel markup
style.css         Spectrum-style dark theme (hand-rolled; external file because
                  UXP's default CSP forbids inline <style> blocks)
main.js           orchestration: sampling pipeline, events, throttle, UI wiring
src/ycbcr.js      BT.601 math, scope geometry, targets, I-line, tonal buckets
src/sampling.js   pixel buffer normalization + stride sampling (pure, unit-tested)
src/stats.js      peak/avg saturation, dominant-hue histogram
src/scope.js      ScopeView: canvas renderer (graticule cache, trace, heatmap)
icons/            panel icons referenced by the manifest
```

### Data pipeline (per refresh)

```
Photoshop doc --imaging.getPixels({targetSize})--> PhotoshopImageData
   |  (Photoshop downscales server-side; buffer long edge = sample size,
   |   so full-resolution data is never materialized; pyramid cache used
   |   when available - the returned level is shown in the status bar)
   v
8-bit chunky pixels --stride guard--> RGB samples (<= 256x256 / 512x512)
   v
RGB -> YCbCr (BT.601):  x = Cr/0.5, y = Cb/0.5,  luma = Y
   v
selection-bounds filter --> tonal bucket split (shadows / mids / highlights)
   v
ScopeView render (trace or heatmap, zoomed) + statistics HUD
   v
imageData.dispose() immediately after the sampling pass
```

All imaging calls run inside `core.executeAsModal()` (apiVersion 2, the
modal JavaScript paradigm).

### Memory management

* `imaging.getPixels()` does the downscale **on the Photoshop side**; the
  JavaScript heap only ever holds a buffer whose long edge is the selected
  sample size (256 or 512 px) - at most ~1 MB for 512 px RGB. Full-resolution
  buffers are never materialized (prompt item 1, Phase 1).
* The `PhotoshopImageData` handle is `dispose()`-d as soon as the sampling
  pass finishes; `getData()` is awaited inside a `try/finally` so the handle
  is released even when the read fails.
* All per-pixel work writes into **pre-allocated, reusable** `Float32Array`
  buckets; the hot loop performs zero allocations.
* Rendering is synchronous Canvas 2D but bounded (a 512 sample is 262 k
  points worst case), so the JS main thread never blocks for more than a
  frame or two - satisfying the "no UI freeze" constraint (prompt:
  Deliverables, item 4).

### Design decisions & deviations from the prompt

The prompt is a brief, not a runnable spec; where it was ambiguous or
physically impossible in UXP, these decisions were made:

1. **Downsampling.** `imaging.getPixels()` accepts a `targetSize`, so
   Photoshop downscales the pixels before they reach JavaScript; the CPU
   stride pass is kept only as a guard (and for the 256 preset). This is
   exactly the "downsampled proxy" the prompt asks for, done natively.
   The buffer is requested in 8-bit RGB (matted on white), which is the
   correct depth for scope work.
2. **Spectrum Web Components.** Bundling the full `@adobe/spectrum-web-components`
   package (~hundreds of KB, many files) for five controls would bloat the
   plugin and slow UXP startup. The dark theme reproduces Spectrum's visual
   language in ~4 KB of CSS instead.
3. **I-line angle.** The prompt says "~123 degrees". That number depends on
   the reference axis; in standard scope convention the skin-tone line sits
   **21 degrees above the horizontal Cr axis** (the universally quoted
   figure). We use 21 degrees; the constant is `I_LINE_DEGREES` in
   `src/ycbcr.js` if you want to debate it.
4. **Selection = bounding box.** The action-manager selection query returns
   vector paths, not a pixel mask. Rasterizing arbitrary lasso paths into a
   per-pixel mask on every refresh was deemed too costly for the 300 ms
   budget; we use the selection **bounds** (rectangular marquee: exact;
   lasso/magic-wand/object-select: enclosing box). The HUD status bar shows
   `[selection]` so you always know which mode is active.
5. **Throttle model.** "250-500 ms" becomes a 300 ms *leading-edge*
   throttle: the first event after a quiet period samples immediately,
   subsequent events during an active gesture (brush stroke) are dropped
   until 300 ms have passed. This keeps perceived latency low and CPU flat.
6. **Target year 2026 / API version 2.** Manifest v5 with the Photoshop
   `host` object and `apiVersion: 2`; pixels come from `imaging.getPixels()
   ({ targetSize })`, which downscales on the Photoshop side, so no
   full-resolution buffer is ever built in JavaScript.
7. **IIFE module packaging.** UXP executes every `<script>` of a panel in
   **one shared global scope** and does not expose CommonJS `require`
   between local files. Each `src/*.js` is therefore wrapped in an IIFE
   that publishes its API on `globalThis` (`VSyc`, `VSsampling`, `VSstats`,
   `VSscope`) and, when running under Node, also sets `module.exports`.
   `test/uxp-scope.test.js` replays the shared-scope load in a `vm`
   context to regression-test this.

## Testing

The color math and statistics are unit-tested in Node (no Photoshop needed):

```bash
npm test            # test/unit.test.js + test/uxp-scope.test.js (node:test)
```

The shared-scope test loads all four `src/` files into a single `vm`
context without `module` / `require` / `process` - the exact UXP conditions
that broke the panel in the field ("Identifier '_yc' has already been
declared").

Full behavior (event timing, imaging module, selection) requires the real
Photoshop host; the DevTools workflow above is the practical loop.

## Troubleshooting

**"Validate command successfull ... Load command failed".** Enable
**Developer Mode inside Photoshop**: *Plugins > Development > Enable
Developer Mode*, then **restart Photoshop** and load again from the UXP
Developer Tool. Recent Photoshop builds refuse to load Developer-Tool-added
plugins until that switch is on, even though the manifest validates fine.

**"Invalid Manifest File" in the UXP Developer Tool.** The manifest must use
`manifestVersion: 5` with a *host object* (not an array) and the Photoshop
`data.apiVersion: 2` flag; the imaging API is reached through the regular
`photoshop` module, so no `modules` section is needed:

```json
"host": { "app": "PS", "minVersion": "23.3.0", "data": { "apiVersion": 2 } },
"manifestVersion": 5
```

**"Expected the icon to have a 1X scaled file" (Load failed).** Recent
Photoshop builds validate icon *files* against the declared scale: one icon
entry per scale factor, each pointing at a file whose pixel size equals
`width x scale` (e.g. a 23 px logical icon needs both a 23 px file with
`"scale": [1]` and a 46 px file with `"scale": [2]`). A single file claiming
`"scale": [1, 2]` fails the check.

If your build still rejects the manifest, lower `minVersion` to `"23.0"` and
confirm the panel loads in *Window > Extensions* inside Photoshop itself (the
Developer Tool validates a slightly different schema than the host).

**Panel loads but the scope shows an error.** The HUD status line reports the
buffer the host actually returned, e.g.
`sampled in 42 ms - 512x341 RGB lvl1`. If red and blue look swapped, that
value tells us the channel layout your build uses; extend `channelLayout()` in
`src/sampling.js` accordingly.

**Nothing updates while I paint.** Auto-updates subscribe to the UXP event
notifier; some builds only fire `DOCUMENT_CHANGED` when the tool is released.
The REFRESH button always works, and the 300 ms leading-edge throttle keeps
it non-blocking.

## Roadmap

* Per-pixel selection mask via vector-path rasterization (opt-in, slower).
* WebGL rendering path for 1 k+ point traces.
* Waveform + VU-meter siblings sharing the same pipeline.
* Histogram of luma alongside the scope.

## License

MIT - see `LICENSE`.
