// Layout and drag math of the Field bounds gizmo (the Bounds tool, T).
// Pure arithmetic on number tuples: no host runtime, so tests load it directly.

export type Axis = 0 | 1 | 2;
export type Side = 'min' | 'max';
export type Vec3 = [number, number, number];

/**
 * One handle of the rect. `axes` are the local axes it moves along (one for
 * an edge, two for a corner or the centre disc); `sides` says which bound
 * each of those axes writes. The centre disc (`move`) writes no single bound:
 * it shifts the whole box.
 */
export interface BoundsHandleSpec {
  id: string;
  kind: 'corner' | 'edge' | 'move';
  position: Vec3;
  axes: Axis[];
  sides: Partial<Record<Axis, Side>>;
  /** Normal axis of the rect plane the handle lies in. */
  normal: Axis;
  /** Edge only: the drawn side of the rectangle, and the axis it runs along. */
  segment?: [Vec3, Vec3];
  edgeAxis?: Axis;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface DragModifiers {
  /** Ctrl/Cmd: sizes, or the centre disc's move, snap to whole cells. */
  snap: boolean;
  /** Alt: the opposite bound mirrors the move, so the centre stays put. */
  symmetric: boolean;
  /** Shift: a corner keeps its aspect ratio; the centre disc moves along one axis only. */
  uniform: boolean;
}

export const NO_MODIFIERS: DragModifiers = { snap: false, symmetric: false, uniform: false };

/** Normal axis of a 2D Field's plane. */
export const PLANE_NORMAL: Record<string, Axis> = { XY: 2, XZ: 1, YZ: 0 };

/**
 * Hysteresis of the rect-plane pick: the rect moves to another plane only
 * when that plane's on-screen area beats the current one's by this factor.
 * Without it, a view near 45 degrees flips the rect every frame. Unity has
 * none, but its handles redraw only on repaint; ours redraw every frame.
 */
export const RECT_AXIS_HYSTERESIS = 1.15;

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

function cross(u: Vec3, v: Vec3): Vec3 {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

function projectOnPlane(v: Vec3, unitNormal: Vec3): Vec3 {
  const d = v[0] * unitNormal[0] + v[1] * unitNormal[1] + v[2] * unitNormal[2];
  return [v[0] - d * unitNormal[0], v[1] - d * unitNormal[1], v[2] - d * unitNormal[2]];
}

/**
 * Normal axis of the rect plane, chosen as Unity's Rect tool does
 * (UnityCsReference `Tools.GetRectAxisForViewDir`): for each local axis,
 * take the box's two other sides as world vectors, project them onto the
 * screen plane (perpendicular to `viewDir`) and measure the area they span.
 * The plane with the largest on-screen area wins.
 *
 * `edges[i]` is local axis i in world space, multiplied by the box size
 * along it, so rotation, object scale and box proportions all count.
 * `viewDir` is the camera's forward direction, unit length.
 */
export function pickRectAxis(edges: [Vec3, Vec3, Vec3], viewDir: Vec3, current: Axis | null, hysteresis = RECT_AXIS_HYSTERESIS): Axis {
  const score = (normal: Axis): number => {
    const [a, b] = otherAxes(normal);
    const c = cross(projectOnPlane(edges[a], viewDir), projectOnPlane(edges[b], viewDir));
    return Math.hypot(c[0], c[1], c[2]);
  };
  const scores = [score(0), score(1), score(2)];
  let best: Axis = 0;
  if (scores[1] > scores[best]) best = 1;
  if (scores[2] > scores[best]) best = 2;
  if (current === null || current === best) return best;
  return scores[best] > scores[current] * hysteresis ? best : current;
}

/**
 * Handles of Unity's Rect tool on a 3D box: a rectangle on the box's centre
 * slice perpendicular to `normal` (not on a face), with four corners, four
 * sides and a centre disc that moves the box within that plane. Nine handles.
 * A 2D Field passes its own plane's normal.
 */
export function buildBoundsHandles(bounds: Bounds, normal: Axis): BoundsHandleSpec[] {
  const [a, b] = otherAxes(normal);
  const sides: Side[] = ['min', 'max'];
  const mid = (axis: Axis) => (bounds.min[axis] + bounds.max[axis]) / 2;
  const slice = mid(normal);
  const handles: BoundsHandleSpec[] = [];

  for (const sa of sides) {
    for (const sb of sides) {
      handles.push({
        id: `corner-${sa}-${sb}`,
        kind: 'corner',
        position: point([[a, boundValue(bounds, a, sa)], [b, boundValue(bounds, b, sb)], [normal, slice]]),
        axes: [a, b],
        sides: { [a]: sa, [b]: sb },
        normal,
      });
    }
  }

  // A side at a = sa runs along b and moves a; the same for b.
  for (const [moved, along] of [[a, b], [b, a]] as Array<[Axis, Axis]>) {
    for (const side of sides) {
      const value = boundValue(bounds, moved, side);
      const start = point([[moved, value], [along, bounds.min[along]], [normal, slice]]);
      const end = point([[moved, value], [along, bounds.max[along]], [normal, slice]]);
      handles.push({
        id: `edge-${moved}-${side}`,
        kind: 'edge',
        position: point([[moved, value], [along, mid(along)], [normal, slice]]),
        axes: [moved],
        sides: { [moved]: side },
        normal,
        segment: [start, end],
        edgeAxis: along,
      });
    }
  }

  handles.push({
    id: 'move',
    kind: 'move',
    position: point([[a, mid(a)], [b, mid(b)], [normal, slice]]),
    axes: [a, b],
    sides: {},
    normal,
  });
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

/**
 * Bounds after the centre disc is dragged from `handle.position` to
 * `pointer` (local): the box shifts along the rect's two axes. With
 * `uniform` (Shift) only the axis that moved more is kept, as in Unity's
 * Rect tool; with `snap` (Ctrl) each shift is a whole number of cells, else
 * of `roundStep`.
 */
export function applyBoundsMove(
  start: Bounds,
  handle: BoundsHandleSpec,
  pointer: Vec3,
  cell: number | null,
  mods: DragModifiers = NO_MODIFIERS,
): Bounds {
  const min = [...start.min] as Vec3;
  const max = [...start.max] as Vec3;
  const step = cell !== null && cell > 0 ? cell : roundStep(start);
  const delta = new Map<Axis, number>();
  for (const axis of handle.axes) {
    const d = pointer[axis] - handle.position[axis];
    delta.set(axis, Number.isFinite(d) ? d : 0);
  }
  if (mods.uniform && handle.axes.length === 2) {
    const [p, q] = handle.axes;
    if (Math.abs(delta.get(p) ?? 0) >= Math.abs(delta.get(q) ?? 0)) delta.set(q, 0);
    else delta.set(p, 0);
  }
  for (const axis of handle.axes) {
    let d = delta.get(axis) ?? 0;
    if (mods.snap && step > 0) d = Math.round(d / step) * step;
    min[axis] += d;
    max[axis] += d;
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
