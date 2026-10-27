# AI Agent Prompt: Advanced Photoshop UXP Vectorscope Panel

**Role:** You are an expert Adobe UXP (Unified Extensibility Platform) developer specializing in high-performance Photoshop plugins.

**Task:** Develop a custom Photoshop UXP Panel (Manifest v5) that functions as an advanced Vectorscope for still-image color correction and analysis. The tool must provide pseudo real-time color information matching native Photoshop performance standards.

## Technical Stack & Requirements

* **Platform:** Adobe Photoshop UXP (API Version 2+, Manifest v5, target year 2026).

* **Frontend:** Vanilla JavaScript (or React) with HTML5 and CSS.

* **Rendering:** Use HTML5 `<canvas>` elements (Canvas 2D or WebGL) to draw the Vectorscope graticules (targets for R, Mg, B, Cy, G, Yl) and plot the pixel data.

* **Image Data Extraction:** Strictly use the `@photoshop/imaging` API to extract pixel data.

## Phase 1: Core Logic & Architecture

1. **Downsampling for Performance:** Never read the full-resolution document. Use the `imaging.getPixels()` method to fetch a low-resolution proxy of the active document (e.g., downsampled to 256x256 or 512x512 max). This is critical to prevent UI blocking.

2. **Color Space Conversion:** Iterate through the extracted RGB pixel array and convert the RGB values to the YCbCr color space.

   * Map the Cb and Cr components to Cartesian coordinates (X and Y) to plot them on the circular vectorscope canvas.

   * Calculate hue as the angle and saturation as the distance from the center.

3. **Pseudo Real-Time Updates:**

   * Set up event listeners for Photoshop document changes (e.g., `historyStateChanged` or `imageChanged` via the `photoshop.action` or `photoshop.app.eventNotifier` APIs).

   * Implement a throttle mechanism (e.g., 250ms - 500ms) on the update function to ensure the panel updates smoothly during brush strokes or adjustment layer tweaks without lagging the host application.

4. **Base UI/UX:** Dark, professional theme matching Photoshop's native UI (using Spectrum Web Components). Include a manual "Refresh" button as a fallback.

## Phase 2: Advanced Analysis Features (For Color Grading)

Since the primary use case is still-image color correction, prioritize precision and color statistics over absolute frame rate:

1. **Skin Tone Line (I-Line):**

   * Draw a permanent, toggleable reference line on the vectorscope canvas radiating from the center towards the \~123-degree mark (between Red and Yellow targets) to indicate universal human skin tone.

2. **Center Zoom (White Balance Mode):**

   * Implement a "Zoom" UI toggle (e.g., 1x, 2x, 4x) that scales the canvas rendering matrix to magnify the center of the scope. This allows the user to detect micro-color casts in near-neutral pixels.

3. **Selection & Layer Isolation:**

   * Modify the `@photoshop/imaging` extraction logic to respect active selections. If a selection marquee (Lasso, Magic Wand, Object Select) is active, only process the pixels within those bounds.

   * Add a dropdown in the UI to choose the Data Source: "Composite (Entire Image)" vs. "Active Layer Only".

4. **Tonal Range Separation (Shadows, Midtones, Highlights):**

   * Implement Luma-based filtering. During the RGB-to-YCbCr conversion, use the calculated 'Y' (Luminance) value to categorize pixels into three tonal buckets: Shadows (e.g., Luma < 30%), Midtones (30% - 70%), and Highlights (Luma > 70%).
   
   * **UI Implementation:** Add a segmented control in the UI to switch the active view between "Global", "Shadows", "Midtones", and "Highlights". 
   
   * **Split View Mode:** Provide a layout option to display three smaller, side-by-side (or vertically stacked) vectorscope canvases to visualize the three tonal ranges simultaneously.

5. **Density Mapping (Heatmap Trace):**

   * Instead of drawing solid opaque dots, implement a density map algorithm. Plot points with very low opacity (e.g., `rgba(0, 255, 0, 0.05)`), or use a false-color heatmap lookup table based on pixel accumulation. This reveals dominant color palette volumes visually.

6. **Luma-Mapped Opacity/Size:**

   * When mapping RGB to YCbCr in the Global view, use the 'Y' (Luminance) value to influence the brightness or size of the plotted dot on the canvas, providing a pseudo-3D representation of color volume.

7. **Color Statistics HUD (Heads Up Display):**

   * Overlay a minimal text block on the UI displaying calculated data from the current sample:

     * *Peak Saturation:* (Percentage 0-100%) highlighting if colors are clipping at the vectorscope's edge.

     * *Avg Saturation:* (Percentage).

     * *Dominant Hues:* Calculate and display the top 1 or 2 most populated hue angles (in degrees or color names).

## Deliverables & Constraints

1. Provide the `manifest.json` configured for a UXP panel.

2. Provide the `index.html` structure.

3. Provide the `main.js` containing UXP API calls, event listeners, imaging API integration, RGB-to-YCbCr math, tonal separation logic, and the Canvas drawing loops.

4. **Memory Management:** Strictly ensure that any image data objects or pixel buffers are disposed of immediately after rendering to prevent memory leaks in Photoshop. Ensure complex heatmap math and multi-canvas rendering do not freeze the main UXP JavaScript thread.