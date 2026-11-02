import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, useCallback, useRef, useState, useThree, useFrame } from '../runtime';
import type { ThreeEvent } from '../runtime';
import { screenConstantScale } from './fieldHitTarget';

export type HandleType = 'corner' | 'edge' | 'face';
export type AxisConstraint = 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | 'xyz';

interface FieldHandleProps {
  position: [number, number, number];
  type: HandleType;
  axis: AxisConstraint;
  onDragStart?: () => void;
  onDrag: (newPosition: [number, number, number]) => void;
  onDragEnd?: () => void;
  color?: string;
  hoverColor?: string;
  activeColor?: string;
  setGizmoDragging?: (active: boolean) => void;
  // For corner handles: which bounds this handle affects
  affectsMin?: [boolean, boolean, boolean];
  affectsMax?: [boolean, boolean, boolean];
  // For edge handles: the direction the edge runs along
  edgeDirection?: 'x' | 'y' | 'z';
}

const FieldHandle: ReactTypes.FC<FieldHandleProps> = ({
  position,
  type,
  axis,
  onDragStart,
  onDrag,
  onDragEnd,
  color = '#88ccff',
  hoverColor = '#ffffff',
  activeColor = '#ffff00',
  setGizmoDragging = () => undefined,
  affectsMin = [false, false, false],
  affectsMax = [false, false, false],
  edgeDirection
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const { camera, gl, size } = useThree();
  const meshRef = useRef<ThreeTypes.Mesh>(null);

  const dragStartRef = useRef<ThreeTypes.Vector3 | null>(null);
  const planeRef = useRef<ThreeTypes.Plane | null>(null);
  const initialPositionRef = useRef<[number, number, number]>([0, 0, 0]);
  const parentMatrixWorldInverseRef = useRef<ThreeTypes.Matrix4 | null>(null);

  // Handle size in screen units; see screenConstantScale.
  const baseScreenSize = type === 'corner' ? 14 : type === 'edge' ? 16 : 18;

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.scale.setScalar(screenConstantScale(camera, meshRef.current, size.height) * baseScreenSize);
    }
  });

  // Current color
  const currentColor = isDragging ? activeColor : isHovered ? hoverColor : color;

  // Create drag plane based on camera orientation and axis constraints
  const createDragPlane = useCallback((point: ThreeTypes.Vector3) => {
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);

    let planeNormal: ThreeTypes.Vector3;

    // Choose plane based on axis constraint and camera
    switch (axis) {
      case 'x':
        // For X-only movement, use YZ plane
        planeNormal = new THREE.Vector3(0, 0, 1);
        // If camera is looking along Z, use Y plane instead
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(0, 1, 0);
        }
        break;
      case 'y':
        // For Y-only movement, use XZ plane
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      case 'z':
        // For Z-only movement, use XY plane
        planeNormal = new THREE.Vector3(0, 1, 0);
        if (Math.abs(cameraDirection.y) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      case 'xy':
        // For XY movement, use Z plane
        planeNormal = new THREE.Vector3(0, 0, 1);
        break;
      case 'xz':
        // For XZ movement, use Y plane
        planeNormal = new THREE.Vector3(0, 1, 0);
        break;
      case 'yz':
        // For YZ movement, use X plane
        planeNormal = new THREE.Vector3(1, 0, 0);
        break;
      case 'xyz':
      default:
        // For free movement, use camera-facing plane
        planeNormal = cameraDirection.clone().negate();
        break;
    }

    return new THREE.Plane(planeNormal, -planeNormal.dot(point));
  }, [camera, axis]);

  // Ray intersection with plane
  const intersectPlane = useCallback((event: PointerEvent): ThreeTypes.Vector3 | null => {
    if (!planeRef.current) return null;

    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(planeRef.current, intersection);

    return intersection;
  }, [camera, gl]);

  // Apply axis constraints to movement
  const applyConstraints = useCallback((delta: ThreeTypes.Vector3): ThreeTypes.Vector3 => {
    const constrained = new THREE.Vector3();

    switch (axis) {
      case 'x':
        constrained.x = delta.x;
        break;
      case 'y':
        constrained.y = delta.y;
        break;
      case 'z':
        constrained.z = delta.z;
        break;
      case 'xy':
        constrained.x = delta.x;
        constrained.y = delta.y;
        break;
      case 'xz':
        constrained.x = delta.x;
        constrained.z = delta.z;
        break;
      case 'yz':
        constrained.y = delta.y;
        constrained.z = delta.z;
        break;
      case 'xyz':
      default:
        constrained.copy(delta);
        break;
    }

    return constrained;
  }, [axis]);

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    // Only the left button drags. Right and middle drags move the camera
    // (orbit, pan, fly); a press that starts on a handle must not also
    // resize the box, or an orbit across it rewrites the domain.
    if (e.button !== 0) return;
    e.stopPropagation();
    setIsDragging(true);
    setGizmoDragging(true);

    // Get the world position of the handle and its parent's inverse matrix
    if (meshRef.current) {
      const worldPos = new THREE.Vector3();
      meshRef.current.getWorldPosition(worldPos);
      dragStartRef.current = worldPos.clone();

      // Store parent's inverse world matrix for converting world coords back to local
      if (meshRef.current.parent) {
        parentMatrixWorldInverseRef.current = meshRef.current.parent.matrixWorld.clone().invert();
      }

      // Create drag plane in world space
      planeRef.current = createDragPlane(worldPos);
    } else {
      const point = new THREE.Vector3(...position);
      dragStartRef.current = point.clone();
      planeRef.current = createDragPlane(point);
    }

    initialPositionRef.current = [...position];

    onDragStart?.();

    // Set cursor and capture pointer
    document.body.style.cursor = 'move';
    gl.domElement.setPointerCapture(e.pointerId);

    // Add global event listeners
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!dragStartRef.current || !planeRef.current) return;

      const intersection = intersectPlane(moveEvent);
      if (!intersection) return;

      // Convert intersection from world space to local space
      let localIntersection = intersection.clone();
      if (parentMatrixWorldInverseRef.current) {
        localIntersection.applyMatrix4(parentMatrixWorldInverseRef.current);
      }

      // Get world-space delta and transform to local for proper axis constraints
      const worldDelta = intersection.clone().sub(dragStartRef.current);
      let localDelta = worldDelta.clone();
      if (parentMatrixWorldInverseRef.current) {
        // Transform delta direction (not position)
        const zeroWorld = new THREE.Vector3(0, 0, 0);
        const deltaWorld = worldDelta.clone();
        zeroWorld.applyMatrix4(parentMatrixWorldInverseRef.current);
        deltaWorld.add(new THREE.Vector3()).applyMatrix4(parentMatrixWorldInverseRef.current);
        localDelta = deltaWorld.sub(zeroWorld);
      }

      const constrainedDelta = applyConstraints(localDelta);

      const newPosition: [number, number, number] = [
        initialPositionRef.current[0] + constrainedDelta.x,
        initialPositionRef.current[1] + constrainedDelta.y,
        initialPositionRef.current[2] + constrainedDelta.z
      ];

      onDrag(newPosition);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      setIsDragging(false);
      setGizmoDragging(false);
      dragStartRef.current = null;
      planeRef.current = null;
      parentMatrixWorldInverseRef.current = null;
      document.body.style.cursor = '';

      gl.domElement.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      onDragEnd?.();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [position, createDragPlane, intersectPlane, applyConstraints, onDrag, onDragStart, onDragEnd, gl, setGizmoDragging]);

  const handlePointerEnter = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setIsHovered(true);
    if (!isDragging) {
      document.body.style.cursor = 'move';
    }
  }, [isDragging]);

  const handlePointerLeave = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setIsHovered(false);
    if (!isDragging) {
      document.body.style.cursor = '';
    }
  }, [isDragging]);

  // Determine L-shape directions based on which bounds this corner affects
  // The L extends INWARD toward the box center (opposite direction from the corner position)
  const getCornerLDirections = (): { bars: Array<{ axis: 'x' | 'y' | 'z', direction: number }> } => {
    const bars: Array<{ axis: 'x' | 'y' | 'z', direction: number }> = [];

    // For each axis, determine if we need a bar and which direction
    // If affectsMin[i] is true, the corner is at min position on that axis, so bar extends in +direction
    // If affectsMax[i] is true, the corner is at max position on that axis, so bar extends in -direction
    if (affectsMin[0] || affectsMax[0]) {
      bars.push({ axis: 'x', direction: affectsMin[0] ? 1 : -1 });
    }
    if (affectsMin[1] || affectsMax[1]) {
      bars.push({ axis: 'y', direction: affectsMin[1] ? 1 : -1 });
    }
    if (affectsMin[2] || affectsMax[2]) {
      bars.push({ axis: 'z', direction: affectsMin[2] ? 1 : -1 });
    }

    return { bars };
  };

  // Render L-shaped corner handle
  const renderCornerGeometry = () => {
    const { bars } = getCornerLDirections();
    const barLength = 1.0;
    const barThickness = 0.25;

    return (
      <group>
        {bars.map((bar, i) => {
          const pos: [number, number, number] = [0, 0, 0];
          const size: [number, number, number] = [barThickness, barThickness, barThickness];

          // Set position and size based on axis
          if (bar.axis === 'x') {
            pos[0] = bar.direction * barLength / 2;
            size[0] = barLength;
          } else if (bar.axis === 'y') {
            pos[1] = bar.direction * barLength / 2;
            size[1] = barLength;
          } else {
            pos[2] = bar.direction * barLength / 2;
            size[2] = barLength;
          }

          return (
            <mesh key={i} position={pos}>
              <boxGeometry args={size} />
              <meshBasicMaterial
                color={currentColor}
                transparent
                opacity={0.9}
                depthTest
                depthWrite={false}
              />
            </mesh>
          );
        })}
      </group>
    );
  };

  // Render edge box geometry - long edge along the edge direction
  const renderEdgeGeometry = () => {
    const barLength = 1.2;
    const barThickness = 0.3;
    let size: [number, number, number];

    // Use edgeDirection if provided, otherwise infer from axis
    const dir = edgeDirection || (axis === 'x' ? 'y' : axis === 'y' ? 'x' : 'x');

    if (dir === 'x') {
      size = [barLength, barThickness, barThickness];
    } else if (dir === 'y') {
      size = [barThickness, barLength, barThickness];
    } else {
      size = [barThickness, barThickness, barLength];
    }

    return <boxGeometry args={size} />;
  };

  // Render face cross geometry - a cross shape for face handles
  const renderFaceGeometry = () => {
    const barLength = 0.8;
    const barThickness = 0.2;

    // Create a cross on the face plane
    // axis tells us which direction handle moves (perpendicular to face)
    // Cross is on the plane perpendicular to that axis
    let bar1Size: [number, number, number];
    let bar2Size: [number, number, number];

    if (axis === 'x') {
      // Face perpendicular to X, cross on YZ plane
      bar1Size = [barThickness, barLength, barThickness];
      bar2Size = [barThickness, barThickness, barLength];
    } else if (axis === 'y') {
      // Face perpendicular to Y, cross on XZ plane
      bar1Size = [barLength, barThickness, barThickness];
      bar2Size = [barThickness, barThickness, barLength];
    } else {
      // Face perpendicular to Z, cross on XY plane
      bar1Size = [barLength, barThickness, barThickness];
      bar2Size = [barThickness, barLength, barThickness];
    }

    return (
      <group>
        <mesh>
          <boxGeometry args={bar1Size} />
          <meshBasicMaterial
            color={currentColor}
            transparent
            opacity={0.9}
            depthTest
            depthWrite={false}
          />
        </mesh>
        <mesh>
          <boxGeometry args={bar2Size} />
          <meshBasicMaterial
            color={currentColor}
            transparent
            opacity={0.9}
            depthTest
            depthWrite={false}
          />
        </mesh>
      </group>
    );
  };

  // For corner type, use a group with L-shape.
  // userData.isGizmo = true on the root makes eventOccludedByGizmo() detect
  // the handle when raycaster hits any of the nested L-bar meshes (it walks
  // parents). Required so a click on a corner handle doesn't fall through
  // to the scene object behind it.
  if (type === 'corner') {
    return (
      <group
        ref={meshRef as any}
        position={position}
        userData={{ isGizmo: true }}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {renderCornerGeometry()}
      </group>
    );
  }

  // For face type, use a cross shape
  if (type === 'face') {
    return (
      <group
        ref={meshRef as any}
        position={position}
        userData={{ isGizmo: true }}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {renderFaceGeometry()}
      </group>
    );
  }

  // For edge type, use oriented box geometry
  return (
    <mesh
      ref={meshRef}
      position={position}
      userData={{ isGizmo: true }}
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {renderEdgeGeometry()}
      <meshBasicMaterial
        color={currentColor}
        transparent
        opacity={0.9}
        depthTest
        depthWrite={false}
      />
    </mesh>
  );
};

export default FieldHandle;
