import type * as ThreeTypes from 'three';
import { useEffect, useThree } from '../runtime';

/**
 * The main viewport's canvas and scene, for code outside the R3F tree: the
 * slice panel cuts scene meshes for its outlines and records the canvas.
 * Set by a render pass that mounts inside the viewport's <Canvas>.
 */
export interface ViewportHandle {
  canvas: HTMLCanvasElement;
  scene: ThreeTypes.Scene;
  invalidate: () => void;
}

let handle: ViewportHandle | null = null;

export function viewportHandle(): ViewportHandle | null {
  return handle;
}

export function ViewportHandlePass(): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const mine: ViewportHandle = { canvas: gl.domElement, scene, invalidate };
    handle = mine;
    return () => {
      if (handle === mine) handle = null;
    };
  }, [gl, scene, invalidate]);
  return null;
}
