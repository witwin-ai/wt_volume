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

test('the rect sits on the centre slice, with no depth handles', () => {
  const handles = layout.buildBoundsHandles(box, 2);
  assert.equal(handles.length, 9);
  assert.equal(handles.filter((h) => h.kind === 'corner').length, 4);
  assert.equal(handles.filter((h) => h.kind === 'edge').length, 4);
  assert.equal(handles.filter((h) => h.kind === 'move').length, 1);
  const h = byId(handles);
  // z = (min + max) / 2 = 0, not a face at z = +-3.
  for (const spec of handles) assert.equal(spec.position[2], 0);
  assert.deepEqual(h['corner-min-max'].position, [-1, 2, 0]);
  assert.deepEqual(h['corner-min-max'].axes, [0, 1]);
  assert.deepEqual(h['edge-0-max'].segment, [[1, -2, 0], [1, 2, 0]]);
  assert.equal(h['edge-0-max'].edgeAxis, 1);
  assert.deepEqual(h.move.position, [0, 0, 0]);
  assert.deepEqual(h.move.axes, [0, 1]);
  assert.ok(handles.every((spec) => spec.normal === 2));
});

test('an off-centre box keeps its slice at its own centre', () => {
  const shifted = { min: [0, 0, 2], max: [2, 4, 6] };
  const handles = layout.buildBoundsHandles(shifted, 1);
  assert.ok(handles.every((spec) => spec.position[1] === 2));
  assert.deepEqual(byId(handles).move.position, [1, 2, 4]);
});

const unitEdges = (size) => [[size[0], 0, 0], [0, size[1], 0], [0, 0, size[2]]];

test('the rect plane is the one with the largest area on screen', () => {
  const cube = unitEdges([1, 1, 1]);
  // Looking down -z sees the XY plane; down -y sees XZ.
  assert.equal(layout.pickRectAxis(cube, [0, 0, -1], null), 2);
  assert.equal(layout.pickRectAxis(cube, [0, -1, 0], null), 1);
  // Unity's pick weighs the box's proportions, not only the view angle: a
  // slab 10 wide and 10 deep but 0.1 tall, seen 30 degrees above the
  // horizon, still shows its XZ plane largest.
  const slab = unitEdges([10, 0.1, 10]);
  const down30 = [0, -Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)];
  assert.equal(layout.pickRectAxis(slab, down30, null), 1);
  // A camera-position rule would have picked z (cos 30 > sin 30).
  assert.equal(layout.pickRectAxis(cube, down30, null), 2);
});

test('the rect plane keeps its axis until another is clearly larger', () => {
  const cube = unitEdges([1, 1, 1]);
  const near45 = (deg) => {
    const r = (deg * Math.PI) / 180;
    return [0, -Math.sin(r), -Math.cos(r)];
  };
  assert.equal(layout.pickRectAxis(cube, near45(47), 2), 2);
  assert.equal(layout.pickRectAxis(cube, near45(60), 2), 1);
});

test('the centre disc moves the box without resizing it', () => {
  const h = byId(layout.buildBoundsHandles(box, 2));
  const next = layout.applyBoundsMove(box, h.move, [0.5, -1, 9], null);
  assert.deepEqual(next, { min: [-0.5, -3, -3], max: [1.5, 1, 3] });
  // Shift: only the axis that moved more.
  const locked = layout.applyBoundsMove(box, h.move, [0.5, -1, 0], null, { snap: false, symmetric: false, uniform: true });
  assert.deepEqual(locked, { min: [-1, -3, -3], max: [1, 1, 3] });
  // Ctrl: whole cells.
  const snapped = layout.applyBoundsMove(box, h.move, [0.7, 0.2, 0], 0.5, { snap: true, symmetric: false, uniform: false });
  assert.deepEqual(snapped, { min: [-0.5, -2, -3], max: [1.5, 2, 3] });
});

test('a side drag moves one bound and clamps at one cell', () => {
  const h = byId(layout.buildBoundsHandles(box, 2));
  let next = layout.applyBoundsDrag(box, h['edge-0-max'], [2.5, 0, 3], 0.5);
  assert.deepEqual(next, { min: [-1, -2, -3], max: [2.5, 2, 3] });
  next = layout.applyBoundsDrag(box, h['edge-0-max'], [-5, 0, 3], 0.5);
  assert.deepEqual(next.max[0], -0.5);
});

test('snap makes the size a whole number of cells', () => {
  const h = byId(layout.buildBoundsHandles(box, 2));
  const next = layout.applyBoundsDrag(box, h['edge-0-max'], [1.3, 0, 3], 0.5, { snap: true, symmetric: false, uniform: false });
  assert.equal(next.max[0], 1.5); // size 2.3 -> 2.5
});

test('symmetric drag keeps the centre', () => {
  const h = byId(layout.buildBoundsHandles(box, 2));
  const next = layout.applyBoundsDrag(box, h['edge-0-max'], [2, 0, 3], 0.1, { snap: false, symmetric: true, uniform: false });
  assert.deepEqual([next.min[0], next.max[0]], [-2, 2]);
});

test('uniform corner drag keeps the aspect ratio', () => {
  const h = byId(layout.buildBoundsHandles(box, 2));
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
  const h = byId(layout.buildBoundsHandles(tiny, 2));
  // A drag far past the opposite side stops at 0.1 % of the box, not at a metre-scale default.
  const flat = layout.applyBoundsDrag(tiny, h['edge-0-max'], [-1, 0, 4e-6], null);
  assert.ok(Math.abs(flat.max[0] - flat.min[0] - 8e-9) < 1e-15);
  assert.ok(Math.abs(layout.roundStep(tiny) - 1e-7) < 1e-18);
  const snapped = layout.applyBoundsDrag(tiny, h['edge-0-max'], [5.23e-6, 0, 4e-6], null, { snap: true, symmetric: false, uniform: false });
  assert.ok(Math.abs(snapped.max[0] - 5.2e-6) < 1e-12); // size 9.23 µm -> 9.2 µm
  assert.equal(layout.roundStep(box), 0.1);
});
