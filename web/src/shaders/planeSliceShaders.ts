/**
 * Plane Slice Shaders for rendering 2D slices from 3D field textures
 *
 * Used by FieldVisualizer in Slices render mode to dynamically extract
 * slices from field data without requiring backend to send 2D heatmaps.
 * Sampling (grid lookup, complex phase) comes from FIELD_SAMPLING_GLSL.
 *
 * Height style: the vertex shader samples the field too and lifts each
 * vertex along the plane normal (local +Z of the PlaneGeometry) by the
 * shown value, and the fragment shader shades the relief with a headlight
 * so peaks read as shape, not just colour.
 */
import { FIELD_SAMPLING_GLSL } from '../field/sampling';

// Field position [0,1]^3 under a slice UV. PlaneGeometry rotation decides
// the UV -> world mapping: the XZ plane is rotated -90 deg about X (UV.y
// runs along -Z), the YZ plane +90 deg about Y (UV.x runs along -Z).
const SLICE_POINT_GLSL = /* glsl */ `
uniform int slicePlane;      // 0=XY, 1=XZ, 2=YZ
uniform float slicePosition; // 0-1 normalized position along perpendicular axis

vec3 slicePoint(vec2 uv) {
  if (slicePlane == 0) return vec3(uv.x, uv.y, slicePosition);
  if (slicePlane == 1) return vec3(uv.x, slicePosition, 1.0 - uv.y);
  return vec3(slicePosition, uv.y, 1.0 - uv.x);
}
`;

const PRECISION = /* glsl */ `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;
`;

export const planeSliceVertexShader = `
${PRECISION}
${FIELD_SAMPLING_GLSL}
${SLICE_POINT_GLSL}

uniform float valueMin;
uniform float valueMax;
uniform bool discardBelowMin;
uniform float heightAmount; // local units at the top of the range; 0 = flat

varying vec2 vUv;
varying vec3 vViewPosition;

void main() {
  vUv = uv;
  vec3 pos = position;
  if (heightAmount != 0.0) {
    float v = fieldValue(slicePoint(uv));
    // Signed values rise and sink about the plane; unsigned ones rise from
    // the bottom of the display range.
    float h = discardBelowMin
      ? clamp((v - valueMin) / max(valueMax - valueMin, 1e-6), 0.0, 1.0)
      : clamp(v / max(valueMax, 1e-6), -1.0, 1.0);
    pos.z += h * heightAmount;
  }
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vViewPosition = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const planeSliceFragmentShader = `
${PRECISION}
${FIELD_SAMPLING_GLSL}
${SLICE_POINT_GLSL}

uniform sampler2D colormapTexture;
uniform float opacity;
uniform float valueMin;
uniform float valueMax;
uniform bool logColormap;    // Apply logarithmic scaling to colormap
uniform bool discardBelowMin; // false for signed quantities, whose negative half is data
uniform float heightAmount;

varying vec2 vUv;
varying vec3 vViewPosition;

void main() {
  float value = fieldValue(slicePoint(vUv));

  // Values below min are transparent, values above max are clamped to max
  if (discardBelowMin && value < valueMin) {
    discard;
  }
  float normalized = fieldNormalize(value, valueMin, valueMax, logColormap);

  vec3 color = texture2D(colormapTexture, vec2(normalized, 0.5)).rgb;
  if (heightAmount != 0.0) {
    vec3 n = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    color *= 0.55 + 0.45 * abs(n.z);
  }

  gl_FragColor = vec4(color, opacity);
}
`;
