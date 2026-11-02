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

/**
 * World length that gizmo offsets and labels are written in: 1 m for fields
 * of 2 m and up (the size they were tuned for), shrinking with smaller
 * fields so a micrometre field keeps its slider and label next to it
 * instead of a metre away.
 */
export function fieldGizmoUnit(minBound: number[], maxBound: number[]): number {
  const largest = Math.max(0, ...[0, 1, 2].map((i) => Math.abs((maxBound[i] ?? 0) - (minBound[i] ?? 0))));
  return largest > EPSILON * EPSILON ? Math.min(1, largest / 2) : 1;
}

/**
 * World units per local unit of `object`'s parent: the smallest axis of its
 * world scale. Studio draws small Bench scenes under a scaled root (1 m of
 * scene = 10^k world units), so a gizmo's local size is not its world size.
 */
export function parentWorldScale(object: ThreeTypes.Object3D): number {
  const s = new THREE.Vector3(1, 1, 1);
  object.parent?.getWorldScale(s);
  return Math.max(Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)), 1e-12);
}

/**
 * Scale that keeps gizmo geometry a fixed size on screen: one geometry unit
 * becomes `pxPerUnit` pixels. Scaling by camera distance instead breaks in an
 * orthographic view, where zoom (not distance) sets the on-screen size; a
 * micrometre field then got centimetre handles that covered the viewport.
 * The default of 2 px keeps the old perspective look (fov 50, ~900 px tall).
 * Returned as a local scale, so it divides by the parent's world scale.
 */
export function screenConstantScale(
  camera: ThreeTypes.Camera,
  object: ThreeTypes.Object3D,
  viewportHeightPx: number,
  pxPerUnit = 2,
): number {
  const worldPoint = object.getWorldPosition(new THREE.Vector3());
  return (getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) * pxPerUnit) / parentWorldScale(object);
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
  /** World units per unit of minBound/maxBound and of the returned radius. */
  worldScale?: number;
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
  worldScale = 1,
}: FieldEdgeHitRadiusOptions): number {
  // In the field's own units (metres), like the bounds and the radius limits.
  const screenRadius = (getWorldUnitsPerScreenPixel(camera, worldPoint, viewportHeightPx) * targetHitWidthPx) / 2 / worldScale;
  const shortestExtent = getShortestPositiveFieldExtent(minBound, maxBound);
  const fieldRadiusCap = shortestExtent > EPSILON ? shortestExtent * fieldFraction : maxRadius;

  // minRadius suits metre-scale boxes; it must not make the edge of a
  // micrometre box centimetres thick, so the field cap wins below it.
  return clamp(Math.min(screenRadius, fieldRadiusCap), Math.min(minRadius, fieldRadiusCap), maxRadius);
}
