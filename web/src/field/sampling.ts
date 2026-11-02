/**
 * Field sampling GLSL shared by every field display mode (slice, volume, ...).
 *
 * Input is a position inside the field box, normalised to [0,1]^3. Output is
 * the displayed scalar at that position. Two things vary per field:
 *
 * - Grid. A uniform grid uses the position directly as the 3D texture
 *   coordinate (the behaviour wt_volume always had). A non-uniform grid
 *   stores each axis's grid coordinates, also normalised to [0,1], in a 1D
 *   texture; the shader binary-searches it and returns (lo + t + 0.5) / n, so
 *   the hardware's linear filter interpolates between grid points lo and
 *   lo + 1 with weight t. Approach taken from @instamax/field-viewer.
 * - Value. A real field returns its value. A complex field (re and im
 *   volumes) returns Re(E e^{-i phase}) = re cos(phase) + im sin(phase), or
 *   |E| when u_fieldQuantity is 1. Phase increasing moves an e^{ikx} wave
 *   towards +x.
 *
 * Display mapping (range, log scale, colormap) stays with each shader, but
 * goes through fieldNormalize so every mode maps values the same way.
 */
export const FIELD_SAMPLING_GLSL = /* glsl */ `
uniform sampler3D u_fieldRe;
uniform sampler3D u_fieldIm;
uniform bool u_fieldComplex;
uniform bool u_fieldUniformGrid;
uniform sampler2D u_fieldAxisX;
uniform sampler2D u_fieldAxisY;
uniform sampler2D u_fieldAxisZ;
uniform int u_fieldQuantity; // 0: value (Re at phase for complex fields), 1: magnitude
uniform float u_fieldPhase;

float fieldAxisCoord(sampler2D axis, float v) {
  int n = textureSize(axis, 0).x;
  float first = texelFetch(axis, ivec2(0, 0), 0).r;
  float last = texelFetch(axis, ivec2(n - 1, 0), 0).r;
  if (v <= first) return 0.5 / float(n);
  if (v >= last) return (float(n) - 0.5) / float(n);
  int lo = 0;
  int hi = n - 1;
  // 2^16 covers any axis texture WebGL2 allows.
  for (int it = 0; it < 16; ++it) {
    if (hi - lo <= 1) break;
    int mid = (lo + hi) / 2;
    if (texelFetch(axis, ivec2(mid, 0), 0).r <= v) lo = mid; else hi = mid;
  }
  float a = texelFetch(axis, ivec2(lo, 0), 0).r;
  float b = texelFetch(axis, ivec2(lo + 1, 0), 0).r;
  float t = (v - a) / max(b - a, 1e-12);
  return (float(lo) + t + 0.5) / float(n);
}

vec3 fieldTexCoord(vec3 p) {
  if (u_fieldUniformGrid) return p;
  return vec3(fieldAxisCoord(u_fieldAxisX, p.x), fieldAxisCoord(u_fieldAxisY, p.y), fieldAxisCoord(u_fieldAxisZ, p.z));
}

float fieldValue(vec3 p) {
  vec3 tc = fieldTexCoord(p);
  float re = texture(u_fieldRe, tc).r;
  if (!u_fieldComplex) return u_fieldQuantity == 1 ? abs(re) : re;
  float im = texture(u_fieldIm, tc).r;
  if (u_fieldQuantity == 1) return length(vec2(re, im));
  return re * cos(u_fieldPhase) + im * sin(u_fieldPhase);
}

// Value -> [0,1] colormap index. Values above vmax clamp; callers decide what
// to do below vmin (slices and volumes treat it as empty).
float fieldNormalize(float v, float vmin, float vmax, bool logScale) {
  float n = (min(v, vmax) - vmin) / (vmax - vmin + 0.0001);
  n = clamp(n, 0.0, 1.0);
  // log10(1 + 9n) maps 0 -> 0 and 1 -> 1 while spreading small values.
  if (logScale) n = log(1.0 + 9.0 * n) / log(10.0);
  return n;
}
`;
