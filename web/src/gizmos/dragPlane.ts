import type * as ThreeTypes from 'three';

// Pure vector math on the caller's three objects, so it needs no host runtime.

/**
 * Normal of the plane a handle drags on when it moves along one axis: the
 * plane holds the axis and faces the camera as squarely as the axis allows,
 * i.e. the view direction with its along-axis part removed.
 *
 * A fixed plane per axis (the old choice) fails when the camera looks along
 * it: the pointer ray grazes the plane, and a move of a few pixels lands the
 * hit point far away. From a top view an x handle on the z plane stretched a
 * 8 um domain to 0.5 m in one step.
 *
 * `axis` and `viewDir` are unit vectors in world space. Looking straight
 * down the axis leaves no good plane; any plane holding the axis is returned.
 */
export function axisDragPlaneNormal(axis: ThreeTypes.Vector3, viewDir: ThreeTypes.Vector3): ThreeTypes.Vector3 {
  const normal = viewDir.clone().addScaledVector(axis, -viewDir.dot(axis));
  if (normal.lengthSq() > 1e-8) return normal.normalize();
  const helper = Math.abs(axis.x) < 0.9 ? axis.clone().set(1, 0, 0) : axis.clone().set(0, 1, 0);
  return helper.cross(axis).normalize();
}

/** Below this |cos| between the pointer ray and the plane normal, the hit is too far off to use. */
const MIN_RAY_PLANE_COS = 1e-3;

/**
 * Where the pointer ray meets `plane`, or null when it misses or grazes it.
 * Ray.intersectPlane leaves its target untouched on a miss, so callers that
 * used the target anyway snapped the handle to the origin.
 */
export function intersectDragPlane(ray: ThreeTypes.Ray, plane: ThreeTypes.Plane): ThreeTypes.Vector3 | null {
  if (Math.abs(plane.normal.dot(ray.direction)) < MIN_RAY_PLANE_COS) return null;
  return ray.intersectPlane(plane, ray.origin.clone());
}
