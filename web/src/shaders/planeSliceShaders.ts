/**
 * Plane Slice Shaders for rendering 2D slices from 3D field textures
 *
 * Used by FieldVisualizer in Slices render mode to dynamically extract
 * slices from field data without requiring backend to send 2D heatmaps.
 * Sampling (grid lookup, complex phase) comes from FIELD_SAMPLING_GLSL.
 */
import { FIELD_SAMPLING_GLSL } from '../field/sampling';

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
 * Samples a 2D slice from a 3D field
 */
export const planeSliceFragmentShader = `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;

${FIELD_SAMPLING_GLSL}

uniform sampler2D colormapTexture;
uniform int slicePlane;      // 0=XY, 1=XZ, 2=YZ
uniform float slicePosition; // 0-1 normalized position along perpendicular axis
uniform float opacity;
uniform float valueMin;
uniform float valueMax;
uniform bool logColormap;    // Apply logarithmic scaling to colormap
uniform bool discardBelowMin; // false for signed quantities, whose negative half is data

varying vec2 vUv;

void main() {
  // Build the normalized field position based on slice plane
  // Note: PlaneGeometry rotation affects UV->world mapping
  // XZ plane rotates -90 deg around X: UV.y direction becomes -Z
  // YZ plane rotates 90 deg around Y: UV.x direction becomes -Z
  vec3 p;

  if (slicePlane == 0) {
    // XY plane - slice along Z axis
    p = vec3(vUv.x, vUv.y, slicePosition);
  } else if (slicePlane == 1) {
    // XZ plane - slice along Y axis (flip Z)
    p = vec3(vUv.x, slicePosition, 1.0 - vUv.y);
  } else {
    // YZ plane - slice along X axis (flip Z)
    p = vec3(slicePosition, vUv.y, 1.0 - vUv.x);
  }

  float value = fieldValue(p);

  // Values below min are transparent, values above max are clamped to max
  if (discardBelowMin && value < valueMin) {
    discard;
  }
  float normalized = fieldNormalize(value, valueMin, valueMax, logColormap);

  vec3 color = texture2D(colormapTexture, vec2(normalized, 0.5)).rgb;

  gl_FragColor = vec4(color, opacity);
}
`;
