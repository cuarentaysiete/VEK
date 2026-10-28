/**
 * main.js - VektorShop Vectorscope orchestration.
 *
 * Pipeline (per refresh):
 *   1. Resolve the active document and any active selection bounds.
 *   2. Read pixels via the Photoshop imaging API ONLY, using
 *      imaging.getPixels() with a targetSize so Photoshop downscales
 *      server-side: the buffer is always <= the sample size (256/512 px
 *      long edge). Full-resolution buffers are never materialized and no
 *      document duplication/resizing via the action manager is needed.
 *   3. Stride-sample (guard), convert RGB -> YCbCr (BT.601), split into
 *      tonal buckets, filter by selection.
 *   4. Render scope views, compute statistics, dispose the image data.
 *
 * Memory policy: the PhotoshopImageData handle is dispose()-d as soon as the
 * sampling pass finishes; the typed arrays handed to rendering are reusable
 * buffers, never copies of the document buffer.
 */
'use strict';
(() => {
  // Photoshop UXP exposes every API (app, action, core, imaging) on the
  // single 'photoshop' module; '@photoshop/*' paths are fallbacks for
  // older builds.
  let photoshop;
  try { photoshop = require('photoshop'); }
  catch (e) { photoshop = require('@photoshop'); }
  const { app, action } = photoshop;
  const core = photoshop.core || {};
  const imaging = photoshop.imaging || (typeof require === 'function' ? (function () {
    try { return require('@photoshop/imaging'); } catch (e) { return null; }
  })() : null);

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  const THROTTLE_MS = 300;                    // minimum spacing between samples

  const state = {
    auto: true,
    source: 'composite',      // 'composite' | 'layer'
    tonal: 'global',          // 'global' | 'shadows' | 'mids' | 'highlights'
    layout: 'single',         // 'single' | 'split'
    zoom: 1,                  // 1 | 2 | 4
    sampleSize: 256,          // downsample target (256 | 512)
    mode: 'trace',            // 'trace' | 'heatmap'
    iLine: true,
    busy: false
  };

  // ------------------------------------------------------------------
  // DOM handles
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const ui = {
    docInfo: $('doc-info'),
    status: $('status'),
    refresh: $('btn-refresh'),
    auto: $('chk-auto'),
    source: $('sel-source'),
    iline: $('chk-iline'),
    tag: $('tag-single'),
    hud: { peak: $('hud-peak'), avg: $('hud-avg'), hues: $('hud-hues'), samples: $('hud-samples') }
  };

  const views = {
    main: new ScopeView($('scope-main')),
    shadows: new ScopeView($('scope-shadows')),
    mids: new ScopeView($('scope-mids')),
    highlights: new ScopeView($('scope-highlights'))
  };

  // Tonal point buffers (reallocated only when capacity must grow).
  let buffers = [
    { x: new Float32Array(0), y: new Float32Array(0), luma: new Float32Array(0), n: 0 },
    { x: new Float32Array(0), y: new Float32Array(0), luma: new Float32Array(0), n: 0 },
    { x: new Float32Array(0), y: new Float32Array(0), luma: new Float32Array(0), n: 0 }
  ];
  let capacity = 0;

  function ensureCapacity(maxN) {
    if (maxN <= capacity) return;
    capacity = Math.max(maxN, 65536);
    for (let i = 0; i < 3; i++) {
      buffers[i].x = new Float32Array(capacity);
      buffers[i].y = new Float32Array(capacity);
      buffers[i].luma = new Float32Array(capacity);
    }
  }

  // ------------------------------------------------------------------
  // Status / HUD helpers
  // ------------------------------------------------------------------
  function setStatus(msg, cls) {
    ui.status.textContent = msg;
    ui.status.className = cls || '';
  }

  function setBusy(b) {
    state.busy = b;
    ui.refresh.disabled = b;
  }

  function fmtCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function updateDocInfo(doc, hadSelection) {
    ui.docInfo.textContent =
      `${doc.name} - ${doc.width}x${doc.height} px` + (hadSelection ? ' [selection]' : '');
  }

  function updateHud(stats, ms, sampleSize) {
    ui.hud.peak.textContent = (stats.peakSat * 100).toFixed(1) + '%';
    ui.hud.peak.className = 'v' + (stats.peakSat > 0.95 ? ' warn' : '');
    ui.hud.avg.textContent = (stats.avgSat * 100).toFixed(1) + '%';
    ui.hud.hues.textContent = stats.dominant.length
      ? stats.dominant.map((d) => `${d.deg} deg ${d.name}`).join('  |  ')
      : '-';
    ui.hud.samples.textContent =
      `${fmtCount(stats.total)} px (of ${fmtCount(sampleSize * sampleSize)} sampled)`;
    if (!state.busy) {
      setStatus(`sampled in ${Math.round(ms)} ms`, 'busy' === 'x' ? '' : '');
    }
  }

  /**
   * Run a function inside Photoshop's modal JavaScript scope (apiVersion 2).
   * Falls back to a plain call on builds without executeAsModal.
   */
  function runModal(fn) {
    if (typeof core.executeAsModal === 'function') return core.executeAsModal(fn);
    return fn();
  }

  // ------------------------------------------------------------------
  // Selection bounds (original document, pixels)
  // ------------------------------------------------------------------
  function getSelectionBounds() {
    try {
      const res = action.batchPlay([{ _object: 'get', _class: 'selection', _noUndo: true }])[0];
      const r = res && res.rect;
      if (!r) return null;
      const v = (u) => (typeof u === 'number' ? u : (u && u._value));
      const left = v(r.left), top = v(r.top), right = v(r.right), bottom = v(r.bottom);
      if ([left, top, right, bottom].some((x) => x == null)) return null;
      if (left >= right || top >= bottom) return null;
      return { left, top, right, bottom };
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // The pixel loop lives in src/sampling.js (unit-tested in Node; loaded
  // as a plain script in the panel, so sampleInto() is a global here).
  // This wrapper only manages buffer capacity, then delegates.
  function sampleIntoDoc(imData, sel, srcW, srcH) {
    const w = imData.width, h = imData.height;
    if (!w || !h) return 0;
    const stride = Math.max(1, Math.ceil(Math.max(w, h) / state.sampleSize));
    ensureCapacity(Math.ceil(w / stride) * Math.ceil(h / stride) + 4);
    return sampleInto(imData, sel, srcW, srcH, state, buffers);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function applyViewSettings(view) {
    view.setZoom(state.zoom);
    view.setMode(state.mode);
    view.setIline(state.iLine);
  }

  /** Render one tonal bucket (index 0..2) onto a view. */
  function renderView(view, i) {
    view.render(buffers[i].x, buffers[i].y, buffers[i].luma, buffers[i].n);
    if (buffers[i].n === 0) view.emptyNote();
  }

  /**
   * Render the main (single-layout) view from retained buffers.
   * "global" merges all three tonal buckets into one frame.
   */
  function renderMainFromBuffers() {
    applyViewSettings(views.main);
    views.main.beginFrame();
    if (state.tonal === 'global') {
      let total = 0;
      for (let i = 0; i < 3; i++) {
        total += buffers[i].n;
        views.main.plot(buffers[i].x, buffers[i].y, buffers[i].luma, buffers[i].n, false);
      }
      views.main.plot(0, 0, 0, 0);   // flush any pending heatmap grid
      if (total === 0) views.main.emptyNote();
    } else {
      const idx = state.tonal === 'shadows' ? 0 : state.tonal === 'mids' ? 1 : 2;
      renderView(views.main, idx);
    }
  }

  /** Redraw from the retained buffers (no resample): used by view-only changes. */
  function redrawLast() {
    if (state.layout === 'split') {
      applyViewSettings(views.shadows);
      applyViewSettings(views.mids);
      applyViewSettings(views.highlights);
      renderView(views.shadows, 0);
      renderView(views.mids, 1);
      renderView(views.highlights, 2);
    } else {
      renderMainFromBuffers();
    }
  }

  /**
   * Read (downsampled) pixels of the active document (or the active layer)
   * through the imaging API. Photoshop performs the downscale server-side
   * via targetSize, so the returned buffer is small by construction.
   *
   * Returns { width, height, channelOrder, data, pixelFormat, level } or
   * null when the read produced no pixels.
   */
  async function readPixels(doc, layerId) {
    const opts = {
      documentID: doc.id,
      colorSpace: 'RGB',
      componentSize: 8,
      applyAlpha: true
    };
    if (typeof layerId === 'number') opts.layerID = layerId;
    // Ask for the sample size directly; a single dimension keeps aspect ratio.
    if (doc.width >= doc.height) opts.targetSize = { width: state.sampleSize };
    else opts.targetSize = { height: state.sampleSize };

    const obj = await runModal(async () => imaging.getPixels(opts));
    const img = obj && obj.imageData;
    if (!img) return null;
    let norm;
    try {
      const data = await img.getData({ chunky: true });
      norm = {
        width: img.width,
        height: img.height,
        channelOrder: img.pixelFormat || img.channelOrder || '',
        data,
        pixelFormat: img.pixelFormat || '',
        level: obj && obj.level != null ? obj.level : -1
      };
    } finally {
      if (typeof img.dispose === 'function') img.dispose();
    }
    if (!norm.data || !norm.width || !norm.height) return null;
    return norm;
  }

  // ------------------------------------------------------------------
  // Refresh pipeline
  // ------------------------------------------------------------------
  async function refresh() {
    if (state.busy) return;
    setBusy(true);
    setStatus('sampling...');
    const t0 = performance.now();
    let norm = null;
    try {
      const doc = app.activeDocument;
      if (!doc) {
        setStatus('No document open', 'error');
        return;
      }
      if (!imaging || typeof imaging.getPixels !== 'function') {
        setStatus('Imaging API unavailable in this Photoshop build', 'error');
        return;
      }
      const sel = getSelectionBounds();
      updateDocInfo(doc, !!sel);

      // Layer source: the UXP core Layer exposes an id on current builds.
      let layerId;
      if (state.source === 'layer') {
        const layer = doc.activeLayer;
        layerId = layer && typeof layer.id === 'number' ? layer.id : undefined;
      }

      norm = await readPixels(doc, layerId);
      if (!norm) throw new Error('Pixel read returned no data');
      if (norm.pixelFormat && !/rgb/i.test(norm.pixelFormat) && !/gray/i.test(norm.pixelFormat)) {
        throw new Error(`Unsupported pixel format '${norm.pixelFormat}' (open the document as RGB)`);
      }

      // The buffer is a (possibly pyramid-cached) downscale of the whole
      // document, so selection bounds must be expressed in buffer pixels.
      let bufSel = null;
      if (sel) {
        const sx = norm.width / doc.width;
        const sy = norm.height / doc.height;
        bufSel = {
          left: sel.left * sx, top: sel.top * sy,
          right: sel.right * sx, bottom: sel.bottom * sy
        };
      }

      const total = sampleIntoDoc(norm, bufSel, norm.width, norm.height);
      const ms = performance.now() - t0;

      // Rendering
      if (state.layout === 'split') {
        applyViewSettings(views.shadows);
        applyViewSettings(views.mids);
        applyViewSettings(views.highlights);
        renderView(views.shadows, 0);
        renderView(views.mids, 1);
        renderView(views.highlights, 2);
      } else {
        renderMainFromBuffers();
      }

      // Statistics (over whatever the view shows)
      const statBufs = state.layout === 'split' || state.tonal === 'global'
        ? [buffers[0], buffers[1], buffers[2]]
        : [buffers[state.tonal === 'shadows' ? 0 : state.tonal === 'mids' ? 1 : 2]];
      const stats = computeStats(statBufs);
      updateHud(stats, ms, state.sampleSize);
      setStatus(total > 0
        ? `sampled in ${Math.round(ms)} ms - ${norm.width}x${norm.height} ${norm.pixelFormat || norm.channelOrder}${norm.level >= 0 ? ' lvl' + norm.level : ''}`
        : 'no pixels in range', total > 0 ? '' : 'error');
    } catch (e) {
      setStatus(`Error: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // Throttling + Photoshop event subscription
  // ------------------------------------------------------------------
  let throttleTimer = 0;

  /** Leading-edge throttle: fire now, then ignore events for THROTTLE_MS. */
  function scheduleRefresh() {
    if (!state.auto || state.busy) return;
    if (throttleTimer) return;
    refresh().finally(() => {
      throttleTimer = setTimeout(() => { throttleTimer = 0; }, THROTTLE_MS);
    });
  }

  function bindEvents() {
    const notifier = app.eventNotifier;
    const types = app.EventNotifier && app.EventNotifier.NotificationEventType;
    if (!notifier || !types) {
      setStatus('Event notifier unavailable; use manual Refresh', 'error');
      return;
    }
    for (const name of ['DOCUMENT_CHANGED', 'HISTORY_STATE_CHANGED', 'ACTIVE_DOCUMENT_CHANGED', 'SELECTION_CHANGED']) {
      const t = types[name];
      if (t) notifier.on(t, scheduleRefresh);
    }
  }

  // ------------------------------------------------------------------
  // UI wiring
  // ------------------------------------------------------------------
  function wireSegment(id, key, afterChange) {
    const seg = $(id);
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b === btn);
      seg.dataset.value = btn.dataset.value;
      state[key] = btn.dataset.value;
      if (afterChange) afterChange();
    });
  }

  function wireUI() {
    ui.refresh.addEventListener('click', () => refresh());
    ui.auto.addEventListener('change', () => {
      state.auto = ui.auto.checked;
      if (state.auto) scheduleRefresh();
    });
    ui.source.addEventListener('change', () => { state.source = ui.source.value; refresh(); });
    ui.iline.addEventListener('change', () => { state.iLine = ui.iline.checked; redrawLast(); });

    wireSegment('seg-tonal', 'tonal', () => {
      ui.tag.textContent = state.tonal;
      redrawLast();
    });
    wireSegment('seg-layout', 'layout', () => {
      document.body.dataset.layout = state.layout;
      redrawLast();
    });
    wireSegment('seg-zoom', 'zoom', () => { state.zoom = Number(state.zoom); redrawLast(); });
    wireSegment('seg-sample', 'sampleSize', () => { state.sampleSize = Number(state.sampleSize); refresh(); });
    wireSegment('seg-mode', 'mode', () => redrawLast());
  }

  function onResize() {
    // Redraw with retained buffers; canvases re-sync their backing size.
    redrawLast();
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init() {
    wireUI();
    bindEvents();
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onResize);
      ro.observe($('scope-single'));
      ro.observe($('scope-split'));
    }
    setStatus('ready');
    scheduleRefresh();
  }

  init();
})();
