import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, Line, useCallback, useMemo, useRef, useState } from '../runtime';
import FieldHandle, { HandleType, AxisConstraint } from './FieldHandle';
import FieldHeightSlider from './FieldHeightSlider';
import type { HostSceneObject, SceneService, ViewportInteractionApi } from '@witwin/host';

type SceneWrites = Pick<SceneService, 'updateComponentField' | 'updateObjectTransform'>;
import { VOLUME_DEPTH_SKIP_FLAG } from './VolumeDepthPrepass';

interface FieldComponentData {
  componentName?: string;  // The actual component name (Field, FDTDSolver, etc.)
  dimension?: string;
  plane?: string;
  min_bound?: number[];
  max_bound?: number[];
  cell_size?: number;
  // Render mode
  render_mode?: string;
  // Plane renderer settings
  plane_axis?: string;
  plane_position?: number;
}

interface HandleInfo {
  position: [number, number, number];
  type: HandleType;
  axis: AxisConstraint;
  // Which bounds this handle affects: 'min' or 'max' for each axis
  affectsMin: [boolean, boolean, boolean];
  affectsMax: [boolean, boolean, boolean];
  // For edge handles: the direction the edge runs along
  edgeDirection?: 'x' | 'y' | 'z';
}

interface FieldGizmoProps {
  objectId: string;
  fieldData: FieldComponentData;
  isLocked?: boolean;
  getObject?: (objectId: string) => HostSceneObject | undefined;
  interaction?: ViewportInteractionApi;
  sceneWrites?: SceneWrites;
}

const noopInteraction: ViewportInteractionApi = {
  setGizmoDragging: () => undefined,
  isGizmoDragging: () => false,
};

const noopSceneWrites: SceneWrites = {
  updateComponentField: async () => undefined,
  updateObjectTransform: async () => undefined,
};

function vectorArray(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(value)) {
    return [
      Number(value[0] ?? fallback[0]),
      Number(value[1] ?? fallback[1]),
      Number(value[2] ?? fallback[2]),
    ];
  }
  if (value && typeof value === 'object') {
    const v = value as { x?: unknown; y?: unknown; z?: unknown };
    return [
      Number(v.x ?? fallback[0]),
      Number(v.y ?? fallback[1]),
      Number(v.z ?? fallback[2]),
    ];
  }
  return fallback;
}

const FieldGizmo: ReactTypes.FC<FieldGizmoProps> = ({
  objectId,
  fieldData,
  isLocked = false,
  getObject,
  interaction = noopInteraction,
  sceneWrites = noopSceneWrites,
}) => {
  const {
    componentName = 'Field',  // Default to 'Field' for backward compatibility
    dimension = '3D',
    plane = 'XZ',
    min_bound = [-5, -5, -5],
    max_bound = [5, 5, 5],
    cell_size = 0.5,
    render_mode = 'None',
    plane_axis = 'XZ',
    plane_position = 0.0
  } = fieldData;

  const [isDragging, setIsDragging] = useState(false);
  const [localMinBound, setLocalMinBound] = useState<number[]>(min_bound);
  const [localMaxBound, setLocalMaxBound] = useState<number[]>(max_bound);

  // Use refs to track current bounds during drag for stable callbacks
  const localMinRef = useRef<number[]>(min_bound);
  const localMaxRef = useRef<number[]>(max_bound);

  // Sync local state when props change (from backend updates)
  React.useEffect(() => {
    // Only sync when not dragging
    if (!isDragging) {
      localMinRef.current = min_bound;
      localMaxRef.current = max_bound;
      setLocalMinBound(min_bound);
      setLocalMaxBound(max_bound);
    }
  }, [min_bound, max_bound, isDragging]);

  // Use local state during drag, props otherwise
  const currentMin = isDragging ? localMinBound : min_bound;
  const currentMax = isDragging ? localMaxBound : max_bound;

  // Generate handles based on dimension mode
  const handles = useMemo((): HandleInfo[] => {
    const [minX, minY, minZ] = currentMin;
    const [maxX, maxY, maxZ] = currentMax;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const midZ = (minZ + maxZ) / 2;

    if (dimension === '2D') {
      // 2D mode: 4 corners + 4 edges on the specified plane
      // Corners can move in 2 axes (the plane axes)
      // Edges can only move in 1 axis (perpendicular to the edge, within the plane)
      switch (plane) {
        case 'XY':
          return [
            // Corners - can move in X and Y
            { position: [minX, minY, minZ], type: 'corner', axis: 'xy', affectsMin: [true, true, false], affectsMax: [false, false, false] },
            { position: [maxX, minY, minZ], type: 'corner', axis: 'xy', affectsMin: [false, true, false], affectsMax: [true, false, false] },
            { position: [maxX, maxY, minZ], type: 'corner', axis: 'xy', affectsMin: [false, false, false], affectsMax: [true, true, false] },
            { position: [minX, maxY, minZ], type: 'corner', axis: 'xy', affectsMin: [true, false, false], affectsMax: [false, true, false] },
            // Edges - horizontal edges (along X) can only move in Y, vertical edges (along Y) can only move in X
            { position: [midX, minY, minZ], type: 'edge', axis: 'y', affectsMin: [false, true, false], affectsMax: [false, false, false], edgeDirection: 'x' },
            { position: [maxX, midY, minZ], type: 'edge', axis: 'x', affectsMin: [false, false, false], affectsMax: [true, false, false], edgeDirection: 'y' },
            { position: [midX, maxY, minZ], type: 'edge', axis: 'y', affectsMin: [false, false, false], affectsMax: [false, true, false], edgeDirection: 'x' },
            { position: [minX, midY, minZ], type: 'edge', axis: 'x', affectsMin: [true, false, false], affectsMax: [false, false, false], edgeDirection: 'y' },
          ];
        case 'YZ':
          return [
            // Corners - can move in Y and Z
            { position: [minX, minY, minZ], type: 'corner', axis: 'yz', affectsMin: [false, true, true], affectsMax: [false, false, false] },
            { position: [minX, maxY, minZ], type: 'corner', axis: 'yz', affectsMin: [false, false, true], affectsMax: [false, true, false] },
            { position: [minX, maxY, maxZ], type: 'corner', axis: 'yz', affectsMin: [false, false, false], affectsMax: [false, true, true] },
            { position: [minX, minY, maxZ], type: 'corner', axis: 'yz', affectsMin: [false, true, false], affectsMax: [false, false, true] },
            // Edges - horizontal edges (along Z) can only move in Y, vertical edges (along Y) can only move in Z
            { position: [minX, minY, midZ], type: 'edge', axis: 'y', affectsMin: [false, true, false], affectsMax: [false, false, false], edgeDirection: 'z' },
            { position: [minX, midY, maxZ], type: 'edge', axis: 'z', affectsMin: [false, false, false], affectsMax: [false, false, true], edgeDirection: 'y' },
            { position: [minX, maxY, midZ], type: 'edge', axis: 'y', affectsMin: [false, false, false], affectsMax: [false, true, false], edgeDirection: 'z' },
            { position: [minX, midY, minZ], type: 'edge', axis: 'z', affectsMin: [false, false, true], affectsMax: [false, false, false], edgeDirection: 'y' },
          ];
        case 'XZ':
        default:
          return [
            // Corners - can move in X and Z
            { position: [minX, minY, minZ], type: 'corner', axis: 'xz', affectsMin: [true, false, true], affectsMax: [false, false, false] },
            { position: [maxX, minY, minZ], type: 'corner', axis: 'xz', affectsMin: [false, false, true], affectsMax: [true, false, false] },
            { position: [maxX, minY, maxZ], type: 'corner', axis: 'xz', affectsMin: [false, false, false], affectsMax: [true, false, true] },
            { position: [minX, minY, maxZ], type: 'corner', axis: 'xz', affectsMin: [true, false, false], affectsMax: [false, false, true] },
            // Edges - edges along X can only move in Z, edges along Z can only move in X
            { position: [midX, minY, minZ], type: 'edge', axis: 'z', affectsMin: [false, false, true], affectsMax: [false, false, false], edgeDirection: 'x' },
            { position: [maxX, minY, midZ], type: 'edge', axis: 'x', affectsMin: [false, false, false], affectsMax: [true, false, false], edgeDirection: 'z' },
            { position: [midX, minY, maxZ], type: 'edge', axis: 'z', affectsMin: [false, false, false], affectsMax: [false, false, true], edgeDirection: 'x' },
            { position: [minX, minY, midZ], type: 'edge', axis: 'x', affectsMin: [true, false, false], affectsMax: [false, false, false], edgeDirection: 'z' },
          ];
      }
    }

    // 3D mode: 8 corners + 12 edges + 6 faces
    return [
      // 8 Corners - can move freely in all 3 axes
      { position: [minX, minY, minZ], type: 'corner', axis: 'xyz', affectsMin: [true, true, true], affectsMax: [false, false, false] },
      { position: [maxX, minY, minZ], type: 'corner', axis: 'xyz', affectsMin: [false, true, true], affectsMax: [true, false, false] },
      { position: [maxX, maxY, minZ], type: 'corner', axis: 'xyz', affectsMin: [false, false, true], affectsMax: [true, true, false] },
      { position: [minX, maxY, minZ], type: 'corner', axis: 'xyz', affectsMin: [true, false, true], affectsMax: [false, true, false] },
      { position: [minX, minY, maxZ], type: 'corner', axis: 'xyz', affectsMin: [true, true, false], affectsMax: [false, false, true] },
      { position: [maxX, minY, maxZ], type: 'corner', axis: 'xyz', affectsMin: [false, true, false], affectsMax: [true, false, true] },
      { position: [maxX, maxY, maxZ], type: 'corner', axis: 'xyz', affectsMin: [false, false, false], affectsMax: [true, true, true] },
      { position: [minX, maxY, maxZ], type: 'corner', axis: 'xyz', affectsMin: [true, false, false], affectsMax: [false, true, true] },

      // 12 Edges - can move in the plane perpendicular to edge direction (2 axes)
      // Bottom edges (Y = minY) - edges along X can move in Y and Z
      { position: [midX, minY, minZ], type: 'edge', axis: 'yz', affectsMin: [false, true, true], affectsMax: [false, false, false], edgeDirection: 'x' },
      { position: [midX, minY, maxZ], type: 'edge', axis: 'yz', affectsMin: [false, true, false], affectsMax: [false, false, true], edgeDirection: 'x' },
      // Bottom edges along Z can move in X and Y
      { position: [maxX, minY, midZ], type: 'edge', axis: 'xy', affectsMin: [false, true, false], affectsMax: [true, false, false], edgeDirection: 'z' },
      { position: [minX, minY, midZ], type: 'edge', axis: 'xy', affectsMin: [true, true, false], affectsMax: [false, false, false], edgeDirection: 'z' },
      // Top edges (Y = maxY) - edges along X can move in Y and Z
      { position: [midX, maxY, minZ], type: 'edge', axis: 'yz', affectsMin: [false, false, true], affectsMax: [false, true, false], edgeDirection: 'x' },
      { position: [midX, maxY, maxZ], type: 'edge', axis: 'yz', affectsMin: [false, false, false], affectsMax: [false, true, true], edgeDirection: 'x' },
      // Top edges along Z can move in X and Y
      { position: [maxX, maxY, midZ], type: 'edge', axis: 'xy', affectsMin: [false, false, false], affectsMax: [true, true, false], edgeDirection: 'z' },
      { position: [minX, maxY, midZ], type: 'edge', axis: 'xy', affectsMin: [true, false, false], affectsMax: [false, true, false], edgeDirection: 'z' },
      // Vertical edges (along Y) - can move in X and Z
      { position: [minX, midY, minZ], type: 'edge', axis: 'xz', affectsMin: [true, false, true], affectsMax: [false, false, false], edgeDirection: 'y' },
      { position: [maxX, midY, minZ], type: 'edge', axis: 'xz', affectsMin: [false, false, true], affectsMax: [true, false, false], edgeDirection: 'y' },
      { position: [maxX, midY, maxZ], type: 'edge', axis: 'xz', affectsMin: [false, false, false], affectsMax: [true, false, true], edgeDirection: 'y' },
      { position: [minX, midY, maxZ], type: 'edge', axis: 'xz', affectsMin: [true, false, false], affectsMax: [false, false, true], edgeDirection: 'y' },

      // 6 Faces - can only move in 1 axis (perpendicular to face)
      { position: [minX, midY, midZ], type: 'face', axis: 'x', affectsMin: [true, false, false], affectsMax: [false, false, false] },
      { position: [maxX, midY, midZ], type: 'face', axis: 'x', affectsMin: [false, false, false], affectsMax: [true, false, false] },
      { position: [midX, minY, midZ], type: 'face', axis: 'y', affectsMin: [false, true, false], affectsMax: [false, false, false] },
      { position: [midX, maxY, midZ], type: 'face', axis: 'y', affectsMin: [false, false, false], affectsMax: [false, true, false] },
      { position: [midX, midY, minZ], type: 'face', axis: 'z', affectsMin: [false, false, true], affectsMax: [false, false, false] },
      { position: [midX, midY, maxZ], type: 'face', axis: 'z', affectsMin: [false, false, false], affectsMax: [false, false, true] },
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

  const handleDrag = useCallback((handle: HandleInfo, newPosition: [number, number, number]) => {
    // Use refs to get current values to avoid stale closures
    const newMin = [...localMinRef.current];
    const newMax = [...localMaxRef.current];

    // Update bounds based on which axes this handle affects
    for (let i = 0; i < 3; i++) {
      if (handle.affectsMin[i]) {
        // Ensure min doesn't exceed max - cell_size
        newMin[i] = Math.min(newPosition[i], newMax[i] - cell_size);
      }
      if (handle.affectsMax[i]) {
        // Ensure max doesn't go below min + cell_size
        newMax[i] = Math.max(newPosition[i], newMin[i] + cell_size);
      }
    }

    // Update refs and local state only
    localMinRef.current = newMin;
    localMaxRef.current = newMax;
    setLocalMinBound(newMin);
    setLocalMaxBound(newMax);
  }, [cell_size]);

  const handleDragEnd = useCallback(() => {
    // Set dragging to false
    setIsDragging(false);

    const newMin = localMinRef.current;
    const newMax = localMaxRef.current;

    // Calculate the center of bounds
    const centerX = (newMin[0] + newMax[0]) / 2;
    const centerY = (newMin[1] + newMax[1]) / 2;
    const centerZ = (newMin[2] + newMax[2]) / 2;

    // Adjust bounds to be relative to new center (so center becomes origin)
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
      const transform = (object as any).transform || {};
      const currentPos = vectorArray(transform.position, [0, 0, 0]);
      const currentRot = vectorArray(transform.rotation, [0, 0, 0]);
      const currentScale = vectorArray(transform.scale, [1, 1, 1]);

      // Center offset is in local space, need to rotate it to world space
      const localCenterOffset = new THREE.Vector3(centerX, centerY, centerZ);
      const rotation = new THREE.Euler(currentRot[0], currentRot[1], currentRot[2], 'ZXY');
      const worldCenterOffset = localCenterOffset.applyEuler(rotation);

      // New position = current position + rotated center offset
      const newPosition: [number, number, number] = [
        currentPos[0] + worldCenterOffset.x,
        currentPos[1] + worldCenterOffset.y,
        currentPos[2] + worldCenterOffset.z
      ];

      void Promise.all([
        sceneWrites.updateComponentField(objectId, componentName, 'min_bound', adjustedMin),
        sceneWrites.updateComponentField(objectId, componentName, 'max_bound', adjustedMax),
        sceneWrites.updateObjectTransform(objectId, {
          position: newPosition,
          rotation: currentRot,
          scale: currentScale,
        }),
      ]);
    }

    interaction.setGizmoDragging(false);
  }, [objectId, componentName, getObject, interaction, sceneWrites]);

  // Create stable drag handlers for each handle
  const createDragHandler = useCallback((handle: HandleInfo) => {
    return (newPos: [number, number, number]) => handleDrag(handle, newPos);
  }, [handleDrag]);

  // Local state for height slider (for smooth dragging)
  const [localPlanePosition, setLocalPlanePosition] = useState(plane_position);

  // Sync local height state with props when not dragging
  React.useEffect(() => {
    setLocalPlanePosition(plane_position);
  }, [plane_position]);

  // Handle height slider change (local update during drag)
  const handleHeightChange = useCallback((newHeight: number) => {
    setLocalPlanePosition(newHeight);
    void sceneWrites.updateComponentField(objectId, componentName, 'plane_position', newHeight);
  }, [objectId, componentName, sceneWrites]);

  // Handle height slider change end (send to backend)
  const handleHeightChangeEnd = useCallback((finalHeight: number) => {
    void sceneWrites.updateComponentField(objectId, componentName, 'plane_position', finalHeight);
  }, [objectId, componentName, sceneWrites]);

  // Generate box edges for wireframe (only during drag)
  const boxEdges = useMemo(() => {
    if (!isDragging) return [];

    const [minX, minY, minZ] = currentMin;
    const [maxX, maxY, maxZ] = currentMax;

    if (dimension === '2D') {
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
      [minX, minY, minZ],
      [maxX, minY, minZ],
      [maxX, maxY, minZ],
      [minX, maxY, minZ],
      [minX, minY, maxZ],
      [maxX, minY, maxZ],
      [maxX, maxY, maxZ],
      [minX, maxY, maxZ],
    ];

    return [
      [corners[0], corners[1]], [corners[1], corners[5]], [corners[5], corners[4]], [corners[4], corners[0]],
      [corners[3], corners[2]], [corners[2], corners[6]], [corners[6], corners[7]], [corners[7], corners[3]],
      [corners[0], corners[3]], [corners[1], corners[2]], [corners[5], corners[6]], [corners[4], corners[7]],
    ];
  }, [isDragging, currentMin, currentMax, dimension, plane]);

  return (
    <group userData={{ [VOLUME_DEPTH_SKIP_FLAG]: true }}>
      {/* Show edges during drag (only when not locked) */}
      {!isLocked && isDragging && boxEdges.map((edge, i) => (
        <Line
          key={`drag-edge-${i}`}
        points={edge as [ThreeTypes.Vector3Tuple, ThreeTypes.Vector3Tuple]}
          color="#ff8800"
          lineWidth={2}
          transparent
          opacity={0.8}
          raycast={() => null}
        />
      ))}

      {/* Handles for resizing bounds (hidden when locked) */}
      {!isLocked && handles.map((handle, i) => (
        <FieldHandle
          key={`handle-${handle.type}-${i}`}
          position={handle.position}
          type={handle.type}
          axis={handle.axis}
          onDragStart={handleDragStart}
          onDrag={createDragHandler(handle)}
          onDragEnd={handleDragEnd}
          setGizmoDragging={interaction.setGizmoDragging}
          color={handle.type === 'corner' ? '#ff4444' : handle.type === 'edge' ? '#ff6666' : '#ff8888'}
          hoverColor="#ffff00"
          activeColor="#00ff00"
          affectsMin={handle.affectsMin}
          affectsMax={handle.affectsMax}
          edgeDirection={handle.edgeDirection}
        />
      ))}

      {/* Height slider for Slices renderer in 3D mode (always shown, even when locked) */}
      {dimension === '3D' && render_mode === 'Slices' && (
        <FieldHeightSlider
          minBound={currentMin}
          maxBound={currentMax}
          plane={plane_axis as 'XY' | 'XZ' | 'YZ'}
          height={localPlanePosition}
          onHeightChange={handleHeightChange}
          onHeightChangeEnd={handleHeightChangeEnd}
          setGizmoDragging={interaction.setGizmoDragging}
        />
      )}
    </group>
  );
};

export default FieldGizmo;
