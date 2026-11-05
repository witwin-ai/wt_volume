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
  buildBoundsHandles,
  cellCounts,
  formatLength,
  pickFacingAxis,
  type Axis,
  type Bounds,
  type BoundsHandleSpec,
  type DragModifiers,
  type Side,
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

/** cos 10°: within this of head-on, the depth handles are hidden. */
const HEAD_ON_COS = Math.cos((10 * Math.PI) / 180);

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
 * Handles follow a rect tool: corners and sides on the face that looks at the
 * camera, plus the near and far face centres for depth (see boundsLayout.ts).
 * They move to another face as the view turns. While dragging, the box and
 * its size in metres (and cells, when the Field has a cell size) are shown.
 * Ctrl snaps (to whole cells, else to a round step), Alt resizes about the
 * centre, Shift keeps a corner's aspect ratio.
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

  // Face the handles sit on. 2D Fields use their own plane; 3D Fields the
  // face nearest the camera, re-picked every frame except during a drag.
  const fixedNormal: Axis | null = is2d ? (PLANE_NORMAL[plane] ?? 1) : null;
  const [facing, setFacing] = useState<{ normal: Axis; near: Side; headOn: boolean }>({ normal: fixedNormal ?? 1, near: 'max', headOn: false });
  const facingRef = useRef(facing);
  const showHandles = !isLocked && tool === 'bounds';

  useFrame(() => {
    if (!showHandles || fixedNormal !== null || dragStartRef.current || !rootRef.current) return;
    const local = rootRef.current.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
    const toCamera: Vec3 = [0, 1, 2].map((i) =>
      local.getComponent(i) - (bounds.min[i] + bounds.max[i]) / 2,
    ) as Vec3;
    const normal = pickFacingAxis(toCamera, facingRef.current.normal);
    const near: Side = toCamera[normal] >= 0 ? 'max' : 'min';
    // Looking (almost) straight down the normal, both depth dots land on the
    // rect's centre and a drag along the view axis has no usable plane.
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
      fixedNormal !== null ? 'min' : facing.near,
      !is2d && !facing.headOn,
    ),
    [bounds, fixedNormal, facing, is2d],
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
    const next = applyBoundsDrag(start, spec, pointer, cell, mods);
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
  const sizeLabel = useMemo(() => {
    if (!dragging) return null;
    const axes = is2d ? ([0, 1, 2] as Axis[]).filter((axis) => axis !== fixedNormal) : ([0, 1, 2] as Axis[]);
    const cells = cell !== null ? cellCounts(bounds, cell) : null;
    return {
      size: axes.map((axis) => formatLength(bounds.max[axis] - bounds.min[axis])).join(' × '),
      cells: cells ? `${axes.map((axis) => cells[axis]).join(' × ')} cells` : null,
    };
  }, [dragging, bounds, cell, is2d, fixedNormal]);
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
