import type * as ThreeTypes from 'three';
import { THREE } from '../runtime';

export const FIELD_EDGE_HIT_WIDTH_PX = 8;
export const FIELD_EDGE_HIT_MIN_RADIUS = 0.01;
export const FIELD_EDGE_HIT_MAX_RADIUS = 0.08;
export const FIELD_EDGE_HIT_FIELD_FRACTION = 0.02;

const EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getShortestPositiveFieldExtent(minBound: number[], maxBound: number[]): number {
  const extents = [0, 1, 2]
    .map((i) => Math.abs((maxBound[i] ?? 0) - (minBound[i] ?? 0)))
    .filter((extent) => extent > EPSILON);
  return extents.length > 0 ? Math.min(...extents) : 0;
}

export function getWorldUnitsPerScreenPixel(
  camera: ThreeTypes.Camera,
  worldPoint: ThreeTypes.Vector3,
  viewportHeightPx: number,
): number {
  if (viewportHeightPx <= 0) return 0;

  if ((camera as ThreeTypes.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as ThreeTypes.OrthographicCamera;
    return Math.abs(ortho.top - ortho.bottom) / Math.max(ortho.zoom, EPSILON) / viewportHeightPx;
  }

  if ((camera as ThreeTypes.PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as ThreeTypes.PerspectiveCamera;
    const cameraWorldPosition = new THREE.Vector3();
    perspective.getWorldPosition(cameraWorldPosition);
    const distance = Math.max(cameraWorldPosition.distanceTo(worldPoint), EPSILON);
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) * distance;
    return visibleHeight / viewportHeightPx;
  }

  return 0;
}

export interface FieldEdgeHitRadiusOptions {
  camera: ThreeTypes.Camera;
  worldPoint: ThreeTypes.Vector3;
  viewportHeightPx: number;
  minBound: number[];
  maxBound: number[];
  targetHitWidthPx?: number;
  minRadius?: number;
  maxRadius?: number;
  fieldFraction?: number;
}

export function calculateFieldEdgeHitRadius({
  camera,
  worldPoint,
  viewportHeightPx,
  minBound,
  maxBound,
  targetHitWidthPx = FIELD_EDGE_HIT_WIDTH_PX,
  minRadius = FIELD_EDGE_HIT_MIN_RADIUS,
  maxRadius = FIELD_EDGE_HIT_MAX_RADIUS,
  fieldFraction = FIELD_EDGE_HIT_FIELD_FRACTION,
}: FieldEdgeHitRadiusOptions): number {
  const screenRadius = getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) * targetHitWidthPx / 2;
  const shortestExtent = getShortestPositiveFieldExtent(minBound, maxBound);
  const fieldRadiusCap = shortestExtent > EPSILON ? shortestExtent * fieldFraction : maxRadius;

  return clamp(Math.min(screenRadius, fieldRadiusCap), minRadius, maxRadius);
}
