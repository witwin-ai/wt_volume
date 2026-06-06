/**
 * VectorField Visualizer Component
 *
 * Renders 3D/2D vector fields using instanced arrows (shaft + cone head).
 * Features:
 * - InstancedMesh for 10,000+ arrows in a single draw call
 * - Magnitude-based coloring using colormap
 * - Magnitude filtering (min/max threshold)
 * - Optional arrow normalization
 */

import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, Html, Line, useEffect, useMemo, useRef, useState } from '../runtime';
import { loadVectorFieldData, sampleVectorField, VectorFieldSampleData } from '../assets/vectorFieldTexture';
import { getColormapFunc } from '../shaders/volumeShaders';
import { VisualizerConfig, VisualizerProps } from './types';
import { getComponentValue } from './utils';
import type { ViewportAssetsApi } from '../sdk/types';

// Default field color and opacity (same as FieldVisualizer)
const DEFAULT_FIELD_COLOR = '#333333';
const DEFAULT_FIELD_OPACITY = 0.7;

// Loading spinner component
const LoadingSpinner: ReactTypes.FC = () => (
  <Html center>
    <div style={{
      width: 32,
      height: 32,
      border: '3px solid rgba(100, 150, 255, 0.3)',
      borderTop: '3px solid #4488ff',
      borderRadius: '50%',
      animation: 'spin 1s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  </Html>
);

interface VectorFieldComponentData {
  vector_field_id?: string;
  resolution?: number[];
  min_bound?: number[];
  max_bound?: number[];
  dimension?: string;
  colormap?: string;
  vector_arrow_density?: number;
  vector_arrow_scale?: number;
  vector_arrow_thickness?: number;
  display_range?: number[];  // [min, max] - normalized (0-1)
  vector_normalize_arrows?: boolean;
}

interface VectorFieldVisualizerProps {
  data: VectorFieldComponentData;
  assets: ViewportAssetsApi;
  selected?: boolean;
}

/**
 * Create combined arrow geometry (shaft cylinder + cone head)
 * Arrow is aligned along +Y axis, with base at origin
 */
function createArrowGeometry(): ThreeTypes.BufferGeometry {
  const shaftRadius = 0.015;
  const shaftLength = 0.65;
  const headRadius = 0.045;
  const headLength = 0.35;

  // Create shaft (cylinder)
  const shaft = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 6);
  shaft.translate(0, shaftLength / 2, 0);

  // Create head (cone)
  const head = new THREE.ConeGeometry(headRadius, headLength, 6);
  head.translate(0, shaftLength + headLength / 2, 0);

  // Merge geometries using BufferGeometryUtils pattern
  const shaftPos = shaft.getAttribute('position') as ThreeTypes.BufferAttribute;
  const headPos = head.getAttribute('position') as ThreeTypes.BufferAttribute;
  const shaftNorm = shaft.getAttribute('normal') as ThreeTypes.BufferAttribute;
  const headNorm = head.getAttribute('normal') as ThreeTypes.BufferAttribute;

  const totalVertices = shaftPos.count + headPos.count;

  // Create merged position array
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);

  // Copy shaft data
  for (let i = 0; i < shaftPos.count; i++) {
    positions[i * 3] = shaftPos.getX(i);
    positions[i * 3 + 1] = shaftPos.getY(i);
    positions[i * 3 + 2] = shaftPos.getZ(i);
    normals[i * 3] = shaftNorm.getX(i);
    normals[i * 3 + 1] = shaftNorm.getY(i);
    normals[i * 3 + 2] = shaftNorm.getZ(i);
  }

  // Copy head data with offset
  const offset = shaftPos.count;
  for (let i = 0; i < headPos.count; i++) {
    positions[(offset + i) * 3] = headPos.getX(i);
    positions[(offset + i) * 3 + 1] = headPos.getY(i);
    positions[(offset + i) * 3 + 2] = headPos.getZ(i);
    normals[(offset + i) * 3] = headNorm.getX(i);
    normals[(offset + i) * 3 + 1] = headNorm.getY(i);
    normals[(offset + i) * 3 + 2] = headNorm.getZ(i);
  }

  // Merge indices
  const shaftIndex = shaft.getIndex()!;
  const headIndex = head.getIndex()!;
  const indices = new Uint16Array(shaftIndex.count + headIndex.count);

  for (let i = 0; i < shaftIndex.count; i++) {
    indices[i] = shaftIndex.getX(i);
  }
  for (let i = 0; i < headIndex.count; i++) {
    indices[shaftIndex.count + i] = headIndex.getX(i) + offset;
  }

  // Create merged geometry
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  // Clean up source geometries
  shaft.dispose();
  head.dispose();

  return merged;
}

const VectorFieldVisualizer: ReactTypes.FC<VectorFieldVisualizerProps> = ({
  data,
  assets,
  selected = false
}) => {
  const meshRef = useRef<ThreeTypes.InstancedMesh>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawData, setRawData] = useState<Float32Array | null>(null);
  const [dataResolution, setDataResolution] = useState<[number, number, number]>([1, 1, 1]);

  const {
    vector_field_id = '',
    resolution = [64, 64, 64],
    min_bound = [-5, -5, -5],
    max_bound = [5, 5, 5],
    dimension = '3D',
    colormap = 'viridis',
    vector_arrow_density = 16,
    vector_arrow_scale = 1.0,
    vector_arrow_thickness = 1.0,
    display_range = [0.0, 1.0],
    vector_normalize_arrows = false
  } = data;

  // Volume data is already normalized to 0-1 in backend (set_volume_data)
  // So display_range (0-1) maps directly to valueMin/valueMax
  const vector_value_min = display_range[0];
  const vector_value_max = display_range[1];

  const isGizmoDragging = false;

  // Calculate field bounds
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

  // Generate box edges for wireframe (same as FieldVisualizer)
  const boxEdges = useMemo(() => {
    const [minX, minY, minZ] = min_bound;
    const [maxX, maxY, maxZ] = max_bound;

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
  }, [min_bound, max_bound]);

  // Edge styling based on selection state
  const edgeLineWidth = selected ? 2.5 : 1.5;
  const edgeColor = isGizmoDragging ? '#666666' : selected ? '#ff8800' : DEFAULT_FIELD_COLOR;
  const edgeOpacity = isGizmoDragging ? 0.3 : (selected ? 1 : DEFAULT_FIELD_OPACITY);

  // Load vector field data when vector_field_id changes
  useEffect(() => {
    if (!vector_field_id) {
      setRawData(null);
      return;
    }

    setLoading(true);
    setError(null);

    loadVectorFieldData(assets, vector_field_id)
      .then(result => {
        setRawData(result.rawData);
        setDataResolution(result.resolution);
        setLoading(false);
      })
      .catch(err => {
        console.error('[VectorFieldVisualizer] Load failed:', err);
        setError(err.message);
        setLoading(false);
      });
  }, [assets, vector_field_id]);

  // Sample vector field data
  const instanceData = useMemo((): VectorFieldSampleData | null => {
    if (!rawData) return null;

    return sampleVectorField(
      rawData,
      dataResolution,
      vector_arrow_density,
      vector_value_min,
      vector_value_max
    );
  }, [rawData, dataResolution, vector_arrow_density, vector_value_min, vector_value_max]);

  // Create shared arrow geometry
  const arrowGeometry = useMemo(() => createArrowGeometry(), []);

  // Create material
  // Note: Don't use vertexColors - instance colors are handled separately by Three.js
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      roughness: 0.6,
      metalness: 0.2,
      side: THREE.DoubleSide
    });
  }, []);

  // Get colormap function
  const colormapFunc = useMemo(() => getColormapFunc(colormap), [colormap]);

  // Update instanced mesh matrices and colors
  useEffect(() => {
    if (!meshRef.current || !instanceData || instanceData.count === 0) return;

    const mesh = meshRef.current;
    const { positions, directions, magnitudes, count } = instanceData;

    // Set instance count
    mesh.count = count;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3();

    // Create color array for instances
    const colors = new Float32Array(count * 3);

    // Base arrow size - scale with field size and density
    const minFieldDim = Math.min(fieldSize[0], fieldSize[1], fieldSize[2]);
    const baseSize = (minFieldDim / vector_arrow_density) * 0.9;

    for (let i = 0; i < count; i++) {
      // Position: convert from normalized [-0.5, 0.5] to world coordinates
      position.set(
        positions[i * 3] * fieldSize[0] + fieldCenter[0],
        positions[i * 3 + 1] * fieldSize[1] + fieldCenter[1],
        positions[i * 3 + 2] * fieldSize[2] + fieldCenter[2]
      );

      // Direction (already normalized)
      direction.set(
        directions[i * 3],
        directions[i * 3 + 1],
        directions[i * 3 + 2]
      );

      // Rotation: align arrow (+Y) with direction vector
      quaternion.setFromUnitVectors(up, direction);

      // Scale based on magnitude (or uniform if normalized)
      // X and Z control thickness, Y controls length
      const mag = magnitudes[i];
      const arrowLength = vector_normalize_arrows
        ? baseSize * vector_arrow_scale
        : baseSize * (0.3 + mag * 0.7) * vector_arrow_scale;
      const arrowThickness = baseSize * vector_arrow_thickness;

      scale.set(arrowThickness, arrowLength, arrowThickness);

      // Compose transformation matrix
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);

      // Color from colormap based on magnitude
      const [r, g, b] = colormapFunc(mag);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    // Update instance matrix buffer
    mesh.instanceMatrix.needsUpdate = true;

    // Set instance colors
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.instanceColor.needsUpdate = true;

  }, [instanceData, fieldSize, fieldCenter, vector_arrow_scale, vector_arrow_thickness, vector_normalize_arrows, colormapFunc]);

  // Cleanup
  useEffect(() => {
    return () => {
      arrowGeometry.dispose();
      material.dispose();
    };
  }, [arrowGeometry, material]);

  // Loading state
  if (loading) {
    return <LoadingSpinner />;
  }

  // Error or no data
  if (error || !vector_field_id || !instanceData || instanceData.count === 0) {
    return null;
  }

  // Max instances for buffer allocation (use actual count or at least 1)
  const maxInstances = Math.max(instanceData.count, 1);

  return (
    <group position={[0, 0, 0]}>
      {/* Instanced arrows - raycast disabled (pure renderer, no click handling) */}
      <instancedMesh
        ref={meshRef}
        args={[arrowGeometry, material, maxInstances]}
        frustumCulled={false}
        raycast={() => null}
      />

      {/* Box edges - same as FieldVisualizer */}
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
    </group>
  );
};

/**
 * Adapter component with unified VisualizerProps interface
 */
const VectorFieldVisualizerAdapter: ReactTypes.FC<VisualizerProps<VectorFieldComponentData> & { assets: ViewportAssetsApi }> = ({
  data,
  assets,
  selected
}) => {
  return <VectorFieldVisualizer data={data} assets={assets} selected={selected} />;
};

/**
 * Registration configuration for VectorField visualizer
 */
export const vectorFieldVisualizerConfig: VisualizerConfig<VectorFieldComponentData> = {
  name: 'vectorfield',
  priority: 11,

  // Only match VectorFieldRenderer component (pure renderer)
  // Field components handle their own VectorField rendering via FieldVisualizer + field3DRenderData
  matcher: (c) => c.name === 'VectorFieldRenderer',

  // Extract visualization data from component
  // Note: Don't return null for empty vector_field_id - let the component handle it
  // This ensures the visualizer is mounted and can react to subsequent updates
  extractor: (comp) => {
    return {
      vector_field_id: getComponentValue(comp, 'vector_field_id', ''),
      resolution: getComponentValue(comp, 'resolution', [64, 64, 64]),
      min_bound: getComponentValue(comp, 'min_bound', [-5, -5, -5]),
      max_bound: getComponentValue(comp, 'max_bound', [5, 5, 5]),
      dimension: getComponentValue(comp, 'dimension', '3D'),
      colormap: getComponentValue(comp, 'colormap', 'viridis'),
      vector_arrow_density: getComponentValue(comp, 'vector_arrow_density', 16),
      vector_arrow_scale: getComponentValue(comp, 'vector_arrow_scale', 1.0),
      vector_arrow_thickness: getComponentValue(comp, 'vector_arrow_thickness', 1.0),
      display_range: getComponentValue(comp, 'display_range', [0.0, 1.0]),
      vector_normalize_arrows: getComponentValue(comp, 'vector_normalize_arrows', false),
    };
  },

  component: VectorFieldVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.5,
};

export default VectorFieldVisualizer;
