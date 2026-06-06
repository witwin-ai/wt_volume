/**
 * SDF / Isosurface shaders (separate from volume shader to avoid regressions)
 */
import type * as ThreeTypes from 'three';
import { THREE } from '../runtime';

/**
 * Vertex shader
 * Passes object-space position and camera position in object space
 */
export const sdfVertexShader = `
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
 * Fragment shader for SDF + isosurface rendering
 */
export const sdfFragmentShader = `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;

// Uniforms
uniform sampler3D volumeTexture;
uniform sampler2D colormapTexture;
uniform int renderMode;  // 1=sdf, 2=isosurface
uniform float isoValue;
uniform bool enableLighting;
uniform float opacityScale;
uniform float densityScale;
uniform float valueMin;
uniform float valueMax;
uniform bool logColormap;  // Apply logarithmic scaling to colormap
uniform int raySteps;
uniform bool showSlice;
uniform int slicePlane;  // 0=XY, 1=XZ, 2=YZ
uniform float slicePosition;
uniform vec3 volumeResolution;
uniform mat4 uModelMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uProjectionMatrix;

// Varyings from vertex shader
varying vec3 vPosition;
varying vec3 vCameraLocal;
varying vec3 vPositionLocal;

// Sample volume at normalized position [0,1]^3
float sampleVolume(vec3 pos) {
  if (any(lessThan(pos, vec3(0.0))) || any(greaterThan(pos, vec3(1.0)))) {
    return 0.0;
  }
  return texture(volumeTexture, pos).r;
}

// Calculate surface normal using central differences (gradient)
vec3 calculateNormal(vec3 pos) {
  // Use resolution-aware epsilon: ~1.5 voxels in texture space [0,1]
  vec3 eps = 1.5 / volumeResolution;

  float dx = sampleVolume(pos + vec3(eps.x, 0.0, 0.0)) - sampleVolume(pos - vec3(eps.x, 0.0, 0.0));
  float dy = sampleVolume(pos + vec3(0.0, eps.y, 0.0)) - sampleVolume(pos - vec3(0.0, eps.y, 0.0));
  float dz = sampleVolume(pos + vec3(0.0, 0.0, eps.z)) - sampleVolume(pos - vec3(0.0, 0.0, eps.z));

  // Scale gradient by resolution to get correct direction for non-cubic volumes
  vec3 grad = vec3(dx, dy, dz) * volumeResolution;

  float len = length(grad);
  if (len < 0.0001) {
    return vec3(0.0, 1.0, 0.0);
  }

  return normalize(grad);
}

// Apply Phong lighting model
vec3 applyLighting(vec3 normal, vec3 viewDir, vec3 baseColor) {
  vec3 lightDir1 = normalize(vec3(1.0, 1.0, 1.0));
  float diffuse1 = max(dot(normal, lightDir1), 0.0);

  vec3 lightDir2 = normalize(vec3(-0.5, 0.3, -0.5));
  float diffuse2 = max(dot(normal, lightDir2), 0.0);

  vec3 reflectDir = reflect(-lightDir1, normal);
  float specular = pow(max(dot(viewDir, reflectDir), 0.0), 32.0);

  float rim = 1.0 - max(dot(viewDir, normal), 0.0);
  rim = pow(rim, 3.0);

  float ambient = 0.3;
  float diffuse = diffuse1 * 0.5 + diffuse2 * 0.2;

  vec3 color = baseColor * (ambient + diffuse);
  color += vec3(1.0) * specular * 0.2;
  color += baseColor * rim * 0.15;

  return clamp(color, 0.0, 1.0);
}

// Apply transfer function: value -> RGBA (used for slice)
vec4 applyTransferFunction(float value) {
  if (value < valueMin || value > valueMax) {
    return vec4(0.0);
  }

  float normalized = (value - valueMin) / (valueMax - valueMin + 0.0001);

  // Apply logarithmic scaling if enabled
  float colormapIndex = normalized;
  if (logColormap) {
    colormapIndex = log(1.0 + 9.0 * normalized) / log(10.0);
  }

  vec3 color = texture2D(colormapTexture, vec2(colormapIndex, 0.5)).rgb;
  float opacity = normalized * opacityScale;

  return vec4(color, opacity);
}

// Convert object-space position to depth buffer value (0-1)
float computeDepth(vec3 localPos) {
  vec4 worldPos = uModelMatrix * vec4(localPos, 1.0);
  vec4 clipPos = uProjectionMatrix * uViewMatrix * worldPos;
  return clipPos.z / clipPos.w * 0.5 + 0.5;
}

void main() {
  // ===== Slice Mode =====
  if (showSlice) {
    vec3 slicePos = vPosition;

    if (slicePlane == 0) {
      slicePos.z = slicePosition;
    } else if (slicePlane == 1) {
      slicePos.y = slicePosition;
    } else {
      slicePos.x = slicePosition;
    }

    float value = sampleVolume(slicePos) * densityScale;
    vec4 color = applyTransferFunction(value);

    // Depth should correspond to the slice plane, not the cube face
    vec3 sliceLocal = slicePos - 0.5;
    gl_FragDepth = computeDepth(sliceLocal);
    gl_FragColor = color;
    return;
  }

  // ===== Ray Setup (front faces: viewer into volume) =====
  vec3 rayOrigin = vPositionLocal;
  vec3 rayDir = normalize(vPositionLocal - vCameraLocal);

  vec3 boxMin = vec3(-0.5);
  vec3 boxMax = vec3(0.5);

  vec3 invRayDir = 1.0 / (rayDir + vec3(0.0001));
  vec3 tMin = (boxMin - rayOrigin) * invRayDir;
  vec3 tMax = (boxMax - rayOrigin) * invRayDir;
  vec3 t1 = min(tMin, tMax);
  vec3 t2 = max(tMin, tMax);

  float tNear = max(max(t1.x, t1.y), t1.z);
  float tFar = min(min(t2.x, t2.y), t2.z);

  if (tNear > tFar || tFar < 0.0) {
    discard;
  }

  tNear = max(tNear, 0.0);

  // ===== SDF Mode =====
  if (renderMode == 1) {
    float t = tNear;
    float threshold = 0.001;

    for (int i = 0; i < 512; i++) {
      if (i >= raySteps) break;
      if (t > tFar) break;

      vec3 pos = rayOrigin + rayDir * t;
      vec3 texCoord = pos + 0.5;

      float sdfValue = sampleVolume(texCoord);
      float dist = abs(sdfValue - isoValue);

      if (dist < threshold) {
        float colorCoord = 0.5;
        vec3 baseColor = texture2D(colormapTexture, vec2(colorCoord, 0.5)).rgb;

        vec3 normal = calculateNormal(texCoord);
        vec3 viewDir = normalize(vCameraLocal - pos);
        vec3 color = enableLighting ? applyLighting(normal, viewDir, baseColor) : baseColor;

        gl_FragDepth = computeDepth(pos);
        gl_FragColor = vec4(color, 1.0);
        return;
      }

      float stepDist = max(dist * 0.5, 0.001);
      t += stepDist;
    }

    discard;
  }

  // ===== Isosurface Mode =====
  if (renderMode == 2) {
    float stepSize = (tFar - tNear) / float(raySteps);
    float t = tNear;

    float prevValue = sampleVolume((rayOrigin + rayDir * t) + 0.5);

    for (int i = 0; i < 512; i++) {
      if (i >= raySteps) break;

      t += stepSize;
      if (t > tFar) break;

      vec3 pos = rayOrigin + rayDir * t;
      vec3 texCoord = pos + 0.5;

      float value = sampleVolume(texCoord);

      if ((prevValue < isoValue && value >= isoValue) ||
          (prevValue > isoValue && value <= isoValue)) {

        float tStart = t - stepSize;
        float tEnd = t;

        for (int j = 0; j < 4; j++) {
          float tMid = (tStart + tEnd) * 0.5;
          vec3 midPos = rayOrigin + rayDir * tMid;
          vec3 midTexCoord = midPos + 0.5;
          float midValue = sampleVolume(midTexCoord);

          if ((prevValue < isoValue && midValue < isoValue) ||
              (prevValue > isoValue && midValue > isoValue)) {
            tStart = tMid;
          } else {
            tEnd = tMid;
          }
        }

        vec3 surfacePos = rayOrigin + rayDir * ((tStart + tEnd) * 0.5);
        vec3 surfaceTexCoord = surfacePos + 0.5;

        vec3 normal = calculateNormal(surfaceTexCoord);

        float normalizedValue = (isoValue + 1.0) * 0.5;
        vec3 baseColor = texture2D(colormapTexture, vec2(normalizedValue, 0.5)).rgb;

        vec3 viewDir = normalize(vCameraLocal - surfacePos);
        vec3 color = enableLighting ? applyLighting(normal, viewDir, baseColor) : baseColor;

        gl_FragDepth = computeDepth(surfacePos);
        gl_FragColor = vec4(color, 1.0);
        return;
      }

      prevValue = value;
    }

    discard;
  }

  // Unknown render mode
  discard;
}
`;

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
export function getColormapFunc(name: string): ColormapFunc {
  switch (name) {
    case 'inferno': return infernoColormap;
    case 'plasma': return plasmaColormap;
    case 'viridis': return viridisColormap;
    case 'jet': return jetColormap;
    case 'coolwarm': return coolwarmColormap;
    case 'bwr': return bwrColormap;
    default: return infernoColormap;
  }
}

/**
 * Generate 1D colormap texture for shader
 */
export function createColormapTexture(colormapName: string): ThreeTypes.DataTexture {
  const width = 256;
  const data = new Uint8Array(width * 4);

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
