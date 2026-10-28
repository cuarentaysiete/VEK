'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// UXP executes every <script> of a panel inside ONE shared global scope and
// does not expose CommonJS `module` / `require` / `process` to panel code.
// This test replays that exact environment to prove the src/ files can be
// loaded together (the "_yc already declared" regression from the field).
test('shared-scope load: all src files coexist and publish their APIs', () => {
  const ctx = vm.createContext({ console });
  const files = ['ycbcr.js', 'sampling.js', 'stats.js', 'scope.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }

  // Bundle handles
  assert.ok(ctx.VSyc, 'VSyc published');
  assert.ok(ctx.VSsampling, 'VSsampling published');
  assert.ok(ctx.VSstats, 'VSstats published');
  assert.ok(ctx.VSscope, 'VSscope published');

  // Bare names, exactly as main.js references them
  assert.equal(typeof ctx.rgb8ToScope, 'function');
  assert.equal(typeof ctx.sampleInto, 'function');
  assert.equal(typeof ctx.computeStats, 'function');
  assert.equal(typeof ctx.ScopeView, 'function');

  // Sanity: the math actually works through the shared scope.
  // Red sits right, slightly below the horizontal axis, near the rim.
  const o = { x: 0, y: 0, luma: 0 };
  ctx.rgb8ToScope(255, 0, 0, o);
  assert.ok(o.x > 0.85, `red sits right (x=${o.x})`);
  assert.ok(o.y < 0 && o.y > -0.5, `red slightly below center (y=${o.y})`);
  assert.ok(Math.hypot(o.x, o.y) > 0.9, `red near the rim (r=${Math.hypot(o.x, o.y)})`);
});
