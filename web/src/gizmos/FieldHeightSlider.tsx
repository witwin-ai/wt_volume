import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, useCallback, useMemo, useRef, useState, useThree, useFrame, Line, Text } from '../runtime';
import type { ThreeEvent } from '../runtime';
import { fieldGizmoUnit, screenConstantScale } from './fieldHitTarget';

const LABEL_PX = 12;

interface FieldHeightSliderProps {
  // Bounding box
  minBound: number[];
  maxBound: number[];
  // Current plane and height
  plane: 'XY' | 'XZ' | 'YZ';
  height: number; // 0-1 normalized
  // Callbacks
  onHeightChange: (height: number) => void;
  onHeightChangeEnd?: (height: number) => void;
  // Styling
  color?: string;
  activeColor?: string;
  setGizmoDragging?: (active: boolean) => void;
}

const FieldHeightSlider: ReactTypes.FC<FieldHeightSliderProps> = ({
  minBound,
  maxBound,
  plane,
  height,
  onHeightChange,
  onHeightChangeEnd,
  color = '#333333',
  activeColor = '#666666',
  setGizmoDragging = () => undefined
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [dragHeight, setDragHeight] = useState(height); // Local height during drag
  const { camera, gl, size } = useThree();

  const groupRef = useRef<ThreeTypes.Group>(null);
  const handleRef = useRef<ThreeTypes.Mesh>(null);
  const startCapRef = useRef<ThreeTypes.Mesh>(null);
  const endCapRef = useRef<ThreeTypes.Mesh>(null);
  const labelRef = useRef<ThreeTypes.Group>(null);
  const dragStartRef = useRef<{ height: number; worldY: number } | null>(null);
  const planeRef = useRef<ThreeTypes.Plane | null>(null);
  // Store parent world position at drag start for consistent coordinate transformation
  const parentWorldPosRef = useRef<ThreeTypes.Vector3>(new THREE.Vector3());
  // Track latest height during drag to avoid stale closure issues
  const latestHeightRef = useRef<number>(height);

  // Sync local drag height with prop when not dragging
  React.useEffect(() => {
    if (!isDragging) {
      setDragHeight(height);
    }
  }, [height, isDragging]);

  const [minX, minY, minZ] = minBound;
  const [maxX, maxY, maxZ] = maxBound;

  // Screen-space handle size (matching FieldHandle for consistency)
  const baseScreenSize = 16;

  // Use local drag height during drag for immediate feedback
  const currentHeight = isDragging ? dragHeight : height;

  // Offsets are in field units (see fieldGizmoUnit).
  const unit = fieldGizmoUnit(minBound, maxBound);

  // Calculate slider position and dimensions based on plane
  const sliderConfig = useMemo(() => {
    const offset = 1.0 * unit; // Distance from the bounding box

    switch (plane) {
      case 'XY': {
        // Slider along Z axis, positioned outside the box
        const sliderStart: [number, number, number] = [maxX + offset, (minY + maxY) / 2, minZ];
        const sliderEnd: [number, number, number] = [maxX + offset, (minY + maxY) / 2, maxZ];
        const axisLength = maxZ - minZ;
        const handlePos: [number, number, number] = [
          maxX + offset,
          (minY + maxY) / 2,
          minZ + currentHeight * axisLength
        ];
        const axisDir = new THREE.Vector3(0, 0, 1);
        const startPoint = new THREE.Vector3(sliderStart[0], sliderStart[1], sliderStart[2]);
        return { sliderStart, sliderEnd, handlePos, axis: 'z' as const, axisLength, axisMin: minZ, axisDir, startPoint };
      }
      case 'YZ': {
        // Slider along X axis
        const sliderStart: [number, number, number] = [minX, (minY + maxY) / 2, maxZ + offset];
        const sliderEnd: [number, number, number] = [maxX, (minY + maxY) / 2, maxZ + offset];
        const axisLength = maxX - minX;
        const handlePos: [number, number, number] = [
          minX + currentHeight * axisLength,
          (minY + maxY) / 2,
          maxZ + offset
        ];
        const axisDir = new THREE.Vector3(1, 0, 0);
        const startPoint = new THREE.Vector3(sliderStart[0], sliderStart[1], sliderStart[2]);
        return { sliderStart, sliderEnd, handlePos, axis: 'x' as const, axisLength, axisMin: minX, axisDir, startPoint };
      }
      case 'XZ':
      default: {
        // Slider along Y axis
        const sliderStart: [number, number, number] = [maxX + offset, minY, (minZ + maxZ) / 2];
        const sliderEnd: [number, number, number] = [maxX + offset, maxY, (minZ + maxZ) / 2];
        const axisLength = maxY - minY;
        const handlePos: [number, number, number] = [
          maxX + offset,
          minY + currentHeight * axisLength,
          (minZ + maxZ) / 2
        ];
        const axisDir = new THREE.Vector3(0, 1, 0);
        const startPoint = new THREE.Vector3(sliderStart[0], sliderStart[1], sliderStart[2]);
        return { sliderStart, sliderEnd, handlePos, axis: 'y' as const, axisLength, axisMin: minY, axisDir, startPoint };
      }
    }
  }, [plane, minX, minY, minZ, maxX, maxY, maxZ, currentHeight, isDragging, unit]);

  // Screen-constant sizes, matching FieldHandle; the caps are smaller than the handle.
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

  const currentColor = isDragging ? activeColor : isHovered ? '#555555' : color;

  // Create drag plane based on axis
  const createDragPlane = useCallback((point: ThreeTypes.Vector3) => {
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);

    let planeNormal: ThreeTypes.Vector3;

    switch (sliderConfig.axis) {
      case 'x':
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(0, 1, 0);
        }
        break;
      case 'y':
        planeNormal = new THREE.Vector3(0, 0, 1);
        if (Math.abs(cameraDirection.z) > 0.9) {
          planeNormal = new THREE.Vector3(1, 0, 0);
        }
        break;
      case 'z':
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

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    // Only the left button drags. Right and middle drags move the camera
    // (orbit, pan, fly); a press that starts on a handle must not also
    // resize the box, or an orbit across it rewrites the domain.
    if (e.button !== 0) return;
    e.stopPropagation();
    setIsDragging(true);
    setGizmoDragging(true);

    // Capture parent group's world position for coordinate transformation
    if (groupRef.current) {
      groupRef.current.getWorldPosition(parentWorldPosRef.current);
    }

    if (handleRef.current) {
      const worldPos = new THREE.Vector3();
      handleRef.current.getWorldPosition(worldPos);

      dragStartRef.current = {
        height,
        worldY: sliderConfig.axis === 'x' ? worldPos.x :
                sliderConfig.axis === 'y' ? worldPos.y : worldPos.z
      };

      planeRef.current = createDragPlane(worldPos);
    }

    document.body.style.cursor = 'ns-resize';
    gl.domElement.setPointerCapture(e.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!dragStartRef.current || !planeRef.current) return;

      const intersection = intersectPlane(moveEvent);
      if (!intersection) return;

      // Transform intersection from world to local coordinates by subtracting parent's world position
      const localIntersection = intersection.clone().sub(parentWorldPosRef.current);

      // Project the intersection onto the slider axis line to ignore perpendicular movement
      // Formula: projected = startPoint + axisDir * dot(localIntersection - startPoint, axisDir)
      const toIntersection = localIntersection.clone().sub(sliderConfig.startPoint);
      const projectedDistance = toIntersection.dot(sliderConfig.axisDir);

      // Convert projected distance to normalized height (0-1)
      let newHeight = projectedDistance / sliderConfig.axisLength;
      newHeight = Math.max(0, Math.min(1, newHeight));

      // Update ref for use in handlePointerUp (avoids stale closure)
      latestHeightRef.current = newHeight;

      // Update local state for immediate visual feedback
      setDragHeight(newHeight);
      onHeightChange(newHeight);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      setIsDragging(false);
      setGizmoDragging(false);
      dragStartRef.current = null;
      planeRef.current = null;
      document.body.style.cursor = '';

      gl.domElement.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      // Get final height value from ref (avoids stale closure issues)
      onHeightChangeEnd?.(latestHeightRef.current);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [height, sliderConfig, createDragPlane, intersectPlane, onHeightChange, onHeightChangeEnd, gl, setGizmoDragging]);

  const handlePointerEnter = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setIsHovered(true);
    if (!isDragging) {
      document.body.style.cursor = 'ns-resize';
    }
  }, [isDragging]);

  const handlePointerLeave = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setIsHovered(false);
    if (!isDragging) {
      document.body.style.cursor = '';
    }
  }, [isDragging]);

  // Calculate percentage label position
  const labelPosition = useMemo(() => {
    const pos = [...sliderConfig.handlePos] as [number, number, number];
    // Offset label to the side
    switch (sliderConfig.axis) {
      case 'x':
        pos[2] += 0.5 * unit;
        break;
      case 'y':
        pos[0] += 0.5 * unit;
        break;
      case 'z':
        pos[0] += 0.5 * unit;
        break;
    }
    return pos;
  }, [sliderConfig, unit]);

  return (
    <group ref={groupRef}>
      {/* Slider track line */}
      <Line
        points={[sliderConfig.sliderStart, sliderConfig.sliderEnd]}
        color={color}
        lineWidth={2}
        transparent
        opacity={0.8}
      />

      {/* End caps - using screen-space scaled spheres */}
      <mesh ref={startCapRef} position={sliderConfig.sliderStart}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} />
      </mesh>
      <mesh ref={endCapRef} position={sliderConfig.sliderEnd}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} />
      </mesh>

      {/* Draggable handle - box geometry oriented along slider axis.
          userData.isGizmo = true so eventOccludedByGizmo() blocks scene
          objects behind the handle from receiving hover / click events. */}
      <mesh
        ref={handleRef}
        position={sliderConfig.handlePos}
        userData={{ isGizmo: true }}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <boxGeometry args={
          sliderConfig.axis === 'x' ? [1, 0.4, 0.4] :
          sliderConfig.axis === 'y' ? [0.4, 1, 0.4] :
          [0.4, 0.4, 1]
        } />
        <meshBasicMaterial
          color={currentColor}
          transparent
          opacity={1.0}
          depthTest={false}
        />
      </mesh>

      {/* Height percentage label, LABEL_PX tall on screen like the handles */}
      <group ref={labelRef} position={labelPosition}>
        <Text
          fontSize={1}
          color={currentColor}
          anchorX="left"
          anchorY="middle"
        >
          {`${Math.round(currentHeight * 100)}%`}
        </Text>
      </group>
    </group>
  );
};

export default FieldHeightSlider;
