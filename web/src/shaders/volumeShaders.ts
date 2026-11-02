/**
 * Volume rendering shaders for ray marching through 3D scalar fields
 */
import type * as ThreeTypes from 'three';
import { THREE } from '../runtime';
import { FIELD_SAMPLING_GLSL } from '../field/sampling';

/**
 * Vertex shader for volume ray marching
 * Passes through position in object space [0,1]^3 and camera position in object space
 */
export const volumeVertexShader = `
uniform mat4 modelMatrixInverse;

varying vec3 vPosition;
varying vec3 vCameraLocal;
varying vec3 vPositionLocal;

void main() {
  // Convert from [-0.5, 0.5] to [0, 1] for texture sampling
  vPosition = position + 0.5;
  vPositionLocal = position;

  // Transform camera position to object space
  vCameraLocal = (modelMatrixInverse * vec4(cameraPosition, 1.0)).xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Fragment shader for volume ray marching with transfer function
 */
export const volumeFragmentShader = `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;

${FIELD_SAMPLING_GLSL}

// Uniforms
uniform sampler2D colormapTexture;
uniform sampler2D blueNoiseTexture;  // Blue noise for stochastic jittering
uniform float opacityScale;
uniform float densityScale;
uniform float absorptionScale;  // Controls how quickly the volume becomes opaque
uniform float valueMin;
uniform float valueMax;
uniform int raySteps;
uniform bool showSlice;
uniform int slicePlane;  // 0=XY, 1=XZ, 2=YZ
uniform float slicePosition;
uniform vec3 volumeResolution;
uniform mat4 uModelMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uProjectionMatrix;
uniform sampler2D sceneDepthTexture;
uniform vec2 viewportSize;
uniform float cameraNear;
uniform float cameraFar;
uniform bool logColormap;  // Apply logarithmic scaling to colormap

// Varyings from vertex shader
varying vec3 vPosition;
varying vec3 vCameraLocal;
varying vec3 vPositionLocal;

// Sample volume at normalized position [0,1]^3
float sampleVolume(vec3 pos) {
  // Clamp to valid texture coordinates
  if (any(lessThan(pos, vec3(0.0))) || any(greaterThan(pos, vec3(1.0)))) {
    return 0.0;
  }
  return fieldValue(pos);
}

// Apply transfer function: value -> RGBA
vec4 applyTransferFunction(float value) {
  // Values below min are transparent
  if (value < valueMin) {
    return vec4(0.0);
  }

  // Values above max are clamped to max (not discarded)
  float clampedValue = min(value, valueMax);

  // Normalize to [0,1] based on threshold range
  float normalized = (clampedValue - valueMin) / (valueMax - valueMin + 0.0001);

  // Apply logarithmic scaling if enabled (compresses large dynamic range)
  float colormapIndex = normalized;
  if (logColormap) {
    // Log scaling: log10(1 + 9*x) / log10(10) = log10(1 + 9*x)
    // This maps 0->0, 1->1 with logarithmic distribution
    colormapIndex = log(1.0 + 9.0 * normalized) / log(10.0);
  }

  // Sample colormap (1D texture, sample at y=0.5)
  vec3 color = texture2D(colormapTexture, vec2(colormapIndex, 0.5)).rgb;

  // Opacity calculation with absorption:
  // Use Beer-Lambert-like exponential absorption for more realistic thick volume rendering
  // Higher absorptionScale = faster opacity accumulation = thicker volumes hide objects better
  float baseOpacity = normalized * opacityScale;
  float opacity = 1.0 - exp(-baseOpacity * absorptionScale);

  return vec4(color, opacity);
}

// Sample blue noise texture for stochastic jittering
// Blue noise provides better visual quality than white noise (hash)
// because it has no low-frequency components
float sampleBlueNoise(vec2 fragCoord) {
  // Blue noise texture is 64x64, tiles via RepeatWrapping
  vec2 uv = fragCoord / 64.0;
  return texture2D(blueNoiseTexture, uv).r;
}

// Convert object-space position to depth buffer value (0-1)
float computeDepth(vec3 localPos) {
  vec4 worldPos = uModelMatrix * vec4(localPos, 1.0);
  vec4 clipPos = uProjectionMatrix * uViewMatrix * worldPos;
  return clipPos.z / clipPos.w * 0.5 + 0.5;
}

// Convert depth buffer value back to view-space Z (Three.js helpers replicated inline)
float perspectiveDepthToViewZ(const float invClipZ, const float near, const float far) {
  return (near * far) / ((far - near) * invClipZ - far);
}

void main() {
  // ===== Slice Mode =====
  if (showSlice) {
    vec3 slicePos = vPosition;

    // Set coordinate along slice axis
    if (slicePlane == 0) {      // XY plane (slice along Z)
      slicePos.z = slicePosition;
    } else if (slicePlane == 1) { // XZ plane (slice along Y)
      slicePos.y = slicePosition;
    } else {                    // YZ plane (slice along X)
      slicePos.x = slicePosition;
    }

    float value = sampleVolume(slicePos) * densityScale;
    vec4 color = applyTransferFunction(value);

    // Depth of the actual slice plane, not the box face
    vec3 sliceLocal = slicePos - 0.5;
    gl_FragDepth = computeDepth(sliceLocal);
    gl_FragColor = color;
    return;
  }

  // ===== Ray Setup (Common for all modes) =====

  // Ray setup in object space [-0.5, 0.5]^3
  // We're rendering back faces, ray goes from camera through volume to back face
  vec3 rayOrigin = vCameraLocal;
  vec3 rayDir = normalize(vPositionLocal - vCameraLocal);

  // Ray-box intersection (slab method)
  // Box is [-0.5, 0.5]^3 in object space
  vec3 boxMin = vec3(-0.5);
  vec3 boxMax = vec3(0.5);

  // Avoid division by zero while preserving the ray direction sign for near-parallel rays
  vec3 dir = rayDir;
  vec3 eps = vec3(1e-6);
  dir.x = abs(dir.x) < eps.x ? (dir.x >= 0.0 ? eps.x : -eps.x) : dir.x;
  dir.y = abs(dir.y) < eps.y ? (dir.y >= 0.0 ? eps.y : -eps.y) : dir.y;
  dir.z = abs(dir.z) < eps.z ? (dir.z >= 0.0 ? eps.z : -eps.z) : dir.z;
  vec3 invRayDir = 1.0 / dir;
  vec3 tMin = (boxMin - rayOrigin) * invRayDir;
  vec3 tMax = (boxMax - rayOrigin) * invRayDir;
  vec3 t1 = min(tMin, tMax);
  vec3 t2 = max(tMin, tMax);

  float tNear = max(max(t1.x, t1.y), t1.z);
  float tFar = min(min(t2.x, t2.y), t2.z);

  // No intersection or behind camera
  if (tNear > tFar || tFar < 0.0) {
    discard;
  }

  // Start at box entry point (or fragment if inside box)
  tNear = max(tNear, 0.0);

  // ===== Clamp marching range by scene depth (mesh occlusion) =====
  vec2 fragUV = gl_FragCoord.xy / viewportSize;
  float depthSample = texture2D(sceneDepthTexture, fragUV).r;

  // Only clamp when we actually have something closer than the far plane
  if (depthSample < 0.999999) {
    float sceneViewZ = perspectiveDepthToViewZ(depthSample, cameraNear, cameraFar);

    // Ray in view space using the same parameterization as object space
    vec3 rayOriginWorld = (uModelMatrix * vec4(rayOrigin, 1.0)).xyz;
    vec3 rayDirWorld = (uModelMatrix * vec4(rayDir, 0.0)).xyz;
    vec3 rayOriginView = (uViewMatrix * vec4(rayOriginWorld, 1.0)).xyz;
    vec3 rayDirView = (uViewMatrix * vec4(rayDirWorld, 0.0)).xyz;

    // Solve for t where the ray reaches the depth buffer distance
    float denom = rayDirView.z;
    if (abs(denom) > 1e-6) {
      float depthT = (sceneViewZ - rayOriginView.z) / denom;
      if (depthT > 0.0) {
        float maxT = min(tFar, depthT - 1e-4);
        if (maxT <= tNear) {
          discard;
        }
        tFar = maxT;
      }
    }
  }

  // ===== Volume Ray Marching =====

  // Voxel size and step size
  float voxelSize = 1.0 / max(max(volumeResolution.x, volumeResolution.y), volumeResolution.z);
  float stepSize = voxelSize * 0.5;

  // Stochastic phase offset using blue noise to break fixed-grid interference
  // Blue noise provides more uniform distribution than white noise, reducing visible plugins
  // Offset stays within one step to keep sampling density consistent
  float tStart = tNear + sampleBlueNoise(gl_FragCoord.xy) * stepSize;

  // Calculate steps needed
  float pathLength = tFar - tNear;
  int maxSteps = int(ceil(pathLength / stepSize)) + 1; // extra step to cover jittered start
  maxSteps = min(maxSteps, 1024);

  vec3 currentPos = rayOrigin + rayDir * tStart;
  vec3 step = rayDir * stepSize;

  // Reference step size for opacity correction (1 voxel)
  float refStepSize = voxelSize;

  // Accumulated color (front-to-back compositing)
  vec4 accumulated = vec4(0.0);
  float depthForTest = 1.0;
  bool hasContribution = false;
  bool becameOpaque = false;

  // March through volume
  for (int i = 0; i < 1024; i++) {
    if (i >= maxSteps) break;

    // Convert from object space [-0.5, 0.5] to texture space [0, 1]
    vec3 texCoord = currentPos + 0.5;

    // Sample volume
    float value = sampleVolume(texCoord) * densityScale;
    vec4 srcColor = applyTransferFunction(value);

    // Step-size independent opacity correction (Beer-Lambert law)
    // Transfer function assumes reference step size = 1 voxel
    // For different step sizes, correct opacity to maintain consistent accumulation
    // Formula: alpha_corrected = 1 - (1 - alpha)^(stepSize/refStepSize)
    float stepRatio = stepSize / refStepSize;
    srcColor.a = 1.0 - pow(max(1.0 - srcColor.a, 0.0001), stepRatio);

    // Pre-multiply alpha
    srcColor.rgb *= srcColor.a;

    if (srcColor.a > 0.0001 && !hasContribution) {
      depthForTest = computeDepth(currentPos);
      hasContribution = true;
    }

    // Front-to-back compositing
    accumulated += (1.0 - accumulated.a) * srcColor;

    // Early ray termination
    if (accumulated.a > 0.98) {
      becameOpaque = true;
      break;
    }

    // Step along ray
    currentPos += step;
  }

  // If nothing contributed, skip writing a fragment
  if (!hasContribution || accumulated.a <= 0.0001) {
    discard;
  }

  // If the volume became opaque before reaching the mesh depth, bias depth in front of the mesh
  if (becameOpaque && depthSample < 0.999999) {
    gl_FragDepth = min(depthForTest, depthSample - 1e-5);
  } else {
    gl_FragDepth = depthForTest;
  }
  gl_FragColor = accumulated;
}
`;

// =========================
// Colormap Functions
// =========================

export type ColormapFunc = (v: number) => [number, number, number];

// Inferno colormap (black -> deep purple -> orange-red -> yellow)
export function infernoColormap(v: number): [number, number, number] {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.001 + t * 0.15, 0.001 + t * 0.06, 0.014 + t * 0.34];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.15 + t * 0.45, 0.07 + t * 0.09, 0.35 + t * 0.15];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.60 + t * 0.35, 0.16 + t * 0.36, 0.50 - t * 0.40];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.03, 0.52 + t * 0.42, 0.10 - t * 0.03];
  }
}

// Plasma colormap (purple -> pink -> orange -> yellow)
export function plasmaColormap(v: number): [number, number, number] {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.05 + t * 0.35, 0.03 + t * 0.02, 0.53 + t * 0.17];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.40 + t * 0.40, 0.05 + t * 0.10, 0.70 - t * 0.20];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.80 + t * 0.15, 0.15 + t * 0.35, 0.50 - t * 0.30];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.05, 0.50 + t * 0.40, 0.20 - t * 0.10];
  }
}

// Viridis colormap (purple -> blue -> teal -> green -> yellow)
export function viridisColormap(v: number): [number, number, number] {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.267 + t * 0.015, 0.004 + t * 0.136, 0.329 + t * 0.128];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.282 - t * 0.155, 0.140 + t * 0.426, 0.457 + t * 0.093];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.127 + t * 0.614, 0.566 + t * 0.307, 0.550 - t * 0.400];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.741 + t * 0.252, 0.873 + t * 0.033, 0.150 - t * 0.006];
  }
}

// Jet colormap (blue -> cyan -> green -> yellow -> red)
export function jetColormap(v: number): [number, number, number] {
  if (v < 0.125) {
    const t = v / 0.125;
    return [0, 0, 0.5 + t * 0.5];
  } else if (v < 0.375) {
    const t = (v - 0.125) / 0.25;
    return [0, t, 1];
  } else if (v < 0.625) {
    const t = (v - 0.375) / 0.25;
    return [t, 1, 1 - t];
  } else if (v < 0.875) {
    const t = (v - 0.625) / 0.25;
    return [1, 1 - t, 0];
  } else {
    const t = (v - 0.875) / 0.125;
    return [1 - t * 0.5, 0, 0];
  }
}

// Coolwarm colormap (blue -> white -> red)
export function coolwarmColormap(v: number): [number, number, number] {
  if (v < 0.5) {
    const t = v / 0.5;
    return [0.23 + t * 0.77, 0.30 + t * 0.70, 0.75 + t * 0.25];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1.0, 1.0 - t * 0.70, 1.0 - t * 0.75];
  }
}

// BWR colormap (blue -> white -> red)
export function bwrColormap(v: number): [number, number, number] {
  if (v < 0.5) {
    const t = v / 0.5;
    return [t, t, 1];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t, 1 - t];
  }
}

// Get colormap function by name
// Evenly spaced colour stops, linearly interpolated.
function stopsColormap(hexStops: string[]): ColormapFunc {
  const stops = hexStops.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as [number, number, number];
  });
  return (v) => {
    const x = Math.min(Math.max(v, 0), 1) * (stops.length - 1);
    const i = Math.min(Math.floor(x), stops.length - 2);
    const t = x - i;
    const a = stops[i];
    const b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
}

// ColorBrewer RdBu reversed, so negative is blue, with a neutral midpoint:
// the usual map for signed fields such as Re(E).
export const rdbuColormap = stopsColormap([
  '#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7',
  '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f',
]);

// matplotlib magma: perceptually uniform, for magnitudes and intensities.
export const magmaColormap = stopsColormap([
  '#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8761', '#fec287', '#fcfdbf',
]);

export function getColormapFunc(name: string): ColormapFunc {
  switch (name) {
    case 'rdbu': return rdbuColormap;
    case 'magma': return magmaColormap;
    case 'inferno': return infernoColormap;
    case 'plasma': return plasmaColormap;
    case 'viridis': return viridisColormap;
    case 'jet': return jetColormap;
    case 'coolwarm': return coolwarmColormap;
    case 'bwr': return bwrColormap;
    default: return infernoColormap;  // Default to inferno
  }
}

/**
 * Generate 1D colormap texture for shader
 */
export function createColormapTexture(colormapName: string): ThreeTypes.DataTexture {
  const width = 256;
  const data = new Uint8Array(width * 4); // RGBA

  const colormapFunc = getColormapFunc(colormapName);

  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const [r, g, b] = colormapFunc(t);

    data[i * 4 + 0] = Math.round(r * 255);
    data[i * 4 + 1] = Math.round(g * 255);
    data[i * 4 + 2] = Math.round(b * 255);
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  return texture;
}
