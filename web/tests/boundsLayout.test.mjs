import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// boundsLayout imports nothing from the host, so it is compiled with the
// Studio checkout's esbuild and tested directly (as in sliceMath.test.mjs).
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const codeRoot = path.resolve(webRoot, '..', '..', '..');
const studioDir = process.env.WITWIN_STUDIO_DIR ?? path.join(codeRoot, 'witwin-studio', 'studio');
const esbuild = createRequire(path.join(studioDir, 'package.json'))('esbuild');

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-volume-')), 'module.mjs');
await esbuild.build({ entryPoints: [path.join(webRoot, 'src/gizmos/boundsLayout.ts')], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const layout = await import(pathToFileURL(out).href);

const box = { min: [-1, -2, -3], max: [1, 2, 3] };
const byId = (handles) => Object.fromEntries(handles.map((h) => [h.id, h]));

test('3D layout puts a rect on the near face plus two depth handles', () => {
  const handles = layout.buildBoundsHandles(box, 2, 'max', true);
  assert.equal(handles.length, 10);
  assert.equal(handles.filter((h) => h.kind === 'corner').length, 4);
  assert.equal(handles.filter((h) => h.kind === 'edge').length, 4);
  const h = byId(handles);
  // Corners and sides sit on z = max.
  for (const spec of handles.filter((s) => s.kind !== 'face')) assert.equal(spec.position[2], 3);
  assert.deepEqual(h['corner-min-max'].position, [-1, 2, 3]);
  assert.deepEqual(h['corner-min-max'].axes, [0, 1]);
  assert.deepEqual(h['edge-0-max'].segment, [[1, -2, 3], [1, 2, 3]]);
  assert.equal(h['edge-0-max'].edgeAxis, 1);
  assert.deepEqual(h['face-min'].position, [0, 0, -3]);
  assert.equal(h['face-min'].back, true);
  assert.equal(h['face-max'].back, false);
});

test('2D layout has no depth handles', () => {
  const handles = layout.buildBoundsHandles(box, 1, 'min', false);
  assert.equal(handles.length, 8);
  assert.ok(handles.every((h) => h.position[1] === -2));
});

test('facing axis keeps the current face until another is clearly squarer', () => {
  assert.equal(layout.pickFacingAxis([0.2, 1, 0.3], null), 1);
  // Just past the diagonal: stays on the current axis.
  assert.equal(layout.pickFacingAxis([1.05, 1, 0], 1), 1);
  assert.equal(layout.pickFacingAxis([1.3, 1, 0], 1), 0);
});

test('a side drag moves one bound and clamps at one cell', () => {
  const h = byId(layout.buildBoundsHandles(box, 2, 'max', true));
  let next = layout.applyBoundsDrag(box, h['edge-0-max'], [2.5, 0, 3], 0.5);
  assert.deepEqual(next, { min: [-1, -2, -3], max: [2.5, 2, 3] });
  next = layout.applyBoundsDrag(box, h['edge-0-max'], [-5, 0, 3], 0.5);
  assert.deepEqual(next.max[0], -0.5);
});

test('snap makes the size a whole number of cells', () => {
  const h = byId(layout.buildBoundsHandles(box, 2, 'max', true));
  const next = layout.applyBoundsDrag(box, h['edge-0-max'], [1.3, 0, 3], 0.5, { snap: true, symmetric: false, uniform: false });
  assert.equal(next.max[0], 1.5); // size 2.3 -> 2.5
});

test('symmetric drag keeps the centre', () => {
  const h = byId(layout.buildBoundsHandles(box, 2, 'max', true));
  const next = layout.applyBoundsDrag(box, h['edge-0-max'], [2, 0, 3], 0.1, { snap: false, symmetric: true, uniform: false });
  assert.deepEqual([next.min[0], next.max[0]], [-2, 2]);
});

test('uniform corner drag keeps the aspect ratio', () => {
  const h = byId(layout.buildBoundsHandles(box, 2, 'max', true));
  const next = layout.applyBoundsDrag(box, h['corner-max-max'], [3, 2.2, 3], 0.01, { snap: false, symmetric: false, uniform: true });
  // x went 2 -> 4 (ratio 2), so y goes 4 -> 8 from its min.
  assert.equal(next.max[0], 3);
  assert.equal(next.max[1], 6);
});

test('lengths and cell counts read as a person would write them', () => {
  assert.equal(layout.formatLength(2.5), '2.5 m');
  assert.equal(layout.formatLength(0.0125), '12.5 mm');
  assert.equal(layout.formatLength(8e-6), '8 µm');
  assert.deepEqual(layout.cellCounts(box, 0.5), [4, 8, 12]);
});

test('without a cell size the floor and snap step follow the box size', () => {
  const tiny = { min: [-4e-6, -4e-6, -4e-6], max: [4e-6, 4e-6, 4e-6] };
  const h = byId(layout.buildBoundsHandles(tiny, 2, 'max', true));
  // A drag far past the opposite side stops at 0.1 % of the box, not at a metre-scale default.
  const flat = layout.applyBoundsDrag(tiny, h['edge-0-max'], [-1, 0, 4e-6], null);
  assert.ok(Math.abs(flat.max[0] - flat.min[0] - 8e-9) < 1e-15);
  assert.ok(Math.abs(layout.roundStep(tiny) - 1e-7) < 1e-18);
  const snapped = layout.applyBoundsDrag(tiny, h['edge-0-max'], [5.23e-6, 0, 4e-6], null, { snap: true, symmetric: false, uniform: false });
  assert.ok(Math.abs(snapped.max[0] - 5.2e-6) < 1e-12); // size 9.23 µm -> 9.2 µm
  assert.equal(layout.roundStep(box), 0.1);
});
