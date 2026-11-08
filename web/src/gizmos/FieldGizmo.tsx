import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, Html, Line, useCallback, useMemo, useRef, useState, useThree, useFrame } from '../runtime';
import FieldHandle, { type BoundsHandleColors } from './FieldHandle';
import FieldHeightSlider from './FieldHeightSlider';
import type { HostSceneObject, SceneService, TransformToolName, ViewportInteractionApi } from '@witwin/host';
import { VOLUME_DEPTH_SKIP_FLAG } from './VolumeDepthPrepass';
import {
  PLANE_NORMAL,
  applyBoundsDrag,
  applyBoundsMove,
  buildBoundsHandles,
  cellCounts,
  formatLength,
  pickRectAxis,
  type Axis,
  type Bounds,
  type BoundsHandleSpec,
  type DragModifiers,
  type Vec3,
} from './boundsLayout';

type SceneWrites = Pick<SceneService, 'updateComponentField' | 'updateObjectTransform'>;

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

interface FieldGizmoProps {
  objectId: string;
  fieldData: FieldComponentData;
  isLocked?: boolean;
  /** Active viewport tool while the object is selected. Resize handles show only under 'bounds'. */
  tool?: TransformToolName;
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

function vec3(value: number[] | undefined, fallback: Vec3): Vec3 {
  return [Number(value?.[0] ?? fallback[0]), Number(value?.[1] ?? fallback[1]), Number(value?.[2] ?? fallback[2])];
}

// Handle colours follow the Studio accent so the gizmo matches the rest of the
// editor; they are never the axis red/green/blue, which would read as axes.
/* allow-color: 3D gizmo fallbacks when the host theme tokens are not readable */
const FALLBACK_COLORS: BoundsHandleColors = { accent: '#0066cc', fill: '#ffffff' };

function readHandleColors(): BoundsHandleColors {
  try {
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim();
    // --accent-text is the accent lifted for dark backgrounds; it reads better
    // over a dark viewport than the raw accent.
    const lifted = style.getPropertyValue('--accent-text').trim();
    const pick = (value: string) => (value && !value.includes('(') ? value : '');
    return { accent: pick(lifted) || pick(accent) || FALLBACK_COLORS.accent, fill: FALLBACK_COLORS.fill };
  } catch {
    return FALLBACK_COLORS;
  }
}

/** The 12 edges (3D) or 4 sides (2D) of the box, as segment endpoint pairs. */
function boxSegments(bounds: Bounds, normal2d: Axis | null): Vec3[] {
  const { min, max } = bounds;
  if (normal2d !== null) {
    const [a, b] = normal2d === 0 ? [1, 2] : normal2d === 1 ? [0, 2] : [0, 1];
    const at = (va: number, vb: number): Vec3 => {
      const p: Vec3 = [0, 0, 0];
      p[a] = va; p[b] = vb; p[normal2d] = min[normal2d];
      return p;
    };
    const c = [at(min[a], min[b]), at(max[a], min[b]), at(max[a], max[b]), at(min[a], max[b])];
    return [c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]];
  }
  const c: Vec3[] = [
    [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]],
    [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
  ];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return pairs.flatMap(([i, j]) => [c[i], c[j]]);
}

const labelStyle: ReactTypes.CSSProperties = {
  transform: 'translate(14px, -50%)',
  padding: '3px 7px',
  borderRadius: 4,
  background: 'var(--tooltip-bg)',
  color: 'var(--tooltip-text)',
  boxShadow: 'var(--shadow-md)',
  font: '11px/1.35 var(--font-mono, monospace)',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
};

/**
 * Resize gizmo of a Field's bounds, used by the Bounds tool (T).
 *
 * Handles follow Unity's Rect tool on a 3D object: a rectangle on the box's
 * centre slice, in the plane that shows the largest area on screen, with
 * corners, sides and a centre disc that moves the box in that plane (see
 * boundsLayout.ts). The plane changes as the view turns, never during a drag.
 * While dragging, the box and its size in metres (and cells, when the Field
 * has a cell size) are shown. Ctrl snaps (to whole cells, else to a round
 * step), Alt resizes about the centre, Shift keeps a corner's aspect ratio
 * or keeps the disc on one axis.
 *
 * Bounds are relative to the object's origin; on release the box is
 * re-centred on it and the object moves by the centre offset.
 */
const FieldGizmo: ReactTypes.FC<FieldGizmoProps> = ({
  objectId,
  fieldData,
  isLocked = false,
  tool,
  getObject,
  interaction = noopInteraction,
  sceneWrites = noopSceneWrites,
}) => {
  const {
    componentName = 'Field',  // Default to 'Field' for backward compatibility
    dimension = '3D',
    plane = 'XZ',
    cell_size,
    render_mode = 'None',
    plane_axis = 'XZ',
    plane_position = 0.0
  } = fieldData;
  const is2d = dimension === '2D';
  // Only a Field that declares its cell size gets cell counts and cell snapping;
  // solvers that derive their grid elsewhere (Maxwell: wavelength / ppw) do not.
  const cell = typeof cell_size === 'number' && cell_size > 0 ? cell_size : null;
  const propBounds = useMemo<Bounds>(
    () => ({ min: vec3(fieldData.min_bound, [-5, -5, -5]), max: vec3(fieldData.max_bound, [5, 5, 5]) }),
    [fieldData.min_bound, fieldData.max_bound],
  );

  const { camera } = useThree();
  const rootRef = useRef<ThreeTypes.Group>(null);
  const colors = useMemo(readHandleColors, []);

  // Drag state. The bounds under drag live here until release; refs keep the
  // drag callbacks stable while they change.
  const [dragBounds, setDragBounds] = useState<Bounds | null>(null);
  const [activeHandle, setActiveHandle] = useState<BoundsHandleSpec | null>(null);
  const dragStartRef = useRef<Bounds | null>(null);
  const dragBoundsRef = useRef<Bounds | null>(null);
  const bounds = dragBounds ?? propBounds;

  // Normal axis of the rect plane. 2D Fields use their own plane; 3D Fields
  // the plane with the largest area on screen, re-picked every frame except
  // during a drag (Unity locks it the same way).
  const fixedNormal: Axis | null = is2d ? (PLANE_NORMAL[plane] ?? 1) : null;
  const [rectNormal, setRectNormal] = useState<Axis>(fixedNormal ?? 1);
  const rectNormalRef = useRef(rectNormal);
  const showHandles = !isLocked && tool === 'bounds';

  useFrame(() => {
    if (!showHandles || fixedNormal !== null || dragStartRef.current || !rootRef.current) return;
    // The world matrix's basis columns are the local axes with rotation and
    // every parent scale applied; times the box size they are its sides.
    const basis = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    rootRef.current.matrixWorld.extractBasis(basis[0], basis[1], basis[2]);
    const edges = basis.map((v, i) => {
      const size = Math.abs(bounds.max[i] - bounds.min[i]) || 1;
      return [v.x * size, v.y * size, v.z * size] as Vec3;
    }) as [Vec3, Vec3, Vec3];
    const view = camera.getWorldDirection(new THREE.Vector3());
    const normal = pickRectAxis(edges, [view.x, view.y, view.z], rectNormalRef.current);
    if (normal !== rectNormalRef.current) {
      rectNormalRef.current = normal;
      setRectNormal(normal);
    }
  });

  const handles = useMemo(
    () => buildBoundsHandles(bounds, fixedNormal ?? rectNormal),
    [bounds, fixedNormal, rectNormal],
  );

  const handleDragStart = useCallback((spec: BoundsHandleSpec) => {
    interaction.setGizmoDragging(true);
    dragStartRef.current = propBounds;
    dragBoundsRef.current = propBounds;
    setDragBounds(propBounds);
    setActiveHandle(spec);
  }, [interaction, propBounds]);

  const handleDrag = useCallback((spec: BoundsHandleSpec, pointer: Vec3, mods: DragModifiers) => {
    const start = dragStartRef.current;
    if (!start) return;
    const next = spec.kind === 'move'
      ? applyBoundsMove(start, spec, pointer, cell, mods)
      : applyBoundsDrag(start, spec, pointer, cell, mods);
    dragBoundsRef.current = next;
    setDragBounds(next);
  }, [cell]);

  const handleDragEnd = useCallback(() => {
    const next = dragBoundsRef.current;
    dragStartRef.current = null;
    dragBoundsRef.current = null;
    setActiveHandle(null);
    // Keep drawing the dragged bounds until the scene echoes them back, so
    // the box does not flash to its old size for a round trip.
    if (!next) {
      setDragBounds(null);
      interaction.setGizmoDragging(false);
      return;
    }

    const centre: Vec3 = [0, 1, 2].map((i) => (next.min[i] + next.max[i]) / 2) as Vec3;
    const adjustedMin = next.min.map((v, i) => v - centre[i]);
    const adjustedMax = next.max.map((v, i) => v - centre[i]);

    const object = getObject?.(objectId);
    if (object) {
      const transform = (object as any).transform || {};
      const currentPos = vectorArray(transform.position, [0, 0, 0]);
      const currentRot = vectorArray(transform.rotation, [0, 0, 0]);
      const currentScale = vectorArray(transform.scale, [1, 1, 1]);

      // The centre offset is local (rotated and scaled with the object); the position is in the parent's frame.
      const offset = new THREE.Vector3(
        centre[0] * currentScale[0],
        centre[1] * currentScale[1],
        centre[2] * currentScale[2],
      ).applyEuler(new THREE.Euler(currentRot[0], currentRot[1], currentRot[2], 'ZXY'));

      void Promise.all([
        sceneWrites.updateComponentField(objectId, componentName, 'min_bound', adjustedMin),
        sceneWrites.updateComponentField(objectId, componentName, 'max_bound', adjustedMax),
        sceneWrites.updateObjectTransform(objectId, {
          position: [currentPos[0] + offset.x, currentPos[1] + offset.y, currentPos[2] + offset.z],
          rotation: currentRot,
          scale: currentScale,
        }),
      ]).finally(() => setDragBounds(null));
    } else {
      setDragBounds(null);
    }

    interaction.setGizmoDragging(false);
  }, [objectId, componentName, getObject, interaction, sceneWrites]);

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

  const dragging = activeHandle !== null;
  const segments = useMemo(() => (dragging ? boxSegments(bounds, fixedNormal) : null), [dragging, bounds, fixedNormal]);
  // A move keeps the size, so it shows the box but no size label.
  const sizeLabel = useMemo(() => {
    if (!dragging || activeHandle?.kind === 'move') return null;
    const axes = is2d ? ([0, 1, 2] as Axis[]).filter((axis) => axis !== fixedNormal) : ([0, 1, 2] as Axis[]);
    const cells = cell !== null ? cellCounts(bounds, cell) : null;
    return {
      size: axes.map((axis) => formatLength(bounds.max[axis] - bounds.min[axis])).join(' × '),
      cells: cells ? `${axes.map((axis) => cells[axis]).join(' × ')} cells` : null,
    };
  }, [dragging, activeHandle, bounds, cell, is2d, fixedNormal]);
  // The label sits next to the dragged handle, at its current place.
  const labelAnchor = useMemo(
    () => (activeHandle ? handles.find((h) => h.id === activeHandle.id)?.position ?? activeHandle.position : null),
    [activeHandle, handles],
  );

  return (
    <group ref={rootRef} userData={{ [VOLUME_DEPTH_SKIP_FLAG]: true }}>
      {showHandles && segments && (
        <Line
          points={segments as ThreeTypes.Vector3Tuple[]}
          segments
          color={colors.accent}
          lineWidth={1}
          transparent
          opacity={0.6}
          depthTest={false}
          renderOrder={999}
          raycast={() => null}
        />
      )}

      {showHandles && handles.map((spec) => (
        <FieldHandle
          key={spec.id}
          spec={spec}
          colors={colors}
          active={activeHandle?.id === spec.id}
          onDragStart={handleDragStart}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          setGizmoDragging={interaction.setGizmoDragging}
        />
      ))}

      {showHandles && sizeLabel && labelAnchor && (
        <Html position={labelAnchor} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div style={labelStyle}>
            <div>{sizeLabel.size}</div>
            {sizeLabel.cells && <div style={{ opacity: 0.7 }}>{sizeLabel.cells}</div>}
          </div>
        </Html>
      )}

      {/* Height slider for Slices renderer in 3D mode (always shown, even when locked) */}
      {dimension === '3D' && render_mode === 'Slices' && (
        <FieldHeightSlider
          minBound={bounds.min}
          maxBound={bounds.max}
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
