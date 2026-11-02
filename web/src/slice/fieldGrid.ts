/**
 * A field on the CPU, for the 2D slice panel: the same data the viewport
 * samples on the GPU, as Float32Arrays.
 *
 * Storage is x fastest, index = i + nx (j + ny k): the layout the publisher
 * writes for WebGL 3D textures (zyx_for_webgl3d). Coordinates are metres,
 * from axis_coords for a non-uniform grid, else spread evenly over the
 * component's bounds.
 */
export interface FieldGrid {
  coords: [Float64Array, Float64Array, Float64Array];
  re: Float32Array;
  /** Imaginary part of a complex field, else null. */
  im: Float32Array | null;
}

/** Slice plane names as the Field component uses them, with the normal axis. */
export type SlicePlane = 'XY' | 'XZ' | 'YZ';
const NORMAL: Record<SlicePlane, number> = { XY: 2, XZ: 1, YZ: 0 };

export function gridCoords(
  resolution: number[],
  minBound: number[],
  maxBound: number[],
  axisCoords: number[][] | null,
): [Float64Array, Float64Array, Float64Array] {
  return [0, 1, 2].map((a) => {
    const given = axisCoords?.[a];
    if (given && given.length === resolution[a]) return Float64Array.from(given);
    const n = Math.max(1, resolution[a]);
    return Float64Array.from({ length: n }, (_, i) => (n === 1 ? (minBound[a] + maxBound[a]) / 2 : minBound[a] + ((maxBound[a] - minBound[a]) * i) / (n - 1)));
  }) as [Float64Array, Float64Array, Float64Array];
}

/** Fractional cell position of v on a sorted axis: lower index and weight, clamped to the ends. */
export function locate(axis: ArrayLike<number>, v: number): [number, number] {
  const n = axis.length;
  if (n < 2 || v <= axis[0]) return [0, 0];
  if (v >= axis[n - 1]) return [n - 2, 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= v) lo = mid;
    else hi = mid;
  }
  return [lo, (v - axis[lo]) / (axis[hi] - axis[lo])];
}

export interface Slice2DData {
  /** World axis index (0 x, 1 y, 2 z) of the plot's horizontal and vertical axes, and the normal. */
  uAxis: number;
  vAxis: number;
  normal: number;
  /** World position of the plane along the normal, metres. */
  position: number;
  u: Float64Array;
  v: Float64Array;
  /** nu x nv, u fastest. */
  re: Float32Array;
  im: Float32Array | null;
}

/**
 * The field on plane `plane` at `t` (0..1 across the grid along the normal),
 * linearly interpolated between the two nearest grid planes.
 */
export function sliceGrid(field: FieldGrid, plane: SlicePlane, t: number): Slice2DData {
  const a = NORMAL[plane];
  const [ua, va] = [0, 1, 2].filter((d) => d !== a) as [number, number];
  const n = field.coords.map((c) => c.length);
  const axis = field.coords[a];
  const position = axis[0] + Math.min(1, Math.max(0, t)) * (axis[axis.length - 1] - axis[0]);
  const [k0, w] = locate(axis, position);
  const k1 = Math.min(k0 + 1, n[a] - 1);
  const nu = n[ua];
  const nv = n[va];
  const stride = [1, n[0], n[0] * n[1]];
  const re = new Float32Array(nu * nv);
  const im = field.im ? new Float32Array(nu * nv) : null;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const base = i * stride[ua] + j * stride[va];
      const i0 = base + k0 * stride[a];
      const i1 = base + k1 * stride[a];
      const o = i + nu * j;
      re[o] = field.re[i0] * (1 - w) + field.re[i1] * w;
      if (im && field.im) im[o] = field.im[i0] * (1 - w) + field.im[i1] * w;
    }
  }
  return { uAxis: ua, vAxis: va, normal: a, position, u: field.coords[ua], v: field.coords[va], re, im };
}

// ---------- ticks and units (same rules as the viewport ruler) ----------

/** Smallest step from {1, 2, 5} x 10^n that is at least `minStep`. */
export function niceStep(minStep: number): number {
  const m = Math.max(minStep, 1e-15);
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 2, 5, 10]) if (p * f >= m * (1 - 1e-9)) return p * f;
  return p * 10;
}

/** Decimal places that show a step without trailing noise (0.05 -> 2). */
export function stepDecimals(step: number): number {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

export function ticksIn(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-6);
  const last = Math.floor(hi / step + 1e-6);
  for (let k = first; k <= last; k++) out.push(k * step);
  return out;
}

export function formatTick(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

const UNITS: Array<[number, string]> = [
  [1, 'm'],
  [1e-3, 'mm'],
  [1e-6, 'µm'],
  [1e-9, 'nm'],
];

/** [metres per unit, unit name] for lengths about `scale` metres: the largest unit that keeps it >= 1. */
export function lengthUnit(scale: number): [number, string] {
  for (const unit of UNITS) if (Math.abs(scale) >= unit[0]) return unit;
  return UNITS[UNITS.length - 1];
}
