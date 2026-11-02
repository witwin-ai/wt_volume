import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// The slice math and the GIF encoder import nothing from the host, so they
// are compiled with the Studio checkout's esbuild and tested directly.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const codeRoot = path.resolve(webRoot, '..', '..', '..');
const studioDir = process.env.WITWIN_STUDIO_DIR ?? path.join(codeRoot, 'witwin-studio', 'studio');
const esbuild = createRequire(path.join(studioDir, 'package.json'))('esbuild');

async function load(relative) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-volume-')), 'module.mjs');
  await esbuild.build({ entryPoints: [path.join(webRoot, relative)], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}

const grid = await load('src/slice/fieldGrid.ts');
const gif = await load('src/media/gif.ts');

test('locate finds the cell and weight on a non-uniform axis', () => {
  const axis = [0, 1, 3, 7];
  assert.deepEqual(grid.locate(axis, 2), [1, 0.5]);
  assert.deepEqual(grid.locate(axis, -1), [0, 0]);
  assert.deepEqual(grid.locate(axis, 9), [2, 1]);
});

test('sliceGrid interpolates between grid planes and keeps u fastest', () => {
  // 2 x 3 x 2 grid, value = i + 10 j + 100 k.
  const n = [2, 3, 2];
  const re = new Float32Array(12);
  for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) re[i + 2 * (j + 3 * k)] = i + 10 * j + 100 * k;
  const field = { coords: grid.gridCoords(n, [0, 0, 0], [1, 2, 1], null), re, im: null };
  const s = grid.sliceGrid(field, 'XY', 0.25);
  assert.equal(s.normal, 2);
  assert.equal(s.uAxis, 0);
  assert.equal(s.vAxis, 1);
  assert.equal(s.position, 0.25);
  assert.deepEqual(Array.from(s.re), [25, 26, 35, 36, 45, 46]);
  const xz = grid.sliceGrid(field, 'XZ', 1);
  assert.deepEqual(Array.from(xz.re), [20, 21, 120, 121]);
});

test('gridCoords prefers axis_coords that match the resolution', () => {
  const coords = grid.gridCoords([3, 2, 1], [0, 0, 0], [1, 1, 1], [[0, 0.1, 1], [5], null]);
  assert.deepEqual(Array.from(coords[0]), [0, 0.1, 1]);
  assert.deepEqual(Array.from(coords[1]), [0, 1]);
  assert.deepEqual(Array.from(coords[2]), [0.5]);
});

test('lengthUnit picks the largest unit that keeps the size at least 1', () => {
  assert.deepEqual(grid.lengthUnit(3), [1, 'm']);
  assert.deepEqual(grid.lengthUnit(0.004), [1e-3, 'mm']);
  assert.deepEqual(grid.lengthUnit(2e-6), [1e-6, 'µm']);
  assert.deepEqual(grid.lengthUnit(5e-11), [1e-9, 'nm']);
});

test('encodeGif writes a looping GIF89a with one frame per image', () => {
  const frame = (r) => ({ width: 2, height: 2, data: new Uint8ClampedArray([r, 0, 0, 255, 0, r, 0, 255, 0, 0, r, 255, r, r, r, 255]) });
  const bytes = gif.encodeGif([frame(255), frame(128), frame(0)], 80);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 6)), 'GIF89a');
  assert.ok(new TextDecoder().decode(bytes).includes('NETSCAPE2.0'));
  assert.equal(bytes.filter((b, i) => b === 0x2c && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00).length >= 3, true);
  assert.equal(bytes[bytes.length - 1], 0x3b);
});
