import type * as ThreeTypes from 'three';
import { THREE } from '../runtime';

// A scanned or imported mesh this large would stall every slice change.
const MAX_TRIANGLES = 300_000;

/**
 * Where scene parts cross the slice plane, as line segments in the plane's
 * (u, v) world coordinates: [u0, v0, u1, v1, ...]. These are the structure
 * outlines drawn over the 2D heatmap.
 *
 * Parts are the meshes tagged with userData.objectId (scene objects), minus
 * gizmos; field visualizer surfaces carry no objectId and are skipped. Each
 * triangle that straddles the plane contributes one segment.
 */
export function sliceOutlines(scene: ThreeTypes.Object3D, normal: number, position: number, uAxis: number, vAxis: number): Float32Array {
  const out: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const tri = [a, b, c];
  const d = [0, 0, 0];
  scene.updateMatrixWorld();
  scene.traverseVisible((o) => {
    const mesh = o as ThreeTypes.Mesh;
    if (!mesh.isMesh || !o.userData.objectId || o.userData.isGizmo) return;
    const geometry = mesh.geometry as ThreeTypes.BufferGeometry | undefined;
    const pos = geometry?.attributes?.position;
    if (!pos) return;
    const index = geometry!.index;
    const count = index ? index.count : pos.count;
    if (count / 3 > MAX_TRIANGLES) return;
    // Skip parts whose world bounds miss the plane.
    if (!geometry!.boundingBox) geometry!.computeBoundingBox();
    const box = geometry!.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    if (box.min.getComponent(normal) > position || box.max.getComponent(normal) < position) return;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t + k) : t + k;
        tri[k].fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        d[k] = tri[k].getComponent(normal) - position;
      }
      // Points where the plane crosses the triangle's edges.
      const hits: number[] = [];
      for (let k = 0; k < 3 && hits.length < 4; k++) {
        const k2 = (k + 1) % 3;
        if ((d[k] < 0) === (d[k2] < 0)) continue;
        const s = d[k] / (d[k] - d[k2]);
        const p = tri[k];
        const q = tri[k2];
        hits.push(
          p.getComponent(uAxis) + (q.getComponent(uAxis) - p.getComponent(uAxis)) * s,
          p.getComponent(vAxis) + (q.getComponent(vAxis) - p.getComponent(vAxis)) * s,
        );
      }
      if (hits.length === 4) out.push(...hits);
    }
  });
  return Float32Array.from(out);
}
