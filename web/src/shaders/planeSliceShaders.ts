/**
 * Plane Slice Shaders for rendering 2D slices from 3D volume textures
 *
 * Used by FieldVisualizer in Plane render mode to dynamically extract
 * slices from volume data without requiring backend to send 2D heatmaps.
 */

/**
 * Vertex shader for plane slice rendering
 * Simple passthrough with UV coordinates
 */
export const planeSliceVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Fragment shader for plane slice rendering
 * Samples a 2D slice from a 3D volume texture
 */
export const planeSliceFragmentShader = `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;

uniform sampler3D volumeTexture;
uniform sampler2D colormapTexture;
uniform int slicePlane;      // 0=XY, 1=XZ, 2=YZ
uniform float slicePosition; // 0-1 normalized position along perpendicular axis
uniform float opacity;
uniform float valueMin;
uniform float valueMax;
uniform bool logColormap;    // Apply logarithmic scaling to colormap

varying vec2 vUv;

void main() {
  // Build 3D texture coordinate based on slice plane
  // Note: PlaneGeometry rotation affects UV->world mapping
  // XZ plane rotates -90 deg around X: UV.y direction becomes -Z
  // YZ plane rotates 90 deg around Y: UV.x direction becomes -Z
  vec3 texCoord;

  if (slicePlane == 0) {
    // XY plane - slice along Z axis
    // UV.x -> X, UV.y -> Y, slicePosition -> Z
    texCoord = vec3(vUv.x, vUv.y, slicePosition);
  } else if (slicePlane == 1) {
    // XZ plane - slice along Y axis
    // UV.x -> X, UV.y -> -Z (flip Z), slicePosition -> Y
    texCoord = vec3(vUv.x, slicePosition, 1.0 - vUv.y);
  } else {
    // YZ plane - slice along X axis
    // UV.x -> -Z (flip Z), UV.y -> Y, slicePosition -> X
    texCoord = vec3(slicePosition, vUv.y, 1.0 - vUv.x);
  }

  // Sample volume
  float value = texture(volumeTexture, texCoord).r;

  // Values below min are transparent, values above max are clamped to max
  if (value < valueMin) {
    discard;
  }
  float clampedValue = min(value, valueMax);

  // Normalize value to 0-1 based on threshold range
  float normalized = (clampedValue - valueMin) / (valueMax - valueMin + 0.0001);

  // Apply logarithmic scaling if enabled (compresses large dynamic range)
  if (logColormap) {
    // Log scaling: log10(1 + 9*x) / log10(10) = log10(1 + 9*x)
    // This maps 0->0, 1->1 with logarithmic distribution
    normalized = log(1.0 + 9.0 * normalized) / log(10.0);
  }

  // Sample colormap
  vec3 color = texture2D(colormapTexture, vec2(normalized, 0.5)).rgb;

  gl_FragColor = vec4(color, opacity);
}
`;
