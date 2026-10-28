# VektorShop Vectorscope

An advanced **vectorscope** panel for Adobe Photoshop, built on the **UXP**
extension platform. It gives still-image colorists the circular color-space
view that video engineers have had for decades: the whole image (or a
selection, or one tonal range) plotted as Cr/Cb cloud, with phosphor-trace
or false-color density rendering, a skin-tone I-line, center zoom for
white-balance work, and a live statistics HUD.

Built to the specification in
[`docs/photoshop_uxp_vectorscope_prompt.md`](docs/photoshop_uxp_vectorscope_prompt.md).

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
3. The panel appears under **Window > Extensions > VektorShop Vectorscope**.
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
src/sampling.js   ImData normalization + stride sampling (pure, unit-tested)
src/stats.js      peak/avg saturation, dominant-hue histogram
src/scope.js      ScopeView: canvas renderer (graticule cache, trace, heatmap)
manifest.no-imaging.json  fallback manifest without the C++ imaging module
```

### Data pipeline (per refresh)

```
Photoshop doc --toImagingDocument--> ImDocument
   |  (> 8 Mpx docs: duplicated, resized to <= 512 px, read, closed unsaved)
   v
ImData (Int32Array, 8-bit) --stride downsample--> RGB samples (<= 256x256 / 512x512)
   v
RGB -> YCbCr (BT.601):  x = Cr/0.5, y = Cb/0.5,  luma = Y
   v
selection-bounds filter --> tonal bucket split (shadows / mids / highlights)
   v
ScopeView render (trace or heatmap, zoomed) + statistics HUD
   v
ImData / ImDocument released immediately after use
```

### Memory management

* The Photoshop imaging API has no server-side downsample, so documents above
  8 megapixels are **duplicated and resized to a 512 px proxy** before pixel
  read; the proxy is closed without saving and the original re-activated.
  Full-resolution buffers are never materialized (prompt item 1, Phase 1).
* `ImData` / `ImDocument` handles are `dispose()`-d (where the API exposes it)
  and dereferenced as soon as the sampling pass finishes.
* All per-pixel work writes into **pre-allocated, reusable** `Float32Array`
  buckets; the hot loop performs zero allocations.
* Rendering is synchronous Canvas 2D but bounded (a 512 sample is 262 k
  points worst case, typically far less after striding), so the JS main
  thread never blocks for more than a frame or two - satisfying the
  "no UI freeze" constraint (prompt: Deliverables, item 4).

### Design decisions & deviations from the prompt

The prompt is a brief, not a runnable spec; where it was ambiguous or
physically impossible in UXP, these decisions were made:

1. **Downsampling.** `@photoshop/imaging` exposes no downsampled
   `getPixels()`. We honor the *intent* (never materialize full-res
   buffers, bounded CPU) via the scaled-copy proxy + CPU stride sampling.
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
6. **Target year 2026 / API version 2.** Manifest v5, `requiredPhotoShopVersion
   23.0`, `@photoshop/imaging` (the JS imaging module) - all current.

## Testing

The color math and statistics are unit-tested in Node (no Photoshop needed):

```bash
npm test            # runs test/unit.test.js (node:test, zero dependencies)
```

Full behavior (event timing, imaging module, selection) requires the real
Photoshop host; the DevTools workflow above is the practical loop.

## Troubleshooting

**"Invalid Manifest File" in the UXP Developer Tool.** The imaging API in
Photoshop UXP is a *C++* module; it must be declared with its `cpp-*`
feature flags, not as an empty object:

```json
"modules": {
  "photoshop": { "scopes": ["app", "action", "core"] },
  "imaging": {
    "cpp-photostandard": true,
    "cpp-photoshop": true,
    "cpp-photoshop-composite": true
  }
}
```

(`core` is required for `toImagingDocument()` and `activeDocument`.) If your
build still rejects the manifest, copy `manifest.no-imaging.json` over
`manifest.json` to load the UI without pixel access, then paste the DevTools
console output so we can isolate which flag your build dislikes.

**Panel loads but the scope shows an error.** The HUD status line reports the
ImData shape the host actually returned, e.g.
`sampled in 42 ms - 512x341 bgra`. If red and blue look swapped, that value
tells us the channel layout your build uses; extend `channelLayout()` in
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
