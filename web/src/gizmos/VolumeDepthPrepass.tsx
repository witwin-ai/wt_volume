import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, useEffect, useMemo, useFrame, useThree } from '../runtime';

// Flag set on meshes that should be hidden during the depth prepass
export const VOLUME_DEPTH_SKIP_FLAG = '__skipVolumeDepthPrepass';
export const VOLUME_DEPTH_INCLUDE_FLAG = '__includeVolumeDepthPrepass';

let sharedDepthTarget: ThreeTypes.WebGLRenderTarget | null = null;
let sharedDepthTexture: ThreeTypes.DepthTexture | null = null;

export function getVolumeDepthTexture() {
  return sharedDepthTexture;
}

// Renders a depth-only prepass for opaque geometry so volume raymarching
// can stop at the first scene surface along the view ray.
const VolumeDepthPrepass: ReactTypes.FC = () => {
  const { gl, size, scene, camera } = useThree();
  const enableDepthPrepass = true;

  const depthMaterial = useMemo(() => new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  }), []);

  // Clean up allocated resources when the canvas unmounts
  useEffect(() => {
    return () => {
      depthMaterial.dispose();
      if (sharedDepthTarget) {
        sharedDepthTarget.dispose();
        sharedDepthTarget = null;
        sharedDepthTexture = null;
      }
    };
  }, [depthMaterial]);

  useFrame(() => {
    const pixelRatio = gl.getPixelRatio();
    const targetWidth = Math.max(1, Math.round(size.width * pixelRatio));
    const targetHeight = Math.max(1, Math.round(size.height * pixelRatio));

    // Lazily create / resize the depth target (needed even when disabled to clear properly)
    if (!sharedDepthTarget) {
      const depthTexture = new THREE.DepthTexture(targetWidth, targetHeight);
      depthTexture.minFilter = THREE.NearestFilter;
      depthTexture.magFilter = THREE.NearestFilter;
      sharedDepthTarget = new THREE.WebGLRenderTarget(targetWidth, targetHeight, {
        depthTexture,
        depthBuffer: true,
        stencilBuffer: false,
      });
      sharedDepthTarget.texture.minFilter = THREE.NearestFilter;
      sharedDepthTarget.texture.magFilter = THREE.NearestFilter;
    } else if (sharedDepthTarget.width !== targetWidth || sharedDepthTarget.height !== targetHeight) {
      sharedDepthTarget.setSize(targetWidth, targetHeight);
    }

    if (!sharedDepthTarget) return;

    const previousTarget = gl.getRenderTarget();

    // When disabled, just clear the depth buffer to far plane (1.0) so volume shader
    // won't clip against any geometry
    if (!enableDepthPrepass) {
      gl.setRenderTarget(sharedDepthTarget);
      gl.clearDepth();
      gl.setRenderTarget(previousTarget);
      sharedDepthTexture = sharedDepthTarget.depthTexture;
      return;
    }

    const previousOverride = scene.overrideMaterial;

    // Hide everything by default; only explicitly included renderables stay visible
    const hidden: Array<{ obj: THREE.Object3D; prevVisible: boolean }> = [];
    scene.traverse((obj) => {
      const includeFlag = (obj as any).userData?.[VOLUME_DEPTH_INCLUDE_FLAG] === true;
      const userFlagged = (obj as any).userData?.[VOLUME_DEPTH_SKIP_FLAG];
      const helperRenderable =
        (obj as any).isLine ||
        (obj as any).isLineSegments ||
        (obj as any).isPoints ||
        (obj as any).isSprite;
      const isMeshLike = (obj as any).isMesh || (obj as any).isInstancedMesh || (obj as any).isSkinnedMesh;
      const isRenderable = isMeshLike || helperRenderable;

      if (!isRenderable) return;

      // Skip takes precedence; otherwise only include-flagged renderables are kept
      const shouldHide = userFlagged || helperRenderable || !includeFlag;
      if (shouldHide) {
        hidden.push({ obj, prevVisible: obj.visible });
        obj.visible = false;
      }
    });

    scene.overrideMaterial = depthMaterial;
    gl.setRenderTarget(sharedDepthTarget);
    gl.clear();
    gl.render(scene, camera);
    scene.overrideMaterial = previousOverride;
    gl.setRenderTarget(previousTarget);

    hidden.forEach(({ obj, prevVisible }) => {
      obj.visible = prevVisible;
    });

    sharedDepthTexture = sharedDepthTarget.depthTexture;
  }, -1); // Run before the main render

  return null;
};

export default VolumeDepthPrepass;
