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

// Uniforms
uniform sampler3D volumeTexture;
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
  return texture(volumeTexture, pos).r;
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
function getColormapFunc(name) {
  switch (name) {
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
var sharedDepthTexture = null;
function getVolumeDepthTexture() {
  return sharedDepthTexture;
}

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
  const [volumeTexture, setVolumeTexture] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [textureResolution, setTextureResolution] = useState([128, 128, 128]);
  const volumeTextureRef = useRef(null);
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
    max_bound
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
        console.error("[VolumeVisualizer] Failed to load volume:", err);
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
    if (!volumeTexture || !colormapTextureRef.current) return null;
    const modelMatrixInverse = new THREE.Matrix4();
    const dummyDepth = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
    dummyDepth.needsUpdate = true;
    const initialViewportSize = gl.getDrawingBufferSize(new THREE.Vector2());
    const blueNoiseTexture2 = getBlueNoiseTexture();
    return new THREE.ShaderMaterial({
      uniforms: {
        volumeTexture: { value: volumeTexture },
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
  }, [volumeTexture]);
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

// src/gizmos/PointCloudVisualizer.tsx
function infernoColormap3(v) {
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
function plasmaColormap3(v) {
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
function viridisColormap3(v) {
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
function jetColormap3(v) {
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
function coolwarmColormap3(v) {
  if (v < 0.5) {
    const t = v / 0.5;
    return [0.23 + t * 0.77, 0.3 + t * 0.7, 0.75 + t * 0.25];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t * 0.7, 1 - t * 0.75];
  }
}
function bwrColormap3(v) {
  if (v < 0.5) {
    const t = v / 0.5;
    return [t, t, 1];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t, 1 - t];
  }
}
function getColormapFunc3(name) {
  switch (name) {
    case "inferno":
      return infernoColormap3;
    case "plasma":
      return plasmaColormap3;
    case "viridis":
      return viridisColormap3;
    case "jet":
      return jetColormap3;
    case "coolwarm":
      return coolwarmColormap3;
    case "bwr":
      return bwrColormap3;
    default:
      return viridisColormap3;
  }
}
var vertexShader = `
  attribute vec3 color;
  varying vec3 vColor;
  uniform float pointSize;      // base size (already *100 for screen mode)
  uniform float worldPointSize; // raw point_size for world mode (in world units)
  uniform float pointScale;
  uniform float pixelRatio;
  uniform float spaceMode;  // 0 = screen space, 1 = world space
  uniform float viewportHeight;

  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    float size;
    if (spaceMode > 0.5) {
      // World Space: size is in world units, gets smaller with perspective
      // Calculate pixel size based on world unit at this depth
      // projectionMatrix[1][1] = 1 / tan(fov/2), relates to vertical field of view
      float worldUnitInPixels = viewportHeight * projectionMatrix[1][1] / (-mvPosition.z * 2.0);
      // worldPointSize is the actual world size (e.g., 0.05 = 0.05 units)
      size = worldPointSize * pointScale * worldUnitInPixels * pixelRatio;
    } else {
      // Screen Space: constant screen size regardless of distance
      size = pointSize * pointScale * pixelRatio * 10.0;
    }

    gl_PointSize = clamp(size, 1.0, 256.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
var fragmentShader = `
  varying vec3 vColor;
  uniform float opacity;

  void main() {
    // Create circular shape
    vec2 center = gl_PointCoord - vec2(0.5);
    float dist = length(center);

    // Smooth circle edge
    float alpha = 1.0 - smoothstep(0.4, 0.5, dist);

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(vColor, alpha * opacity);
  }
`;
var tooltipElement = null;
if (typeof document !== "undefined") {
  const existing = document.querySelector(".pointcloud-tooltip");
  if (existing) {
    existing.remove();
  }
}
function getOrCreateTooltip() {
  if (!tooltipElement || !document.body.contains(tooltipElement)) {
    tooltipElement = document.createElement("div");
    tooltipElement.className = "pointcloud-tooltip";
    tooltipElement.style.position = "fixed";
    tooltipElement.style.pointerEvents = "none";
    tooltipElement.style.zIndex = "9999";
    tooltipElement.style.display = "none";
    tooltipElement.style.background = "#2a2a2a";
    tooltipElement.style.color = "#ffffff";
    tooltipElement.style.border = "1px solid #444";
    tooltipElement.style.borderRadius = "4px";
    tooltipElement.style.padding = "8px";
    tooltipElement.style.fontSize = "11px";
    tooltipElement.style.fontFamily = "-apple-system, BlinkMacSystemFont, sans-serif";
    tooltipElement.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)";
    tooltipElement.style.minWidth = "180px";
    tooltipElement.style.maxWidth = "300px";
    document.body.appendChild(tooltipElement);
  }
  return tooltipElement;
}
function showTooltip(x, y, position, heat, extraData) {
  const tooltip = getOrCreateTooltip();
  const sectionStyle = "display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:2px 0;line-height:1.4;";
  const labelStyle = "color:#aaa;font-weight:500;flex-shrink:0;";
  const valueStyle = "color:#fff;font-family:monospace;font-size:11px;text-align:right;";
  const dividerStyle = "height:1px;background:#444;margin:4px 0;";
  let html = `
    <div style="${sectionStyle}">
      <span style="${labelStyle}">Position:</span>
      <span style="${valueStyle}">(${position[0].toFixed(2)}, ${position[1].toFixed(2)}, ${position[2].toFixed(2)})</span>
    </div>
    <div style="${sectionStyle}">
      <span style="${labelStyle}">Heat:</span>
      <span style="${valueStyle}">${heat.toFixed(3)}</span>
    </div>
  `;
  const entries = Object.entries(extraData || {});
  if (entries.length > 0) {
    html += `<div style="${dividerStyle}"></div>`;
    for (const [key, value] of entries) {
      html += `
        <div style="${sectionStyle}">
          <span style="${labelStyle}">${key}:</span>
          <span style="${valueStyle}">${String(value)}</span>
        </div>
      `;
    }
  }
  tooltip.innerHTML = html;
  tooltip.style.left = x + 15 + "px";
  tooltip.style.top = y + 15 + "px";
  tooltip.style.display = "block";
}
function hideTooltip() {
  const tooltip = getOrCreateTooltip();
  tooltip.style.display = "none";
}
function getPointPosition(positions, index) {
  return [
    positions[index * 3],
    positions[index * 3 + 1],
    positions[index * 3 + 2]
  ];
}
function getPointHeat(heat, index) {
  return heat[index];
}
var PointCloudVisualizer = ({
  componentData,
  assets,
  selected,
  hovered
}) => {
  const pointsRef = useRef(null);
  const [pointData, setPointData] = useState(null);
  const [loading, setLoading] = useState(false);
  const { gl, raycaster } = useThree();
  useEffect(() => {
    if (!componentData.cloud) {
      setPointData(null);
      return;
    }
    setLoading(true);
    assets.loadPointCloud(componentData.cloud).then((data) => {
      setPointData({
        positions: data.positions,
        heat: data.heat,
        extra_data: data.extraData,
        count: data.count,
        point_size: componentData.point_size,
        colormap: componentData.colormap,
        heat_min: componentData.heat_min,
        heat_max: componentData.heat_max,
        show_points: componentData.show_points,
        opacity: componentData.opacity,
        point_scale: componentData.point_scale ?? 1,
        space_mode: componentData.space_mode ?? "screen"
      });
    }).catch((err) => {
      console.error("Failed to load point cloud:", err);
      setPointData(null);
    }).finally(() => setLoading(false));
  }, [assets, componentData.cloud?.assetId, componentData.cloud?.uri, componentData.point_size, componentData.colormap, componentData.heat_min, componentData.heat_max]);
  const colormapFunc = useMemo(() => {
    return getColormapFunc3(componentData.colormap);
  }, [componentData.colormap]);
  const geometry = useMemo(() => {
    if (!pointData) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pointData.positions, 3));
    const colors = new Float32Array(pointData.count * 3);
    for (let i = 0; i < pointData.count; i++) {
      const heatValue = pointData.heat[i];
      const normalized = (heatValue - pointData.heat_min) / (pointData.heat_max - pointData.heat_min || 1);
      const clampedNormalized = Math.max(0, Math.min(1, normalized));
      const [r, g, b] = colormapFunc(clampedNormalized);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [pointData, colormapFunc]);
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        pointSize: { value: componentData.point_size * 100 },
        worldPointSize: { value: componentData.point_size },
        pointScale: { value: componentData.point_scale ?? 1 },
        opacity: { value: componentData.opacity },
        pixelRatio: { value: gl.getPixelRatio() },
        spaceMode: { value: componentData.space_mode === "world" ? 1 : 0 },
        viewportHeight: { value: gl.domElement.clientHeight }
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending
    });
  }, [gl]);
  useEffect(() => {
    raycaster.params.Points = raycaster.params.Points || {};
    raycaster.params.Points.threshold = componentData.point_size * 2;
  }, [raycaster, componentData.point_size]);
  useEffect(() => {
    if (material) {
      material.uniforms.pointSize.value = componentData.point_size * 100;
      material.uniforms.worldPointSize.value = componentData.point_size;
      material.uniforms.pointScale.value = componentData.point_scale ?? 1;
      material.uniforms.opacity.value = componentData.opacity;
      material.uniforms.spaceMode.value = componentData.space_mode === "world" ? 1 : 0;
      material.uniforms.viewportHeight.value = gl.domElement.clientHeight;
    }
  }, [material, gl, componentData.point_size, componentData.point_scale, componentData.opacity, componentData.space_mode]);
  const handlePointerMove = useCallback((event) => {
    if (!pointData || !pointsRef.current) return;
    event.stopPropagation();
    const intersection = event.intersections.find((i) => i.object === pointsRef.current);
    if (intersection && intersection.index !== void 0) {
      const idx = intersection.index;
      const position = getPointPosition(pointData.positions, idx);
      const heat = getPointHeat(pointData.heat, idx);
      const extraData = pointData.extra_data?.[idx] || {};
      showTooltip(event.clientX, event.clientY, position, heat, extraData);
    } else {
      hideTooltip();
    }
  }, [pointData]);
  const handlePointerLeave = useCallback((event) => {
    event.stopPropagation();
    hideTooltip();
  }, []);
  useEffect(() => {
    return () => hideTooltip();
  }, []);
  useEffect(() => {
    return () => {
      geometry?.dispose();
      material?.dispose();
    };
  }, [geometry, material]);
  if (!pointData || !geometry || !componentData.show_points) return null;
  if (loading) return null;
  return /* @__PURE__ */ React.createElement(
    "points",
    {
      ref: pointsRef,
      geometry,
      material,
      onPointerMove: handlePointerMove,
      onPointerLeave: handlePointerLeave
    }
  );
};
var PointCloudVisualizerAdapter = ({
  data,
  assets,
  selected,
  hovered
}) => {
  return /* @__PURE__ */ React.createElement(PointCloudVisualizer, { componentData: data, assets, selected, hovered });
};
var pointCloudVisualizerConfig = {
  name: "pointcloud",
  priority: 5,
  // Match PointClouds component
  matcher: (c) => c.name === "PointClouds",
  // Extract visualization data from component
  // Always return data (even without a cloud resource) so object is selectable
  extractor: (comp) => ({
    point_count: getComponentValue(comp, "point_count", 0),
    point_size: getComponentValue(comp, "point_size", 0.05),
    colormap: getComponentValue(comp, "colormap", "viridis"),
    heat_min: getComponentValue(comp, "heat_min", 0),
    heat_max: getComponentValue(comp, "heat_max", 1),
    show_points: getComponentValue(comp, "show_points", true),
    opacity: getComponentValue(comp, "opacity", 1),
    point_scale: getComponentValue(comp, "point_scale", 1),
    space_mode: getComponentValue(comp, "space_mode", "screen"),
    cloud: getComponentValue(comp, "cloud", null)
  }),
  component: PointCloudVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.6
};
var PointCloudVisualizer_default = PointCloudVisualizer;

// src/shaders/planeSliceShaders.ts
var planeSliceVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
var planeSliceFragmentShader = `
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
function calculateFieldEdgeHitRadius({
  camera,
  worldPoint,
  viewportHeightPx,
  minBound,
  maxBound,
  targetHitWidthPx = FIELD_EDGE_HIT_WIDTH_PX,
  minRadius = FIELD_EDGE_HIT_MIN_RADIUS,
  maxRadius = FIELD_EDGE_HIT_MAX_RADIUS,
  fieldFraction = FIELD_EDGE_HIT_FIELD_FRACTION
}) {
  const screenRadius = getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) * targetHitWidthPx / 2;
  const shortestExtent = getShortestPositiveFieldExtent(minBound, maxBound);
  const fieldRadiusCap = shortestExtent > EPSILON ? shortestExtent * fieldFraction : maxRadius;
  return clamp(Math.min(screenRadius, fieldRadiusCap), minRadius, maxRadius);
}

// src/gizmos/selectionHitTarget.ts
var SOFT_SELECTION_HIT_AREA_FLAG = "__softSelectionHitArea";

// src/gizmos/FieldVisualizer.tsx
var DEFAULT_FIELD_COLOR = "#333333";
var DEFAULT_FIELD_OPACITY = 0.7;
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
    const worldRadius = calculateFieldEdgeHitRadius({
      camera,
      worldPoint: worldMid,
      viewportHeightPx: size.height,
      minBound,
      maxBound
    });
    const worldScale = new THREE.Vector3(1, 1, 1);
    mesh.parent?.getWorldScale(worldScale);
    const localScale = Math.min(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z));
    const localRadius = worldRadius / Math.max(localScale, 1e-6);
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
    resolution = [128, 128, 128],
    display_range = [0, 1]
  } = fieldData2;
  const valueMin = display_range[0];
  const valueMax = display_range[1];
  const [volumeTexture, setVolumeTexture] = useState(null);
  const volumeTextureRef = useRef(null);
  const colormapTextureRef = useRef(null);
  const sliceMeshRef = useRef(null);
  const planeParamsRef = useRef({
    slicePlaneInt: 1,
    slicePosition: plane_position,
    opacity: plane_opacity,
    valueMin,
    valueMax,
    logColormap: log_colormap
  });
  useEffect(() => {
    if (!volume || render_mode !== "Slices") {
      return;
    }
    const loadVolume = async () => {
      try {
        const loadResolution = resolution;
        const support = checkVolumeSupport(loadResolution);
        if (!support.supported) {
          console.error("[FieldVisualizer] Volume not supported:", support.message);
          return;
        }
        if (volumeTextureRef.current) {
          volumeTextureRef.current.dispose();
          volumeTextureRef.current = null;
        }
        const result = await loadVolumeTexture(assets, volume, loadResolution);
        volumeTextureRef.current = result.texture;
        setVolumeTexture(result.texture);
      } catch (err) {
        console.error("[FieldVisualizer] Failed to load volume:", err);
      }
    };
    loadVolume();
    return () => {
      if (volumeTextureRef.current) {
        volumeTextureRef.current.dispose();
        volumeTextureRef.current = null;
      }
    };
  }, [assets, volume?.assetId, volume?.uri, render_mode]);
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
  planeParamsRef.current = {
    slicePlaneInt,
    slicePosition: effectiveSlicePosition,
    opacity: plane_opacity,
    valueMin,
    valueMax,
    logColormap: log_colormap
  };
  const planeSliceMaterial = useMemo(() => {
    if (!volumeTexture || !colormapTextureRef.current) return null;
    return new THREE.ShaderMaterial({
      uniforms: {
        volumeTexture: { value: volumeTexture },
        colormapTexture: { value: colormapTextureRef.current },
        slicePlane: { value: slicePlaneInt },
        slicePosition: { value: effectiveSlicePosition },
        opacity: { value: plane_opacity },
        valueMin: { value: valueMin },
        valueMax: { value: valueMax },
        logColormap: { value: log_colormap }
      },
      vertexShader: planeSliceVertexShader,
      fragmentShader: planeSliceFragmentShader,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      alphaTest: 0.01
    });
  }, [volumeTexture]);
  useFrame(() => {
    if (!sliceMeshRef.current || !planeSliceMaterial) return;
    const params = planeParamsRef.current;
    planeSliceMaterial.uniforms.slicePlane.value = params.slicePlaneInt;
    planeSliceMaterial.uniforms.slicePosition.value = params.slicePosition;
    planeSliceMaterial.uniforms.opacity.value = params.opacity;
    planeSliceMaterial.uniforms.valueMin.value = params.valueMin;
    planeSliceMaterial.uniforms.valueMax.value = params.valueMax;
    planeSliceMaterial.uniforms.logColormap.value = params.logColormap;
    if (colormapTextureRef.current) {
      planeSliceMaterial.uniforms.colormapTexture.value = colormapTextureRef.current;
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
      let width, height;
      if (dimension === "2D") {
        switch (plane) {
          case "XY":
            width = resolution[0];
            height = resolution[1];
            break;
          case "YZ":
            width = resolution[1];
            height = resolution[2];
            break;
          case "XZ":
          default:
            width = resolution[0];
            height = resolution[2];
            break;
        }
      } else {
        switch (plane_axis) {
          case "XY":
            width = resolution[0];
            height = resolution[1];
            break;
          case "YZ":
            width = resolution[1];
            height = resolution[2];
            break;
          case "XZ":
          default:
            width = resolution[0];
            height = resolution[2];
            break;
        }
      }
      width = Math.max(2, Math.round(width));
      height = Math.max(2, Math.round(height));
      const texture = createCheckerboardTexture(width, height);
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
    if (dimension === "2D") {
      switch (plane) {
        case "XY":
          return {
            position: [(minX + maxX) / 2, (minY + maxY) / 2, minZ + 1e-3],
            rotation: [0, 0, 0],
            size: [maxX - minX, maxY - minY]
          };
        case "YZ":
          return {
            position: [minX + 1e-3, (minY + maxY) / 2, (minZ + maxZ) / 2],
            rotation: [0, Math.PI / 2, 0],
            size: [maxZ - minZ, maxY - minY]
          };
        case "XZ":
        default:
          return {
            position: [(minX + maxX) / 2, minY + 1e-3, (minZ + maxZ) / 2],
            rotation: [-Math.PI / 2, 0, 0],
            size: [maxX - minX, maxZ - minZ]
          };
      }
    } else {
      const h = plane_position;
      switch (plane_axis) {
        case "XY": {
          const zPos = minZ + h * (maxZ - minZ) + 1e-3;
          return {
            position: [(minX + maxX) / 2, (minY + maxY) / 2, zPos],
            rotation: [0, 0, 0],
            size: [maxX - minX, maxY - minY]
          };
        }
        case "YZ": {
          const xPos = minX + h * (maxX - minX) + 1e-3;
          return {
            position: [xPos, (minY + maxY) / 2, (minZ + maxZ) / 2],
            rotation: [0, Math.PI / 2, 0],
            size: [maxZ - minZ, maxY - minY]
          };
        }
        case "XZ":
        default: {
          const yPos = minY + h * (maxY - minY) + 1e-3;
          return {
            position: [(minX + maxX) / 2, yPos, (minZ + maxZ) / 2],
            rotation: [-Math.PI / 2, 0, 0],
            size: [maxX - minX, maxZ - minZ]
          };
        }
      }
    }
  }, [min_bound, max_bound, dimension, plane, plane_axis, plane_position]);
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
    /* @__PURE__ */ React.createElement("planeGeometry", { args: [planeGeometry.size[0], planeGeometry.size[1]] })
  ), checkerboardTexture && show_grid && render_mode === "Slices" && /* @__PURE__ */ React.createElement(
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
    resolution: getComponentValue(comp, "resolution", [128, 128, 128]),
    // Normalized display range (0-1)
    display_range: getComponentValue(comp, "display_range", [0, 1])
  }),
  component: FieldVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.5
};
var FieldVisualizer_default = FieldVisualizer;

// src/gizmos/FieldHandle.tsx
var FieldHandle = ({
  position,
  type,
  axis,
  onDragStart,
  onDrag,
  onDragEnd,
  color = "#88ccff",
  hoverColor = "#ffffff",
  activeColor = "#ffff00",
  setGizmoDragging = () => void 0,
  affectsMin = [false, false, false],
  affectsMax = [false, false, false],
  edgeDirection
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const { camera, gl } = useThree();
  const meshRef = useRef(null);
  const dragStartRef = useRef(null);
  const planeRef = useRef(null);
  const initialPositionRef = useRef([0, 0, 0]);
  const parentMatrixWorldInverseRef = useRef(null);
  const baseScreenSize = type === "corner" ? 14 : type === "edge" ? 16 : 18;
  useFrame(() => {
    if (meshRef.current) {
      const worldPos = new THREE.Vector3();
      meshRef.current.getWorldPosition(worldPos);
      const distance = camera.position.distanceTo(worldPos);
      const scale = distance * baseScreenSize / 500;
      meshRef.current.scale.setScalar(scale);
    }
  });
  const currentColor = isDragging ? activeColor : isHovered ? hoverColor : color;
  const createDragPlane = useCallback((point) => {
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    let planeNormal;
    switch (axis) {
      case "x":
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(0, 1, 0);
        }
        break;
      case "y":
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      case "z":
        planeNormal = new THREE.Vector3(0, 1, 0);
        if (Math.abs(cameraDirection.y) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      case "xy":
        planeNormal = new THREE.Vector3(0, 0, 1);
        break;
      case "xz":
        planeNormal = new THREE.Vector3(0, 1, 0);
        break;
      case "yz":
        planeNormal = new THREE.Vector3(1, 0, 0);
        break;
      case "xyz":
      default:
        planeNormal = cameraDirection.clone().negate();
        break;
    }
    return new THREE.Plane(planeNormal, -planeNormal.dot(point));
  }, [camera, axis]);
  const intersectPlane = useCallback((event) => {
    if (!planeRef.current) return null;
    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(planeRef.current, intersection);
    return intersection;
  }, [camera, gl]);
  const applyConstraints = useCallback((delta) => {
    const constrained = new THREE.Vector3();
    switch (axis) {
      case "x":
        constrained.x = delta.x;
        break;
      case "y":
        constrained.y = delta.y;
        break;
      case "z":
        constrained.z = delta.z;
        break;
      case "xy":
        constrained.x = delta.x;
        constrained.y = delta.y;
        break;
      case "xz":
        constrained.x = delta.x;
        constrained.z = delta.z;
        break;
      case "yz":
        constrained.y = delta.y;
        constrained.z = delta.z;
        break;
      case "xyz":
      default:
        constrained.copy(delta);
        break;
    }
    return constrained;
  }, [axis]);
  const handlePointerDown = useCallback((e) => {
    e.stopPropagation();
    setIsDragging(true);
    setGizmoDragging(true);
    if (meshRef.current) {
      const worldPos = new THREE.Vector3();
      meshRef.current.getWorldPosition(worldPos);
      dragStartRef.current = worldPos.clone();
      if (meshRef.current.parent) {
        parentMatrixWorldInverseRef.current = meshRef.current.parent.matrixWorld.clone().invert();
      }
      planeRef.current = createDragPlane(worldPos);
    } else {
      const point = new THREE.Vector3(...position);
      dragStartRef.current = point.clone();
      planeRef.current = createDragPlane(point);
    }
    initialPositionRef.current = [...position];
    onDragStart?.();
    document.body.style.cursor = "move";
    gl.domElement.setPointerCapture(e.pointerId);
    const handlePointerMove = (moveEvent) => {
      if (!dragStartRef.current || !planeRef.current) return;
      const intersection = intersectPlane(moveEvent);
      if (!intersection) return;
      let localIntersection = intersection.clone();
      if (parentMatrixWorldInverseRef.current) {
        localIntersection.applyMatrix4(parentMatrixWorldInverseRef.current);
      }
      const worldDelta = intersection.clone().sub(dragStartRef.current);
      let localDelta = worldDelta.clone();
      if (parentMatrixWorldInverseRef.current) {
        const zeroWorld = new THREE.Vector3(0, 0, 0);
        const deltaWorld = worldDelta.clone();
        zeroWorld.applyMatrix4(parentMatrixWorldInverseRef.current);
        deltaWorld.add(new THREE.Vector3()).applyMatrix4(parentMatrixWorldInverseRef.current);
        localDelta = deltaWorld.sub(zeroWorld);
      }
      const constrainedDelta = applyConstraints(localDelta);
      const newPosition = [
        initialPositionRef.current[0] + constrainedDelta.x,
        initialPositionRef.current[1] + constrainedDelta.y,
        initialPositionRef.current[2] + constrainedDelta.z
      ];
      onDrag(newPosition);
    };
    const handlePointerUp = (upEvent) => {
      setIsDragging(false);
      setGizmoDragging(false);
      dragStartRef.current = null;
      planeRef.current = null;
      parentMatrixWorldInverseRef.current = null;
      document.body.style.cursor = "";
      gl.domElement.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      onDragEnd?.();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [position, createDragPlane, intersectPlane, applyConstraints, onDrag, onDragStart, onDragEnd, gl, setGizmoDragging]);
  const handlePointerEnter = useCallback((e) => {
    e.stopPropagation();
    setIsHovered(true);
    if (!isDragging) {
      document.body.style.cursor = "move";
    }
  }, [isDragging]);
  const handlePointerLeave = useCallback((e) => {
    e.stopPropagation();
    setIsHovered(false);
    if (!isDragging) {
      document.body.style.cursor = "";
    }
  }, [isDragging]);
  const getCornerLDirections = () => {
    const bars = [];
    if (affectsMin[0] || affectsMax[0]) {
      bars.push({ axis: "x", direction: affectsMin[0] ? 1 : -1 });
    }
    if (affectsMin[1] || affectsMax[1]) {
      bars.push({ axis: "y", direction: affectsMin[1] ? 1 : -1 });
    }
    if (affectsMin[2] || affectsMax[2]) {
      bars.push({ axis: "z", direction: affectsMin[2] ? 1 : -1 });
    }
    return { bars };
  };
  const renderCornerGeometry = () => {
    const { bars } = getCornerLDirections();
    const barLength = 1;
    const barThickness = 0.25;
    return /* @__PURE__ */ React.createElement("group", null, bars.map((bar, i) => {
      const pos = [0, 0, 0];
      const size = [barThickness, barThickness, barThickness];
      if (bar.axis === "x") {
        pos[0] = bar.direction * barLength / 2;
        size[0] = barLength;
      } else if (bar.axis === "y") {
        pos[1] = bar.direction * barLength / 2;
        size[1] = barLength;
      } else {
        pos[2] = bar.direction * barLength / 2;
        size[2] = barLength;
      }
      return /* @__PURE__ */ React.createElement("mesh", { key: i, position: pos }, /* @__PURE__ */ React.createElement("boxGeometry", { args: size }), /* @__PURE__ */ React.createElement(
        "meshBasicMaterial",
        {
          color: currentColor,
          transparent: true,
          opacity: 0.9,
          depthTest: true,
          depthWrite: false
        }
      ));
    }));
  };
  const renderEdgeGeometry = () => {
    const barLength = 1.2;
    const barThickness = 0.3;
    let size;
    const dir = edgeDirection || (axis === "x" ? "y" : axis === "y" ? "x" : "x");
    if (dir === "x") {
      size = [barLength, barThickness, barThickness];
    } else if (dir === "y") {
      size = [barThickness, barLength, barThickness];
    } else {
      size = [barThickness, barThickness, barLength];
    }
    return /* @__PURE__ */ React.createElement("boxGeometry", { args: size });
  };
  const renderFaceGeometry = () => {
    const barLength = 0.8;
    const barThickness = 0.2;
    let bar1Size;
    let bar2Size;
    if (axis === "x") {
      bar1Size = [barThickness, barLength, barThickness];
      bar2Size = [barThickness, barThickness, barLength];
    } else if (axis === "y") {
      bar1Size = [barLength, barThickness, barThickness];
      bar2Size = [barThickness, barThickness, barLength];
    } else {
      bar1Size = [barLength, barThickness, barThickness];
      bar2Size = [barThickness, barLength, barThickness];
    }
    return /* @__PURE__ */ React.createElement("group", null, /* @__PURE__ */ React.createElement("mesh", null, /* @__PURE__ */ React.createElement("boxGeometry", { args: bar1Size }), /* @__PURE__ */ React.createElement(
      "meshBasicMaterial",
      {
        color: currentColor,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        depthWrite: false
      }
    )), /* @__PURE__ */ React.createElement("mesh", null, /* @__PURE__ */ React.createElement("boxGeometry", { args: bar2Size }), /* @__PURE__ */ React.createElement(
      "meshBasicMaterial",
      {
        color: currentColor,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        depthWrite: false
      }
    )));
  };
  if (type === "corner") {
    return /* @__PURE__ */ React.createElement(
      "group",
      {
        ref: meshRef,
        position,
        userData: { isGizmo: true },
        onPointerDown: handlePointerDown,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave
      },
      renderCornerGeometry()
    );
  }
  if (type === "face") {
    return /* @__PURE__ */ React.createElement(
      "group",
      {
        ref: meshRef,
        position,
        userData: { isGizmo: true },
        onPointerDown: handlePointerDown,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave
      },
      renderFaceGeometry()
    );
  }
  return /* @__PURE__ */ React.createElement(
    "mesh",
    {
      ref: meshRef,
      position,
      userData: { isGizmo: true },
      onPointerDown: handlePointerDown,
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave
    },
    renderEdgeGeometry(),
    /* @__PURE__ */ React.createElement(
      "meshBasicMaterial",
      {
        color: currentColor,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        depthWrite: false
      }
    )
  );
};
var FieldHandle_default = FieldHandle;

// src/gizmos/FieldHeightSlider.tsx
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
  const { camera, gl } = useThree();
  const groupRef = useRef(null);
  const handleRef = useRef(null);
  const startCapRef = useRef(null);
  const endCapRef = useRef(null);
  const dragStartRef = useRef(null);
  const planeRef = useRef(null);
  const parentWorldPosRef = useRef(new THREE.Vector3());
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
  const sliderConfig = useMemo(() => {
    const offset = 1;
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
  }, [plane, minX, minY, minZ, maxX, maxY, maxZ, currentHeight, isDragging]);
  useFrame(() => {
    if (handleRef.current) {
      const worldPos = new THREE.Vector3();
      handleRef.current.getWorldPosition(worldPos);
      const distance = camera.position.distanceTo(worldPos);
      const scale = distance * baseScreenSize / 500;
      handleRef.current.scale.setScalar(scale);
    }
    if (startCapRef.current) {
      const worldPos = new THREE.Vector3();
      startCapRef.current.getWorldPosition(worldPos);
      const distance = camera.position.distanceTo(worldPos);
      const scale = distance * 2.5 / 500;
      startCapRef.current.scale.setScalar(scale);
    }
    if (endCapRef.current) {
      const worldPos = new THREE.Vector3();
      endCapRef.current.getWorldPosition(worldPos);
      const distance = camera.position.distanceTo(worldPos);
      const scale = distance * 2.5 / 500;
      endCapRef.current.scale.setScalar(scale);
    }
  });
  const currentColor = isDragging ? activeColor : isHovered ? "#555555" : color;
  const createDragPlane = useCallback((point) => {
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    let planeNormal;
    switch (sliderConfig.axis) {
      case "x":
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(0, 1, 0);
        }
        break;
      case "y":
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      case "z":
        planeNormal = new THREE.Vector3(0, 1, 0);
        if (Math.abs(cameraDirection.y) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      default:
        planeNormal = cameraDirection.clone().negate();
    }
    return new THREE.Plane(planeNormal, -planeNormal.dot(point));
  }, [camera, sliderConfig.axis]);
  const intersectPlane = useCallback((event) => {
    if (!planeRef.current) return null;
    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(planeRef.current, intersection);
    return intersection;
  }, [camera, gl]);
  const handlePointerDown = useCallback((e) => {
    e.stopPropagation();
    setIsDragging(true);
    setGizmoDragging(true);
    if (groupRef.current) {
      groupRef.current.getWorldPosition(parentWorldPosRef.current);
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
      const localIntersection = intersection.clone().sub(parentWorldPosRef.current);
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
        pos[2] += 0.5;
        break;
      case "y":
        pos[0] += 0.5;
        break;
      case "z":
        pos[0] += 0.5;
        break;
    }
    return pos;
  }, [sliderConfig]);
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
  ), /* @__PURE__ */ React.createElement(
    Text,
    {
      position: labelPosition,
      fontSize: 0.3,
      color: currentColor,
      anchorX: "left",
      anchorY: "middle"
    },
    `${Math.round(currentHeight * 100)}%`
  ));
};
var FieldHeightSlider_default = FieldHeightSlider;

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
var FieldGizmo = ({
  objectId,
  fieldData: fieldData2,
  isLocked = false,
  getObject,
  interaction = noopInteraction,
  sceneWrites = noopSceneWrites
}) => {
  const {
    componentName = "Field",
    // Default to 'Field' for backward compatibility
    dimension = "3D",
    plane = "XZ",
    min_bound = [-5, -5, -5],
    max_bound = [5, 5, 5],
    cell_size = 0.5,
    render_mode = "None",
    plane_axis = "XZ",
    plane_position = 0
  } = fieldData2;
  const [isDragging, setIsDragging] = useState(false);
  const [localMinBound, setLocalMinBound] = useState(min_bound);
  const [localMaxBound, setLocalMaxBound] = useState(max_bound);
  const localMinRef = useRef(min_bound);
  const localMaxRef = useRef(max_bound);
  React.useEffect(() => {
    if (!isDragging) {
      localMinRef.current = min_bound;
      localMaxRef.current = max_bound;
      setLocalMinBound(min_bound);
      setLocalMaxBound(max_bound);
    }
  }, [min_bound, max_bound, isDragging]);
  const currentMin = isDragging ? localMinBound : min_bound;
  const currentMax = isDragging ? localMaxBound : max_bound;
  const handles = useMemo(() => {
    const [minX, minY, minZ] = currentMin;
    const [maxX, maxY, maxZ] = currentMax;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const midZ = (minZ + maxZ) / 2;
    if (dimension === "2D") {
      switch (plane) {
        case "XY":
          return [
            // Corners - can move in X and Y
            { position: [minX, minY, minZ], type: "corner", axis: "xy", affectsMin: [true, true, false], affectsMax: [false, false, false] },
            { position: [maxX, minY, minZ], type: "corner", axis: "xy", affectsMin: [false, true, false], affectsMax: [true, false, false] },
            { position: [maxX, maxY, minZ], type: "corner", axis: "xy", affectsMin: [false, false, false], affectsMax: [true, true, false] },
            { position: [minX, maxY, minZ], type: "corner", axis: "xy", affectsMin: [true, false, false], affectsMax: [false, true, false] },
            // Edges - horizontal edges (along X) can only move in Y, vertical edges (along Y) can only move in X
            { position: [midX, minY, minZ], type: "edge", axis: "y", affectsMin: [false, true, false], affectsMax: [false, false, false], edgeDirection: "x" },
            { position: [maxX, midY, minZ], type: "edge", axis: "x", affectsMin: [false, false, false], affectsMax: [true, false, false], edgeDirection: "y" },
            { position: [midX, maxY, minZ], type: "edge", axis: "y", affectsMin: [false, false, false], affectsMax: [false, true, false], edgeDirection: "x" },
            { position: [minX, midY, minZ], type: "edge", axis: "x", affectsMin: [true, false, false], affectsMax: [false, false, false], edgeDirection: "y" }
          ];
        case "YZ":
          return [
            // Corners - can move in Y and Z
            { position: [minX, minY, minZ], type: "corner", axis: "yz", affectsMin: [false, true, true], affectsMax: [false, false, false] },
            { position: [minX, maxY, minZ], type: "corner", axis: "yz", affectsMin: [false, false, true], affectsMax: [false, true, false] },
            { position: [minX, maxY, maxZ], type: "corner", axis: "yz", affectsMin: [false, false, false], affectsMax: [false, true, true] },
            { position: [minX, minY, maxZ], type: "corner", axis: "yz", affectsMin: [false, true, false], affectsMax: [false, false, true] },
            // Edges - horizontal edges (along Z) can only move in Y, vertical edges (along Y) can only move in Z
            { position: [minX, minY, midZ], type: "edge", axis: "y", affectsMin: [false, true, false], affectsMax: [false, false, false], edgeDirection: "z" },
            { position: [minX, midY, maxZ], type: "edge", axis: "z", affectsMin: [false, false, false], affectsMax: [false, false, true], edgeDirection: "y" },
            { position: [minX, maxY, midZ], type: "edge", axis: "y", affectsMin: [false, false, false], affectsMax: [false, true, false], edgeDirection: "z" },
            { position: [minX, midY, minZ], type: "edge", axis: "z", affectsMin: [false, false, true], affectsMax: [false, false, false], edgeDirection: "y" }
          ];
        case "XZ":
        default:
          return [
            // Corners - can move in X and Z
            { position: [minX, minY, minZ], type: "corner", axis: "xz", affectsMin: [true, false, true], affectsMax: [false, false, false] },
            { position: [maxX, minY, minZ], type: "corner", axis: "xz", affectsMin: [false, false, true], affectsMax: [true, false, false] },
            { position: [maxX, minY, maxZ], type: "corner", axis: "xz", affectsMin: [false, false, false], affectsMax: [true, false, true] },
            { position: [minX, minY, maxZ], type: "corner", axis: "xz", affectsMin: [true, false, false], affectsMax: [false, false, true] },
            // Edges - edges along X can only move in Z, edges along Z can only move in X
            { position: [midX, minY, minZ], type: "edge", axis: "z", affectsMin: [false, false, true], affectsMax: [false, false, false], edgeDirection: "x" },
            { position: [maxX, minY, midZ], type: "edge", axis: "x", affectsMin: [false, false, false], affectsMax: [true, false, false], edgeDirection: "z" },
            { position: [midX, minY, maxZ], type: "edge", axis: "z", affectsMin: [false, false, false], affectsMax: [false, false, true], edgeDirection: "x" },
            { position: [minX, minY, midZ], type: "edge", axis: "x", affectsMin: [true, false, false], affectsMax: [false, false, false], edgeDirection: "z" }
          ];
      }
    }
    return [
      // 8 Corners - can move freely in all 3 axes
      { position: [minX, minY, minZ], type: "corner", axis: "xyz", affectsMin: [true, true, true], affectsMax: [false, false, false] },
      { position: [maxX, minY, minZ], type: "corner", axis: "xyz", affectsMin: [false, true, true], affectsMax: [true, false, false] },
      { position: [maxX, maxY, minZ], type: "corner", axis: "xyz", affectsMin: [false, false, true], affectsMax: [true, true, false] },
      { position: [minX, maxY, minZ], type: "corner", axis: "xyz", affectsMin: [true, false, true], affectsMax: [false, true, false] },
      { position: [minX, minY, maxZ], type: "corner", axis: "xyz", affectsMin: [true, true, false], affectsMax: [false, false, true] },
      { position: [maxX, minY, maxZ], type: "corner", axis: "xyz", affectsMin: [false, true, false], affectsMax: [true, false, true] },
      { position: [maxX, maxY, maxZ], type: "corner", axis: "xyz", affectsMin: [false, false, false], affectsMax: [true, true, true] },
      { position: [minX, maxY, maxZ], type: "corner", axis: "xyz", affectsMin: [true, false, false], affectsMax: [false, true, true] },
      // 12 Edges - can move in the plane perpendicular to edge direction (2 axes)
      // Bottom edges (Y = minY) - edges along X can move in Y and Z
      { position: [midX, minY, minZ], type: "edge", axis: "yz", affectsMin: [false, true, true], affectsMax: [false, false, false], edgeDirection: "x" },
      { position: [midX, minY, maxZ], type: "edge", axis: "yz", affectsMin: [false, true, false], affectsMax: [false, false, true], edgeDirection: "x" },
      // Bottom edges along Z can move in X and Y
      { position: [maxX, minY, midZ], type: "edge", axis: "xy", affectsMin: [false, true, false], affectsMax: [true, false, false], edgeDirection: "z" },
      { position: [minX, minY, midZ], type: "edge", axis: "xy", affectsMin: [true, true, false], affectsMax: [false, false, false], edgeDirection: "z" },
      // Top edges (Y = maxY) - edges along X can move in Y and Z
      { position: [midX, maxY, minZ], type: "edge", axis: "yz", affectsMin: [false, false, true], affectsMax: [false, true, false], edgeDirection: "x" },
      { position: [midX, maxY, maxZ], type: "edge", axis: "yz", affectsMin: [false, false, false], affectsMax: [false, true, true], edgeDirection: "x" },
      // Top edges along Z can move in X and Y
      { position: [maxX, maxY, midZ], type: "edge", axis: "xy", affectsMin: [false, false, false], affectsMax: [true, true, false], edgeDirection: "z" },
      { position: [minX, maxY, midZ], type: "edge", axis: "xy", affectsMin: [true, false, false], affectsMax: [false, true, false], edgeDirection: "z" },
      // Vertical edges (along Y) - can move in X and Z
      { position: [minX, midY, minZ], type: "edge", axis: "xz", affectsMin: [true, false, true], affectsMax: [false, false, false], edgeDirection: "y" },
      { position: [maxX, midY, minZ], type: "edge", axis: "xz", affectsMin: [false, false, true], affectsMax: [true, false, false], edgeDirection: "y" },
      { position: [maxX, midY, maxZ], type: "edge", axis: "xz", affectsMin: [false, false, false], affectsMax: [true, false, true], edgeDirection: "y" },
      { position: [minX, midY, maxZ], type: "edge", axis: "xz", affectsMin: [true, false, false], affectsMax: [false, false, true], edgeDirection: "y" },
      // 6 Faces - can only move in 1 axis (perpendicular to face)
      { position: [minX, midY, midZ], type: "face", axis: "x", affectsMin: [true, false, false], affectsMax: [false, false, false] },
      { position: [maxX, midY, midZ], type: "face", axis: "x", affectsMin: [false, false, false], affectsMax: [true, false, false] },
      { position: [midX, minY, midZ], type: "face", axis: "y", affectsMin: [false, true, false], affectsMax: [false, false, false] },
      { position: [midX, maxY, midZ], type: "face", axis: "y", affectsMin: [false, false, false], affectsMax: [false, true, false] },
      { position: [midX, midY, minZ], type: "face", axis: "z", affectsMin: [false, false, true], affectsMax: [false, false, false] },
      { position: [midX, midY, maxZ], type: "face", axis: "z", affectsMin: [false, false, false], affectsMax: [false, false, true] }
    ];
  }, [dimension, plane, currentMin, currentMax]);
  const handleDragStart = useCallback(() => {
    setIsDragging(true);
    interaction.setGizmoDragging(true);
    const minCopy = [...min_bound];
    const maxCopy = [...max_bound];
    setLocalMinBound(minCopy);
    setLocalMaxBound(maxCopy);
    localMinRef.current = minCopy;
    localMaxRef.current = maxCopy;
  }, [interaction, min_bound, max_bound]);
  const handleDrag = useCallback((handle, newPosition) => {
    const newMin = [...localMinRef.current];
    const newMax = [...localMaxRef.current];
    for (let i = 0; i < 3; i++) {
      if (handle.affectsMin[i]) {
        newMin[i] = Math.min(newPosition[i], newMax[i] - cell_size);
      }
      if (handle.affectsMax[i]) {
        newMax[i] = Math.max(newPosition[i], newMin[i] + cell_size);
      }
    }
    localMinRef.current = newMin;
    localMaxRef.current = newMax;
    setLocalMinBound(newMin);
    setLocalMaxBound(newMax);
  }, [cell_size]);
  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    const newMin = localMinRef.current;
    const newMax = localMaxRef.current;
    const centerX = (newMin[0] + newMax[0]) / 2;
    const centerY = (newMin[1] + newMax[1]) / 2;
    const centerZ = (newMin[2] + newMax[2]) / 2;
    const adjustedMin = [
      newMin[0] - centerX,
      newMin[1] - centerY,
      newMin[2] - centerZ
    ];
    const adjustedMax = [
      newMax[0] - centerX,
      newMax[1] - centerY,
      newMax[2] - centerZ
    ];
    const object = getObject?.(objectId);
    if (object) {
      const transform = object.transform || {};
      const currentPos = vectorArray(transform.position, [0, 0, 0]);
      const currentRot = vectorArray(transform.rotation, [0, 0, 0]);
      const currentScale = vectorArray(transform.scale, [1, 1, 1]);
      const localCenterOffset = new THREE.Vector3(centerX, centerY, centerZ);
      const rotation = new THREE.Euler(currentRot[0], currentRot[1], currentRot[2], "ZXY");
      const worldCenterOffset = localCenterOffset.applyEuler(rotation);
      const newPosition = [
        currentPos[0] + worldCenterOffset.x,
        currentPos[1] + worldCenterOffset.y,
        currentPos[2] + worldCenterOffset.z
      ];
      void Promise.all([
        sceneWrites.updateComponentField(objectId, componentName, "min_bound", adjustedMin),
        sceneWrites.updateComponentField(objectId, componentName, "max_bound", adjustedMax),
        sceneWrites.updateObjectTransform(objectId, {
          position: newPosition,
          rotation: currentRot,
          scale: currentScale
        })
      ]);
    }
    interaction.setGizmoDragging(false);
  }, [objectId, componentName, getObject, interaction, sceneWrites]);
  const createDragHandler = useCallback((handle) => {
    return (newPos) => handleDrag(handle, newPos);
  }, [handleDrag]);
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
  const boxEdges = useMemo(() => {
    if (!isDragging) return [];
    const [minX, minY, minZ] = currentMin;
    const [maxX, maxY, maxZ] = currentMax;
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
      [maxX, minY, minZ],
      [maxX, maxY, minZ],
      [minX, maxY, minZ],
      [minX, minY, maxZ],
      [maxX, minY, maxZ],
      [maxX, maxY, maxZ],
      [minX, maxY, maxZ]
    ];
    return [
      [corners[0], corners[1]],
      [corners[1], corners[5]],
      [corners[5], corners[4]],
      [corners[4], corners[0]],
      [corners[3], corners[2]],
      [corners[2], corners[6]],
      [corners[6], corners[7]],
      [corners[7], corners[3]],
      [corners[0], corners[3]],
      [corners[1], corners[2]],
      [corners[5], corners[6]],
      [corners[4], corners[7]]
    ];
  }, [isDragging, currentMin, currentMax, dimension, plane]);
  return /* @__PURE__ */ React.createElement("group", { userData: { [VOLUME_DEPTH_SKIP_FLAG]: true } }, !isLocked && isDragging && boxEdges.map((edge, i) => /* @__PURE__ */ React.createElement(
    Line,
    {
      key: `drag-edge-${i}`,
      points: edge,
      color: "#ff8800",
      lineWidth: 2,
      transparent: true,
      opacity: 0.8,
      raycast: () => null
    }
  )), !isLocked && handles.map((handle, i) => /* @__PURE__ */ React.createElement(
    FieldHandle_default,
    {
      key: `handle-${handle.type}-${i}`,
      position: handle.position,
      type: handle.type,
      axis: handle.axis,
      onDragStart: handleDragStart,
      onDrag: createDragHandler(handle),
      onDragEnd: handleDragEnd,
      setGizmoDragging: interaction.setGizmoDragging,
      color: handle.type === "corner" ? "#ff4444" : handle.type === "edge" ? "#ff6666" : "#ff8888",
      hoverColor: "#ffff00",
      activeColor: "#00ff00",
      affectsMin: handle.affectsMin,
      affectsMax: handle.affectsMax,
      edgeDirection: handle.edgeDirection
    }
  )), dimension === "3D" && render_mode === "Slices" && /* @__PURE__ */ React.createElement(
    FieldHeightSlider_default,
    {
      minBound: currentMin,
      maxBound: currentMax,
      plane: plane_axis,
      height: localPlanePosition,
      onHeightChange: handleHeightChange,
      onHeightChangeEnd: handleHeightChangeEnd,
      setGizmoDragging: interaction.setGizmoDragging
    }
  ));
};
var FieldGizmo_default = FieldGizmo;

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
  host
}) {
  if (!selected) return null;
  const component = findComponent(object, (c) => c?.name === "Field" || c?.base_classes?.includes?.("Field"));
  if (!component) return null;
  return /* @__PURE__ */ React.createElement(
    FieldGizmo_default,
    {
      objectId: object.id,
      fieldData: fieldData(component, object),
      isLocked: !!object.locked,
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
    id: "witwin.volume.pointcloud",
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, pointCloudVisualizerConfig.matcher),
    component: ({ object, selected, hovered }) => {
      const component = findComponent(object, pointCloudVisualizerConfig.matcher);
      const data = component ? pointCloudVisualizerConfig.extractor(component, object) : null;
      return data ? /* @__PURE__ */ React.createElement(PointCloudVisualizer_default, { componentData: data, assets: host.assets, selected, hovered }) : null;
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
