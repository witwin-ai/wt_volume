import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, Line, useCallback, useRef, useState, useThree, useFrame } from '../runtime';
import type { ThreeEvent } from '../runtime';
import { screenConstantScale } from './fieldHitTarget';
import { axisDragPlaneNormal, intersectDragPlane } from './dragPlane';
import type { Axis, BoundsHandleSpec, DragModifiers, Vec3 } from './boundsLayout';

/** Dot radius on screen, in px. Corners carry two axes, so they read a little larger. */
const CORNER_RADIUS_PX = 5;
const FACE_RADIUS_PX = 4.5;
/** Width of the band around a side that catches the pointer, in px. */
const EDGE_HIT_PX = 10;
/**
 * The band stops this far (px) short of each end. Without the gap it covers
 * the corner dots, and being thicker it wins the raycast, so a press on a
 * corner moved only one side.
 */
const EDGE_END_CLEARANCE_PX = 12;
const EDGE_LINE_PX = 1.5;
const EDGE_LINE_HOVER_PX = 3;
/** Opacity of a handle on the far side of the box. */
const BACK_OPACITY = 0.35;

/**
 * Handles draw over the scene (depthTest off) so they stay usable inside
 * other geometry and inside the Field's own volume. Back-facing handles are
 * dimmed from the layout instead (`spec.back`), since a wire box has no
 * surface to hide them.
 */
const HANDLE_RENDER_ORDER = 1000;

export interface BoundsHandleColors {
  /** Ring, side lines and the active fill. */
  accent: string;
  /** Dot fill at rest. */
  fill: string;
}

interface FieldHandleProps {
  spec: BoundsHandleSpec;
  colors: BoundsHandleColors;
  /** This handle is the one being dragged. */
  active: boolean;
  onDragStart: (spec: BoundsHandleSpec) => void;
  /** `pointer` is the handle's local position plus the pointer's movement. */
  onDrag: (spec: BoundsHandleSpec, pointer: Vec3, mods: DragModifiers) => void;
  onDragEnd: () => void;
  setGizmoDragging: (active: boolean) => void;
}

function modifiersOf(event: PointerEvent): DragModifiers {
  return { snap: event.ctrlKey || event.metaKey, symmetric: event.altKey, uniform: event.shiftKey };
}

const AXIS_VECTORS: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * One resize handle of the bounds gizmo: a dot (corner, face) or a side of
 * the rectangle (edge). Its root must be a direct child of the gizmo group,
 * whose local frame is the Field's: the drag converts pointer hits into that
 * frame, so rotated, scaled and display-scaled Fields drag along their own
 * axes.
 */
const FieldHandle: ReactTypes.FC<FieldHandleProps> = ({
  spec,
  colors,
  active,
  onDragStart,
  onDrag,
  onDragEnd,
  setGizmoDragging,
}) => {
  const [hovered, setHovered] = useState(false);
  const { camera, gl, size } = useThree();
  const rootRef = useRef<ThreeTypes.Group>(null);
  const hitRef = useRef<ThreeTypes.Mesh>(null);

  const isEdge = spec.kind === 'edge';
  const radiusPx = spec.kind === 'corner' ? CORNER_RADIUS_PX : FACE_RADIUS_PX;
  const lit = hovered || active;
  const opacity = spec.back && !lit ? BACK_OPACITY : 1;

  useFrame(() => {
    if (!isEdge && rootRef.current) {
      const grow = lit ? 1.3 : 1;
      rootRef.current.scale.setScalar(screenConstantScale(camera, rootRef.current, size.height, radiusPx * grow));
    }
    if (isEdge && hitRef.current && spec.segment && spec.edgeAxis !== undefined) {
      // Long axis: the side's length in local units; the other two: EDGE_HIT_PX on screen.
      const thickness = screenConstantScale(camera, hitRef.current, size.height, EDGE_HIT_PX);
      const clearance = screenConstantScale(camera, hitRef.current, size.height, EDGE_END_CLEARANCE_PX);
      const [p, q] = spec.segment;
      const length = Math.abs(q[spec.edgeAxis] - p[spec.edgeAxis]);
      const scale: Vec3 = [thickness, thickness, thickness];
      // A side shorter than both clearances keeps its middle fifth, so it stays grabbable.
      scale[spec.edgeAxis] = Math.max(length - 2 * clearance, length * 0.2);
      hitRef.current.scale.set(scale[0], scale[1], scale[2]);
    }
  });

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    // Only the left button drags. Right and middle drags move the camera
    // (orbit, pan, fly); a press that starts on a handle must not also
    // resize the box, or an orbit across it rewrites the domain.
    if (e.button !== 0) return;
    const object: ThreeTypes.Object3D | null = isEdge ? hitRef.current : rootRef.current;
    const parent = object?.parent;
    if (!object || !parent) return;
    e.stopPropagation();

    parent.updateMatrixWorld();
    const parentWorld = parent.matrixWorld.clone();
    const parentInverse = parentWorld.clone().invert();
    const worldAxis = (axis: Axis) => new THREE.Vector3(...AXIS_VECTORS[axis]).transformDirection(parentWorld);
    const origin = object.getWorldPosition(new THREE.Vector3());
    const viewDir = camera.getWorldDirection(new THREE.Vector3());

    // One axis: the plane that holds it and faces the camera best. Two axes:
    // the plane they span, which is the face the handles sit on.
    let normal: ThreeTypes.Vector3;
    if (spec.axes.length === 1) {
      normal = axisDragPlaneNormal(worldAxis(spec.axes[0]), viewDir);
    } else {
      const third = ([0, 1, 2] as Axis[]).find((axis) => !spec.axes.includes(axis)) ?? 2;
      normal = worldAxis(third);
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);

    const raycaster = new THREE.Raycaster();
    const hitLocal = (event: PointerEvent): ThreeTypes.Vector3 | null => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hit = intersectDragPlane(raycaster.ray, plane);
      return hit ? hit.applyMatrix4(parentInverse) : null;
    };

    // Measure from where the pointer first met the plane, not from the
    // handle's centre, so grabbing a dot off-centre does not jump it.
    const startHit = hitLocal(e.nativeEvent) ?? origin.clone().applyMatrix4(parentInverse);
    const startPosition = [...spec.position] as Vec3;

    setGizmoDragging(true);
    onDragStart(spec);
    document.body.style.cursor = 'grabbing';
    gl.domElement.setPointerCapture(e.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      // A move with no button held is not part of this drag (the release was missed).
      if (moveEvent.buttons === 0) return;
      const hit = hitLocal(moveEvent);
      if (!hit) return;
      const delta = hit.sub(startHit);
      const pointer = [...startPosition] as Vec3;
      for (const axis of spec.axes) pointer[axis] += delta.getComponent(axis);
      onDrag(spec, pointer, modifiersOf(moveEvent));
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      setGizmoDragging(false);
      document.body.style.cursor = '';
      if (gl.domElement.hasPointerCapture(upEvent.pointerId)) gl.domElement.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      onDragEnd();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [camera, gl, isEdge, spec, onDragStart, onDrag, onDragEnd, setGizmoDragging]);

  const handlePointerEnter = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    if (!active) document.body.style.cursor = 'grab';
  }, [active]);

  const handlePointerLeave = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(false);
    if (!active) document.body.style.cursor = '';
  }, [active]);

  // userData.isGizmo makes eventOccludedByGizmo() treat a hit on the handle
  // (or any mesh under it) as the gizmo's, so the click does not also select
  // the object behind it.
  if (isEdge && spec.segment) {
    return (
      <>
        <Line
          points={spec.segment as [ThreeTypes.Vector3Tuple, ThreeTypes.Vector3Tuple]}
          color={colors.accent}
          lineWidth={lit ? EDGE_LINE_HOVER_PX : EDGE_LINE_PX}
          transparent
          depthTest={false}
          renderOrder={HANDLE_RENDER_ORDER}
          raycast={() => null}
        />
        <mesh
          ref={hitRef}
          position={spec.position}
          userData={{ isGizmo: true }}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      </>
    );
  }

  // A dot: an accent sphere with a smaller fill sphere drawn over it, which
  // reads as a ringed disc from every side. Hover and drag fill it with the accent.
  return (
    <group
      ref={rootRef}
      position={spec.position}
      userData={{ isGizmo: true }}
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <mesh renderOrder={HANDLE_RENDER_ORDER}>
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial color={colors.accent} transparent opacity={opacity} depthTest={false} depthWrite={false} />
      </mesh>
      <mesh renderOrder={HANDLE_RENDER_ORDER + 1} raycast={() => null}>
        <sphereGeometry args={[0.6, 16, 12]} />
        <meshBasicMaterial color={lit ? colors.accent : colors.fill} transparent opacity={opacity} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
};

export default FieldHandle;
