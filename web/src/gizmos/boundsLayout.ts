// Layout and drag math of the Field bounds gizmo (the Bounds tool, T).
// Pure arithmetic on number tuples: no host runtime, so tests load it directly.

export type Axis = 0 | 1 | 2;
export type Side = 'min' | 'max';
export type Vec3 = [number, number, number];

/**
 * One resize handle. `axes` are the local axes it moves along (one for an
 * edge or a face, two for a corner); `sides` says which bound each of those
 * axes writes.
 */
export interface BoundsHandleSpec {
  id: string;
  kind: 'corner' | 'edge' | 'face';
  position: Vec3;
  axes: Axis[];
  sides: Partial<Record<Axis, Side>>;
  /** Edge only: the drawn side of the rectangle, and the axis it runs along. */
  segment?: [Vec3, Vec3];
  edgeAxis?: Axis;
  /** Face only: on the far side of the box from the camera; drawn dimmed. */
  back?: boolean;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface DragModifiers {
  /** Ctrl/Cmd: sizes snap to whole cells. */
  snap: boolean;
  /** Alt: the opposite bound mirrors the move, so the centre stays put. */
  symmetric: boolean;
  /** Shift on a corner: both axes keep their ratio. */
  uniform: boolean;
}

export const NO_MODIFIERS: DragModifiers = { snap: false, symmetric: false, uniform: false };

/** Normal axis of a 2D Field's plane. */
export const PLANE_NORMAL: Record<string, Axis> = { XY: 2, XZ: 1, YZ: 0 };

/**
 * Hysteresis of the facing-axis pick: the handles move to another face only
 * when the camera looks down that axis this much more squarely than the
 * current one. Without it, a view near 45 degrees flips the handles every
 * frame. 1.15 is about 7 degrees past the diagonal.
 */
export const FACING_HYSTERESIS = 1.15;

/**
 * Local axis the camera looks down most squarely. `toCamera` is the vector
 * from the box centre to the camera in the box's local frame.
 */
export function pickFacingAxis(toCamera: Vec3, current: Axis | null, hysteresis = FACING_HYSTERESIS): Axis {
  const magnitude = toCamera.map(Math.abs) as Vec3;
  let best: Axis = 0;
  if (magnitude[1] > magnitude[best]) best = 1;
  if (magnitude[2] > magnitude[best]) best = 2;
  if (current === null || current === best) return best;
  return magnitude[best] > magnitude[current] * hysteresis ? best : current;
}

function otherAxes(normal: Axis): [Axis, Axis] {
  return normal === 0 ? [1, 2] : normal === 1 ? [0, 2] : [0, 1];
}

function boundValue(bounds: Bounds, axis: Axis, side: Side): number {
  return side === 'min' ? bounds.min[axis] : bounds.max[axis];
}

function point(entries: Array<[Axis, number]>): Vec3 {
  const p: Vec3 = [0, 0, 0];
  for (const [axis, value] of entries) p[axis] = value;
  return p;
}

/**
 * Handles in the style of a rect tool: four corners and four sides on the
 * face that looks at the camera (normal axis `normal`, on side `near`), plus,
 * with `withDepth`, one handle at the centre of the near and the far face for
 * the third axis. Ten handles in 3D, eight in 2D.
 */
export function buildBoundsHandles(bounds: Bounds, normal: Axis, near: Side, withDepth: boolean): BoundsHandleSpec[] {
  const [a, b] = otherAxes(normal);
  const sides: Side[] = ['min', 'max'];
  const nearValue = boundValue(bounds, normal, near);
  const mid = (axis: Axis) => (bounds.min[axis] + bounds.max[axis]) / 2;
  const handles: BoundsHandleSpec[] = [];

  for (const sa of sides) {
    for (const sb of sides) {
      handles.push({
        id: `corner-${sa}-${sb}`,
        kind: 'corner',
        position: point([[a, boundValue(bounds, a, sa)], [b, boundValue(bounds, b, sb)], [normal, nearValue]]),
        axes: [a, b],
        sides: { [a]: sa, [b]: sb },
      });
    }
  }

  // A side at a = sa runs along b and moves a; the same for b.
  for (const [moved, along] of [[a, b], [b, a]] as Array<[Axis, Axis]>) {
    for (const side of sides) {
      const value = boundValue(bounds, moved, side);
      const start = point([[moved, value], [along, bounds.min[along]], [normal, nearValue]]);
      const end = point([[moved, value], [along, bounds.max[along]], [normal, nearValue]]);
      handles.push({
        id: `edge-${moved}-${side}`,
        kind: 'edge',
        position: point([[moved, value], [along, mid(along)], [normal, nearValue]]),
        axes: [moved],
        sides: { [moved]: side },
        segment: [start, end],
        edgeAxis: along,
      });
    }
  }

  if (withDepth) {
    for (const side of sides) {
      handles.push({
        id: `face-${side}`,
        kind: 'face',
        position: point([[a, mid(a)], [b, mid(b)], [normal, boundValue(bounds, normal, side)]]),
        axes: [normal],
        sides: { [normal]: side },
        back: side !== near,
      });
    }
  }
  return handles;
}

function snapSize(size: number, step: number): number {
  return Math.max(step, Math.round(size / step) * step);
}

function largestExtent(bounds: Bounds): number {
  return Math.max(0, ...[0, 1, 2].map((i) => Math.abs(bounds.max[i] - bounds.min[i])));
}

/**
 * Snap step when the Field has no cell size: a tenth of the power of ten
 * below its largest side, so a 1.2 m box snaps to 0.1 m and an 8 µm box to
 * 0.1 µm.
 */
export function roundStep(bounds: Bounds): number {
  const extent = largestExtent(bounds);
  return extent > 0 ? 10 ** Math.floor(Math.log10(extent)) / 10 : 1;
}

/**
 * Smallest size a drag leaves when the Field has no cell size: 0.1 % of the
 * largest side, so a drag past the opposite bound cannot make a flat or
 * inverted box at any scale.
 */
export function minimumSize(bounds: Bounds): number {
  return largestExtent(bounds) * 1e-3;
}

/**
 * New bounds for `handle` dragged to `pointer` (local, the handle's own
 * position plus the pointer's movement), starting from `start`.
 *
 * `cell` is the Field's cell size, or null when it has none (a solver that
 * derives its grid elsewhere). With a cell every size stays at least one cell
 * and `snap` gives a whole number of cells; without one the floor is
 * `minimumSize` and `snap` uses `roundStep`.
 */
export function applyBoundsDrag(
  start: Bounds,
  handle: BoundsHandleSpec,
  pointer: Vec3,
  cell: number | null,
  mods: DragModifiers = NO_MODIFIERS,
): Bounds {
  const min = [...start.min] as Vec3;
  const max = [...start.max] as Vec3;
  const hasCell = cell !== null && cell > 0;
  const minSize = hasCell ? cell : minimumSize(start);
  const step = hasCell ? cell : roundStep(start);

  // Size each moved axis would get, signed so a drag past the opposite bound clamps.
  const sizes = new Map<Axis, number>();
  for (const axis of handle.axes) {
    const side = handle.sides[axis] ?? 'max';
    const startSize = start.max[axis] - start.min[axis];
    const centre = (start.min[axis] + start.max[axis]) / 2;
    const size = mods.symmetric
      ? 2 * (side === 'max' ? pointer[axis] - centre : centre - pointer[axis])
      : side === 'max' ? pointer[axis] - start.min[axis] : start.max[axis] - pointer[axis];
    sizes.set(axis, Number.isFinite(size) ? size : startSize);
  }

  if (mods.uniform && handle.axes.length === 2) {
    // The axis that changed more (relative to its start) sets the ratio for both.
    let ratio = 1;
    let change = -1;
    for (const axis of handle.axes) {
      const startSize = start.max[axis] - start.min[axis];
      if (startSize <= 0) continue;
      const r = (sizes.get(axis) ?? startSize) / startSize;
      if (Math.abs(r - 1) > change) {
        change = Math.abs(r - 1);
        ratio = r;
      }
    }
    for (const axis of handle.axes) sizes.set(axis, (start.max[axis] - start.min[axis]) * ratio);
  }

  for (const axis of handle.axes) {
    const side = handle.sides[axis] ?? 'max';
    let size = Math.max(sizes.get(axis) ?? 0, minSize);
    if (mods.snap && step > 0) size = snapSize(size, step);
    if (mods.symmetric) {
      const centre = (start.min[axis] + start.max[axis]) / 2;
      min[axis] = centre - size / 2;
      max[axis] = centre + size / 2;
    } else if (side === 'max') {
      max[axis] = start.min[axis] + size;
    } else {
      min[axis] = start.max[axis] - size;
    }
  }
  return { min, max };
}

/** Number of cells along each axis, rounded; at least 1. */
export function cellCounts(bounds: Bounds, cell: number): Vec3 {
  return [0, 1, 2].map((i) =>
    cell > 0 ? Math.max(1, Math.round((bounds.max[i] - bounds.min[i]) / cell)) : 0,
  ) as Vec3;
}

const LENGTH_UNITS: Array<[number, string]> = [
  [1, 'm'],
  [1e-3, 'mm'],
  [1e-6, 'µm'],
  [1e-9, 'nm'],
];

/** A length in metres with an SI prefix and three significant digits, e.g. "12.5 mm". */
export function formatLength(metres: number): string {
  const magnitude = Math.abs(metres);
  const [scale, unit] = LENGTH_UNITS.find(([s]) => magnitude >= s * 0.9995) ?? LENGTH_UNITS[LENGTH_UNITS.length - 1];
  return `${Number((metres / scale).toPrecision(3))} ${unit}`;
}
