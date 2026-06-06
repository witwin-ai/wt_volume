import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, Line, useEffect, useMemo, useRef, useState, useFrame, useThree } from '../runtime';
import { VisualizerConfig, VisualizerProps } from './types';
import { getComponentValue, inheritsFrom } from './utils';
import { loadVolumeTexture, checkVolumeSupport } from '../assets/volumeTexture';
import { createColormapTexture } from '../shaders/volumeShaders';
import { planeSliceVertexShader, planeSliceFragmentShader } from '../shaders/planeSliceShaders';
import { calculateFieldEdgeHitRadius } from './fieldHitTarget';
import { SOFT_SELECTION_HIT_AREA_FLAG } from './selectionHitTarget';
import type { RenderResourceRef, ViewportAssetsApi } from '../sdk/types';

// Default field color and opacity
const DEFAULT_FIELD_COLOR = '#333333';
const DEFAULT_FIELD_OPACITY = 0.7;

interface FieldComponentData {
  componentName?: string;  // The actual component name (Field, FDTDSolver, etc.)
  dimension?: string;
  plane?: string;
  min_bound?: number[];
  max_bound?: number[];
  cell_size?: number;
  show_grid?: boolean;
  // Render mode (None/Slices/Volume/SDF)
  render_mode?: string;
  // Shared colormap
  colormap?: string;
  log_colormap?: boolean;  // Apply logarithmic scaling to colormap
  // Plane renderer settings
  plane_axis?: string;
  plane_position?: number;
  plane_opacity?: number;
  // Volume data for shader-based rendering (unified for 2D and 3D)
  volume?: RenderResourceRef | null;
  resolution?: number[];
  // Normalized display range (0-1)
  display_range?: number[];  // [min, max] normalized (0-1)
}

interface FieldVisualizerProps {
  fieldData: FieldComponentData;
  assets: ViewportAssetsApi;
  selected?: boolean;
  isGizmoDragging?: boolean;
}

// Create checkerboard texture for grid overlay
function createCheckerboardTexture(width: number, height: number): ThreeTypes.DataTexture {
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Checkerboard pattern: alternate between light and dark
      const isLight = (x + y) % 2 === 0;
      const gray = isLight ? 255 : 0;
      data[i] = gray;     // R
      data[i + 1] = gray; // G
      data[i + 2] = gray; // B
      data[i + 3] = isLight ? 40 : 20; // Alpha (semi-transparent)
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

interface FieldEdgeHitAreaProps {
  edge: [ThreeTypes.Vector3Tuple, ThreeTypes.Vector3Tuple];
  minBound: number[];
  maxBound: number[];
}

const FieldEdgeHitArea: ReactTypes.FC<FieldEdgeHitAreaProps> = ({ edge, minBound, maxBound }) => {
  const meshRef = useRef<ThreeTypes.Mesh>(null);
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
      length: edgeLength,
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
      maxBound,
    });

    const worldScale = new THREE.Vector3(1, 1, 1);
    mesh.parent?.getWorldScale(worldScale);
    const localScale = Math.min(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z));
    const localRadius = worldRadius / Math.max(localScale, 1e-6);
    mesh.scale.set(localRadius, length, localRadius);
  });

  return (
    <mesh
      ref={meshRef}
      position={[mid.x, mid.y, mid.z]}
      rotation={[euler.x, euler.y, euler.z]}
      userData={{ [SOFT_SELECTION_HIT_AREA_FLAG]: true }}
    >
      <cylinderGeometry args={[1, 1, 1, 8]} />
      <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
    </mesh>
  );
};

const FieldVisualizer: ReactTypes.FC<FieldVisualizerProps> = ({
  fieldData,
  assets,
  selected = false,
  isGizmoDragging = false
}) => {
  const {
    dimension = '3D',
    plane = 'XZ',
    min_bound = [-5, -5, -5],
    max_bound = [5, 5, 5],
    show_grid = false,
    render_mode = 'None',
    colormap = 'inferno',
    log_colormap = false,
    plane_axis = 'XZ',
    plane_position = 0.5,
    plane_opacity = 1.0,
    volume,
    resolution = [128, 128, 128],
    display_range = [0.0, 1.0]
  } = fieldData;

  // Volume data is already normalized to 0-1 in backend (set_volume_data)
  // So display_range (0-1) maps directly to valueMin/valueMax shader uniforms
  const valueMin = display_range[0];
  const valueMax = display_range[1];

  // 3D volume texture state (unified for 2D and 3D modes)
  const [volumeTexture, setVolumeTexture] = useState<ThreeTypes.Data3DTexture | null>(null);
  const volumeTextureRef = useRef<ThreeTypes.Data3DTexture | null>(null);
  const colormapTextureRef = useRef<ThreeTypes.DataTexture | null>(null);
  const sliceMeshRef = useRef<ThreeTypes.Mesh | null>(null);

  // Refs for shader uniforms (to ensure useFrame gets latest values)
  const planeParamsRef = useRef({
    slicePlaneInt: 1,
    slicePosition: plane_position,
    opacity: plane_opacity,
    valueMin: valueMin,
    valueMax: valueMax,
    logColormap: log_colormap
  });

  // Load 3D volume texture when the resource ref changes (unified for both 2D and 3D)
  useEffect(() => {
    // Only load if we have a volume resource and are in Slices mode
    if (!volume || render_mode !== 'Slices') {
      return;
    }

    const loadVolume = async () => {
      try {
        const loadResolution = resolution as [number, number, number];

        // Check WebGL2 support
        const support = checkVolumeSupport(loadResolution);
        if (!support.supported) {
          console.error('[FieldVisualizer] Volume not supported:', support.message);
          return;
        }

        // Cleanup old texture
        if (volumeTextureRef.current) {
          volumeTextureRef.current.dispose();
          volumeTextureRef.current = null;
        }

        // Load volume
        const result = await loadVolumeTexture(assets, volume, loadResolution);

        volumeTextureRef.current = result.texture;
        setVolumeTexture(result.texture);

      } catch (err: any) {
        console.error('[FieldVisualizer] Failed to load volume:', err);
      }
    };

    loadVolume();

    // Cleanup on unmount
    return () => {
      if (volumeTextureRef.current) {
        volumeTextureRef.current.dispose();
        volumeTextureRef.current = null;
      }
    };
  }, [assets, volume?.assetId, volume?.uri, render_mode]);

  // Create/update colormap texture for shader-based plane slicing
  useEffect(() => {
    // Cleanup old texture
    if (colormapTextureRef.current) {
      colormapTextureRef.current.dispose();
    }

    // Create new colormap texture
    const texture = createColormapTexture(colormap);
    colormapTextureRef.current = texture;

    return () => {
      if (colormapTextureRef.current) {
        colormapTextureRef.current.dispose();
      }
    };
  }, [colormap]);

  // Determine slice plane based on dimension
  // In 2D mode, use the 'plane' field; in 3D mode, use 'plane_axis'
  const effectivePlaneAxis = dimension === '2D' ? plane : plane_axis;

  // In 2D mode, slice position is always 0.5 (middle of the thin dimension)
  const effectiveSlicePosition = dimension === '2D' ? 0.5 : plane_position;

  // Convert plane axis string to int for shader
  const slicePlaneInt = useMemo(() => {
    switch (effectivePlaneAxis) {
      case 'XY': return 0;
      case 'XZ': return 1;
      case 'YZ': return 2;
      default: return 1;
    }
  }, [effectivePlaneAxis]);

  // Update ref with latest plane params (for useFrame to access)
  planeParamsRef.current = {
    slicePlaneInt,
    slicePosition: effectiveSlicePosition,
    opacity: plane_opacity,
    valueMin: valueMin,
    valueMax: valueMax,
    logColormap: log_colormap
  };

  // Create plane slice shader material
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

  // Update plane slice shader uniforms every frame
  useFrame(() => {
    if (!sliceMeshRef.current || !planeSliceMaterial) return;

    // Get latest params from ref (avoids stale closure issues)
    const params = planeParamsRef.current;

    // Update uniforms
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

  // Generate box edges for wireframe
  const boxEdges = useMemo(() => {
    const [minX, minY, minZ] = min_bound;
    const [maxX, maxY, maxZ] = max_bound;

    if (dimension === '2D') {
      // For 2D, draw a rectangle on the appropriate plane
      let corners: [number, number, number][];

      switch (plane) {
        case 'XY':
          corners = [
            [minX, minY, minZ],
            [maxX, minY, minZ],
            [maxX, maxY, minZ],
            [minX, maxY, minZ],
          ];
          break;
        case 'YZ':
          corners = [
            [minX, minY, minZ],
            [minX, maxY, minZ],
            [minX, maxY, maxZ],
            [minX, minY, maxZ],
          ];
          break;
        case 'XZ':
        default:
          corners = [
            [minX, minY, minZ],
            [maxX, minY, minZ],
            [maxX, minY, maxZ],
            [minX, minY, maxZ],
          ];
          break;
      }

      return [
        [corners[0], corners[1]],
        [corners[1], corners[2]],
        [corners[2], corners[3]],
        [corners[3], corners[0]],
      ];
    }

    // 3D box edges
    const corners: [number, number, number][] = [
      [minX, minY, minZ], // 0
      [maxX, minY, minZ], // 1
      [maxX, maxY, minZ], // 2
      [minX, maxY, minZ], // 3
      [minX, minY, maxZ], // 4
      [maxX, minY, maxZ], // 5
      [maxX, maxY, maxZ], // 6
      [minX, maxY, maxZ], // 7
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
      [corners[4], corners[7]],
    ];
  }, [min_bound, max_bound, dimension, plane]);

  // Checkerboard texture state for grid overlay
  const [checkerboardTexture, setCheckerboardTexture] = useState<ThreeTypes.DataTexture | null>(null);
  const checkerboardTextureRef = useRef<ThreeTypes.DataTexture | null>(null);

  // Create/update checkerboard texture based on resolution
  useEffect(() => {
    // Cleanup old texture
    if (checkerboardTextureRef.current) {
      checkerboardTextureRef.current.dispose();
      checkerboardTextureRef.current = null;
    }

    if (show_grid && resolution) {
      // Use resolution to determine grid size
      // For 2D mode with thin dimension, pick the appropriate axes
      let width: number, height: number;

      if (dimension === '2D') {
        switch (plane) {
          case 'XY':
            width = resolution[0];
            height = resolution[1];
            break;
          case 'YZ':
            width = resolution[1];
            height = resolution[2];
            break;
          case 'XZ':
          default:
            width = resolution[0];
            height = resolution[2];
            break;
        }
      } else {
        // 3D mode - use plane_axis
        switch (plane_axis) {
          case 'XY':
            width = resolution[0];
            height = resolution[1];
            break;
          case 'YZ':
            width = resolution[1];
            height = resolution[2];
            break;
          case 'XZ':
          default:
            width = resolution[0];
            height = resolution[2];
            break;
        }
      }

      // Ensure minimum size
      width = Math.max(2, Math.round(width));
      height = Math.max(2, Math.round(height));

      const texture = createCheckerboardTexture(width, height);
      checkerboardTextureRef.current = texture;
      setCheckerboardTexture(texture);
    } else {
      setCheckerboardTexture(null);
    }

    // Cleanup on unmount
    return () => {
      if (checkerboardTextureRef.current) {
        checkerboardTextureRef.current.dispose();
      }
    };
  }, [show_grid, resolution, dimension, plane, plane_axis]);

  // Line width based on selection state
  const edgeLineWidth = selected ? 2.5 : 1.5;

  // Edge color based on selection - gray and transparent when dragging
  const edgeColor = isGizmoDragging ? '#666666' : selected ? '#ff8800' : DEFAULT_FIELD_COLOR;
  const edgeOpacity = isGizmoDragging ? 0.3 : (selected ? 1 : DEFAULT_FIELD_OPACITY);

  // Calculate plane geometry based on dimension and plane
  const planeGeometry = useMemo(() => {
    const [minX, minY, minZ] = min_bound;
    const [maxX, maxY, maxZ] = max_bound;

    if (dimension === '2D') {
      // 2D mode - place on the selected plane (fixed position)
      switch (plane) {
        case 'XY':
          return {
            position: [(minX + maxX) / 2, (minY + maxY) / 2, minZ + 0.001] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            size: [maxX - minX, maxY - minY] as [number, number]
          };
        case 'YZ':
          return {
            position: [minX + 0.001, (minY + maxY) / 2, (minZ + maxZ) / 2] as [number, number, number],
            rotation: [0, Math.PI / 2, 0] as [number, number, number],
            size: [maxZ - minZ, maxY - minY] as [number, number]
          };
        case 'XZ':
        default:
          return {
            position: [(minX + maxX) / 2, minY + 0.001, (minZ + maxZ) / 2] as [number, number, number],
            rotation: [-Math.PI / 2, 0, 0] as [number, number, number],
            size: [maxX - minX, maxZ - minZ] as [number, number]
          };
      }
    } else {
      // 3D mode - use plane_axis and plane_position to position the slice
      const h = plane_position; // 0 to 1

      switch (plane_axis) {
        case 'XY': {
          const zPos = minZ + h * (maxZ - minZ) + 0.001;
          return {
            position: [(minX + maxX) / 2, (minY + maxY) / 2, zPos] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            size: [maxX - minX, maxY - minY] as [number, number]
          };
        }
        case 'YZ': {
          const xPos = minX + h * (maxX - minX) + 0.001;
          return {
            position: [xPos, (minY + maxY) / 2, (minZ + maxZ) / 2] as [number, number, number],
            rotation: [0, Math.PI / 2, 0] as [number, number, number],
            size: [maxZ - minZ, maxY - minY] as [number, number]
          };
        }
        case 'XZ':
        default: {
          const yPos = minY + h * (maxY - minY) + 0.001;
          return {
            position: [(minX + maxX) / 2, yPos, (minZ + maxZ) / 2] as [number, number, number],
            rotation: [-Math.PI / 2, 0, 0] as [number, number, number],
            size: [maxX - minX, maxZ - minZ] as [number, number]
          };
        }
      }
    }
  }, [min_bound, max_bound, dimension, plane, plane_axis, plane_position]);

  return (
    <group>
      {/* Box edges - visible */}
      {boxEdges.map((edge, i) => (
        <Line
          key={`edge-${i}`}
          points={edge as [ThreeTypes.Vector3Tuple, ThreeTypes.Vector3Tuple]}
          color={edgeColor}
          lineWidth={edgeLineWidth}
          transparent
          opacity={edgeOpacity}
          raycast={() => null}
        />
      ))}

      {/* Box edges - transparent hit areas with viewport-scaled radius */}
      {boxEdges.map((edge, i) => (
        <FieldEdgeHitArea
          key={`edge-hit-${i}`}
          edge={edge as [ThreeTypes.Vector3Tuple, ThreeTypes.Vector3Tuple]}
          minBound={min_bound}
          maxBound={max_bound}
        />
      ))}

      {/* Shader-based plane slice visualization (unified for 2D and 3D) */}
      {render_mode === 'Slices' && planeSliceMaterial && (
        <mesh
          ref={sliceMeshRef}
          position={planeGeometry.position}
          rotation={planeGeometry.rotation}
          raycast={() => null}
          renderOrder={-10}
          material={planeSliceMaterial}
        >
          <planeGeometry args={[planeGeometry.size[0], planeGeometry.size[1]]} />
        </mesh>
      )}

      {/* Checkerboard grid overlay - rendered on top of plane slice with slight offset */}
      {checkerboardTexture && show_grid && render_mode === 'Slices' && (
        <mesh
          position={[
            planeGeometry.position[0],
            planeGeometry.position[1] + (planeGeometry.rotation[0] === 0 ? 0 : 0.002),
            planeGeometry.position[2] + (planeGeometry.rotation[0] === 0 ? 0.002 : 0)
          ]}
          rotation={planeGeometry.rotation}
          raycast={() => null}
          renderOrder={-9}
        >
          <planeGeometry args={[planeGeometry.size[0], planeGeometry.size[1]]} />
          <meshBasicMaterial
            map={checkerboardTexture}
            transparent
            opacity={0.5}
            side={THREE.DoubleSide}
            depthWrite
            alphaTest={0.01}
          />
        </mesh>
      )}

    </group>
  );
};

// Export the data type for external use
export type { FieldComponentData };

/**
 * Adapter component that wraps FieldVisualizer with unified VisualizerProps interface
 */
const FieldVisualizerAdapter: ReactTypes.FC<VisualizerProps<FieldComponentData> & {
  assets: ViewportAssetsApi;
  isGizmoDragging?: boolean;
}> = ({
  data,
  assets,
  selected,
  isGizmoDragging
}) => {
  return <FieldVisualizer fieldData={data} assets={assets} selected={selected} isGizmoDragging={isGizmoDragging} />;
};

/**
 * Registration configuration for Field visualizer
 */
export const fieldVisualizerConfig: VisualizerConfig<FieldComponentData> = {
  name: 'field',
  priority: 10, // Higher priority - Field can contain other visualizations

  // Match Field component or any component inheriting from Field
  matcher: (c) => inheritsFrom(c, 'Field'),

  // Extract visualization data from component
  extractor: (comp) => ({
    componentName: comp.name,
    dimension: getComponentValue(comp, 'dimension', '3D'),
    plane: getComponentValue(comp, 'plane', 'XZ'),
    min_bound: getComponentValue(comp, 'min_bound', [-5, -5, -5]),
    max_bound: getComponentValue(comp, 'max_bound', [5, 5, 5]),
    cell_size: getComponentValue(comp, 'cell_size', 0.5),
    show_grid: getComponentValue(comp, 'show_grid', true),
    render_mode: getComponentValue(comp, 'render_mode', 'None'),
    colormap: getComponentValue(comp, 'colormap', 'inferno'),
    log_colormap: getComponentValue(comp, 'log_colormap', false),
    // Plane renderer settings
    plane_axis: getComponentValue(comp, 'plane_axis', 'XZ'),
    plane_position: getComponentValue(comp, 'plane_position', 0.5),
    plane_opacity: getComponentValue(comp, 'plane_opacity', 1.0),
    // Volume data for shader-based rendering (unified)
    volume: getComponentValue(comp, 'volume', null),
    resolution: getComponentValue(comp, 'resolution', [128, 128, 128]),
    // Normalized display range (0-1)
    display_range: getComponentValue(comp, 'display_range', [0.0, 1.0]),
  }),

  component: FieldVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.5,
};

export default FieldVisualizer;
