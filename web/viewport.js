var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/runtime.ts
function shared() {
  const globals = globalThis.__witwin;
  if (!globals?.react || !globals.three || !globals.fiber) {
    throw new Error("[wt_volume] viewport host singletons are unavailable");
  }
  return globals;
}
var React = shared().react;
var THREE = shared().three;
var useCallback = React.useCallback;
var useEffect = React.useEffect;
var useMemo = React.useMemo;
var useRef = React.useRef;
var useState = React.useState;
var fiber = shared().fiber;
var drei = shared().drei;
if (!drei?.Html || !drei.Line || !drei.Text) {
  throw new Error("[wt_volume] @react-three/drei host singleton is incomplete");
}
var useFrame = fiber.useFrame;
var useThree = fiber.useThree;
var Html = drei.Html;
var Line = drei.Line;
var Text = drei.Text;

// src/assets/volumeTexture.ts
async function loadVolumeTexture(assets, volume, resolution, onProgress) {
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
    sizeBytes: resource.sizeBytes
  };
}
function checkVolumeSupport(resolution) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    return { supported: false, maxSize: 0, message: "WebGL2 not supported" };
  }
  const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  const [nx, ny, nz] = resolution;
  if (nx > maxSize || ny > maxSize || nz > maxSize) {
    return {
      supported: false,
      maxSize,
      message: `Volume resolution ${nx}x${ny}x${nz} exceeds GPU limit of ${maxSize}`
    };
  }
  return { supported: true, maxSize };
}

// src/field/fieldTextures.ts
function createAxisTexture(coords, lo, hi) {
  const span = hi - lo || 1;
  const data = Float32Array.from(coords, (c) => (c - lo) / span);
  const texture = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
function hasAxes(source) {
  const axes = source.axisCoords;
  return !!axes && axes.length === 3 && axes.every((a, i) => Array.isArray(a) && a.length === source.resolution[i] && a.length >= 2);
}
var placeholders = null;
function placeholderTextures() {
  if (!placeholders) {
    const volume = new THREE.Data3DTexture(new Float32Array(1), 1, 1, 1);
    volume.format = THREE.RedFormat;
    volume.type = THREE.FloatType;
    volume.needsUpdate = true;
    placeholders = { volume, axis: createAxisTexture([0, 1], 0, 1) };
  }
  return placeholders;
}
function createFieldUniforms() {
  const p = placeholderTextures();
  return {
    u_fieldRe: { value: p.volume },
    u_fieldIm: { value: p.volume },
    u_fieldComplex: { value: false },
    u_fieldUniformGrid: { value: true },
    u_fieldAxisX: { value: p.axis },
    u_fieldAxisY: { value: p.axis },
    u_fieldAxisZ: { value: p.axis },
    u_fieldQuantity: { value: 0 },
    u_fieldPhase: { value: 0 }
  };
}
function bindFieldUniforms(uniforms, textures, quantity = "value", phase = 0) {
  const p = placeholderTextures();
  uniforms.u_fieldRe.value = textures.re;
  uniforms.u_fieldIm.value = textures.im ?? p.volume;
  uniforms.u_fieldComplex.value = textures.im !== null;
  uniforms.u_fieldUniformGrid.value = textures.axes === null;
  uniforms.u_fieldAxisX.value = textures.axes?.[0] ?? p.axis;
  uniforms.u_fieldAxisY.value = textures.axes?.[1] ?? p.axis;
  uniforms.u_fieldAxisZ.value = textures.axes?.[2] ?? p.axis;
  uniforms.u_fieldQuantity.value = quantity === "magnitude" ? 1 : 0;
  uniforms.u_fieldPhase.value = phase;
}
function disposeTextures(t) {
  if (!t) return;
  t.re.dispose();
  t.im?.dispose();
  t.axes?.forEach((a) => a.dispose());
}
function useFieldTextures(assets, source, enabled) {
  const [state2, setState] = useState({ textures: null, loading: false, error: null });
  const { volume, volumeIm, resolution, axisCoords, minBound, maxBound } = source;
  const axesKey = hasAxes(source) ? JSON.stringify(axisCoords) + JSON.stringify([minBound, maxBound]) : "";
  useEffect(() => {
    if (!enabled || !volume) {
      setState({ textures: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let loaded = null;
    const support = checkVolumeSupport(resolution);
    if (!support.supported) {
      setState({ textures: null, loading: false, error: support.message || "Volume not supported" });
      return;
    }
    setState({ textures: null, loading: true, error: null });
    (async () => {
      try {
        const [re, im] = await Promise.all([
          loadVolumeTexture(assets, volume, resolution),
          volumeIm ? loadVolumeTexture(assets, volumeIm, resolution) : Promise.resolve(null)
        ]);
        const axes = axesKey ? [0, 1, 2].map((a) => createAxisTexture(axisCoords[a], minBound[a], maxBound[a])) : null;
        loaded = { re: re.texture, im: im?.texture ?? null, axes, resolution: re.resolution };
        if (cancelled) disposeTextures(loaded);
        else setState({ textures: loaded, loading: false, error: null });
      } catch (err) {
        console.error("[wt_volume] Failed to load field volume:", err);
        if (!cancelled) setState({ textures: null, loading: false, error: err?.message || "Failed to load volume" });
      }
    })();
    return () => {
      cancelled = true;
      disposeTextures(loaded);
    };
  }, [assets, enabled, volume?.assetId, volume?.uri, volumeIm?.assetId, volumeIm?.uri, axesKey]);
  return state2;
}

// src/field/sampling.ts
var FIELD_SAMPLING_GLSL = (
  /* glsl */
  `
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
`
);

// src/shaders/volumeShaders.ts
var volumeVertexShader = `
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
var volumeFragmentShader = `
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
function infernoColormap(v) {
  if (v < 0.25) {
    const t = v / 0.25;
    return [1e-3 + t * 0.15, 1e-3 + t * 0.06, 0.014 + t * 0.34];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.15 + t * 0.45, 0.07 + t * 0.09, 0.35 + t * 0.15];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.6 + t * 0.35, 0.16 + t * 0.36, 0.5 - t * 0.4];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.03, 0.52 + t * 0.42, 0.1 - t * 0.03];
  }
}
function plasmaColormap(v) {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.05 + t * 0.35, 0.03 + t * 0.02, 0.53 + t * 0.17];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.4 + t * 0.4, 0.05 + t * 0.1, 0.7 - t * 0.2];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.8 + t * 0.15, 0.15 + t * 0.35, 0.5 - t * 0.3];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.05, 0.5 + t * 0.4, 0.2 - t * 0.1];
  }
}
function viridisColormap(v) {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.267 + t * 0.015, 4e-3 + t * 0.136, 0.329 + t * 0.128];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.282 - t * 0.155, 0.14 + t * 0.426, 0.457 + t * 0.093];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.127 + t * 0.614, 0.566 + t * 0.307, 0.55 - t * 0.4];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.741 + t * 0.252, 0.873 + t * 0.033, 0.15 - t * 6e-3];
  }
}
function jetColormap(v) {
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
function coolwarmColormap(v) {
  if (v < 0.5) {
    const t = v / 0.5;
    return [0.23 + t * 0.77, 0.3 + t * 0.7, 0.75 + t * 0.25];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t * 0.7, 1 - t * 0.75];
  }
}
function bwrColormap(v) {
  if (v < 0.5) {
    const t = v / 0.5;
    return [t, t, 1];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t, 1 - t];
  }
}
function stopsColormap(hexStops) {
  const stops = hexStops.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
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
var rdbuColormap = stopsColormap([
  "#053061",
  "#2166ac",
  "#4393c3",
  "#92c5de",
  "#d1e5f0",
  "#f7f7f7",
  "#fddbc7",
  "#f4a582",
  "#d6604d",
  "#b2182b",
  "#67001f"
]);
var magmaColormap = stopsColormap([
  "#000004",
  "#1c1044",
  "#4f127b",
  "#812581",
  "#b5367a",
  "#e55064",
  "#fb8761",
  "#fec287",
  "#fcfdbf"
]);
function getColormapFunc(name) {
  switch (name) {
    case "rdbu":
      return rdbuColormap;
    case "magma":
      return magmaColormap;
    case "inferno":
      return infernoColormap;
    case "plasma":
      return plasmaColormap;
    case "viridis":
      return viridisColormap;
    case "jet":
      return jetColormap;
    case "coolwarm":
      return coolwarmColormap;
    case "bwr":
      return bwrColormap;
    default:
      return infernoColormap;
  }
}
function createColormapTexture(colormapName) {
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

// src/shaders/blueNoise.ts
var BLUE_NOISE_64x64 = generateBlueNoiseData(64);
function generateBlueNoiseData(size) {
  const data = new Array(size * size);
  const phi2 = 1.324717957244746;
  const alpha1 = 1 / phi2;
  const alpha2 = 1 / (phi2 * phi2);
  const points = [];
  for (let i = 0; i < size * size; i++) {
    const x = (0.5 + alpha1 * i) % 1;
    const y = (0.5 + alpha2 * i) % 1;
    points.push({
      x: Math.floor(x * size),
      y: Math.floor(y * size),
      value: i / (size * size)
    });
  }
  const used = /* @__PURE__ */ new Set();
  const getValue = (x, y) => {
    const h = (x * 73856093 ^ y * 19349663) >>> 0;
    return h % 256 / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const r2Value = points[idx]?.value ?? 0;
      const hashValue = getValue(x, y);
      const mixed = r2Value * 0.7 + hashValue * 0.3;
      data[idx] = Math.floor(mixed * 255);
    }
  }
  const indices = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const r2 = (0.5 + alpha1 * (x + y * size)) % 1 + (0.5 + alpha2 * (x * size + y)) % 1 * 0.5;
      indices.push({ idx, r2 });
    }
  }
  indices.sort((a, b) => a.r2 - b.r2);
  for (let i = 0; i < indices.length; i++) {
    data[indices[i].idx] = Math.floor(i / indices.length * 255);
  }
  return data;
}
var blueNoiseTexture = null;
function getBlueNoiseTexture() {
  if (blueNoiseTexture) {
    return blueNoiseTexture;
  }
  const size = 64;
  const data = new Uint8Array(size * size);
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
  blueNoiseTexture.wrapS = THREE.RepeatWrapping;
  blueNoiseTexture.wrapT = THREE.RepeatWrapping;
  blueNoiseTexture.minFilter = THREE.NearestFilter;
  blueNoiseTexture.magFilter = THREE.NearestFilter;
  blueNoiseTexture.needsUpdate = true;
  return blueNoiseTexture;
}

// src/gizmos/utils.ts
function getComponentValue(component, fieldName, defaultValue) {
  const field = component.fields?.find((f) => f.name === fieldName);
  if (field?.value !== void 0) {
    return field.value;
  }
  if (component.values?.[fieldName] !== void 0) {
    return component.values[fieldName];
  }
  return defaultValue;
}
function inheritsFrom(component, baseClassName) {
  if (component.name === baseClassName) return true;
  return component.base_classes?.includes(baseClassName) || false;
}

// src/gizmos/VolumeDepthPrepass.tsx
var VOLUME_DEPTH_SKIP_FLAG = "__skipVolumeDepthPrepass";
var VOLUME_DEPTH_INCLUDE_FLAG = "__includeVolumeDepthPrepass";
var sharedDepthTarget = null;
var sharedDepthTexture = null;
function getVolumeDepthTexture() {
  return sharedDepthTexture;
}
var VolumeDepthPrepass = () => {
  const { gl, size, scene, camera } = useThree();
  const enableDepthPrepass = true;
  const depthMaterial = useMemo(() => new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking
  }), []);
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
    if (!sharedDepthTarget) {
      const depthTexture = new THREE.DepthTexture(targetWidth, targetHeight);
      depthTexture.minFilter = THREE.NearestFilter;
      depthTexture.magFilter = THREE.NearestFilter;
      sharedDepthTarget = new THREE.WebGLRenderTarget(targetWidth, targetHeight, {
        depthTexture,
        depthBuffer: true,
        stencilBuffer: false
      });
      sharedDepthTarget.texture.minFilter = THREE.NearestFilter;
      sharedDepthTarget.texture.magFilter = THREE.NearestFilter;
    } else if (sharedDepthTarget.width !== targetWidth || sharedDepthTarget.height !== targetHeight) {
      sharedDepthTarget.setSize(targetWidth, targetHeight);
    }
    if (!sharedDepthTarget) return;
    const previousTarget = gl.getRenderTarget();
    if (!enableDepthPrepass) {
      gl.setRenderTarget(sharedDepthTarget);
      gl.clearDepth();
      gl.setRenderTarget(previousTarget);
      sharedDepthTexture = sharedDepthTarget.depthTexture;
      return;
    }
    const previousOverride = scene.overrideMaterial;
    const hidden = [];
    scene.traverse((obj) => {
      const includeFlag = obj.userData?.[VOLUME_DEPTH_INCLUDE_FLAG] === true;
      const userFlagged = obj.userData?.[VOLUME_DEPTH_SKIP_FLAG];
      const helperRenderable = obj.isLine || obj.isLineSegments || obj.isPoints || obj.isSprite;
      const isMeshLike = obj.isMesh || obj.isInstancedMesh || obj.isSkinnedMesh;
      const isRenderable = isMeshLike || helperRenderable;
      if (!isRenderable) return;
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
  }, -1);
  return null;
};
var VolumeDepthPrepass_default = VolumeDepthPrepass;

// src/gizmos/VolumeVisualizer.tsx
var LoadingSpinner = () => /* @__PURE__ */ React.createElement(Html, { center: true }, /* @__PURE__ */ React.createElement("div", { style: {
  width: 32,
  height: 32,
  border: "3px solid rgba(100, 150, 255, 0.3)",
  borderTop: "3px solid #4488ff",
  borderRadius: "50%",
  animation: "spin 1s linear infinite"
} }, /* @__PURE__ */ React.createElement("style", null, `@keyframes spin { to { transform: rotate(360deg); } }`)));
var VolumeVisualizer = ({
  volumeData,
  assets,
  selected = false,
  hovered = false
}) => {
  const { camera, gl } = useThree();
  const absorptionScale = 1;
  const colormapTextureRef = useRef(null);
  const meshRef = useRef(null);
  const drawingBufferSize = useMemo(() => new THREE.Vector2(), []);
  const {
    volume,
    resolution = [128, 128, 128],
    colormap = "viridis",
    log_colormap = false,
    opacity_scale = 1,
    density_scale = 1,
    display_range = [0, 1],
    ray_steps = 128,
    show_slice = false,
    slice_plane = "XZ",
    slice_position = 0.5,
    min_bound,
    max_bound,
    volume_im = null,
    axis_coords = null,
    axis_bounds
  } = volumeData;
  const value_min = display_range[0];
  const value_max = display_range[1];
  const boxSize = useMemo(() => {
    if (min_bound && max_bound) {
      return [
        max_bound[0] - min_bound[0],
        max_bound[1] - min_bound[1],
        max_bound[2] - min_bound[2]
      ];
    }
    return [1, 1, 1];
  }, [min_bound, max_bound]);
  const boxCenter = useMemo(() => {
    if (min_bound && max_bound) {
      return [
        (min_bound[0] + max_bound[0]) / 2,
        (min_bound[1] + max_bound[1]) / 2,
        (min_bound[2] + max_bound[2]) / 2
      ];
    }
    return [0, 0, 0];
  }, [min_bound, max_bound]);
  const normBounds = axis_bounds ?? (min_bound && max_bound ? [min_bound, max_bound] : null);
  const { textures, loading, error } = useFieldTextures(
    assets,
    {
      volume: volume ?? null,
      volumeIm: volume_im,
      resolution,
      axisCoords: normBounds ? axis_coords : null,
      minBound: normBounds?.[0] ?? [0, 0, 0],
      maxBound: normBounds?.[1] ?? [1, 1, 1]
    },
    true
  );
  const textureResolution = textures?.resolution ?? [128, 128, 128];
  useEffect(() => {
    if (colormapTextureRef.current) {
      colormapTextureRef.current.dispose();
    }
    const texture = createColormapTexture(colormap);
    colormapTextureRef.current = texture;
    return () => {
      if (colormapTextureRef.current) {
        colormapTextureRef.current.dispose();
      }
    };
  }, [colormap]);
  const slicePlaneInt = useMemo(() => {
    switch (slice_plane) {
      case "XY":
        return 0;
      case "XZ":
        return 1;
      case "YZ":
        return 2;
      default:
        return 1;
    }
  }, [slice_plane]);
  const volumeMaterial = useMemo(() => {
    if (!textures || !colormapTextureRef.current) return null;
    const modelMatrixInverse = new THREE.Matrix4();
    const dummyDepth = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
    dummyDepth.needsUpdate = true;
    const initialViewportSize = gl.getDrawingBufferSize(new THREE.Vector2());
    const blueNoiseTexture2 = getBlueNoiseTexture();
    return new THREE.ShaderMaterial({
      uniforms: {
        ...createFieldUniforms(),
        colormapTexture: { value: colormapTextureRef.current },
        blueNoiseTexture: { value: blueNoiseTexture2 },
        modelMatrixInverse: { value: modelMatrixInverse },
        uModelMatrix: { value: new THREE.Matrix4() },
        uViewMatrix: { value: new THREE.Matrix4() },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        volumeResolution: { value: new THREE.Vector3(textureResolution[0], textureResolution[1], textureResolution[2]) },
        opacityScale: { value: opacity_scale },
        densityScale: { value: density_scale },
        absorptionScale: { value: absorptionScale },
        valueMin: { value: value_min },
        valueMax: { value: value_max },
        logColormap: { value: log_colormap },
        raySteps: { value: ray_steps },
        showSlice: { value: show_slice },
        slicePlane: { value: slicePlaneInt },
        slicePosition: { value: slice_position },
        sceneDepthTexture: { value: dummyDepth },
        viewportSize: { value: initialViewportSize },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far }
      },
      vertexShader: volumeVertexShader,
      fragmentShader: volumeFragmentShader,
      // DoubleSide allows rendering when camera is inside or outside the volume
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
  }, [textures]);
  useEffect(() => {
    return () => {
      if (volumeMaterial) {
        volumeMaterial.dispose();
      }
    };
  }, [volumeMaterial]);
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.userData[VOLUME_DEPTH_SKIP_FLAG] = true;
    }
  }, [volumeMaterial]);
  useFrame(() => {
    if (!meshRef.current || !volumeMaterial) return;
    meshRef.current.updateMatrixWorld();
    const invMatrix = meshRef.current.matrixWorld.clone().invert();
    volumeMaterial.uniforms.modelMatrixInverse.value.copy(invMatrix);
    volumeMaterial.uniforms.uModelMatrix.value.copy(meshRef.current.matrixWorld);
    volumeMaterial.uniforms.uViewMatrix.value.copy(camera.matrixWorldInverse);
    volumeMaterial.uniforms.uProjectionMatrix.value.copy(camera.projectionMatrix);
    volumeMaterial.uniforms.volumeResolution.value.set(textureResolution[0], textureResolution[1], textureResolution[2]);
    volumeMaterial.uniforms.opacityScale.value = opacity_scale;
    volumeMaterial.uniforms.densityScale.value = density_scale;
    volumeMaterial.uniforms.absorptionScale.value = absorptionScale;
    volumeMaterial.uniforms.valueMin.value = value_min;
    volumeMaterial.uniforms.valueMax.value = value_max;
    volumeMaterial.uniforms.logColormap.value = log_colormap;
    volumeMaterial.uniforms.raySteps.value = ray_steps;
    volumeMaterial.uniforms.showSlice.value = show_slice;
    volumeMaterial.uniforms.slicePlane.value = slicePlaneInt;
    volumeMaterial.uniforms.slicePosition.value = slice_position;
    gl.getDrawingBufferSize(drawingBufferSize);
    volumeMaterial.uniforms.viewportSize.value.copy(drawingBufferSize);
    volumeMaterial.uniforms.cameraNear.value = camera.near;
    volumeMaterial.uniforms.cameraFar.value = camera.far;
    if (textures) bindFieldUniforms(volumeMaterial.uniforms, textures, "magnitude");
    const depthTexture = getVolumeDepthTexture();
    if (depthTexture) {
      volumeMaterial.uniforms.sceneDepthTexture.value = depthTexture;
    }
    if (colormapTextureRef.current) {
      volumeMaterial.uniforms.colormapTexture.value = colormapTextureRef.current;
    }
  });
  const showPlaceholder = error || !volume || !volumeMaterial;
  if (loading && !volumeMaterial) {
    return /* @__PURE__ */ React.createElement(LoadingSpinner, null);
  }
  if (showPlaceholder) {
    let placeholderColor = "#666666";
    if (error) placeholderColor = "#ff0000";
    return /* @__PURE__ */ React.createElement("group", { position: boxCenter, scale: boxSize }, /* @__PURE__ */ React.createElement("lineSegments", { ref: meshRef }, /* @__PURE__ */ React.createElement("edgesGeometry", { args: [new THREE.BoxGeometry(1, 1, 1)] }), /* @__PURE__ */ React.createElement(
      "lineBasicMaterial",
      {
        color: placeholderColor,
        transparent: true,
        opacity: 0.5
      }
    )), (selected || hovered) && /* @__PURE__ */ React.createElement("lineSegments", null, /* @__PURE__ */ React.createElement("edgesGeometry", { args: [new THREE.BoxGeometry(1.02, 1.02, 1.02)] }), /* @__PURE__ */ React.createElement(
      "lineBasicMaterial",
      {
        color: selected ? 16746496 : 16755200,
        transparent: true,
        opacity: selected ? 1 : 0.6,
        linewidth: 2
      }
    )));
  }
  return /* @__PURE__ */ React.createElement("group", { position: boxCenter, scale: boxSize }, /* @__PURE__ */ React.createElement("mesh", { ref: meshRef, material: volumeMaterial, raycast: () => null }, /* @__PURE__ */ React.createElement("boxGeometry", { args: [1, 1, 1] })), (selected || hovered) && /* @__PURE__ */ React.createElement("lineSegments", null, /* @__PURE__ */ React.createElement("edgesGeometry", { args: [new THREE.BoxGeometry(1.02, 1.02, 1.02)] }), /* @__PURE__ */ React.createElement(
    "lineBasicMaterial",
    {
      color: selected ? 16746496 : 16755200,
      transparent: true,
      opacity: selected ? 1 : 0.6,
      linewidth: 2
    }
  )));
};
var VolumeVisualizerAdapter = ({
  data,
  assets,
  selected,
  hovered
}) => {
  return /* @__PURE__ */ React.createElement(VolumeVisualizer, { volumeData: data, assets, selected, hovered });
};
var volumeVisualizerConfig = {
  name: "volume",
  priority: 12,
  // Only match VolumeRenderer component (pure renderer)
  // Field components handle their own Volume rendering via FieldVisualizer + field3DRenderData
  matcher: (c) => c.name === "VolumeRenderer",
  // Extract visualization data from component
  extractor: (comp) => {
    const volume = getComponentValue(comp, "volume", null);
    if (!volume) return null;
    return {
      volume,
      resolution: getComponentValue(comp, "resolution", [128, 128, 128]),
      colormap: getComponentValue(comp, "colormap", "viridis"),
      log_colormap: getComponentValue(comp, "log_colormap", false),
      opacity_scale: getComponentValue(comp, "opacity_scale", 1),
      density_scale: getComponentValue(comp, "density_scale", 1),
      display_range: getComponentValue(comp, "display_range", [0, 1]),
      ray_steps: getComponentValue(comp, "ray_steps", 128),
      show_slice: getComponentValue(comp, "show_slice", false),
      slice_plane: getComponentValue(comp, "slice_plane", "XZ"),
      slice_position: getComponentValue(comp, "slice_position", 0.5),
      // Field bounds (for Field-like components)
      min_bound: getComponentValue(comp, "min_bound", void 0),
      max_bound: getComponentValue(comp, "max_bound", void 0)
    };
  },
  component: VolumeVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.6
};
var VolumeVisualizer_default = VolumeVisualizer;

// src/shaders/sdfShaders.ts
var sdfVertexShader = `
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
var sdfFragmentShader = `
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
function infernoColormap2(v) {
  if (v < 0.25) {
    const t = v / 0.25;
    return [1e-3 + t * 0.15, 1e-3 + t * 0.06, 0.014 + t * 0.34];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.15 + t * 0.45, 0.07 + t * 0.09, 0.35 + t * 0.15];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.6 + t * 0.35, 0.16 + t * 0.36, 0.5 - t * 0.4];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.03, 0.52 + t * 0.42, 0.1 - t * 0.03];
  }
}
function plasmaColormap2(v) {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.05 + t * 0.35, 0.03 + t * 0.02, 0.53 + t * 0.17];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.4 + t * 0.4, 0.05 + t * 0.1, 0.7 - t * 0.2];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.8 + t * 0.15, 0.15 + t * 0.35, 0.5 - t * 0.3];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.05, 0.5 + t * 0.4, 0.2 - t * 0.1];
  }
}
function viridisColormap2(v) {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.267 + t * 0.015, 4e-3 + t * 0.136, 0.329 + t * 0.128];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.282 - t * 0.155, 0.14 + t * 0.426, 0.457 + t * 0.093];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.127 + t * 0.614, 0.566 + t * 0.307, 0.55 - t * 0.4];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.741 + t * 0.252, 0.873 + t * 0.033, 0.15 - t * 6e-3];
  }
}
function jetColormap2(v) {
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
function coolwarmColormap2(v) {
  if (v < 0.5) {
    const t = v / 0.5;
    return [0.23 + t * 0.77, 0.3 + t * 0.7, 0.75 + t * 0.25];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t * 0.7, 1 - t * 0.75];
  }
}
function bwrColormap2(v) {
  if (v < 0.5) {
    const t = v / 0.5;
    return [t, t, 1];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t, 1 - t];
  }
}
function getColormapFunc2(name) {
  switch (name) {
    case "inferno":
      return infernoColormap2;
    case "plasma":
      return plasmaColormap2;
    case "viridis":
      return viridisColormap2;
    case "jet":
      return jetColormap2;
    case "coolwarm":
      return coolwarmColormap2;
    case "bwr":
      return bwrColormap2;
    default:
      return infernoColormap2;
  }
}
function createColormapTexture2(colormapName) {
  const width = 256;
  const data = new Uint8Array(width * 4);
  const colormapFunc = getColormapFunc2(colormapName);
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

// src/gizmos/SDFVisualizer.tsx
var LoadingSpinner2 = () => /* @__PURE__ */ React.createElement(Html, { center: true }, /* @__PURE__ */ React.createElement("div", { style: {
  width: 32,
  height: 32,
  border: "3px solid rgba(100, 150, 255, 0.3)",
  borderTop: "3px solid #4488ff",
  borderRadius: "50%",
  animation: "spin 1s linear infinite"
} }, /* @__PURE__ */ React.createElement("style", null, `@keyframes spin { to { transform: rotate(360deg); } }`)));
var SDFVisualizer = ({
  sdfData,
  assets,
  selected = false,
  hovered = false
}) => {
  const { camera } = useThree();
  const [volumeTexture, setVolumeTexture] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [textureResolution, setTextureResolution] = useState([128, 128, 128]);
  const volumeTextureRef = useRef(null);
  const colormapTextureRef = useRef(null);
  const meshRef = useRef(null);
  const {
    volume,
    resolution = [128, 128, 128],
    render_technique = "sdf",
    iso_value = 0,
    enable_lighting = true,
    colormap = "viridis",
    log_colormap = false,
    opacity_scale = 1,
    density_scale = 1,
    display_range = [0, 1],
    ray_steps = 128,
    show_slice = false,
    slice_plane = "XZ",
    slice_position = 0.5,
    min_bound,
    max_bound
  } = sdfData;
  const value_min = display_range[0];
  const value_max = display_range[1];
  const boxSize = useMemo(() => {
    if (min_bound && max_bound) {
      return [
        max_bound[0] - min_bound[0],
        max_bound[1] - min_bound[1],
        max_bound[2] - min_bound[2]
      ];
    }
    return [1, 1, 1];
  }, [min_bound, max_bound]);
  const boxCenter = useMemo(() => {
    if (min_bound && max_bound) {
      return [
        (min_bound[0] + max_bound[0]) / 2,
        (min_bound[1] + max_bound[1]) / 2,
        (min_bound[2] + max_bound[2]) / 2
      ];
    }
    return [0, 0, 0];
  }, [min_bound, max_bound]);
  const renderModeInt = useMemo(() => {
    return render_technique === "isosurface" ? 2 : 1;
  }, [render_technique]);
  useEffect(() => {
    if (!volume) {
      setVolumeTexture(null);
      setError(null);
      setLoading(false);
      return;
    }
    const loadVolume = async () => {
      setLoading(true);
      setError(null);
      try {
        const loadResolution = resolution;
        const support = checkVolumeSupport(loadResolution);
        if (!support.supported) {
          throw new Error(support.message || "Volume not supported");
        }
        if (volumeTextureRef.current) {
          volumeTextureRef.current.dispose();
          volumeTextureRef.current = null;
        }
        const result = await loadVolumeTexture(
          assets,
          volume,
          loadResolution,
          void 0
        );
        volumeTextureRef.current = result.texture;
        setVolumeTexture(result.texture);
        setTextureResolution(result.resolution);
        setLoading(false);
      } catch (err) {
        console.error("[SDFVisualizer] Failed to load SDF:", err);
        setError(err.message || "Failed to load volume");
        setLoading(false);
      }
    };
    loadVolume();
    return () => {
      if (volumeTextureRef.current) {
        volumeTextureRef.current.dispose();
        volumeTextureRef.current = null;
      }
    };
  }, [assets, volume?.assetId, volume?.uri]);
  useEffect(() => {
    if (colormapTextureRef.current) {
      colormapTextureRef.current.dispose();
    }
    const texture = createColormapTexture2(colormap);
    colormapTextureRef.current = texture;
    return () => {
      if (colormapTextureRef.current) {
        colormapTextureRef.current.dispose();
      }
    };
  }, [colormap]);
  const slicePlaneInt = useMemo(() => {
    switch (slice_plane) {
      case "XY":
        return 0;
      case "XZ":
        return 1;
      case "YZ":
        return 2;
      default:
        return 1;
    }
  }, [slice_plane]);
  const sdfMaterial = useMemo(() => {
    if (!volumeTexture || !colormapTextureRef.current) return null;
    const modelMatrixInverse = new THREE.Matrix4();
    return new THREE.ShaderMaterial({
      uniforms: {
        volumeTexture: { value: volumeTexture },
        colormapTexture: { value: colormapTextureRef.current },
        modelMatrixInverse: { value: modelMatrixInverse },
        uModelMatrix: { value: new THREE.Matrix4() },
        uViewMatrix: { value: new THREE.Matrix4() },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        volumeResolution: { value: new THREE.Vector3(textureResolution[0], textureResolution[1], textureResolution[2]) },
        renderMode: { value: renderModeInt },
        isoValue: { value: iso_value },
        enableLighting: { value: enable_lighting },
        opacityScale: { value: opacity_scale },
        densityScale: { value: density_scale },
        valueMin: { value: value_min },
        valueMax: { value: value_max },
        logColormap: { value: log_colormap },
        raySteps: { value: ray_steps },
        showSlice: { value: show_slice },
        slicePlane: { value: slicePlaneInt },
        slicePosition: { value: slice_position }
      },
      vertexShader: sdfVertexShader,
      fragmentShader: sdfFragmentShader,
      // DoubleSide allows rendering when camera is inside or outside the volume
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
  }, [volumeTexture]);
  useEffect(() => {
    return () => {
      if (sdfMaterial) {
        sdfMaterial.dispose();
      }
    };
  }, [sdfMaterial]);
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.userData[VOLUME_DEPTH_SKIP_FLAG] = true;
    }
  }, [sdfMaterial]);
  useFrame(() => {
    if (!meshRef.current || !sdfMaterial) return;
    meshRef.current.updateMatrixWorld();
    const invMatrix = meshRef.current.matrixWorld.clone().invert();
    sdfMaterial.uniforms.modelMatrixInverse.value.copy(invMatrix);
    sdfMaterial.uniforms.uModelMatrix.value.copy(meshRef.current.matrixWorld);
    sdfMaterial.uniforms.uViewMatrix.value.copy(camera.matrixWorldInverse);
    sdfMaterial.uniforms.uProjectionMatrix.value.copy(camera.projectionMatrix);
    sdfMaterial.uniforms.volumeResolution.value.set(textureResolution[0], textureResolution[1], textureResolution[2]);
    sdfMaterial.uniforms.renderMode.value = renderModeInt;
    sdfMaterial.uniforms.isoValue.value = iso_value;
    sdfMaterial.uniforms.enableLighting.value = enable_lighting;
    sdfMaterial.uniforms.opacityScale.value = opacity_scale;
    sdfMaterial.uniforms.densityScale.value = density_scale;
    sdfMaterial.uniforms.valueMin.value = value_min;
    sdfMaterial.uniforms.valueMax.value = value_max;
    sdfMaterial.uniforms.logColormap.value = log_colormap;
    sdfMaterial.uniforms.raySteps.value = ray_steps;
    sdfMaterial.uniforms.showSlice.value = show_slice;
    sdfMaterial.uniforms.slicePlane.value = slicePlaneInt;
    sdfMaterial.uniforms.slicePosition.value = slice_position;
    if (colormapTextureRef.current) {
      sdfMaterial.uniforms.colormapTexture.value = colormapTextureRef.current;
    }
  });
  const showPlaceholder = error || !volume || !sdfMaterial;
  if (loading && !sdfMaterial) {
    return /* @__PURE__ */ React.createElement(LoadingSpinner2, null);
  }
  if (showPlaceholder) {
    let placeholderColor = "#666666";
    if (error) placeholderColor = "#ff0000";
    return /* @__PURE__ */ React.createElement("group", { position: boxCenter, scale: boxSize }, /* @__PURE__ */ React.createElement("lineSegments", { ref: meshRef }, /* @__PURE__ */ React.createElement("edgesGeometry", { args: [new THREE.BoxGeometry(1, 1, 1)] }), /* @__PURE__ */ React.createElement(
      "lineBasicMaterial",
      {
        color: placeholderColor,
        transparent: true,
        opacity: 0.5
      }
    )), (selected || hovered) && /* @__PURE__ */ React.createElement("lineSegments", null, /* @__PURE__ */ React.createElement("edgesGeometry", { args: [new THREE.BoxGeometry(1.02, 1.02, 1.02)] }), /* @__PURE__ */ React.createElement(
      "lineBasicMaterial",
      {
        color: selected ? 16746496 : 16755200,
        transparent: true,
        opacity: selected ? 1 : 0.6,
        linewidth: 2
      }
    )));
  }
  return /* @__PURE__ */ React.createElement("group", { position: boxCenter, scale: boxSize }, /* @__PURE__ */ React.createElement("mesh", { ref: meshRef, material: sdfMaterial, raycast: () => null }, /* @__PURE__ */ React.createElement("boxGeometry", { args: [1, 1, 1] })), (selected || hovered) && /* @__PURE__ */ React.createElement("lineSegments", null, /* @__PURE__ */ React.createElement("edgesGeometry", { args: [new THREE.BoxGeometry(1.02, 1.02, 1.02)] }), /* @__PURE__ */ React.createElement(
    "lineBasicMaterial",
    {
      color: selected ? 16746496 : 16755200,
      transparent: true,
      opacity: selected ? 1 : 0.6,
      linewidth: 2
    }
  )));
};
var SDFVisualizerAdapter = ({
  data,
  assets,
  selected,
  hovered
}) => {
  return /* @__PURE__ */ React.createElement(SDFVisualizer, { sdfData: data, assets, selected, hovered });
};
var sdfVisualizerConfig = {
  name: "sdf",
  priority: 13,
  // Only match SDFRenderer component (pure renderer)
  // Field components handle their own SDF rendering via FieldVisualizer + field3DRenderData
  matcher: (c) => c.name === "SDFRenderer",
  // Extract visualization data from component
  extractor: (comp) => {
    const volume = getComponentValue(comp, "volume", null);
    if (!volume) return null;
    return {
      volume,
      resolution: getComponentValue(comp, "resolution", [128, 128, 128]),
      render_technique: getComponentValue(comp, "render_technique", "sdf"),
      iso_value: getComponentValue(comp, "iso_value", 0),
      enable_lighting: getComponentValue(comp, "enable_lighting", true),
      colormap: getComponentValue(comp, "colormap", "viridis"),
      log_colormap: getComponentValue(comp, "log_colormap", false),
      opacity_scale: getComponentValue(comp, "opacity_scale", 1),
      density_scale: getComponentValue(comp, "density_scale", 1),
      display_range: getComponentValue(comp, "display_range", [0, 1]),
      ray_steps: getComponentValue(comp, "ray_steps", 128),
      show_slice: getComponentValue(comp, "show_slice", false),
      slice_plane: getComponentValue(comp, "slice_plane", "XZ"),
      slice_position: getComponentValue(comp, "slice_position", 0.5),
      // Field bounds (for Field-like components)
      min_bound: getComponentValue(comp, "min_bound", void 0),
      max_bound: getComponentValue(comp, "max_bound", void 0)
    };
  },
  component: SDFVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.6
};
var SDFVisualizer_default = SDFVisualizer;

// src/shaders/planeSliceShaders.ts
var SLICE_POINT_GLSL = (
  /* glsl */
  `
uniform int slicePlane;      // 0=XY, 1=XZ, 2=YZ
uniform float slicePosition; // 0-1 normalized position along perpendicular axis

vec3 slicePoint(vec2 uv) {
  if (slicePlane == 0) return vec3(uv.x, uv.y, slicePosition);
  if (slicePlane == 1) return vec3(uv.x, slicePosition, 1.0 - uv.y);
  return vec3(slicePosition, uv.y, 1.0 - uv.x);
}
`
);
var PRECISION = (
  /* glsl */
  `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;
`
);
var planeSliceVertexShader = `
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
var planeSliceFragmentShader = `
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

// src/field/fieldLegend.ts
var BAR_WIDTH = 168;
var BAR_HEIGHT = 10;
function legendTitle(name, unit, complex, magnitude, hasRange) {
  const quantity = name || (complex ? magnitude ? "|E|" : "Re(E)" : "Value");
  if (unit) return `${quantity} (${unit})`;
  return hasRange ? quantity : `${quantity}, arbitrary units`;
}
function formatLegendValue(v) {
  if (v === 0 || Math.abs(v) < 1e-12) return "0";
  const a = Math.abs(v);
  if (a >= 1e4 || a < 0.01) return v.toExponential(1).replace("e+", "e");
  return String(Number(v.toPrecision(2)));
}
function legendDataValue(spec, n) {
  const range = spec.valueRange;
  if (!range || range.length !== 2) return n;
  if (spec.complex) return n * Math.max(Math.abs(range[0]), Math.abs(range[1]));
  return range[0] + n * (range[1] - range[0]);
}
function fieldLegendSpec(data) {
  const complex = !!data.volume_im;
  const magnitude = data.field_quantity === "magnitude";
  const signed = complex && !magnitude;
  const range = data.display_range ?? [0, 1];
  return {
    title: legendTitle(data.legend_title ?? "", data.field_unit ?? "", complex, magnitude, !!data.value_range),
    colormap: data.colormap ?? "inferno",
    valueMin: signed ? -range[1] : range[0],
    valueMax: range[1],
    signed,
    logScale: !!data.log_colormap,
    complex,
    valueRange: data.value_range ?? null
  };
}
function legendTicks(spec) {
  const ticks = [
    [0, formatLegendValue(legendDataValue(spec, spec.valueMin))],
    [1, formatLegendValue(legendDataValue(spec, spec.valueMax))]
  ];
  if (spec.signed && !spec.logScale) ticks.splice(1, 0, [0.5, "0"]);
  return ticks;
}
var stacks = /* @__PURE__ */ new WeakMap();
function acquireStack(parent) {
  let entry = stacks.get(parent);
  if (!entry) {
    const el = document.createElement("div");
    el.dataset.testid = "field-legends";
    Object.assign(el.style, {
      position: "absolute",
      left: "12px",
      bottom: "44px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      pointerEvents: "none",
      zIndex: "2"
    });
    parent.appendChild(el);
    entry = { el, users: 0 };
    stacks.set(parent, entry);
  }
  entry.users += 1;
  return entry.el;
}
function releaseStack(parent) {
  const entry = stacks.get(parent);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users <= 0) {
    entry.el.remove();
    stacks.delete(parent);
  }
}
function renderCard(card, spec) {
  card.replaceChildren();
  const title = document.createElement("div");
  title.textContent = spec.title;
  Object.assign(title.style, { fontWeight: "500", marginBottom: "6px", color: "var(--text-primary)" });
  const bar = document.createElement("canvas");
  bar.width = BAR_WIDTH;
  bar.height = 1;
  Object.assign(bar.style, { display: "block", width: `${BAR_WIDTH}px`, height: `${BAR_HEIGHT}px`, borderRadius: "2px" });
  const ctx = bar.getContext("2d");
  if (ctx) {
    const colour = getColormapFunc(spec.colormap);
    const img = ctx.createImageData(BAR_WIDTH, 1);
    for (let x = 0; x < BAR_WIDTH; x++) {
      let t = x / (BAR_WIDTH - 1);
      if (spec.logScale) t = Math.log10(1 + 9 * t);
      const [r, g, b] = colour(t);
      img.data.set([r * 255, g * 255, b * 255, 255], x * 4);
    }
    ctx.putImageData(img, 0, 0);
  }
  const ticks = document.createElement("div");
  Object.assign(ticks.style, { position: "relative", height: "14px", marginTop: "4px", color: "var(--text-secondary)" });
  for (const [at, text] of legendTicks(spec)) {
    const label = document.createElement("span");
    label.textContent = text;
    const anchor = at === 0 ? "0%" : at === 1 ? "-100%" : "-50%";
    Object.assign(label.style, { position: "absolute", left: `${at * 100}%`, transform: `translateX(${anchor})` });
    ticks.appendChild(label);
  }
  card.append(title, bar, ticks);
}
function useFieldLegend(spec) {
  const gl = useThree((s) => s.gl);
  const key = spec ? JSON.stringify(spec) : "";
  useEffect(() => {
    const parent = gl.domElement.parentElement;
    if (!spec || !parent) return void 0;
    const stack = acquireStack(parent);
    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "var(--gray-3)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "6px",
      padding: "8px 10px",
      font: "11px var(--font-family)"
    });
    renderCard(card, spec);
    stack.appendChild(card);
    return () => {
      card.remove();
      releaseStack(parent);
    };
  }, [gl, key]);
}

// src/slice/phaseClock.ts
var PERIOD_MS = 2e3;
var state = { playing: false, phase: 0 };
var listeners = /* @__PURE__ */ new Set();
var frame = 0;
var last = 0;
function emit(next) {
  state = next;
  listeners.forEach((l) => l());
}
function tick(now) {
  if (!state.playing) return;
  const dt = last ? now - last : 0;
  last = now;
  emit({ playing: true, phase: (state.phase + 2 * Math.PI * dt / PERIOD_MS) % (2 * Math.PI) });
  frame = requestAnimationFrame(tick);
}
var phaseClock = {
  get: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  play(from) {
    if (state.playing) return;
    last = 0;
    emit({ playing: true, phase: from });
    frame = requestAnimationFrame(tick);
  },
  /** Stops and returns the phase it stopped at. */
  pause() {
    cancelAnimationFrame(frame);
    emit({ playing: false, phase: state.phase });
    return state.phase;
  }
};
function usePhaseClock() {
  return React.useSyncExternalStore(phaseClock.subscribe, phaseClock.get);
}

// src/gizmos/fieldHitTarget.ts
var FIELD_EDGE_HIT_WIDTH_PX = 8;
var FIELD_EDGE_HIT_MIN_RADIUS = 0.01;
var FIELD_EDGE_HIT_MAX_RADIUS = 0.08;
var FIELD_EDGE_HIT_FIELD_FRACTION = 0.02;
var EPSILON = 1e-6;
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function getShortestPositiveFieldExtent(minBound, maxBound) {
  const extents = [0, 1, 2].map((i) => Math.abs((maxBound[i] ?? 0) - (minBound[i] ?? 0))).filter((extent) => extent > EPSILON);
  return extents.length > 0 ? Math.min(...extents) : 0;
}
function getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) {
  if (viewportHeightPx <= 0) return 0;
  if (camera.isOrthographicCamera) {
    const ortho = camera;
    return Math.abs(ortho.top - ortho.bottom) / Math.max(ortho.zoom, EPSILON) / viewportHeightPx;
  }
  if (camera.isPerspectiveCamera) {
    const perspective = camera;
    const cameraWorldPosition = new THREE.Vector3();
    perspective.getWorldPosition(cameraWorldPosition);
    const distance = Math.max(cameraWorldPosition.distanceTo(worldPoint), EPSILON);
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) * distance;
    return visibleHeight / viewportHeightPx;
  }
  return 0;
}
function fieldGizmoUnit(minBound, maxBound) {
  const largest = Math.max(0, ...[0, 1, 2].map((i) => Math.abs((maxBound[i] ?? 0) - (minBound[i] ?? 0))));
  return largest > EPSILON * EPSILON ? Math.min(1, largest / 2) : 1;
}
function parentWorldScale(object) {
  const s = new THREE.Vector3(1, 1, 1);
  object.parent?.getWorldScale(s);
  return Math.max(Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)), 1e-12);
}
function screenConstantScale(camera, object, viewportHeightPx, pxPerUnit = 2) {
  const worldPoint = object.getWorldPosition(new THREE.Vector3());
  return getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) * pxPerUnit / parentWorldScale(object);
}
function calculateFieldEdgeHitRadius({
  camera,
  worldPoint,
  viewportHeightPx,
  minBound,
  maxBound,
  targetHitWidthPx = FIELD_EDGE_HIT_WIDTH_PX,
  minRadius = FIELD_EDGE_HIT_MIN_RADIUS,
  maxRadius = FIELD_EDGE_HIT_MAX_RADIUS,
  fieldFraction = FIELD_EDGE_HIT_FIELD_FRACTION,
  worldScale = 1
}) {
  const screenRadius = getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) * targetHitWidthPx / 2 / worldScale;
  const shortestExtent = getShortestPositiveFieldExtent(minBound, maxBound);
  const fieldRadiusCap = shortestExtent > EPSILON ? shortestExtent * fieldFraction : maxRadius;
  return clamp(Math.min(screenRadius, fieldRadiusCap), Math.min(minRadius, fieldRadiusCap), maxRadius);
}

// src/gizmos/selectionHitTarget.ts
var SOFT_SELECTION_HIT_AREA_FLAG = "__softSelectionHitArea";

// src/gizmos/FieldVisualizer.tsx
var DEFAULT_FIELD_COLOR = "#333333";
var DEFAULT_FIELD_OPACITY = 0.7;
var MAX_HEIGHT_SEGMENTS = 256;
function createCheckerboardTexture(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const isLight = (x + y) % 2 === 0;
      const gray = isLight ? 255 : 0;
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      data[i + 3] = isLight ? 40 : 20;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}
var FieldEdgeHitArea = ({ edge, minBound, maxBound }) => {
  const meshRef = useRef(null);
  const { camera, size } = useThree();
  const { mid, euler, length } = useMemo(() => {
    const start = new THREE.Vector3(...edge[0]);
    const end = new THREE.Vector3(...edge[1]);
    const midpoint = start.clone().add(end).multiplyScalar(0.5);
    const edgeLength = start.distanceTo(end);
    const direction = edgeLength > 1e-6 ? end.clone().sub(start).normalize() : new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    return {
      mid: midpoint,
      euler: new THREE.Euler().setFromQuaternion(quaternion),
      length: edgeLength
    };
  }, [edge]);
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const worldMid = new THREE.Vector3();
    mesh.getWorldPosition(worldMid);
    const localRadius = calculateFieldEdgeHitRadius({
      camera,
      worldPoint: worldMid,
      viewportHeightPx: size.height,
      minBound,
      maxBound,
      worldScale: parentWorldScale(mesh)
    });
    mesh.scale.set(localRadius, length, localRadius);
  });
  return /* @__PURE__ */ React.createElement(
    "mesh",
    {
      ref: meshRef,
      position: [mid.x, mid.y, mid.z],
      rotation: [euler.x, euler.y, euler.z],
      userData: { [SOFT_SELECTION_HIT_AREA_FLAG]: true }
    },
    /* @__PURE__ */ React.createElement("cylinderGeometry", { args: [1, 1, 1, 8] }),
    /* @__PURE__ */ React.createElement("meshBasicMaterial", { transparent: true, opacity: 1e-3, depthWrite: false })
  );
};
var FieldVisualizer = ({
  fieldData: fieldData2,
  assets,
  selected = false,
  isGizmoDragging = false
}) => {
  const {
    dimension = "3D",
    plane = "XZ",
    min_bound = [-5, -5, -5],
    max_bound = [5, 5, 5],
    show_grid = false,
    render_mode = "None",
    colormap = "inferno",
    log_colormap = false,
    plane_axis = "XZ",
    plane_position = 0.5,
    plane_opacity = 1,
    volume,
    volume_im = null,
    axis_coords = null,
    field_quantity = "value",
    field_phase = 0,
    resolution = [128, 128, 128],
    display_range = [0, 1],
    show_legend = true,
    slice_style = "Flat",
    height_scale = 0.2
  } = fieldData2;
  const legend = fieldLegendSpec(fieldData2);
  const { signed, valueMin, valueMax } = legend;
  useFieldLegend(render_mode === "Slices" && show_legend && volume ? legend : null);
  const clock = usePhaseClock();
  const animating = clock.playing && !!volume_im;
  const phase = animating ? clock.phase : field_phase;
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (animating) invalidate();
  }, [animating, phase, invalidate]);
  const colormapTextureRef = useRef(null);
  const sliceMeshRef = useRef(null);
  const { textures } = useFieldTextures(
    assets,
    {
      volume: volume ?? null,
      volumeIm: volume_im ?? null,
      resolution,
      axisCoords: axis_coords ?? null,
      minBound: min_bound,
      maxBound: max_bound
    },
    render_mode === "Slices"
  );
  const planeParamsRef = useRef({
    slicePlaneInt: 1,
    slicePosition: plane_position,
    opacity: plane_opacity,
    valueMin,
    valueMax,
    logColormap: log_colormap,
    signed,
    quantity: field_quantity,
    phase: field_phase,
    heightAmount: 0
  });
  useEffect(() => {
    if (colormapTextureRef.current) {
      colormapTextureRef.current.dispose();
    }
    const texture = createColormapTexture(colormap);
    colormapTextureRef.current = texture;
    return () => {
      if (colormapTextureRef.current) {
        colormapTextureRef.current.dispose();
      }
    };
  }, [colormap]);
  const effectivePlaneAxis = dimension === "2D" ? plane : plane_axis;
  const effectiveSlicePosition = dimension === "2D" ? 0.5 : plane_position;
  const slicePlaneInt = useMemo(() => {
    switch (effectivePlaneAxis) {
      case "XY":
        return 0;
      case "XZ":
        return 1;
      case "YZ":
        return 2;
      default:
        return 1;
    }
  }, [effectivePlaneAxis]);
  const height = slice_style === "Height";
  planeParamsRef.current = {
    slicePlaneInt,
    slicePosition: effectiveSlicePosition,
    opacity: plane_opacity,
    valueMin,
    valueMax,
    logColormap: log_colormap,
    signed,
    quantity: field_quantity,
    phase,
    heightAmount: 0
    // set below, once the plane size is known
  };
  const planeSliceMaterial = useMemo(() => {
    if (!textures || !colormapTextureRef.current) return null;
    const uniforms = {
      ...createFieldUniforms(),
      colormapTexture: { value: colormapTextureRef.current },
      slicePlane: { value: slicePlaneInt },
      slicePosition: { value: effectiveSlicePosition },
      opacity: { value: plane_opacity },
      valueMin: { value: valueMin },
      valueMax: { value: valueMax },
      logColormap: { value: log_colormap },
      discardBelowMin: { value: !signed },
      heightAmount: { value: 0 }
    };
    bindFieldUniforms(uniforms, textures, field_quantity, field_phase);
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: planeSliceVertexShader,
      fragmentShader: planeSliceFragmentShader,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      alphaTest: 0.01
    });
  }, [textures]);
  useEffect(() => () => planeSliceMaterial?.dispose(), [planeSliceMaterial]);
  useFrame(() => {
    if (!sliceMeshRef.current || !planeSliceMaterial || !textures) return;
    const params = planeParamsRef.current;
    const u = planeSliceMaterial.uniforms;
    u.slicePlane.value = params.slicePlaneInt;
    u.slicePosition.value = params.slicePosition;
    u.opacity.value = params.opacity;
    u.valueMin.value = params.valueMin;
    u.valueMax.value = params.valueMax;
    u.logColormap.value = params.logColormap;
    u.discardBelowMin.value = !params.signed;
    u.heightAmount.value = params.heightAmount;
    bindFieldUniforms(u, textures, params.quantity, params.phase);
    if (colormapTextureRef.current) {
      u.colormapTexture.value = colormapTextureRef.current;
    }
  });
  const boxEdges = useMemo(() => {
    const [minX, minY, minZ] = min_bound;
    const [maxX, maxY, maxZ] = max_bound;
    if (dimension === "2D") {
      let corners2;
      switch (plane) {
        case "XY":
          corners2 = [
            [minX, minY, minZ],
            [maxX, minY, minZ],
            [maxX, maxY, minZ],
            [minX, maxY, minZ]
          ];
          break;
        case "YZ":
          corners2 = [
            [minX, minY, minZ],
            [minX, maxY, minZ],
            [minX, maxY, maxZ],
            [minX, minY, maxZ]
          ];
          break;
        case "XZ":
        default:
          corners2 = [
            [minX, minY, minZ],
            [maxX, minY, minZ],
            [maxX, minY, maxZ],
            [minX, minY, maxZ]
          ];
          break;
      }
      return [
        [corners2[0], corners2[1]],
        [corners2[1], corners2[2]],
        [corners2[2], corners2[3]],
        [corners2[3], corners2[0]]
      ];
    }
    const corners = [
      [minX, minY, minZ],
      // 0
      [maxX, minY, minZ],
      // 1
      [maxX, maxY, minZ],
      // 2
      [minX, maxY, minZ],
      // 3
      [minX, minY, maxZ],
      // 4
      [maxX, minY, maxZ],
      // 5
      [maxX, maxY, maxZ],
      // 6
      [minX, maxY, maxZ]
      // 7
    ];
    return [
      // Bottom face
      [corners[0], corners[1]],
      [corners[1], corners[5]],
      [corners[5], corners[4]],
      [corners[4], corners[0]],
      // Top face
      [corners[3], corners[2]],
      [corners[2], corners[6]],
      [corners[6], corners[7]],
      [corners[7], corners[3]],
      // Vertical edges
      [corners[0], corners[3]],
      [corners[1], corners[2]],
      [corners[5], corners[6]],
      [corners[4], corners[7]]
    ];
  }, [min_bound, max_bound, dimension, plane]);
  const [checkerboardTexture, setCheckerboardTexture] = useState(null);
  const checkerboardTextureRef = useRef(null);
  useEffect(() => {
    if (checkerboardTextureRef.current) {
      checkerboardTextureRef.current.dispose();
      checkerboardTextureRef.current = null;
    }
    if (show_grid && resolution) {
      let width, height2;
      if (dimension === "2D") {
        switch (plane) {
          case "XY":
            width = resolution[0];
            height2 = resolution[1];
            break;
          case "YZ":
            width = resolution[1];
            height2 = resolution[2];
            break;
          case "XZ":
          default:
            width = resolution[0];
            height2 = resolution[2];
            break;
        }
      } else {
        switch (plane_axis) {
          case "XY":
            width = resolution[0];
            height2 = resolution[1];
            break;
          case "YZ":
            width = resolution[1];
            height2 = resolution[2];
            break;
          case "XZ":
          default:
            width = resolution[0];
            height2 = resolution[2];
            break;
        }
      }
      width = Math.max(2, Math.round(width));
      height2 = Math.max(2, Math.round(height2));
      const texture = createCheckerboardTexture(width, height2);
      checkerboardTextureRef.current = texture;
      setCheckerboardTexture(texture);
    } else {
      setCheckerboardTexture(null);
    }
    return () => {
      if (checkerboardTextureRef.current) {
        checkerboardTextureRef.current.dispose();
      }
    };
  }, [show_grid, resolution, dimension, plane, plane_axis]);
  const edgeLineWidth = selected ? 2.5 : 1.5;
  const edgeColor = isGizmoDragging ? "#666666" : selected ? "#ff8800" : DEFAULT_FIELD_COLOR;
  const edgeOpacity = isGizmoDragging ? 0.3 : selected ? 1 : DEFAULT_FIELD_OPACITY;
  const planeGeometry = useMemo(() => {
    const [minX, minY, minZ] = min_bound;
    const [maxX, maxY, maxZ] = max_bound;
    const nudge = 1e-3 * fieldGizmoUnit(min_bound, max_bound);
    if (dimension === "2D") {
      switch (plane) {
        case "XY":
          return {
            position: [(minX + maxX) / 2, (minY + maxY) / 2, minZ + nudge],
            rotation: [0, 0, 0],
            size: [maxX - minX, maxY - minY]
          };
        case "YZ":
          return {
            position: [minX + nudge, (minY + maxY) / 2, (minZ + maxZ) / 2],
            rotation: [0, Math.PI / 2, 0],
            size: [maxZ - minZ, maxY - minY]
          };
        case "XZ":
        default:
          return {
            position: [(minX + maxX) / 2, minY + nudge, (minZ + maxZ) / 2],
            rotation: [-Math.PI / 2, 0, 0],
            size: [maxX - minX, maxZ - minZ]
          };
      }
    } else {
      const h = plane_position;
      switch (plane_axis) {
        case "XY": {
          const zPos = minZ + h * (maxZ - minZ) + nudge;
          return {
            position: [(minX + maxX) / 2, (minY + maxY) / 2, zPos],
            rotation: [0, 0, 0],
            size: [maxX - minX, maxY - minY]
          };
        }
        case "YZ": {
          const xPos = minX + h * (maxX - minX) + nudge;
          return {
            position: [xPos, (minY + maxY) / 2, (minZ + maxZ) / 2],
            rotation: [0, Math.PI / 2, 0],
            size: [maxZ - minZ, maxY - minY]
          };
        }
        case "XZ":
        default: {
          const yPos = minY + h * (maxY - minY) + nudge;
          return {
            position: [(minX + maxX) / 2, yPos, (minZ + maxZ) / 2],
            rotation: [-Math.PI / 2, 0, 0],
            size: [maxX - minX, maxZ - minZ]
          };
        }
      }
    }
  }, [min_bound, max_bound, dimension, plane, plane_axis, plane_position]);
  planeParamsRef.current.heightAmount = height ? height_scale * Math.max(planeGeometry.size[0], planeGeometry.size[1]) : 0;
  const sliceSegments = useMemo(() => {
    if (!height) return [1, 1];
    const cells = (axis) => Math.min(MAX_HEIGHT_SEGMENTS, Math.max(1, Math.round(resolution[axis] ?? 64)));
    switch (effectivePlaneAxis) {
      case "XY":
        return [cells(0), cells(1)];
      case "YZ":
        return [cells(2), cells(1)];
      default:
        return [cells(0), cells(2)];
    }
  }, [height, resolution, effectivePlaneAxis]);
  return /* @__PURE__ */ React.createElement("group", null, boxEdges.map((edge, i) => /* @__PURE__ */ React.createElement(
    Line,
    {
      key: `edge-${i}`,
      points: edge,
      color: edgeColor,
      lineWidth: edgeLineWidth,
      transparent: true,
      opacity: edgeOpacity,
      raycast: () => null
    }
  )), boxEdges.map((edge, i) => /* @__PURE__ */ React.createElement(
    FieldEdgeHitArea,
    {
      key: `edge-hit-${i}`,
      edge,
      minBound: min_bound,
      maxBound: max_bound
    }
  )), render_mode === "Slices" && planeSliceMaterial && /* @__PURE__ */ React.createElement(
    "mesh",
    {
      ref: sliceMeshRef,
      position: planeGeometry.position,
      rotation: planeGeometry.rotation,
      raycast: () => null,
      renderOrder: -10,
      material: planeSliceMaterial
    },
    /* @__PURE__ */ React.createElement("planeGeometry", { args: [planeGeometry.size[0], planeGeometry.size[1], sliceSegments[0], sliceSegments[1]] })
  ), checkerboardTexture && show_grid && render_mode === "Slices" && !height && /* @__PURE__ */ React.createElement(
    "mesh",
    {
      position: [
        planeGeometry.position[0],
        planeGeometry.position[1] + (planeGeometry.rotation[0] === 0 ? 0 : 2e-3),
        planeGeometry.position[2] + (planeGeometry.rotation[0] === 0 ? 2e-3 : 0)
      ],
      rotation: planeGeometry.rotation,
      raycast: () => null,
      renderOrder: -9
    },
    /* @__PURE__ */ React.createElement("planeGeometry", { args: [planeGeometry.size[0], planeGeometry.size[1]] }),
    /* @__PURE__ */ React.createElement(
      "meshBasicMaterial",
      {
        map: checkerboardTexture,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: true,
        alphaTest: 0.01
      }
    )
  ));
};
var FieldVisualizerAdapter = ({
  data,
  assets,
  selected,
  isGizmoDragging
}) => {
  return /* @__PURE__ */ React.createElement(FieldVisualizer, { fieldData: data, assets, selected, isGizmoDragging });
};
var fieldVisualizerConfig = {
  name: "field",
  priority: 10,
  // Higher priority - Field can contain other visualizations
  // Match Field component or any component inheriting from Field
  matcher: (c) => inheritsFrom(c, "Field"),
  // Extract visualization data from component
  extractor: (comp) => ({
    componentName: comp.name,
    dimension: getComponentValue(comp, "dimension", "3D"),
    plane: getComponentValue(comp, "plane", "XZ"),
    min_bound: getComponentValue(comp, "min_bound", [-5, -5, -5]),
    max_bound: getComponentValue(comp, "max_bound", [5, 5, 5]),
    cell_size: getComponentValue(comp, "cell_size", 0.5),
    show_grid: getComponentValue(comp, "show_grid", true),
    render_mode: getComponentValue(comp, "render_mode", "None"),
    colormap: getComponentValue(comp, "colormap", "inferno"),
    log_colormap: getComponentValue(comp, "log_colormap", false),
    // Plane renderer settings
    plane_axis: getComponentValue(comp, "plane_axis", "XZ"),
    plane_position: getComponentValue(comp, "plane_position", 0.5),
    plane_opacity: getComponentValue(comp, "plane_opacity", 1),
    // Volume data for shader-based rendering (unified)
    volume: getComponentValue(comp, "volume", null),
    volume_im: getComponentValue(comp, "volume_im", null),
    axis_coords: getComponentValue(comp, "axis_coords", null),
    field_quantity: getComponentValue(comp, "field_quantity", "value"),
    field_phase: getComponentValue(comp, "field_phase", 0),
    resolution: getComponentValue(comp, "resolution", [128, 128, 128]),
    // Normalized display range (0-1)
    display_range: getComponentValue(comp, "display_range", [0, 1]),
    value_range: getComponentValue(comp, "value_range", null),
    show_legend: getComponentValue(comp, "show_legend", true),
    legend_title: getComponentValue(comp, "legend_title", ""),
    field_unit: getComponentValue(comp, "field_unit", ""),
    slice_style: getComponentValue(comp, "slice_style", "Flat"),
    height_scale: getComponentValue(comp, "height_scale", 0.2)
  }),
  component: FieldVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.5
};
var FieldVisualizer_default = FieldVisualizer;

// src/gizmos/dragPlane.ts
function axisDragPlaneNormal(axis, viewDir) {
  const normal = viewDir.clone().addScaledVector(axis, -viewDir.dot(axis));
  if (normal.lengthSq() > 1e-8) return normal.normalize();
  const helper = Math.abs(axis.x) < 0.9 ? axis.clone().set(1, 0, 0) : axis.clone().set(0, 1, 0);
  return helper.cross(axis).normalize();
}
var MIN_RAY_PLANE_COS = 1e-3;
function intersectDragPlane(ray, plane) {
  if (Math.abs(plane.normal.dot(ray.direction)) < MIN_RAY_PLANE_COS) return null;
  return ray.intersectPlane(plane, ray.origin.clone());
}

// src/gizmos/FieldHandle.tsx
var CORNER_RADIUS_PX = 5;
var FACE_RADIUS_PX = 4.5;
var EDGE_HIT_PX = 10;
var EDGE_END_CLEARANCE_PX = 12;
var EDGE_LINE_PX = 1.5;
var EDGE_LINE_HOVER_PX = 3;
var BACK_OPACITY = 0.35;
var HANDLE_RENDER_ORDER = 1e3;
function modifiersOf(event) {
  return { snap: event.ctrlKey || event.metaKey, symmetric: event.altKey, uniform: event.shiftKey };
}
var AXIS_VECTORS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
var FieldHandle = ({
  spec,
  colors,
  active,
  onDragStart,
  onDrag,
  onDragEnd,
  setGizmoDragging
}) => {
  const [hovered, setHovered] = useState(false);
  const { camera, gl, size } = useThree();
  const rootRef = useRef(null);
  const hitRef = useRef(null);
  const isEdge = spec.kind === "edge";
  const radiusPx = spec.kind === "corner" ? CORNER_RADIUS_PX : FACE_RADIUS_PX;
  const lit = hovered || active;
  const opacity = spec.back && !lit ? BACK_OPACITY : 1;
  useFrame(() => {
    if (!isEdge && rootRef.current) {
      const grow = lit ? 1.3 : 1;
      rootRef.current.scale.setScalar(screenConstantScale(camera, rootRef.current, size.height, radiusPx * grow));
    }
    if (isEdge && hitRef.current && spec.segment && spec.edgeAxis !== void 0) {
      const thickness = screenConstantScale(camera, hitRef.current, size.height, EDGE_HIT_PX);
      const clearance = screenConstantScale(camera, hitRef.current, size.height, EDGE_END_CLEARANCE_PX);
      const [p, q] = spec.segment;
      const length = Math.abs(q[spec.edgeAxis] - p[spec.edgeAxis]);
      const scale = [thickness, thickness, thickness];
      scale[spec.edgeAxis] = Math.max(length - 2 * clearance, length * 0.2);
      hitRef.current.scale.set(scale[0], scale[1], scale[2]);
    }
  });
  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    const object = isEdge ? hitRef.current : rootRef.current;
    const parent = object?.parent;
    if (!object || !parent) return;
    e.stopPropagation();
    parent.updateMatrixWorld();
    const parentWorld = parent.matrixWorld.clone();
    const parentInverse = parentWorld.clone().invert();
    const worldAxis = (axis) => new THREE.Vector3(...AXIS_VECTORS[axis]).transformDirection(parentWorld);
    const origin = object.getWorldPosition(new THREE.Vector3());
    const viewDir = camera.getWorldDirection(new THREE.Vector3());
    let normal;
    if (spec.axes.length === 1) {
      normal = axisDragPlaneNormal(worldAxis(spec.axes[0]), viewDir);
    } else {
      const third = [0, 1, 2].find((axis) => !spec.axes.includes(axis)) ?? 2;
      normal = worldAxis(third);
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const raycaster = new THREE.Raycaster();
    const hitLocal = (event) => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        (event.clientX - rect.left) / rect.width * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      const hit = intersectDragPlane(raycaster.ray, plane);
      return hit ? hit.applyMatrix4(parentInverse) : null;
    };
    const startHit = hitLocal(e.nativeEvent) ?? origin.clone().applyMatrix4(parentInverse);
    const startPosition = [...spec.position];
    setGizmoDragging(true);
    onDragStart(spec);
    document.body.style.cursor = "grabbing";
    gl.domElement.setPointerCapture(e.pointerId);
    const handlePointerMove = (moveEvent) => {
      if (moveEvent.buttons === 0) return;
      const hit = hitLocal(moveEvent);
      if (!hit) return;
      const delta = hit.sub(startHit);
      const pointer = [...startPosition];
      for (const axis of spec.axes) pointer[axis] += delta.getComponent(axis);
      onDrag(spec, pointer, modifiersOf(moveEvent));
    };
    const handlePointerUp = (upEvent) => {
      setGizmoDragging(false);
      document.body.style.cursor = "";
      if (gl.domElement.hasPointerCapture(upEvent.pointerId)) gl.domElement.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      onDragEnd();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [camera, gl, isEdge, spec, onDragStart, onDrag, onDragEnd, setGizmoDragging]);
  const handlePointerEnter = useCallback((e) => {
    e.stopPropagation();
    setHovered(true);
    if (!active) document.body.style.cursor = "grab";
  }, [active]);
  const handlePointerLeave = useCallback((e) => {
    e.stopPropagation();
    setHovered(false);
    if (!active) document.body.style.cursor = "";
  }, [active]);
  if (isEdge && spec.segment) {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      Line,
      {
        points: spec.segment,
        color: colors.accent,
        lineWidth: lit ? EDGE_LINE_HOVER_PX : EDGE_LINE_PX,
        transparent: true,
        depthTest: false,
        renderOrder: HANDLE_RENDER_ORDER,
        raycast: () => null
      }
    ), /* @__PURE__ */ React.createElement(
      "mesh",
      {
        ref: hitRef,
        position: spec.position,
        userData: { isGizmo: true },
        onPointerDown: handlePointerDown,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave
      },
      /* @__PURE__ */ React.createElement("boxGeometry", { args: [1, 1, 1] }),
      /* @__PURE__ */ React.createElement("meshBasicMaterial", { transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
    ));
  }
  return /* @__PURE__ */ React.createElement(
    "group",
    {
      ref: rootRef,
      position: spec.position,
      userData: { isGizmo: true },
      onPointerDown: handlePointerDown,
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave
    },
    /* @__PURE__ */ React.createElement("mesh", { renderOrder: HANDLE_RENDER_ORDER }, /* @__PURE__ */ React.createElement("sphereGeometry", { args: [1, 16, 12] }), /* @__PURE__ */ React.createElement("meshBasicMaterial", { color: colors.accent, transparent: true, opacity, depthTest: false, depthWrite: false })),
    /* @__PURE__ */ React.createElement("mesh", { renderOrder: HANDLE_RENDER_ORDER + 1, raycast: () => null }, /* @__PURE__ */ React.createElement("sphereGeometry", { args: [0.6, 16, 12] }), /* @__PURE__ */ React.createElement("meshBasicMaterial", { color: lit ? colors.accent : colors.fill, transparent: true, opacity, depthTest: false, depthWrite: false }))
  );
};
var FieldHandle_default = FieldHandle;

// src/gizmos/FieldHeightSlider.tsx
var LABEL_PX = 12;
var FieldHeightSlider = ({
  minBound,
  maxBound,
  plane,
  height,
  onHeightChange,
  onHeightChangeEnd,
  color = "#333333",
  activeColor = "#666666",
  setGizmoDragging = () => void 0
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [dragHeight, setDragHeight] = useState(height);
  const { camera, gl, size } = useThree();
  const groupRef = useRef(null);
  const handleRef = useRef(null);
  const startCapRef = useRef(null);
  const endCapRef = useRef(null);
  const labelRef = useRef(null);
  const dragStartRef = useRef(null);
  const planeRef = useRef(null);
  const groupWorldInverseRef = useRef(new THREE.Matrix4());
  const latestHeightRef = useRef(height);
  React.useEffect(() => {
    if (!isDragging) {
      setDragHeight(height);
    }
  }, [height, isDragging]);
  const [minX, minY, minZ] = minBound;
  const [maxX, maxY, maxZ] = maxBound;
  const baseScreenSize = 16;
  const currentHeight = isDragging ? dragHeight : height;
  const unit = fieldGizmoUnit(minBound, maxBound);
  const sliderConfig = useMemo(() => {
    const offset = 1 * unit;
    switch (plane) {
      case "XY": {
        const sliderStart = [maxX + offset, (minY + maxY) / 2, minZ];
        const sliderEnd = [maxX + offset, (minY + maxY) / 2, maxZ];
        const axisLength = maxZ - minZ;
        const handlePos = [
          maxX + offset,
          (minY + maxY) / 2,
          minZ + currentHeight * axisLength
        ];
        const axisDir = new THREE.Vector3(0, 0, 1);
        const startPoint = new THREE.Vector3(sliderStart[0], sliderStart[1], sliderStart[2]);
        return { sliderStart, sliderEnd, handlePos, axis: "z", axisLength, axisMin: minZ, axisDir, startPoint };
      }
      case "YZ": {
        const sliderStart = [minX, (minY + maxY) / 2, maxZ + offset];
        const sliderEnd = [maxX, (minY + maxY) / 2, maxZ + offset];
        const axisLength = maxX - minX;
        const handlePos = [
          minX + currentHeight * axisLength,
          (minY + maxY) / 2,
          maxZ + offset
        ];
        const axisDir = new THREE.Vector3(1, 0, 0);
        const startPoint = new THREE.Vector3(sliderStart[0], sliderStart[1], sliderStart[2]);
        return { sliderStart, sliderEnd, handlePos, axis: "x", axisLength, axisMin: minX, axisDir, startPoint };
      }
      case "XZ":
      default: {
        const sliderStart = [maxX + offset, minY, (minZ + maxZ) / 2];
        const sliderEnd = [maxX + offset, maxY, (minZ + maxZ) / 2];
        const axisLength = maxY - minY;
        const handlePos = [
          maxX + offset,
          minY + currentHeight * axisLength,
          (minZ + maxZ) / 2
        ];
        const axisDir = new THREE.Vector3(0, 1, 0);
        const startPoint = new THREE.Vector3(sliderStart[0], sliderStart[1], sliderStart[2]);
        return { sliderStart, sliderEnd, handlePos, axis: "y", axisLength, axisMin: minY, axisDir, startPoint };
      }
    }
  }, [plane, minX, minY, minZ, maxX, maxY, maxZ, currentHeight, isDragging, unit]);
  useFrame(() => {
    if (handleRef.current) {
      handleRef.current.scale.setScalar(screenConstantScale(camera, handleRef.current, size.height) * baseScreenSize);
    }
    for (const cap of [startCapRef.current, endCapRef.current]) {
      if (cap) cap.scale.setScalar(screenConstantScale(camera, cap, size.height) * 2.5);
    }
    if (labelRef.current) {
      labelRef.current.scale.setScalar(screenConstantScale(camera, labelRef.current, size.height, LABEL_PX));
    }
  });
  const currentColor = isDragging ? activeColor : isHovered ? "#555555" : color;
  const createDragPlane = useCallback((point2) => {
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    const axisWorld = sliderConfig.axisDir.clone();
    const parentWorld = groupRef.current?.matrixWorld;
    if (parentWorld) axisWorld.transformDirection(parentWorld);
    const planeNormal = axisDragPlaneNormal(axisWorld, cameraDirection);
    return new THREE.Plane(planeNormal, -planeNormal.dot(point2));
  }, [camera, sliderConfig.axisDir]);
  const intersectPlane = useCallback((event) => {
    if (!planeRef.current) return null;
    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    return intersectDragPlane(raycaster.ray, planeRef.current);
  }, [camera, gl]);
  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setIsDragging(true);
    setGizmoDragging(true);
    if (groupRef.current) {
      groupWorldInverseRef.current.copy(groupRef.current.matrixWorld).invert();
    }
    if (handleRef.current) {
      const worldPos = new THREE.Vector3();
      handleRef.current.getWorldPosition(worldPos);
      dragStartRef.current = {
        height,
        worldY: sliderConfig.axis === "x" ? worldPos.x : sliderConfig.axis === "y" ? worldPos.y : worldPos.z
      };
      planeRef.current = createDragPlane(worldPos);
    }
    document.body.style.cursor = "ns-resize";
    gl.domElement.setPointerCapture(e.pointerId);
    const handlePointerMove = (moveEvent) => {
      if (!dragStartRef.current || !planeRef.current) return;
      const intersection = intersectPlane(moveEvent);
      if (!intersection) return;
      const localIntersection = intersection.clone().applyMatrix4(groupWorldInverseRef.current);
      const toIntersection = localIntersection.clone().sub(sliderConfig.startPoint);
      const projectedDistance = toIntersection.dot(sliderConfig.axisDir);
      let newHeight = projectedDistance / sliderConfig.axisLength;
      newHeight = Math.max(0, Math.min(1, newHeight));
      latestHeightRef.current = newHeight;
      setDragHeight(newHeight);
      onHeightChange(newHeight);
    };
    const handlePointerUp = (upEvent) => {
      setIsDragging(false);
      setGizmoDragging(false);
      dragStartRef.current = null;
      planeRef.current = null;
      document.body.style.cursor = "";
      gl.domElement.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      onHeightChangeEnd?.(latestHeightRef.current);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [height, sliderConfig, createDragPlane, intersectPlane, onHeightChange, onHeightChangeEnd, gl, setGizmoDragging]);
  const handlePointerEnter = useCallback((e) => {
    e.stopPropagation();
    setIsHovered(true);
    if (!isDragging) {
      document.body.style.cursor = "ns-resize";
    }
  }, [isDragging]);
  const handlePointerLeave = useCallback((e) => {
    e.stopPropagation();
    setIsHovered(false);
    if (!isDragging) {
      document.body.style.cursor = "";
    }
  }, [isDragging]);
  const labelPosition = useMemo(() => {
    const pos = [...sliderConfig.handlePos];
    switch (sliderConfig.axis) {
      case "x":
        pos[2] += 0.5 * unit;
        break;
      case "y":
        pos[0] += 0.5 * unit;
        break;
      case "z":
        pos[0] += 0.5 * unit;
        break;
    }
    return pos;
  }, [sliderConfig, unit]);
  return /* @__PURE__ */ React.createElement("group", { ref: groupRef }, /* @__PURE__ */ React.createElement(
    Line,
    {
      points: [sliderConfig.sliderStart, sliderConfig.sliderEnd],
      color,
      lineWidth: 2,
      transparent: true,
      opacity: 0.8
    }
  ), /* @__PURE__ */ React.createElement("mesh", { ref: startCapRef, position: sliderConfig.sliderStart }, /* @__PURE__ */ React.createElement("sphereGeometry", { args: [1, 12, 12] }), /* @__PURE__ */ React.createElement("meshBasicMaterial", { color, transparent: true, opacity: 0.8 })), /* @__PURE__ */ React.createElement("mesh", { ref: endCapRef, position: sliderConfig.sliderEnd }, /* @__PURE__ */ React.createElement("sphereGeometry", { args: [1, 12, 12] }), /* @__PURE__ */ React.createElement("meshBasicMaterial", { color, transparent: true, opacity: 0.8 })), /* @__PURE__ */ React.createElement(
    "mesh",
    {
      ref: handleRef,
      position: sliderConfig.handlePos,
      userData: { isGizmo: true },
      onPointerDown: handlePointerDown,
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave
    },
    /* @__PURE__ */ React.createElement("boxGeometry", { args: sliderConfig.axis === "x" ? [1, 0.4, 0.4] : sliderConfig.axis === "y" ? [0.4, 1, 0.4] : [0.4, 0.4, 1] }),
    /* @__PURE__ */ React.createElement(
      "meshBasicMaterial",
      {
        color: currentColor,
        transparent: true,
        opacity: 1,
        depthTest: false
      }
    )
  ), /* @__PURE__ */ React.createElement("group", { ref: labelRef, position: labelPosition }, /* @__PURE__ */ React.createElement(
    Text,
    {
      fontSize: 1,
      color: currentColor,
      anchorX: "left",
      anchorY: "middle"
    },
    `${Math.round(currentHeight * 100)}%`
  )));
};
var FieldHeightSlider_default = FieldHeightSlider;

// src/gizmos/boundsLayout.ts
var NO_MODIFIERS = { snap: false, symmetric: false, uniform: false };
var PLANE_NORMAL = { XY: 2, XZ: 1, YZ: 0 };
var FACING_HYSTERESIS = 1.15;
function pickFacingAxis(toCamera, current, hysteresis = FACING_HYSTERESIS) {
  const magnitude = toCamera.map(Math.abs);
  let best = 0;
  if (magnitude[1] > magnitude[best]) best = 1;
  if (magnitude[2] > magnitude[best]) best = 2;
  if (current === null || current === best) return best;
  return magnitude[best] > magnitude[current] * hysteresis ? best : current;
}
function otherAxes(normal) {
  return normal === 0 ? [1, 2] : normal === 1 ? [0, 2] : [0, 1];
}
function boundValue(bounds, axis, side) {
  return side === "min" ? bounds.min[axis] : bounds.max[axis];
}
function point(entries) {
  const p = [0, 0, 0];
  for (const [axis, value] of entries) p[axis] = value;
  return p;
}
function buildBoundsHandles(bounds, normal, near, withDepth) {
  const [a, b] = otherAxes(normal);
  const sides = ["min", "max"];
  const nearValue = boundValue(bounds, normal, near);
  const mid = (axis) => (bounds.min[axis] + bounds.max[axis]) / 2;
  const handles = [];
  for (const sa of sides) {
    for (const sb of sides) {
      handles.push({
        id: `corner-${sa}-${sb}`,
        kind: "corner",
        position: point([[a, boundValue(bounds, a, sa)], [b, boundValue(bounds, b, sb)], [normal, nearValue]]),
        axes: [a, b],
        sides: { [a]: sa, [b]: sb }
      });
    }
  }
  for (const [moved, along] of [[a, b], [b, a]]) {
    for (const side of sides) {
      const value = boundValue(bounds, moved, side);
      const start = point([[moved, value], [along, bounds.min[along]], [normal, nearValue]]);
      const end = point([[moved, value], [along, bounds.max[along]], [normal, nearValue]]);
      handles.push({
        id: `edge-${moved}-${side}`,
        kind: "edge",
        position: point([[moved, value], [along, mid(along)], [normal, nearValue]]),
        axes: [moved],
        sides: { [moved]: side },
        segment: [start, end],
        edgeAxis: along
      });
    }
  }
  if (withDepth) {
    for (const side of sides) {
      handles.push({
        id: `face-${side}`,
        kind: "face",
        position: point([[a, mid(a)], [b, mid(b)], [normal, boundValue(bounds, normal, side)]]),
        axes: [normal],
        sides: { [normal]: side },
        back: side !== near
      });
    }
  }
  return handles;
}
function snapSize(size, step) {
  return Math.max(step, Math.round(size / step) * step);
}
function largestExtent(bounds) {
  return Math.max(0, ...[0, 1, 2].map((i) => Math.abs(bounds.max[i] - bounds.min[i])));
}
function roundStep(bounds) {
  const extent = largestExtent(bounds);
  return extent > 0 ? 10 ** Math.floor(Math.log10(extent)) / 10 : 1;
}
function minimumSize(bounds) {
  return largestExtent(bounds) * 1e-3;
}
function applyBoundsDrag(start, handle2, pointer, cell, mods = NO_MODIFIERS) {
  const min = [...start.min];
  const max = [...start.max];
  const hasCell = cell !== null && cell > 0;
  const minSize = hasCell ? cell : minimumSize(start);
  const step = hasCell ? cell : roundStep(start);
  const sizes = /* @__PURE__ */ new Map();
  for (const axis of handle2.axes) {
    const side = handle2.sides[axis] ?? "max";
    const startSize = start.max[axis] - start.min[axis];
    const centre = (start.min[axis] + start.max[axis]) / 2;
    const size = mods.symmetric ? 2 * (side === "max" ? pointer[axis] - centre : centre - pointer[axis]) : side === "max" ? pointer[axis] - start.min[axis] : start.max[axis] - pointer[axis];
    sizes.set(axis, Number.isFinite(size) ? size : startSize);
  }
  if (mods.uniform && handle2.axes.length === 2) {
    let ratio = 1;
    let change = -1;
    for (const axis of handle2.axes) {
      const startSize = start.max[axis] - start.min[axis];
      if (startSize <= 0) continue;
      const r = (sizes.get(axis) ?? startSize) / startSize;
      if (Math.abs(r - 1) > change) {
        change = Math.abs(r - 1);
        ratio = r;
      }
    }
    for (const axis of handle2.axes) sizes.set(axis, (start.max[axis] - start.min[axis]) * ratio);
  }
  for (const axis of handle2.axes) {
    const side = handle2.sides[axis] ?? "max";
    let size = Math.max(sizes.get(axis) ?? 0, minSize);
    if (mods.snap && step > 0) size = snapSize(size, step);
    if (mods.symmetric) {
      const centre = (start.min[axis] + start.max[axis]) / 2;
      min[axis] = centre - size / 2;
      max[axis] = centre + size / 2;
    } else if (side === "max") {
      max[axis] = start.min[axis] + size;
    } else {
      min[axis] = start.max[axis] - size;
    }
  }
  return { min, max };
}
function cellCounts(bounds, cell) {
  return [0, 1, 2].map(
    (i) => cell > 0 ? Math.max(1, Math.round((bounds.max[i] - bounds.min[i]) / cell)) : 0
  );
}
var LENGTH_UNITS = [
  [1, "m"],
  [1e-3, "mm"],
  [1e-6, "\xB5m"],
  [1e-9, "nm"]
];
function formatLength(metres) {
  const magnitude = Math.abs(metres);
  const [scale, unit] = LENGTH_UNITS.find(([s]) => magnitude >= s * 0.9995) ?? LENGTH_UNITS[LENGTH_UNITS.length - 1];
  return `${Number((metres / scale).toPrecision(3))} ${unit}`;
}

// src/gizmos/FieldGizmo.tsx
var noopInteraction = {
  setGizmoDragging: () => void 0,
  isGizmoDragging: () => false
};
var noopSceneWrites = {
  updateComponentField: async () => void 0,
  updateObjectTransform: async () => void 0
};
function vectorArray(value, fallback) {
  if (Array.isArray(value)) {
    return [
      Number(value[0] ?? fallback[0]),
      Number(value[1] ?? fallback[1]),
      Number(value[2] ?? fallback[2])
    ];
  }
  if (value && typeof value === "object") {
    const v = value;
    return [
      Number(v.x ?? fallback[0]),
      Number(v.y ?? fallback[1]),
      Number(v.z ?? fallback[2])
    ];
  }
  return fallback;
}
function vec3(value, fallback) {
  return [Number(value?.[0] ?? fallback[0]), Number(value?.[1] ?? fallback[1]), Number(value?.[2] ?? fallback[2])];
}
var FALLBACK_COLORS = { accent: "#0066cc", fill: "#ffffff" };
function readHandleColors() {
  try {
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue("--accent").trim();
    const lifted = style.getPropertyValue("--accent-text").trim();
    const pick = (value) => value && !value.includes("(") ? value : "";
    return { accent: pick(lifted) || pick(accent) || FALLBACK_COLORS.accent, fill: FALLBACK_COLORS.fill };
  } catch {
    return FALLBACK_COLORS;
  }
}
function boxSegments(bounds, normal2d) {
  const { min, max } = bounds;
  if (normal2d !== null) {
    const [a, b] = normal2d === 0 ? [1, 2] : normal2d === 1 ? [0, 2] : [0, 1];
    const at = (va, vb) => {
      const p = [0, 0, 0];
      p[a] = va;
      p[b] = vb;
      p[normal2d] = min[normal2d];
      return p;
    };
    const c2 = [at(min[a], min[b]), at(max[a], min[b]), at(max[a], max[b]), at(min[a], max[b])];
    return [c2[0], c2[1], c2[1], c2[2], c2[2], c2[3], c2[3], c2[0]];
  }
  const c = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], max[2]],
    [min[0], max[1], max[2]]
  ];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return pairs.flatMap(([i, j]) => [c[i], c[j]]);
}
var HEAD_ON_COS = Math.cos(10 * Math.PI / 180);
var labelStyle = {
  transform: "translate(14px, -50%)",
  padding: "3px 7px",
  borderRadius: 4,
  background: "var(--tooltip-bg)",
  color: "var(--tooltip-text)",
  boxShadow: "var(--shadow-md)",
  font: "11px/1.35 var(--font-mono, monospace)",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  userSelect: "none"
};
var FieldGizmo = ({
  objectId,
  fieldData: fieldData2,
  isLocked = false,
  tool,
  getObject,
  interaction = noopInteraction,
  sceneWrites = noopSceneWrites
}) => {
  const {
    componentName = "Field",
    // Default to 'Field' for backward compatibility
    dimension = "3D",
    plane = "XZ",
    cell_size,
    render_mode = "None",
    plane_axis = "XZ",
    plane_position = 0
  } = fieldData2;
  const is2d = dimension === "2D";
  const cell = typeof cell_size === "number" && cell_size > 0 ? cell_size : null;
  const propBounds = useMemo(
    () => ({ min: vec3(fieldData2.min_bound, [-5, -5, -5]), max: vec3(fieldData2.max_bound, [5, 5, 5]) }),
    [fieldData2.min_bound, fieldData2.max_bound]
  );
  const { camera } = useThree();
  const rootRef = useRef(null);
  const colors = useMemo(readHandleColors, []);
  const [dragBounds, setDragBounds] = useState(null);
  const [activeHandle, setActiveHandle] = useState(null);
  const dragStartRef = useRef(null);
  const dragBoundsRef = useRef(null);
  const bounds = dragBounds ?? propBounds;
  const fixedNormal = is2d ? PLANE_NORMAL[plane] ?? 1 : null;
  const [facing, setFacing] = useState({ normal: fixedNormal ?? 1, near: "max", headOn: false });
  const facingRef = useRef(facing);
  const showHandles = !isLocked && (tool === void 0 || tool === "bounds");
  useFrame(() => {
    if (!showHandles || fixedNormal !== null || dragStartRef.current || !rootRef.current) return;
    const local = rootRef.current.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
    const toCamera = [0, 1, 2].map(
      (i) => local.getComponent(i) - (bounds.min[i] + bounds.max[i]) / 2
    );
    const normal = pickFacingAxis(toCamera, facingRef.current.normal);
    const near = toCamera[normal] >= 0 ? "max" : "min";
    const length = Math.hypot(...toCamera);
    const headOn = length > 0 && Math.abs(toCamera[normal]) / length > HEAD_ON_COS;
    const current = facingRef.current;
    if (normal !== current.normal || near !== current.near || headOn !== current.headOn) {
      facingRef.current = { normal, near, headOn };
      setFacing(facingRef.current);
    }
  });
  const handles = useMemo(
    () => buildBoundsHandles(
      bounds,
      fixedNormal ?? facing.normal,
      fixedNormal !== null ? "min" : facing.near,
      !is2d && !facing.headOn
    ),
    [bounds, fixedNormal, facing, is2d]
  );
  const handleDragStart = useCallback((spec) => {
    interaction.setGizmoDragging(true);
    dragStartRef.current = propBounds;
    dragBoundsRef.current = propBounds;
    setDragBounds(propBounds);
    setActiveHandle(spec);
  }, [interaction, propBounds]);
  const handleDrag = useCallback((spec, pointer, mods) => {
    const start = dragStartRef.current;
    if (!start) return;
    const next = applyBoundsDrag(start, spec, pointer, cell, mods);
    dragBoundsRef.current = next;
    setDragBounds(next);
  }, [cell]);
  const handleDragEnd = useCallback(() => {
    const next = dragBoundsRef.current;
    dragStartRef.current = null;
    dragBoundsRef.current = null;
    setActiveHandle(null);
    if (!next) {
      setDragBounds(null);
      interaction.setGizmoDragging(false);
      return;
    }
    const centre = [0, 1, 2].map((i) => (next.min[i] + next.max[i]) / 2);
    const adjustedMin = next.min.map((v, i) => v - centre[i]);
    const adjustedMax = next.max.map((v, i) => v - centre[i]);
    const object = getObject?.(objectId);
    if (object) {
      const transform = object.transform || {};
      const currentPos = vectorArray(transform.position, [0, 0, 0]);
      const currentRot = vectorArray(transform.rotation, [0, 0, 0]);
      const currentScale = vectorArray(transform.scale, [1, 1, 1]);
      const offset = new THREE.Vector3(
        centre[0] * currentScale[0],
        centre[1] * currentScale[1],
        centre[2] * currentScale[2]
      ).applyEuler(new THREE.Euler(currentRot[0], currentRot[1], currentRot[2], "ZXY"));
      void Promise.all([
        sceneWrites.updateComponentField(objectId, componentName, "min_bound", adjustedMin),
        sceneWrites.updateComponentField(objectId, componentName, "max_bound", adjustedMax),
        sceneWrites.updateObjectTransform(objectId, {
          position: [currentPos[0] + offset.x, currentPos[1] + offset.y, currentPos[2] + offset.z],
          rotation: currentRot,
          scale: currentScale
        })
      ]).finally(() => setDragBounds(null));
    } else {
      setDragBounds(null);
    }
    interaction.setGizmoDragging(false);
  }, [objectId, componentName, getObject, interaction, sceneWrites]);
  const [localPlanePosition, setLocalPlanePosition] = useState(plane_position);
  React.useEffect(() => {
    setLocalPlanePosition(plane_position);
  }, [plane_position]);
  const handleHeightChange = useCallback((newHeight) => {
    setLocalPlanePosition(newHeight);
    void sceneWrites.updateComponentField(objectId, componentName, "plane_position", newHeight);
  }, [objectId, componentName, sceneWrites]);
  const handleHeightChangeEnd = useCallback((finalHeight) => {
    void sceneWrites.updateComponentField(objectId, componentName, "plane_position", finalHeight);
  }, [objectId, componentName, sceneWrites]);
  const dragging = activeHandle !== null;
  const segments = useMemo(() => dragging ? boxSegments(bounds, fixedNormal) : null, [dragging, bounds, fixedNormal]);
  const sizeLabel = useMemo(() => {
    if (!dragging) return null;
    const axes = is2d ? [0, 1, 2].filter((axis) => axis !== fixedNormal) : [0, 1, 2];
    const cells = cell !== null ? cellCounts(bounds, cell) : null;
    return {
      size: axes.map((axis) => formatLength(bounds.max[axis] - bounds.min[axis])).join(" \xD7 "),
      cells: cells ? `${axes.map((axis) => cells[axis]).join(" \xD7 ")} cells` : null
    };
  }, [dragging, bounds, cell, is2d, fixedNormal]);
  const labelAnchor = useMemo(
    () => activeHandle ? handles.find((h) => h.id === activeHandle.id)?.position ?? activeHandle.position : null,
    [activeHandle, handles]
  );
  return /* @__PURE__ */ React.createElement("group", { ref: rootRef, userData: { [VOLUME_DEPTH_SKIP_FLAG]: true } }, showHandles && segments && /* @__PURE__ */ React.createElement(
    Line,
    {
      points: segments,
      segments: true,
      color: colors.accent,
      lineWidth: 1,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      renderOrder: 999,
      raycast: () => null
    }
  ), showHandles && handles.map((spec) => /* @__PURE__ */ React.createElement(
    FieldHandle_default,
    {
      key: spec.id,
      spec,
      colors,
      active: activeHandle?.id === spec.id,
      onDragStart: handleDragStart,
      onDrag: handleDrag,
      onDragEnd: handleDragEnd,
      setGizmoDragging: interaction.setGizmoDragging
    }
  )), showHandles && sizeLabel && labelAnchor && /* @__PURE__ */ React.createElement(Html, { position: labelAnchor, zIndexRange: [20, 0], style: { pointerEvents: "none" } }, /* @__PURE__ */ React.createElement("div", { style: labelStyle }, /* @__PURE__ */ React.createElement("div", null, sizeLabel.size), sizeLabel.cells && /* @__PURE__ */ React.createElement("div", { style: { opacity: 0.7 } }, sizeLabel.cells))), dimension === "3D" && render_mode === "Slices" && /* @__PURE__ */ React.createElement(
    FieldHeightSlider_default,
    {
      minBound: bounds.min,
      maxBound: bounds.max,
      plane: plane_axis,
      height: localPlanePosition,
      onHeightChange: handleHeightChange,
      onHeightChangeEnd: handleHeightChangeEnd,
      setGizmoDragging: interaction.setGizmoDragging
    }
  ));
};
var FieldGizmo_default = FieldGizmo;

// src/assets/vectorFieldTexture.ts
async function loadVectorFieldData(assets, vectorFieldId, onProgress) {
  const buffer = await assets.fetchBinary(vectorFieldId, {
    onProgress: onProgress ? (loaded, total) => onProgress(loaded, total ?? loaded) : void 0
  });
  const allChunks = new Uint8Array(buffer);
  const headerView = new DataView(allChunks.buffer, 0, 12);
  const nx = headerView.getUint32(0, true);
  const ny = headerView.getUint32(4, true);
  const nz = headerView.getUint32(8, true);
  const dataBytes = new Uint8Array(allChunks.buffer, 12);
  const expectedSize = nx * ny * nz * 4;
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
function sampleVectorField(data, resolution, density, minMagnitude, maxMagnitude) {
  const [nx, ny, nz] = resolution;
  const stepX = Math.max(1, Math.floor(nx / density));
  const stepY = Math.max(1, Math.floor(ny / density));
  const stepZ = Math.max(1, Math.floor(nz / density));
  const tempPositions = [];
  const tempDirections = [];
  const tempMagnitudes = [];
  for (let iz = 0; iz < nz; iz += stepZ) {
    for (let iy = 0; iy < ny; iy += stepY) {
      for (let ix = 0; ix < nx; ix += stepX) {
        const idx = ((iz * ny + iy) * nx + ix) * 4;
        const vx = data[idx];
        const vy = data[idx + 1];
        const vz = data[idx + 2];
        const mag = data[idx + 3];
        if (mag < minMagnitude || mag > maxMagnitude) continue;
        const px = ix / (nx - 1 || 1) - 0.5;
        const py = iy / (ny - 1 || 1) - 0.5;
        const pz = iz / (nz - 1 || 1) - 0.5;
        const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (len < 1e-4) continue;
        tempPositions.push(px, py, pz);
        tempDirections.push(vx / len, vy / len, vz / len);
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

// src/gizmos/VectorFieldVisualizer.tsx
var DEFAULT_FIELD_COLOR2 = "#333333";
var DEFAULT_FIELD_OPACITY2 = 0.7;
var LoadingSpinner3 = () => /* @__PURE__ */ React.createElement(Html, { center: true }, /* @__PURE__ */ React.createElement("div", { style: {
  width: 32,
  height: 32,
  border: "3px solid rgba(100, 150, 255, 0.3)",
  borderTop: "3px solid #4488ff",
  borderRadius: "50%",
  animation: "spin 1s linear infinite"
} }, /* @__PURE__ */ React.createElement("style", null, `@keyframes spin { to { transform: rotate(360deg); } }`)));
function createArrowGeometry() {
  const shaftRadius = 0.015;
  const shaftLength = 0.65;
  const headRadius = 0.045;
  const headLength = 0.35;
  const shaft = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 6);
  shaft.translate(0, shaftLength / 2, 0);
  const head = new THREE.ConeGeometry(headRadius, headLength, 6);
  head.translate(0, shaftLength + headLength / 2, 0);
  const shaftPos = shaft.getAttribute("position");
  const headPos = head.getAttribute("position");
  const shaftNorm = shaft.getAttribute("normal");
  const headNorm = head.getAttribute("normal");
  const totalVertices = shaftPos.count + headPos.count;
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  for (let i = 0; i < shaftPos.count; i++) {
    positions[i * 3] = shaftPos.getX(i);
    positions[i * 3 + 1] = shaftPos.getY(i);
    positions[i * 3 + 2] = shaftPos.getZ(i);
    normals[i * 3] = shaftNorm.getX(i);
    normals[i * 3 + 1] = shaftNorm.getY(i);
    normals[i * 3 + 2] = shaftNorm.getZ(i);
  }
  const offset = shaftPos.count;
  for (let i = 0; i < headPos.count; i++) {
    positions[(offset + i) * 3] = headPos.getX(i);
    positions[(offset + i) * 3 + 1] = headPos.getY(i);
    positions[(offset + i) * 3 + 2] = headPos.getZ(i);
    normals[(offset + i) * 3] = headNorm.getX(i);
    normals[(offset + i) * 3 + 1] = headNorm.getY(i);
    normals[(offset + i) * 3 + 2] = headNorm.getZ(i);
  }
  const shaftIndex = shaft.getIndex();
  const headIndex = head.getIndex();
  const indices = new Uint16Array(shaftIndex.count + headIndex.count);
  for (let i = 0; i < shaftIndex.count; i++) {
    indices[i] = shaftIndex.getX(i);
  }
  for (let i = 0; i < headIndex.count; i++) {
    indices[shaftIndex.count + i] = headIndex.getX(i) + offset;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  shaft.dispose();
  head.dispose();
  return merged;
}
var VectorFieldVisualizer = ({
  data,
  assets,
  selected = false
}) => {
  const meshRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rawData, setRawData] = useState(null);
  const [dataResolution, setDataResolution] = useState([1, 1, 1]);
  const {
    vector_field_id = "",
    resolution = [64, 64, 64],
    min_bound = [-5, -5, -5],
    max_bound = [5, 5, 5],
    dimension = "3D",
    colormap = "viridis",
    vector_arrow_density = 16,
    vector_arrow_scale = 1,
    vector_arrow_thickness = 1,
    display_range = [0, 1],
    vector_normalize_arrows = false
  } = data;
  const vector_value_min = display_range[0];
  const vector_value_max = display_range[1];
  const isGizmoDragging = false;
  const fieldSize = useMemo(() => [
    max_bound[0] - min_bound[0],
    max_bound[1] - min_bound[1],
    max_bound[2] - min_bound[2]
  ], [min_bound, max_bound]);
  const fieldCenter = useMemo(() => [
    (min_bound[0] + max_bound[0]) / 2,
    (min_bound[1] + max_bound[1]) / 2,
    (min_bound[2] + max_bound[2]) / 2
  ], [min_bound, max_bound]);
  const boxEdges = useMemo(() => {
    const [minX, minY, minZ] = min_bound;
    const [maxX, maxY, maxZ] = max_bound;
    const corners = [
      [minX, minY, minZ],
      // 0
      [maxX, minY, minZ],
      // 1
      [maxX, maxY, minZ],
      // 2
      [minX, maxY, minZ],
      // 3
      [minX, minY, maxZ],
      // 4
      [maxX, minY, maxZ],
      // 5
      [maxX, maxY, maxZ],
      // 6
      [minX, maxY, maxZ]
      // 7
    ];
    return [
      // Bottom face
      [corners[0], corners[1]],
      [corners[1], corners[5]],
      [corners[5], corners[4]],
      [corners[4], corners[0]],
      // Top face
      [corners[3], corners[2]],
      [corners[2], corners[6]],
      [corners[6], corners[7]],
      [corners[7], corners[3]],
      // Vertical edges
      [corners[0], corners[3]],
      [corners[1], corners[2]],
      [corners[5], corners[6]],
      [corners[4], corners[7]]
    ];
  }, [min_bound, max_bound]);
  const edgeLineWidth = selected ? 2.5 : 1.5;
  const edgeColor = isGizmoDragging ? "#666666" : selected ? "#ff8800" : DEFAULT_FIELD_COLOR2;
  const edgeOpacity = isGizmoDragging ? 0.3 : selected ? 1 : DEFAULT_FIELD_OPACITY2;
  useEffect(() => {
    if (!vector_field_id) {
      setRawData(null);
      return;
    }
    setLoading(true);
    setError(null);
    loadVectorFieldData(assets, vector_field_id).then((result) => {
      setRawData(result.rawData);
      setDataResolution(result.resolution);
      setLoading(false);
    }).catch((err) => {
      console.error("[VectorFieldVisualizer] Load failed:", err);
      setError(err.message);
      setLoading(false);
    });
  }, [assets, vector_field_id]);
  const instanceData = useMemo(() => {
    if (!rawData) return null;
    return sampleVectorField(
      rawData,
      dataResolution,
      vector_arrow_density,
      vector_value_min,
      vector_value_max
    );
  }, [rawData, dataResolution, vector_arrow_density, vector_value_min, vector_value_max]);
  const arrowGeometry = useMemo(() => createArrowGeometry(), []);
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      roughness: 0.6,
      metalness: 0.2,
      side: THREE.DoubleSide
    });
  }, []);
  const colormapFunc = useMemo(() => getColormapFunc(colormap), [colormap]);
  useEffect(() => {
    if (!meshRef.current || !instanceData || instanceData.count === 0) return;
    const mesh = meshRef.current;
    const { positions, directions, magnitudes, count } = instanceData;
    mesh.count = count;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3();
    const colors = new Float32Array(count * 3);
    const minFieldDim = Math.min(fieldSize[0], fieldSize[1], fieldSize[2]);
    const baseSize = minFieldDim / vector_arrow_density * 0.9;
    for (let i = 0; i < count; i++) {
      position.set(
        positions[i * 3] * fieldSize[0] + fieldCenter[0],
        positions[i * 3 + 1] * fieldSize[1] + fieldCenter[1],
        positions[i * 3 + 2] * fieldSize[2] + fieldCenter[2]
      );
      direction.set(
        directions[i * 3],
        directions[i * 3 + 1],
        directions[i * 3 + 2]
      );
      quaternion.setFromUnitVectors(up, direction);
      const mag = magnitudes[i];
      const arrowLength = vector_normalize_arrows ? baseSize * vector_arrow_scale : baseSize * (0.3 + mag * 0.7) * vector_arrow_scale;
      const arrowThickness = baseSize * vector_arrow_thickness;
      scale.set(arrowThickness, arrowLength, arrowThickness);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      const [r, g, b] = colormapFunc(mag);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.instanceColor.needsUpdate = true;
  }, [instanceData, fieldSize, fieldCenter, vector_arrow_scale, vector_arrow_thickness, vector_normalize_arrows, colormapFunc]);
  useEffect(() => {
    return () => {
      arrowGeometry.dispose();
      material.dispose();
    };
  }, [arrowGeometry, material]);
  if (loading) {
    return /* @__PURE__ */ React.createElement(LoadingSpinner3, null);
  }
  if (error || !vector_field_id || !instanceData || instanceData.count === 0) {
    return null;
  }
  const maxInstances = Math.max(instanceData.count, 1);
  return /* @__PURE__ */ React.createElement("group", { position: [0, 0, 0] }, /* @__PURE__ */ React.createElement(
    "instancedMesh",
    {
      ref: meshRef,
      args: [arrowGeometry, material, maxInstances],
      frustumCulled: false,
      raycast: () => null
    }
  ), boxEdges.map((edge, i) => /* @__PURE__ */ React.createElement(
    Line,
    {
      key: `edge-${i}`,
      points: edge,
      color: edgeColor,
      lineWidth: edgeLineWidth,
      transparent: true,
      opacity: edgeOpacity,
      raycast: () => null
    }
  )));
};
var VectorFieldVisualizerAdapter = ({
  data,
  assets,
  selected
}) => {
  return /* @__PURE__ */ React.createElement(VectorFieldVisualizer, { data, assets, selected });
};
var vectorFieldVisualizerConfig = {
  name: "vectorfield",
  priority: 11,
  // Only match VectorFieldRenderer component (pure renderer)
  // Field components handle their own VectorField rendering via FieldVisualizer + field3DRenderData
  matcher: (c) => c.name === "VectorFieldRenderer",
  // Extract visualization data from component
  // Note: Don't return null for empty vector_field_id - let the component handle it
  // This ensures the visualizer is mounted and can react to subsequent updates
  extractor: (comp) => {
    return {
      vector_field_id: getComponentValue(comp, "vector_field_id", ""),
      resolution: getComponentValue(comp, "resolution", [64, 64, 64]),
      min_bound: getComponentValue(comp, "min_bound", [-5, -5, -5]),
      max_bound: getComponentValue(comp, "max_bound", [5, 5, 5]),
      dimension: getComponentValue(comp, "dimension", "3D"),
      colormap: getComponentValue(comp, "colormap", "viridis"),
      vector_arrow_density: getComponentValue(comp, "vector_arrow_density", 16),
      vector_arrow_scale: getComponentValue(comp, "vector_arrow_scale", 1),
      vector_arrow_thickness: getComponentValue(comp, "vector_arrow_thickness", 1),
      display_range: getComponentValue(comp, "display_range", [0, 1]),
      vector_normalize_arrows: getComponentValue(comp, "vector_normalize_arrows", false)
    };
  },
  component: VectorFieldVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.5
};
var VectorFieldVisualizer_default = VectorFieldVisualizer;

// src/vendor/react-host.ts
var React3 = globalThis.__witwin?.react;
if (!React3) {
  throw new Error("[wt_volume] React host singleton is unavailable on globalThis.__witwin");
}
var createElement = React3.createElement;
var Fragment = React3.Fragment;
var forwardRef = React3.forwardRef;
var memo = React3.memo;
var createContext = React3.createContext;
var useContext = React3.useContext;
var useCallback2 = React3.useCallback;
var useEffect2 = React3.useEffect;
var useMemo2 = React3.useMemo;
var useRef2 = React3.useRef;
var useState2 = React3.useState;

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/shared/src/utils.js
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
var toCamelCase = (string) => string.replace(
  /^([A-Z])|[\s-_]+(\w)/g,
  (match, p1, p2) => p2 ? p2.toUpperCase() : p1.toLowerCase()
);
var toPascalCase = (string) => {
  const camelCase = toCamelCase(string);
  return camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
};
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
  return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();
var hasA11yProp = (props) => {
  for (const prop in props) {
    if (prop.startsWith("aria-") || prop === "role" || prop === "title") {
      return true;
    }
  }
};

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/defaultAttributes.js
var defaultAttributes = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/Icon.js
var Icon = forwardRef(
  ({
    color = "currentColor",
    size = 24,
    strokeWidth = 2,
    absoluteStrokeWidth,
    className = "",
    children,
    iconNode,
    ...rest
  }, ref) => createElement(
    "svg",
    {
      ref,
      ...defaultAttributes,
      width: size,
      height: size,
      stroke: color,
      strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
      className: mergeClasses("lucide", className),
      ...!children && !hasA11yProp(rest) && { "aria-hidden": "true" },
      ...rest
    },
    [
      ...iconNode.map(([tag, attrs]) => createElement(tag, attrs)),
      ...Array.isArray(children) ? children : [children]
    ]
  )
);

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/createLucideIcon.js
var createLucideIcon = (iconName, iconNode) => {
  const Component = forwardRef(
    ({ className, ...props }, ref) => createElement(Icon, {
      ref,
      iconNode,
      className: mergeClasses(
        `lucide-${toKebabCase(toPascalCase(iconName))}`,
        `lucide-${iconName}`,
        className
      ),
      ...props
    })
  );
  Component.displayName = toPascalCase(iconName);
  return Component;
};

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/icons/clapperboard.js
var __iconNode = [
  [
    "path",
    { d: "M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z", key: "1tn4o7" }
  ],
  ["path", { d: "m6.2 5.3 3.1 3.9", key: "iuk76l" }],
  ["path", { d: "m12.4 3.4 3.1 4", key: "6hsd6n" }],
  ["path", { d: "M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", key: "ltgou9" }]
];
var Clapperboard = createLucideIcon("clapperboard", __iconNode);

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/icons/film.js
var __iconNode2 = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M7 3v18", key: "bbkbws" }],
  ["path", { d: "M3 7.5h4", key: "zfgn84" }],
  ["path", { d: "M3 12h18", key: "1i2n21" }],
  ["path", { d: "M3 16.5h4", key: "1230mu" }],
  ["path", { d: "M17 3v18", key: "in4fa5" }],
  ["path", { d: "M17 7.5h4", key: "myr1c1" }],
  ["path", { d: "M17 16.5h4", key: "go4c1d" }]
];
var Film = createLucideIcon("film", __iconNode2);

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/icons/image-down.js
var __iconNode3 = [
  [
    "path",
    {
      d: "M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21",
      key: "9csbqa"
    }
  ],
  ["path", { d: "m14 19 3 3v-5.5", key: "9ldu5r" }],
  ["path", { d: "m17 22 3-3", key: "1nkfve" }],
  ["circle", { cx: "9", cy: "9", r: "2", key: "af1f0g" }]
];
var ImageDown = createLucideIcon("image-down", __iconNode3);

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/icons/pause.js
var __iconNode4 = [
  ["rect", { x: "14", y: "3", width: "5", height: "18", rx: "1", key: "kaeet6" }],
  ["rect", { x: "5", y: "3", width: "5", height: "18", rx: "1", key: "1wsw3u" }]
];
var Pause = createLucideIcon("pause", __iconNode4);

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/icons/play.js
var __iconNode5 = [
  [
    "path",
    {
      d: "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",
      key: "10ikf1"
    }
  ]
];
var Play = createLucideIcon("play", __iconNode5);

// ../../../witwin-studio/studio/node_modules/lucide-react/dist/esm/icons/video.js
var __iconNode6 = [
  [
    "path",
    {
      d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
      key: "ftymec"
    }
  ],
  ["rect", { x: "2", y: "6", width: "14", height: "12", rx: "2", key: "158x01" }]
];
var Video = createLucideIcon("video", __iconNode6);

// src/media/gif.ts
function encodeGif(frames, delayMs) {
  const { width, height } = frames[0];
  const palette = buildPalette(frames);
  const out = new ByteWriter();
  out.str("GIF89a");
  out.u16(width);
  out.u16(height);
  out.byte(247);
  out.byte(0);
  out.byte(0);
  for (let i = 0; i < 256; i++) {
    const c = palette.colors[i] ?? 0;
    out.byte(c >> 16 & 255);
    out.byte(c >> 8 & 255);
    out.byte(c & 255);
  }
  out.bytes([33, 255, 11]);
  out.str("NETSCAPE2.0");
  out.bytes([3, 1, 0, 0, 0]);
  const delay = Math.max(2, Math.round(delayMs / 10));
  for (const f of frames) {
    out.bytes([33, 249, 4, 0]);
    out.u16(delay);
    out.bytes([0, 0]);
    out.byte(44);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0);
    const indices = new Uint8Array(width * height);
    const d = f.data;
    for (let p = 0, o = 0; p < indices.length; p++, o += 4) indices[p] = palette.lookup(d[o], d[o + 1], d[o + 2]);
    out.byte(8);
    lzw(indices, out);
  }
  out.byte(59);
  return out.result();
}
function buildPalette(frames) {
  const hist = new Uint32Array(32768);
  const key = (r, g, b) => r >> 3 << 10 | g >> 3 << 5 | b >> 3;
  for (const f of frames) {
    const d = f.data;
    for (let o = 0; o < d.length; o += 4) hist[key(d[o], d[o + 1], d[o + 2])]++;
  }
  const bins = [...hist.keys()].filter((k) => hist[k] > 0).sort((a, b) => hist[b] - hist[a]).slice(0, 256);
  const colors = bins.map((k) => {
    const r = (k >> 10 & 31) << 3 | 4;
    const g = (k >> 5 & 31) << 3 | 4;
    const b = (k & 31) << 3 | 4;
    return r << 16 | g << 8 | b;
  });
  const cache = new Int16Array(32768).fill(-1);
  const lookup = (r, g, b) => {
    const k = key(r, g, b);
    if (cache[k] >= 0) return cache[k];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const d = ((c >> 16 & 255) - r) ** 2 + ((c >> 8 & 255) - g) ** 2 + ((c & 255) - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache[k] = best;
    return best;
  };
  return { colors, lookup };
}
function lzw(indices, out) {
  const CLEAR = 256;
  const EOI = 257;
  const block = [];
  let bitBuf = 0;
  let bitLen = 0;
  const emit2 = (code, size2) => {
    bitBuf |= code << bitLen;
    bitLen += size2;
    while (bitLen >= 8) {
      block.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitLen -= 8;
      if (block.length === 255) {
        out.byte(255);
        out.bytes(block);
        block.length = 0;
      }
    }
  };
  let dict = /* @__PURE__ */ new Map();
  let next = 258;
  let size = 9;
  emit2(CLEAR, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const keyed = prefix << 8 | k;
    const hit = dict.get(keyed);
    if (hit !== void 0) {
      prefix = hit;
      continue;
    }
    emit2(prefix, size);
    if (next < 4096) {
      dict.set(keyed, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit2(CLEAR, size);
      dict = /* @__PURE__ */ new Map();
      next = 258;
      size = 9;
    }
    prefix = k;
  }
  emit2(prefix, size);
  emit2(EOI, size);
  if (bitLen > 0) block.push(bitBuf & 255);
  if (block.length) {
    out.byte(block.length);
    out.bytes(block);
  }
  out.byte(0);
}
var ByteWriter = class {
  constructor() {
    __publicField(this, "buf", new Uint8Array(1 << 16));
    __publicField(this, "n", 0);
  }
  grow(extra) {
    if (this.n + extra <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + extra));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  byte(v) {
    this.grow(1);
    this.buf[this.n++] = v;
  }
  bytes(v) {
    this.grow(v.length);
    for (let i = 0; i < v.length; i++) this.buf[this.n++] = v[i];
  }
  u16(v) {
    this.byte(v & 255);
    this.byte(v >> 8 & 255);
  }
  str(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result() {
    return this.buf.slice(0, this.n);
  }
};

// src/media/movie.ts
function webmType() {
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not available in this browser.");
  return MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
}
async function encodeCanvasMovie(canvas, draw, opts) {
  const fps = opts.fps ?? 30;
  draw(0);
  const recorder = new MediaRecorder(canvas.captureStream(fps), { mimeType: webmType(), videoBitsPerSecond: opts.bitsPerSecond ?? 6e6 });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((resolve) => recorder.onstop = () => resolve());
  recorder.start();
  for (let f = 0; f < opts.frames; f++) {
    draw(f);
    await new Promise((r) => setTimeout(r, 1e3 / fps));
  }
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: "video/webm" });
}
async function recordCanvas(canvas, durationMs, fps = 30) {
  const recorder = new MediaRecorder(canvas.captureStream(fps), { mimeType: webmType() });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((resolve) => recorder.onstop = () => resolve());
  recorder.start();
  await new Promise((r) => setTimeout(r, durationMs));
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: "video/webm" });
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}

// src/slice/fieldGrid.ts
var NORMAL = { XY: 2, XZ: 1, YZ: 0 };
function gridCoords(resolution, minBound, maxBound, axisCoords) {
  return [0, 1, 2].map((a) => {
    const given = axisCoords?.[a];
    if (given && given.length === resolution[a]) return Float64Array.from(given);
    const n = Math.max(1, resolution[a]);
    return Float64Array.from({ length: n }, (_, i) => n === 1 ? (minBound[a] + maxBound[a]) / 2 : minBound[a] + (maxBound[a] - minBound[a]) * i / (n - 1));
  });
}
function locate(axis, v) {
  const n = axis.length;
  if (n < 2 || v <= axis[0]) return [0, 0];
  if (v >= axis[n - 1]) return [n - 2, 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (axis[mid] <= v) lo = mid;
    else hi = mid;
  }
  return [lo, (v - axis[lo]) / (axis[hi] - axis[lo])];
}
function sliceGrid(field, plane, t) {
  const a = NORMAL[plane];
  const [ua, va] = [0, 1, 2].filter((d) => d !== a);
  const n = field.coords.map((c) => c.length);
  const axis = field.coords[a];
  const position = axis[0] + Math.min(1, Math.max(0, t)) * (axis[axis.length - 1] - axis[0]);
  const [k0, w] = locate(axis, position);
  const k1 = Math.min(k0 + 1, n[a] - 1);
  const nu = n[ua];
  const nv = n[va];
  const stride = [1, n[0], n[0] * n[1]];
  const re = new Float32Array(nu * nv);
  const im = field.im ? new Float32Array(nu * nv) : null;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const base = i * stride[ua] + j * stride[va];
      const i0 = base + k0 * stride[a];
      const i1 = base + k1 * stride[a];
      const o = i + nu * j;
      re[o] = field.re[i0] * (1 - w) + field.re[i1] * w;
      if (im && field.im) im[o] = field.im[i0] * (1 - w) + field.im[i1] * w;
    }
  }
  return { uAxis: ua, vAxis: va, normal: a, position, u: field.coords[ua], v: field.coords[va], re, im };
}
function niceStep(minStep) {
  const m = Math.max(minStep, 1e-15);
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 2, 5, 10]) if (p * f >= m * (1 - 1e-9)) return p * f;
  return p * 10;
}
function stepDecimals(step) {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}
function ticksIn(lo, hi, step) {
  const out = [];
  const first = Math.ceil(lo / step - 1e-6);
  const last2 = Math.floor(hi / step + 1e-6);
  for (let k = first; k <= last2; k++) out.push(k * step);
  return out;
}
function formatTick(v, decimals) {
  const s = v.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}
var UNITS = [
  [1, "m"],
  [1e-3, "mm"],
  [1e-6, "\xB5m"],
  [1e-9, "nm"]
];
function lengthUnit(scale) {
  for (const unit of UNITS) if (Math.abs(scale) >= unit[0]) return unit;
  return UNITS[UNITS.length - 1];
}

// src/slice/outlines.ts
var MAX_TRIANGLES = 3e5;
function sliceOutlines(scene, normal, position, uAxis, vAxis) {
  const out = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const tri = [a, b, c];
  const d = [0, 0, 0];
  scene.updateMatrixWorld();
  scene.traverseVisible((o) => {
    const mesh = o;
    if (!mesh.isMesh || !o.userData.objectId || o.userData.isGizmo) return;
    const geometry = mesh.geometry;
    const pos = geometry?.attributes?.position;
    if (!pos) return;
    const index = geometry.index;
    const count = index ? index.count : pos.count;
    if (count / 3 > MAX_TRIANGLES) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    if (box.min.getComponent(normal) > position || box.max.getComponent(normal) < position) return;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t + k) : t + k;
        tri[k].fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        d[k] = tri[k].getComponent(normal) - position;
      }
      const hits = [];
      for (let k = 0; k < 3 && hits.length < 4; k++) {
        const k2 = (k + 1) % 3;
        if (d[k] < 0 === d[k2] < 0) continue;
        const s = d[k] / (d[k] - d[k2]);
        const p = tri[k];
        const q = tri[k2];
        hits.push(
          p.getComponent(uAxis) + (q.getComponent(uAxis) - p.getComponent(uAxis)) * s,
          p.getComponent(vAxis) + (q.getComponent(vAxis) - p.getComponent(vAxis)) * s
        );
      }
      if (hits.length === 4) out.push(...hits);
    }
  });
  return Float32Array.from(out);
}

// src/slice/slicePlot.ts
var M = { left: 58, right: 100, top: 12, bottom: 42 };
var TARGET_PX = 80;
var AXIS = "xyz";
var OUTLINE_ON_LIGHT = "rgba(29, 29, 33, 0.75)";
var OUTLINE_ON_DARK = "rgba(250, 250, 250, 0.6)";
var DIVERGING = /* @__PURE__ */ new Set(["rdbu", "coolwarm", "bwr"]);
function readColors(el) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  const resolve = (token, fallback) => {
    probe.style.color = fallback;
    probe.style.color = `var(${token}, ${fallback})`;
    return getComputedStyle(probe).color;
  };
  const bg = resolve("--gray-2", "black");
  const colors = {
    backgroundCss: bg,
    background: (bg.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number),
    ink: resolve("--text-primary", "white"),
    ink2: resolve("--text-secondary", "gray"),
    line: resolve("--border-strong", "gray"),
    accent: resolve("--accent", "blue"),
    font: getComputedStyle(el).getPropertyValue("--font-family").trim() || "sans-serif"
  };
  probe.remove();
  return colors;
}
function colormapLut(name) {
  const colour = getColormapFunc(name);
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = colour(i / 255);
    lut.set([r * 255, g * 255, b * 255, 255], i * 4);
  }
  return lut;
}
function lutIndex(v, vmin, vmax, logScale) {
  let n = (Math.min(v, vmax) - vmin) / (vmax - vmin + 1e-4);
  n = Math.min(1, Math.max(0, n));
  if (logScale) n = Math.log10(1 + 9 * n);
  return Math.round(n * 255);
}
var SlicePlot = class {
  constructor(canvas, onHover = () => {
  }) {
    this.canvas = canvas;
    this.onHover = onHover;
    __publicField(this, "params", null);
    // View: centre in metres and metres per CSS pixel.
    __publicField(this, "cu", 0);
    __publicField(this, "cv", 0);
    __publicField(this, "mpp", 1e-3);
    __publicField(this, "fitted", false);
    __publicField(this, "pixRe", new Float32Array(0));
    __publicField(this, "pixIm", new Float32Array(0));
    __publicField(this, "inside", new Uint8Array(0));
    __publicField(this, "image", null);
    __publicField(this, "lut", colormapLut("inferno"));
    __publicField(this, "buffer", document.createElement("canvas"));
    __publicField(this, "phase", 0);
    __publicField(this, "drag", null);
    __publicField(this, "box", null);
    __publicField(this, "colors");
    __publicField(this, "onLeave", () => this.onHover(null));
    __publicField(this, "onDoubleClick", () => {
      this.fitted = false;
      this.resample();
    });
    // ---------- interaction ----------
    __publicField(this, "onWheel", (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const u = this.toU(px);
      const v = this.toV(py);
      this.mpp *= Math.exp(e.deltaY * 15e-4);
      this.cu += u - this.toU(px);
      this.cv += v - this.toV(py);
      this.resample();
    });
    __publicField(this, "onDown", (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (e.shiftKey) this.box = { x0: x, y0: y, x1: x, y1: y };
      else this.drag = { x: e.clientX, y: e.clientY, cu: this.cu, cv: this.cv };
    });
    __publicField(this, "onMove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (this.box) {
        this.box.x1 = e.clientX - r.left;
        this.box.y1 = e.clientY - r.top;
        this.draw();
      } else if (this.drag) {
        this.cu = this.drag.cu - (e.clientX - this.drag.x) * this.mpp;
        this.cv = this.drag.cv + (e.clientY - this.drag.y) * this.mpp;
        this.resample();
      }
      this.hoverAt(e.clientX - r.left, e.clientY - r.top);
    });
    __publicField(this, "onUp", (e) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      this.drag = null;
      const b = this.box;
      this.box = null;
      if (b && Math.abs(b.x1 - b.x0) > 6 && Math.abs(b.y1 - b.y0) > 6) {
        const [ua, ub] = [this.toU(Math.min(b.x0, b.x1)), this.toU(Math.max(b.x0, b.x1))];
        const [va, vb] = [this.toV(Math.max(b.y0, b.y1)), this.toV(Math.min(b.y0, b.y1))];
        const { w, h } = this.plot;
        this.cu = (ua + ub) / 2;
        this.cv = (va + vb) / 2;
        this.mpp = Math.max((ub - ua) / w, (vb - va) / h);
        this.resample();
      } else if (b) {
        this.draw();
      }
    });
    this.colors = readColors(canvas);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
  }
  get plot() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return { x: M.left, y: M.top, w: Math.max(1, w - M.left - M.right), h: Math.max(1, h - M.top - M.bottom) };
  }
  /** New data. Refits the view when the slice moved to another plane or field. */
  set(p, refit) {
    const prev = this.params;
    this.params = p;
    if (refit || !prev) this.fitted = false;
    if (!prev || prev.colormap !== p.colormap) this.lut = colormapLut(p.colormap);
    if (!prev || prev.slice !== p.slice || refit) this.resample();
    else this.draw();
  }
  setPhase(phase) {
    this.phase = phase;
    this.draw();
  }
  /** Call when the canvas's CSS size or the theme changes. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.colors = readColors(this.canvas);
    this.resample();
  }
  fit() {
    const { u, v } = this.params.slice;
    const { w, h } = this.plot;
    const [u0, u1, v0, v1] = [u[0], u[u.length - 1], v[0], v[v.length - 1]];
    this.cu = (u0 + u1) / 2;
    this.cv = (v0 + v1) / 2;
    this.mpp = Math.max((u1 - u0) / w, (v1 - v0) / h, 1e-12) * 1.04;
    this.fitted = true;
  }
  // Screen <-> world for the plot area.
  toU(px) {
    const { x, w } = this.plot;
    return this.cu + (px - x - w / 2) * this.mpp;
  }
  toV(py) {
    const { y, h } = this.plot;
    return this.cv - (py - y - h / 2) * this.mpp;
  }
  sx(u) {
    const { x, w } = this.plot;
    return x + w / 2 + (u - this.cu) / this.mpp;
  }
  sy(v) {
    const { y, h } = this.plot;
    return y + h / 2 - (v - this.cv) / this.mpp;
  }
  /** Resolves every plot pixel to (Re, Im). Run when the view or slice changes. */
  resample() {
    if (!this.params) return;
    if (!this.fitted) this.fit();
    const { w, h } = this.plot;
    const W = Math.round(w);
    const H = Math.round(h);
    const { u, v, re, im } = this.params.slice;
    const nu = u.length;
    const cols = Array.from({ length: W }, (_, i) => this.toU(M.left + i + 0.5));
    const rows = Array.from({ length: H }, (_, j) => this.toV(M.top + j + 0.5));
    const cu = cols.map((x) => locate(u, x));
    const rv = rows.map((y) => locate(v, y));
    const [u0, u1, v0, v1] = [u[0], u[nu - 1], v[0], v[v.length - 1]];
    const du = nu > 1 ? 1 : 0;
    const dv = v.length > 1 ? nu : 0;
    this.pixRe = new Float32Array(W * H);
    this.pixIm = new Float32Array(W * H);
    this.inside = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      if (rows[j] < v0 || rows[j] > v1) continue;
      const [jv, tv] = rv[j];
      for (let i = 0; i < W; i++) {
        if (cols[i] < u0 || cols[i] > u1) continue;
        const [iu, tu] = cu[i];
        const a = iu + nu * jv;
        const o = i + W * j;
        const w00 = (1 - tu) * (1 - tv);
        const w10 = tu * (1 - tv);
        const w01 = (1 - tu) * tv;
        const w11 = tu * tv;
        this.pixRe[o] = re[a] * w00 + re[a + du] * w10 + re[a + dv] * w01 + re[a + du + dv] * w11;
        if (im) this.pixIm[o] = im[a] * w00 + im[a + du] * w10 + im[a + dv] * w01 + im[a + du + dv] * w11;
        this.inside[o] = 1;
      }
    }
    this.buffer.width = W;
    this.buffer.height = H;
    this.image = new ImageData(W, H);
    this.draw();
  }
  /** Displayed (normalised) value at a resolved pixel. */
  valueAt(o) {
    const re = this.pixRe[o];
    const im = this.pixIm[o];
    const p = this.params;
    if (p.quantity === "magnitude") return p.slice.im ? Math.hypot(re, im) : Math.abs(re);
    return p.slice.im ? re * Math.cos(this.phase) + im * Math.sin(this.phase) : re;
  }
  paintHeatmap() {
    const { legend } = this.params;
    const d = this.image.data;
    const lut = this.lut;
    const bg = this.colors.background;
    for (let o = 0; o < this.inside.length; o++) {
      const k = o * 4;
      if (!this.inside[o]) {
        d[k] = bg[0];
        d[k + 1] = bg[1];
        d[k + 2] = bg[2];
        d[k + 3] = 255;
        continue;
      }
      const t = lutIndex(this.valueAt(o), legend.valueMin, legend.valueMax, legend.logScale) * 4;
      d[k] = lut[t];
      d[k + 1] = lut[t + 1];
      d[k + 2] = lut[t + 2];
      d[k + 3] = 255;
    }
    this.buffer.getContext("2d").putImageData(this.image, 0, 0);
  }
  draw() {
    if (!this.params || !this.image) return;
    const ctx = this.canvas.getContext("2d");
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.colors.backgroundCss;
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const plot = this.plot;
    this.paintHeatmap();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buffer, plot.x, plot.y, Math.round(plot.w), Math.round(plot.h));
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (this.params.showGrid) this.drawGrid(ctx);
    this.drawOutlines(ctx);
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box;
      ctx.strokeStyle = this.colors.accent;
      ctx.fillStyle = this.colors.accent;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.globalAlpha = 1;
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();
    this.drawAxes(ctx);
    this.drawColorbar(ctx);
  }
  drawOutlines(ctx) {
    const seg = this.params.outlines;
    if (!seg.length) return;
    ctx.strokeStyle = DIVERGING.has(this.params.colormap) ? OUTLINE_ON_LIGHT : OUTLINE_ON_DARK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k + 3 < seg.length; k += 4) {
      ctx.moveTo(this.sx(seg[k]), this.sy(seg[k + 1]));
      ctx.lineTo(this.sx(seg[k + 2]), this.sy(seg[k + 3]));
    }
    ctx.stroke();
  }
  drawGrid(ctx) {
    const { u, v } = this.params.slice;
    if (minSpacing(u) / this.mpp < 3 && minSpacing(v) / this.mpp < 3) return;
    ctx.strokeStyle = this.colors.line;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of u) {
      const X = Math.round(this.sx(x)) + 0.5;
      ctx.moveTo(X, this.sy(v[0]));
      ctx.lineTo(X, this.sy(v[v.length - 1]));
    }
    for (const y of v) {
      const Y = Math.round(this.sy(y)) + 0.5;
      ctx.moveTo(this.sx(u[0]), Y);
      ctx.lineTo(this.sx(u[u.length - 1]), Y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  drawAxes(ctx) {
    const plot = this.plot;
    const { uAxis, vAxis, u, v } = this.params.slice;
    const x0 = plot.x;
    const y1 = plot.y + plot.h;
    const [unit, unitName] = lengthUnit(Math.max(u[u.length - 1] - u[0], v[v.length - 1] - v[0]));
    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
    ctx.font = `11px ${this.colors.font}`;
    ctx.fillStyle = this.colors.ink2;
    const major = niceStep(TARGET_PX * this.mpp / unit) * unit;
    const dec = stepDecimals(major / unit);
    const axis = (lo, hi, at, tick2, label) => {
      ctx.beginPath();
      for (const t of ticksIn(lo, hi, major / 5)) tick2(Math.round(at(t)) + 0.5, Math.abs(t / major - Math.round(t / major)) < 1e-6 ? 6 : 3);
      ctx.stroke();
      for (const t of ticksIn(lo, hi, major)) label(formatTick(t / unit, dec), at(t));
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    axis(
      this.toU(plot.x),
      this.toU(plot.x + plot.w),
      (t) => this.sx(t),
      (X, len) => {
        ctx.moveTo(X, y1);
        ctx.lineTo(X, y1 + len);
      },
      (s, X) => ctx.fillText(s, X, y1 + 8)
    );
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    axis(
      this.toV(plot.y + plot.h),
      this.toV(plot.y),
      (t) => this.sy(t),
      (Y, len) => {
        ctx.moveTo(x0, Y);
        ctx.lineTo(x0 - len, Y);
      },
      (s, Y) => ctx.fillText(s, x0 - 8, Y)
    );
    ctx.fillStyle = this.colors.ink;
    ctx.font = `500 12px ${this.colors.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${AXIS[uAxis]} (${unitName})`, plot.x + plot.w / 2, this.canvas.clientHeight - 4);
    ctx.save();
    ctx.translate(14, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText(`${AXIS[vAxis]} (${unitName})`, 0, 0);
    ctx.restore();
  }
  drawColorbar(ctx) {
    const { legend } = this.params;
    const plot = this.plot;
    const x = plot.x + plot.w + 18;
    const h = Math.min(plot.h, 320);
    const y = plot.y + (plot.h - h) / 2;
    const colour = getColormapFunc(legend.colormap);
    for (let j = 0; j < h; j++) {
      let t = 1 - j / Math.max(1, h - 1);
      if (legend.logScale) t = Math.log10(1 + 9 * t);
      const [r, g, b] = colour(t);
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fillRect(x, y + j, 12, 1);
    }
    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, 11, h - 1);
    ctx.fillStyle = this.colors.ink2;
    ctx.font = `11px ${this.colors.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const [at, text] of legendTicks(legend)) ctx.fillText(text, x + 17, y + (1 - at) * (h - 1));
    ctx.save();
    ctx.translate(x + 66, y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = this.colors.ink;
    ctx.font = `500 12px ${this.colors.font}`;
    ctx.fillText(legend.title, 0, 0);
    ctx.restore();
  }
  /** The current canvas pixels, for PNG export. */
  get element() {
    return this.canvas;
  }
  /** One optical period as `count` frames, scaled to at most `maxWidth` px, for GIF export. */
  captureFrames(count, maxWidth) {
    const phase0 = this.phase;
    const scale = Math.min(1, maxWidth / this.canvas.width);
    const c = document.createElement("canvas");
    c.width = Math.round(this.canvas.width * scale);
    c.height = Math.round(this.canvas.height * scale);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const frames = [];
    for (let k = 0; k < count; k++) {
      this.setPhase(phase0 + 2 * Math.PI * k / count);
      ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
      frames.push(ctx.getImageData(0, 0, c.width, c.height));
    }
    this.setPhase(phase0);
    return frames;
  }
  hoverAt(px, py) {
    const plot = this.plot;
    const i = Math.floor(px - plot.x);
    const j = Math.floor(py - plot.y);
    const W = Math.round(plot.w);
    const o = i + W * j;
    if (!this.params || i < 0 || j < 0 || i >= W || j >= Math.round(plot.h) || !this.inside[o]) {
      this.onHover(null);
      return;
    }
    const { uAxis, vAxis } = this.params.slice;
    const value = formatLegendValue(legendDataValue(this.params.legend, this.valueAt(o)));
    this.onHover({ u: this.toU(px), v: this.toV(py), value, uLabel: AXIS[uAxis], vLabel: AXIS[vAxis] });
  }
  dispose() {
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
  }
};
function minSpacing(a) {
  let m = Infinity;
  for (let i = 1; i < a.length; i++) m = Math.min(m, a[i] - a[i - 1]);
  return m;
}

// src/slice/viewportHandle.ts
var handle = null;
function viewportHandle() {
  return handle;
}
function ViewportHandlePass() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const mine = { canvas: gl.domElement, scene, invalidate };
    handle = mine;
    return () => {
      if (handle === mine) handle = null;
    };
  }, [gl, scene, invalidate]);
  return null;
}

// src/slice/FieldSlicePanel.tsx
var GIF_FRAMES = 24;
var GIF_MAX_WIDTH = 720;
var MOVIE_FRAMES = 60;
function fieldComponent(object) {
  const components = Array.isArray(object.components) ? object.components : [];
  return components.find((c) => c?.name === "Field" || c?.base_classes?.includes?.("Field")) ?? null;
}
function fieldOf(object) {
  const component = object && fieldComponent(object);
  if (!component) return null;
  const data = fieldVisualizerConfig.extractor(component, object);
  return data?.volume ? data : null;
}
function pickField(host, previous) {
  const objects = host.scene.getObjects();
  const selected = host.scene.getSelection().find((id) => fieldOf(objects[id]));
  if (selected) return selected;
  if (previous && fieldOf(objects[previous])) return previous;
  return Object.keys(objects).find((id) => fieldOf(objects[id])) ?? null;
}
function useSceneVersion(host) {
  const [version, setVersion] = useState(0);
  useEffect(() => host.scene.subscribe(() => setVersion((v) => v + 1)), [host]);
  return version;
}
function useFieldGrid(host, data) {
  const [state2, setState] = useState({ grid: null, error: null });
  const re = data?.volume ?? null;
  const im = data?.volume_im ?? null;
  const axesKey = data ? JSON.stringify([data.axis_coords, data.min_bound, data.max_bound]) : "";
  useEffect(() => {
    if (!re || !data) {
      setState({ grid: null, error: null });
      return void 0;
    }
    let cancelled = false;
    const loaded = [];
    (async () => {
      try {
        const [r, i] = await Promise.all([host.assets.loadVolume(re), im ? host.assets.loadVolume(im) : Promise.resolve(null)]);
        loaded.push(r, ...i ? [i] : []);
        if (cancelled) return;
        const coords = gridCoords(r.resolution, data.min_bound ?? [-5, -5, -5], data.max_bound ?? [5, 5, 5], data.axis_coords ?? null);
        setState({ grid: { coords, re: r.data, im: i?.data ?? null }, error: null });
      } catch (err) {
        if (!cancelled) setState({ grid: null, error: err?.message || "Failed to load the field" });
      }
    })();
    return () => {
      cancelled = true;
      loaded.forEach((r) => host.assets.release(r));
    };
  }, [host, re?.assetId, re?.uri, im?.assetId, im?.uri, axesKey]);
  return state2;
}
function useElementSize(ref, onResize) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return void 0;
    const observer = new ResizeObserver(() => onResize());
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref.current]);
}
function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Canvas export failed")), "image/png"));
}
function fileStem(name) {
  return (name || "field").replace(/[^\w.-]+/g, "_");
}
var styles = {
  root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--gray-2)", color: "var(--text-primary)", font: "12px var(--font-family)" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    height: "var(--header-h)",
    boxSizing: "border-box",
    padding: "0 8px",
    background: "var(--gray-3)",
    borderBottom: "1px solid var(--border-subtle)",
    flex: "none"
  },
  name: { fontWeight: 500, marginRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  status: { marginLeft: "auto", color: "var(--text-secondary)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  stage: { position: "relative", flex: 1, minHeight: 0 },
  canvas: { position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair", touchAction: "none" },
  empty: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-secondary)" }
};
function createFieldSlicePanel(host) {
  const HostButton = host.ui?.Button;
  function ToolButton({ label, icon, onClick, disabled, active }) {
    const content = /* @__PURE__ */ React.createElement(React.Fragment, null, icon, /* @__PURE__ */ React.createElement("span", null, label));
    return HostButton ? /* @__PURE__ */ React.createElement(HostButton, { variant: "ghost", size: "sm", onClick, disabled, active, "aria-label": label }, content) : /* @__PURE__ */ React.createElement("button", { type: "button", onClick, disabled, "aria-label": label, "aria-pressed": active }, content);
  }
  return function FieldSlicePanel() {
    const version = useSceneVersion(host);
    const shownRef = useRef(null);
    const objectId = useMemo(() => {
      shownRef.current = pickField(host, shownRef.current);
      return shownRef.current;
    }, [version]);
    const object = objectId ? host.scene.getObjects()[objectId] : void 0;
    const data = fieldOf(object);
    const { grid, error } = useFieldGrid(host, data);
    const plane = data?.dimension === "2D" ? data.plane : data?.plane_axis;
    const position = data?.dimension === "2D" ? 0.5 : data?.plane_position ?? 0.5;
    const slice = useMemo(() => grid && plane ? sliceGrid(grid, plane, position) : null, [grid, plane, position]);
    const outlines = useMemo(() => {
      const scene = viewportHandle()?.scene;
      return slice && scene ? sliceOutlines(scene, slice.normal, slice.position, slice.uAxis, slice.vAxis) : new Float32Array(0);
    }, [slice, version]);
    const legend = data ? fieldLegendSpec(data) : null;
    const legendKey = JSON.stringify(legend);
    const animatable = !!grid?.im && data?.field_quantity !== "magnitude";
    const clock = usePhaseClock();
    const phase = clock.playing ? clock.phase : data?.field_phase ?? 0;
    const canvasRef = useRef(null);
    const stageRef = useRef(null);
    const plotRef = useRef(null);
    const [hover, setHover] = useState(null);
    const [busy, setBusy] = useState(null);
    const [message, setMessage] = useState(null);
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return void 0;
      const plot2 = new SlicePlot(canvas, setHover);
      plotRef.current = plot2;
      plot2.resize();
      return () => {
        plot2.dispose();
        plotRef.current = null;
      };
    }, [slice !== null]);
    useElementSize(stageRef, () => plotRef.current?.resize());
    const fitKey = `${objectId}|${plane}`;
    const lastFit = useRef("");
    useEffect(() => {
      const plot2 = plotRef.current;
      if (!plot2 || !slice || !legend || !data) return;
      const refit = lastFit.current !== fitKey;
      lastFit.current = fitKey;
      plot2.set({ slice, quantity: data.field_quantity ?? "value", colormap: data.colormap ?? "inferno", showGrid: !!data.show_grid, legend, outlines }, refit);
    }, [slice, legendKey, outlines, data?.field_quantity, data?.colormap, data?.show_grid, fitKey]);
    useEffect(() => {
      plotRef.current?.setPhase(phase);
    }, [phase, slice]);
    useEffect(() => () => void (phaseClock.get().playing && phaseClock.pause()), []);
    const writePhase = (value) => {
      if (!objectId || !data?.componentName) return;
      void host.sceneWrites.updateComponentField(objectId, data.componentName, "field_phase", value);
    };
    const togglePlay = () => {
      if (clock.playing) writePhase(phaseClock.pause());
      else phaseClock.play(data?.field_phase ?? 0);
    };
    const run = async (label, job) => {
      setBusy(label);
      setMessage(null);
      try {
        await job();
      } catch (err) {
        setMessage(err?.message || `${label} failed`);
      } finally {
        setBusy(null);
      }
    };
    const stem = fileStem(object?.name ?? "field");
    const plot = plotRef.current;
    const exportPng = () => run("Saving PNG", async () => {
      if (plot) saveBlob(await canvasBlob(plot.element), `${stem}-slice.png`);
    });
    const exportGif = () => run("Encoding GIF", async () => {
      if (!plot) return;
      await new Promise((r) => setTimeout(r, 30));
      const frames = plot.captureFrames(GIF_FRAMES, GIF_MAX_WIDTH);
      const bytes = encodeGif(frames, PERIOD_MS / GIF_FRAMES);
      saveBlob(new Blob([bytes], { type: "image/gif" }), `${stem}-slice.gif`);
    });
    const exportMovie = () => run("Recording WebM", async () => {
      if (!plot) return;
      const phase0 = phase;
      const blob = await encodeCanvasMovie(plot.element, (f) => plot.setPhase(phase0 + 2 * Math.PI * f / MOVIE_FRAMES), {
        frames: MOVIE_FRAMES,
        fps: 30
      });
      plot.setPhase(phase0);
      saveBlob(blob, `${stem}-slice.webm`);
    });
    const recordViewport = () => run("Recording viewport", async () => {
      const handle2 = viewportHandle();
      if (!handle2) throw new Error("The viewport is not open");
      const wasPlaying = phaseClock.get().playing;
      if (animatable && !wasPlaying) phaseClock.play(phase);
      handle2.invalidate();
      try {
        saveBlob(await recordCanvas(handle2.canvas, PERIOD_MS), `${stem}-viewport.webm`);
      } finally {
        if (animatable && !wasPlaying) phaseClock.pause();
      }
    });
    const unit = slice ? lengthUnit(Math.max(slice.u[slice.u.length - 1] - slice.u[0], slice.v[slice.v.length - 1] - slice.v[0])) : null;
    const readout = hover && unit ? `${hover.uLabel} ${(hover.u / unit[0]).toFixed(3)}  ${hover.vLabel} ${(hover.v / unit[0]).toFixed(3)} ${unit[1]}   ${hover.value}` : null;
    const status = busy ? `${busy}\u2026` : message ?? readout ?? (error ? error : "");
    const disabled = !slice || !!busy;
    return /* @__PURE__ */ React.createElement("div", { style: styles.root, "data-testid": "field-slice-panel" }, /* @__PURE__ */ React.createElement("div", { style: styles.toolbar }, /* @__PURE__ */ React.createElement("span", { style: styles.name }, object?.name ?? "Field Slice"), /* @__PURE__ */ React.createElement(
      ToolButton,
      {
        label: clock.playing ? "Pause" : "Play",
        icon: clock.playing ? /* @__PURE__ */ React.createElement(Pause, { size: 14 }) : /* @__PURE__ */ React.createElement(Play, { size: 14 }),
        onClick: togglePlay,
        disabled: disabled || !animatable,
        active: clock.playing
      }
    ), /* @__PURE__ */ React.createElement(ToolButton, { label: "PNG", icon: /* @__PURE__ */ React.createElement(ImageDown, { size: 14 }), onClick: exportPng, disabled }), /* @__PURE__ */ React.createElement(ToolButton, { label: "GIF", icon: /* @__PURE__ */ React.createElement(Film, { size: 14 }), onClick: exportGif, disabled: disabled || !animatable }), /* @__PURE__ */ React.createElement(ToolButton, { label: "WebM", icon: /* @__PURE__ */ React.createElement(Clapperboard, { size: 14 }), onClick: exportMovie, disabled: disabled || !animatable }), /* @__PURE__ */ React.createElement(ToolButton, { label: "Viewport", icon: /* @__PURE__ */ React.createElement(Video, { size: 14 }), onClick: recordViewport, disabled: !!busy }), /* @__PURE__ */ React.createElement("span", { style: styles.status }, status)), /* @__PURE__ */ React.createElement("div", { style: styles.stage, ref: stageRef }, slice ? /* @__PURE__ */ React.createElement("canvas", { ref: canvasRef, style: styles.canvas }) : /* @__PURE__ */ React.createElement("div", { style: styles.empty }, error ?? "No field data")));
  };
}

// src/activate.tsx
function findComponent(object, predicate) {
  const components = Array.isArray(object.components) ? object.components : [];
  return components.find(predicate) || null;
}
function hasFieldComponent(object) {
  return !!findComponent(
    object,
    (component) => component?.name === "Field" || component?.base_classes?.includes?.("Field")
  );
}
function fieldData(component, object) {
  return fieldVisualizerConfig.extractor(component, object);
}
function FieldBoundsGizmoObject({
  object,
  selected,
  tool,
  host
}) {
  if (!selected) return null;
  const component = findComponent(object, (c) => c?.name === "Field" || c?.base_classes?.includes?.("Field"));
  if (!component) return null;
  return /* @__PURE__ */ React.createElement(
    FieldGizmo_default,
    {
      objectId: object.id,
      fieldData: { ...fieldData(component, object), cell_size: getComponentValue(component, "cell_size", void 0) },
      isLocked: !!object.locked,
      tool,
      getObject: (objectId) => host.scene.getObjects()[objectId],
      interaction: host.interaction,
      sceneWrites: host.sceneWrites
    }
  );
}
function createFieldRenderingObject(host) {
  return function FieldRenderingObject({ object, selected }) {
    const component = findComponent(object, (c) => c?.name === "Field" || c?.base_classes?.includes?.("Field"));
    if (!component) return null;
    const data = fieldData(component, object);
    const renderMode = data.render_mode || "None";
    const volume = getComponentValue(component, "volume", null);
    const min = data.min_bound || [-5, -5, -5];
    const max = data.max_bound || [5, 5, 5];
    const renderSize = [
      max[0] - min[0],
      max[1] - min[1],
      max[2] - min[2]
    ];
    const renderCenter = [
      (max[0] + min[0]) / 2,
      (max[1] + min[1]) / 2,
      (max[2] + min[2]) / 2
    ];
    const sharedVolumeData = {
      volume,
      volume_im: data.volume_im ?? null,
      axis_coords: data.axis_coords ?? null,
      // Bounds for normalising axis_coords only; the group below places and scales the box.
      axis_bounds: [min, max],
      resolution: getComponentValue(component, "resolution", [128, 128, 128]),
      colormap: data.colormap || "inferno",
      log_colormap: data.log_colormap || false,
      opacity_scale: getComponentValue(component, "opacity_scale", 1),
      density_scale: getComponentValue(component, "density_scale", 1),
      display_range: getComponentValue(component, "display_range", [0, 1]),
      ray_steps: getComponentValue(component, "ray_steps", 128)
    };
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      FieldVisualizer_default,
      {
        fieldData: data,
        assets: host.assets,
        selected,
        isGizmoDragging: host.interaction.isGizmoDragging()
      }
    ), renderMode === "Volume" && volume && /* @__PURE__ */ React.createElement("group", { position: renderCenter, scale: renderSize }, /* @__PURE__ */ React.createElement(VolumeVisualizer_default, { volumeData: sharedVolumeData, assets: host.assets, selected: false, hovered: false })), renderMode === "SDF" && volume && /* @__PURE__ */ React.createElement("group", { position: renderCenter, scale: renderSize }, /* @__PURE__ */ React.createElement(
      SDFVisualizer_default,
      {
        sdfData: {
          ...sharedVolumeData,
          ray_steps: getComponentValue(component, "sdf_ray_steps", 128),
          render_technique: getComponentValue(component, "sdf_technique", "sdf"),
          iso_value: getComponentValue(component, "iso_value", 0),
          enable_lighting: getComponentValue(component, "enable_lighting", true)
        },
        assets: host.assets,
        selected: false,
        hovered: false
      }
    )));
  };
}
function activateRenderingViewport(host) {
  host.registerPass({
    id: "witwin.volume.depth",
    priority: -100,
    component: VolumeDepthPrepass_default
  });
  host.registerPass({ id: "witwin.volume.viewportHandle", component: ViewportHandlePass });
  host.registerPanel({
    id: "witwin.volume.fieldSlice",
    title: "Field Slice",
    icon: "scan-line",
    component: createFieldSlicePanel(host),
    track: "peer"
  });
  host.registerVisualizer({
    id: "witwin.volume.field",
    priority: 100,
    skipStandardGeometry: true,
    match: hasFieldComponent,
    component: createFieldRenderingObject(host)
  });
  host.registerGizmo({
    id: "witwin.volume.field.bounds",
    priority: 100,
    match: hasFieldComponent,
    component: (props) => /* @__PURE__ */ React.createElement(FieldBoundsGizmoObject, { ...props, host })
  });
  host.registerVisualizer({
    id: "witwin.volume.volume",
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, volumeVisualizerConfig.matcher),
    component: ({ object, selected, hovered }) => {
      const component = findComponent(object, volumeVisualizerConfig.matcher);
      const data = component ? volumeVisualizerConfig.extractor(component, object) : null;
      return data ? /* @__PURE__ */ React.createElement(VolumeVisualizer_default, { volumeData: data, assets: host.assets, selected, hovered }) : null;
    }
  });
  host.registerVisualizer({
    id: "witwin.volume.sdf",
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, sdfVisualizerConfig.matcher),
    component: ({ object, selected, hovered }) => {
      const component = findComponent(object, sdfVisualizerConfig.matcher);
      const data = component ? sdfVisualizerConfig.extractor(component, object) : null;
      return data ? /* @__PURE__ */ React.createElement(SDFVisualizer_default, { sdfData: data, assets: host.assets, selected, hovered }) : null;
    }
  });
  host.registerVisualizer({
    id: "witwin.volume.vectorfield",
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, vectorFieldVisualizerConfig.matcher),
    component: ({ object, selected }) => {
      const component = findComponent(object, vectorFieldVisualizerConfig.matcher);
      const data = component ? vectorFieldVisualizerConfig.extractor(component, object) : null;
      return data ? /* @__PURE__ */ React.createElement(VectorFieldVisualizer_default, { data, assets: host.assets, selected }) : null;
    }
  });
}

// src/viewport.ts
var sdkVersion = "1.0.0";
function activate(host) {
  activateRenderingViewport(host);
}
export {
  activate,
  sdkVersion
};
