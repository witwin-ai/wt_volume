import { THREE } from '../runtime';
import type { RenderResourceRef, ViewportAssetsApi } from '@witwin/host';

export interface VolumeLoadResult {
  texture: any;
  resolution: [number, number, number];
  sizeBytes: number;
}

export async function loadVolumeTexture(
  assets: ViewportAssetsApi,
  volume: RenderResourceRef,
  resolution?: [number, number, number],
  onProgress?: (loaded: number, total?: number) => void,
): Promise<VolumeLoadResult> {
  const resource = await assets.loadVolume(volume, { onProgress });
  const [nx, ny, nz] = resolution ?? resource.resolution;
  const expectedSize = nx * ny * nz;
  if (resource.data.length !== expectedSize) {
    throw new Error(`Volume size mismatch: expected ${expectedSize} floats, got ${resource.data.length}`);
  }

  const texture = new THREE.Data3DTexture(resource.data, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipMapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return {
    texture,
    resolution: [nx, ny, nz],
    sizeBytes: resource.sizeBytes,
  };
}

export function checkVolumeSupport(resolution: [number, number, number]): {
  supported: boolean;
  maxSize: number;
  message?: string;
} {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');

  if (!gl) {
    return { supported: false, maxSize: 0, message: 'WebGL2 not supported' };
  }

  const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  const [nx, ny, nz] = resolution;

  if (nx > maxSize || ny > maxSize || nz > maxSize) {
    return {
      supported: false,
      maxSize,
      message: `Volume resolution ${nx}x${ny}x${nz} exceeds GPU limit of ${maxSize}`,
    };
  }

  return { supported: true, maxSize };
}
