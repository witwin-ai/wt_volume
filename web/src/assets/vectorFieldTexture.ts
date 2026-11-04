/**
 * Vector field data loading and sampling utilities
 */

import type { ViewportAssetsApi } from '@witwin/host';

export interface VectorFieldLoadResult {
  rawData: Float32Array;  // RGBA data (Vx, Vy, Vz, magnitude)
  resolution: [number, number, number];
  sizeBytes: number;
}

export interface VectorFieldSampleData {
  positions: Float32Array;   // Sample positions (x, y, z) in normalized coordinates [-0.5, 0.5]
  directions: Float32Array;  // Normalized direction vectors (dx, dy, dz)
  magnitudes: Float32Array;  // Magnitude values (0-1)
  count: number;
}

/**
 * Load vector field data from binary file
 *
 * Binary format:
 * - Header (12 bytes): nx, ny, nz as uint32 (little-endian)
 * - Data: float32[nz][ny][nx][4] where channels are (Vx, Vy, Vz, magnitude)
 */
export async function loadVectorFieldData(
  assets: ViewportAssetsApi,
  vectorFieldId: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<VectorFieldLoadResult> {
  const buffer = await assets.fetchBinary(vectorFieldId, {
    onProgress: onProgress
      ? (loaded, total) => onProgress(loaded, total ?? loaded)
      : undefined,
  });
  const allChunks = new Uint8Array(buffer);

  // Parse header (12 bytes: nx, ny, nz as uint32)
  const headerView = new DataView(allChunks.buffer, 0, 12);
  const nx = headerView.getUint32(0, true);  // little-endian
  const ny = headerView.getUint32(4, true);
  const nz = headerView.getUint32(8, true);

  // Parse data (after header) - RGBA float32
  const dataBytes = new Uint8Array(allChunks.buffer, 12);
  const expectedSize = nx * ny * nz * 4;  // 4 channels (RGBA)
  const float32Data = new Float32Array(dataBytes.buffer, dataBytes.byteOffset, expectedSize);

  if (float32Data.length !== expectedSize) {
    throw new Error(
      `Vector field size mismatch: expected ${expectedSize} floats, got ${float32Data.length}`
    );
  }

  return {
    rawData: float32Data,
    resolution: [nx, ny, nz],
    sizeBytes: allChunks.byteLength
  };
}

/**
 * Sample vector field at regular grid points for instanced rendering
 *
 * @param data - Raw RGBA float32 data from loadVectorFieldData
 * @param resolution - Grid resolution [nx, ny, nz]
 * @param density - Number of arrows per axis (total = density^3 for 3D)
 * @param minMagnitude - Minimum magnitude threshold (0-1)
 * @param maxMagnitude - Maximum magnitude threshold (0-1)
 * @returns Sampled data for instanced rendering
 */
export function sampleVectorField(
  data: Float32Array,
  resolution: [number, number, number],
  density: number,
  minMagnitude: number,
  maxMagnitude: number
): VectorFieldSampleData {
  const [nx, ny, nz] = resolution;

  // Calculate step size for subsampling
  const stepX = Math.max(1, Math.floor(nx / density));
  const stepY = Math.max(1, Math.floor(ny / density));
  const stepZ = Math.max(1, Math.floor(nz / density));

  // Temporary arrays (we don't know final count due to filtering)
  const tempPositions: number[] = [];
  const tempDirections: number[] = [];
  const tempMagnitudes: number[] = [];

  // Sample the field
  for (let iz = 0; iz < nz; iz += stepZ) {
    for (let iy = 0; iy < ny; iy += stepY) {
      for (let ix = 0; ix < nx; ix += stepX) {
        // Index into RGBA data (data is stored as [nz][ny][nx][4] in WebGL layout)
        const idx = ((iz * ny + iy) * nx + ix) * 4;

        const vx = data[idx];
        const vy = data[idx + 1];
        const vz = data[idx + 2];
        const mag = data[idx + 3];  // Pre-normalized magnitude (0-1)

        // Filter by magnitude
        if (mag < minMagnitude || mag > maxMagnitude) continue;

        // Compute normalized position in [-0.5, 0.5]
        const px = (ix / (nx - 1 || 1)) - 0.5;
        const py = (iy / (ny - 1 || 1)) - 0.5;
        const pz = (iz / (nz - 1 || 1)) - 0.5;

        // Compute direction magnitude for normalization
        const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (len < 0.0001) continue;  // Skip zero vectors

        // Store position
        tempPositions.push(px, py, pz);

        // Store normalized direction
        tempDirections.push(vx / len, vy / len, vz / len);

        // Store magnitude
        tempMagnitudes.push(mag);
      }
    }
  }

  const count = tempMagnitudes.length;

  return {
    positions: new Float32Array(tempPositions),
    directions: new Float32Array(tempDirections),
    magnitudes: new Float32Array(tempMagnitudes),
    count
  };
}
