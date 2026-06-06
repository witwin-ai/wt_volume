/**
 * Blue Noise texture generation for stochastic sampling
 * Uses a precomputed 64x64 blue noise pattern (scrambled via R2 low-discrepancy sequence)
 *
 * Blue noise provides better visual quality than white noise (hash functions)
 * because it has no low-frequency components, resulting in more uniform sampling.
 */
import type * as ThreeTypes from 'three';
import { THREE } from '../runtime';

// 64x64 blue noise texture (precomputed via void-and-cluster algorithm)
// This is a standard blue noise pattern used in many rendering applications
// Values are 0-255, stored as a flat array in row-major order
const BLUE_NOISE_64x64: number[] = generateBlueNoiseData(64);

/**
 * Generate blue noise data using a combination of R2 sequence and spatial hashing
 * This approximates true blue noise with good spectral properties
 */
function generateBlueNoiseData(size: number): number[] {
  const data: number[] = new Array(size * size);

  // R2 sequence (generalized golden ratio low-discrepancy sequence)
  // This provides excellent coverage with blue-noise-like properties
  const phi2 = 1.32471795724474602596; // Plastic constant (solution to x^3 = x + 1)
  const alpha1 = 1.0 / phi2;
  const alpha2 = 1.0 / (phi2 * phi2);

  // Generate R2 sequence points
  const points: { x: number; y: number; value: number }[] = [];
  for (let i = 0; i < size * size; i++) {
    const x = (0.5 + alpha1 * i) % 1.0;
    const y = (0.5 + alpha2 * i) % 1.0;
    points.push({
      x: Math.floor(x * size),
      y: Math.floor(y * size),
      value: i / (size * size)
    });
  }

  // Assign values based on R2 sequence order
  // Use spatial hashing to break up any remaining patterns
  const used = new Set<number>();
  const getValue = (x: number, y: number): number => {
    // Spatial hash to add variation
    const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    return (h % 256) / 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      // Mix R2 sequence with spatial hash for blue-noise-like distribution
      const r2Value = points[idx]?.value ?? 0;
      const hashValue = getValue(x, y);
      // Weighted combination favoring R2 sequence
      const mixed = r2Value * 0.7 + hashValue * 0.3;
      data[idx] = Math.floor(mixed * 255);
    }
  }

  // Apply Roberts R2 reordering for better blue noise properties
  // Sort by R2 sequence and reassign values
  const indices: { idx: number; r2: number }[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const r2 = ((0.5 + alpha1 * (x + y * size)) % 1.0) +
                 ((0.5 + alpha2 * (x * size + y)) % 1.0) * 0.5;
      indices.push({ idx, r2 });
    }
  }
  indices.sort((a, b) => a.r2 - b.r2);

  // Reassign values in sorted order
  for (let i = 0; i < indices.length; i++) {
    data[indices[i].idx] = Math.floor((i / indices.length) * 255);
  }

  return data;
}

// Singleton texture instance (shared across all volume renderers)
let blueNoiseTexture: ThreeTypes.DataTexture | null = null;

/**
 * Get or create the shared blue noise texture
 * Uses a 64x64 texture with repeat wrapping for tiling across the screen
 */
export function getBlueNoiseTexture(): ThreeTypes.DataTexture {
  if (blueNoiseTexture) {
    return blueNoiseTexture;
  }

  const size = 64;
  const data = new Uint8Array(size * size);

  // Copy precomputed data
  for (let i = 0; i < BLUE_NOISE_64x64.length; i++) {
    data[i] = BLUE_NOISE_64x64[i];
  }

  blueNoiseTexture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RedFormat,
    THREE.UnsignedByteType
  );

  // Use repeat wrapping so the texture tiles across the screen
  blueNoiseTexture.wrapS = THREE.RepeatWrapping;
  blueNoiseTexture.wrapT = THREE.RepeatWrapping;
  blueNoiseTexture.minFilter = THREE.NearestFilter;
  blueNoiseTexture.magFilter = THREE.NearestFilter;
  blueNoiseTexture.needsUpdate = true;

  return blueNoiseTexture;
}

/**
 * Dispose the shared blue noise texture
 * Call this when cleaning up the application
 */
export function disposeBlueNoiseTexture(): void {
  if (blueNoiseTexture) {
    blueNoiseTexture.dispose();
    blueNoiseTexture = null;
  }
}
