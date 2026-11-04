import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(__dirname, '../../../..');

function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

function pluginFileExists(relativePath) {
  return fs.existsSync(path.join(pluginRoot, relativePath));
}

test('declares the volume viewport host and shader permission', () => {
  const manifest = readPluginFile('witwin.toml');

  assert.match(manifest, /id = "witwin\.volume"/);
  assert.match(manifest, /entry = "viewport\.js"/);
  assert.match(manifest, /sdkVersion = "2\.0\.0"/);
  assert.doesNotMatch(manifest, /builtin = "volumeDepth"/);
  assert.match(manifest, /frontend = true/);
  assert.match(manifest, /shader = true/);
});

test('keeps volume activation inside the plugin bundle', () => {
  const viewportBundle = readPluginFile('web/viewport.js');

  assert.match(viewportBundle, /sdkVersion = "2\.0\.0"/);
  assert.match(viewportBundle, /id: "witwin\.volume"/);
  assert.match(viewportBundle, /as default/);
  assert.doesNotMatch(viewportBundle, /export function activate|host\.sceneWrites|host\.scene\./);
  assert.match(viewportBundle, /activateRenderingViewport/);
  assert.match(viewportBundle, /witwin\.volume\.depth/);
  assert.doesNotMatch(viewportBundle, /react\/jsx-runtime/);
  assert.doesNotMatch(viewportBundle, /__witwin\.rendering/);
  assert.doesNotMatch(viewportBundle, /registerFirstPartyRenderingHost/);
});

test('keeps volume viewport source with the plugin package', () => {
  assert.equal(pluginFileExists('web/src/activate.tsx'), true);
  assert.equal(pluginFileExists('web/src/viewport.ts'), true);
  assert.equal(pluginFileExists('web/src/viewport.js'), false);
  assert.equal(pluginFileExists('web/src/gizmos/VolumeVisualizer.tsx'), true);
  assert.equal(pluginFileExists('web/src/gizmos/VolumeDepthPrepass.tsx'), true);
  assert.equal(pluginFileExists('web/src/gizmos/VectorFieldVisualizer.tsx'), true);
  assert.equal(pluginFileExists('web/src/gizmos/PointCloudVisualizer.tsx'), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'studio/packages/witwin-rendering')), false);
});

test('owns vector field visualization source after package split', () => {
  const source = readPluginFile('web/src/activate.tsx');

  assert.match(source, /VectorFieldVisualizer/);
  assert.match(source, /witwin\.volume\.vectorfield/);
  assert.equal(pluginFileExists('web/src/assets/vectorFieldTexture.ts'), true);
});

test('does not register point cloud visualizers from the volume plugin', () => {
  const source = readPluginFile('web/src/activate.tsx');

  assert.doesNotMatch(source, /PointCloudVisualizer/);
  assert.doesNotMatch(source, /pointCloudVisualizerConfig/);
  assert.doesNotMatch(source, /witwin\.volume\.pointcloud/);
});

test('keeps volume web authoring TypeScript-first', () => {
  const pkg = JSON.parse(readPluginFile('web/package.json'));

  assert.match(pkg.scripts.build, /build-viewport/);
  assert.equal(Boolean(pkg.scripts.typecheck), true);
  assert.equal(Boolean(pkg.scripts.watch), true);
  assert.equal(Boolean(pkg.scripts.analyze), true);
});
