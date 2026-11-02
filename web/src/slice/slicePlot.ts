import { formatLegendValue, legendDataValue, legendTicks, type FieldLegendSpec } from '../field/fieldLegend';
import { getColormapFunc } from '../shaders/volumeShaders';
import { formatTick, lengthUnit, locate, niceStep, stepDecimals, ticksIn, type Slice2DData } from './fieldGrid';

/*
 * 2D plot of one field slice on a Canvas2D: heatmap, structure outlines,
 * axes in length units and a colour bar. Ported from @instamax/field-viewer.
 *
 * Interpolation is split by cost. When the view moves, every screen pixel is
 * resolved to (Re, Im) once (slow: binary search on non-uniform axes plus
 * bilinear weights). When only the phase moves, each pixel is one cos/sin
 * combination and a table lookup, cheap enough for 60 fps.
 *
 * The view keeps one scale (metres per CSS pixel) for both axes, so circles
 * stay round. Scroll zooms at the cursor, drag pans, Shift-drag zooms to a
 * box, double-click fits.
 */

const M = { left: 58, right: 100, top: 12, bottom: 42 }; // plot margins, CSS px; the right one holds the colour bar
const TARGET_PX = 80; // aim for a labelled tick about this far apart
const AXIS = 'xyz';

// Outlines must contrast with the heatmap, not the page: dark over the light
// middle of a diverging map, light over the dark low end of a sequential one.
const OUTLINE_ON_LIGHT = 'rgba(29, 29, 33, 0.75)'; /* allow-color: outline over data-viz heatmap */
const OUTLINE_ON_DARK = 'rgba(250, 250, 250, 0.6)'; /* allow-color: outline over data-viz heatmap */
const DIVERGING = new Set(['rdbu', 'coolwarm', 'bwr']);

export interface SlicePlotParams {
  slice: Slice2DData;
  /** 'value' is Re(E e^{-i phase}) for a complex field; 'magnitude' is |E|. */
  quantity: string;
  colormap: string;
  showGrid: boolean;
  /** Colour bar, value mapping and readout; valueMin/valueMax are the normalised display range. */
  legend: FieldLegendSpec;
  /** Structure outlines in (u, v) metres: [u0, v0, u1, v1, ...]. */
  outlines: Float32Array;
}

/** Cursor readout: position in the plane (metres) and the data value there. */
export type SliceHover = { u: number; v: number; value: string; uLabel: string; vLabel: string } | null;

interface Colors {
  background: [number, number, number];
  backgroundCss: string;
  ink: string;
  ink2: string;
  line: string;
  accent: string;
  font: string;
}

/** Theme colours resolved to rgb() strings: canvas cannot read CSS variables. */
function readColors(el: HTMLElement): Colors {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  el.appendChild(probe);
  const resolve = (token: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${token}, ${fallback})`;
    return getComputedStyle(probe).color;
  };
  const bg = resolve('--gray-2', 'black');
  const colors: Colors = {
    backgroundCss: bg,
    background: (bg.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number) as [number, number, number],
    ink: resolve('--text-primary', 'white'),
    ink2: resolve('--text-secondary', 'gray'),
    line: resolve('--border-strong', 'gray'),
    accent: resolve('--accent', 'blue'),
    font: getComputedStyle(el).getPropertyValue('--font-family').trim() || 'sans-serif',
  };
  probe.remove();
  return colors;
}

function colormapLut(name: string): Uint8ClampedArray {
  const colour = getColormapFunc(name);
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = colour(i / 255);
    lut.set([r * 255, g * 255, b * 255, 255], i * 4);
  }
  return lut;
}

/** Normalised value -> 0..255 colormap index, the same mapping as the viewport's fieldNormalize. */
function lutIndex(v: number, vmin: number, vmax: number, logScale: boolean): number {
  let n = (Math.min(v, vmax) - vmin) / (vmax - vmin + 1e-4);
  n = Math.min(1, Math.max(0, n));
  if (logScale) n = Math.log10(1 + 9 * n);
  return Math.round(n * 255);
}

export class SlicePlot {
  private params: SlicePlotParams | null = null;
  // View: centre in metres and metres per CSS pixel.
  private cu = 0;
  private cv = 0;
  private mpp = 1e-3;
  private fitted = false;
  private pixRe = new Float32Array(0);
  private pixIm = new Float32Array(0);
  private inside = new Uint8Array(0);
  private image: ImageData | null = null;
  private lut = colormapLut('inferno');
  private readonly buffer = document.createElement('canvas');
  private phase = 0;
  private drag: { x: number; y: number; cu: number; cv: number } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private colors: Colors;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (h: SliceHover) => void = () => {},
  ) {
    this.colors = readColors(canvas);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('dblclick', this.onDoubleClick);
  }

  private onLeave = () => this.onHover(null);

  private onDoubleClick = () => {
    this.fitted = false;
    this.resample();
  };

  private get plot() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return { x: M.left, y: M.top, w: Math.max(1, w - M.left - M.right), h: Math.max(1, h - M.top - M.bottom) };
  }

  /** New data. Refits the view when the slice moved to another plane or field. */
  set(p: SlicePlotParams, refit: boolean): void {
    const prev = this.params;
    this.params = p;
    if (refit || !prev) this.fitted = false;
    if (!prev || prev.colormap !== p.colormap) this.lut = colormapLut(p.colormap);
    if (!prev || prev.slice !== p.slice || refit) this.resample();
    else this.draw();
  }

  setPhase(phase: number): void {
    this.phase = phase;
    this.draw();
  }

  /** Call when the canvas's CSS size or the theme changes. */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.colors = readColors(this.canvas);
    this.resample();
  }

  private fit(): void {
    const { u, v } = this.params!.slice;
    const { w, h } = this.plot;
    const [u0, u1, v0, v1] = [u[0], u[u.length - 1], v[0], v[v.length - 1]];
    this.cu = (u0 + u1) / 2;
    this.cv = (v0 + v1) / 2;
    this.mpp = Math.max((u1 - u0) / w, (v1 - v0) / h, 1e-12) * 1.04;
    this.fitted = true;
  }

  // Screen <-> world for the plot area.
  private toU(px: number) {
    const { x, w } = this.plot;
    return this.cu + (px - x - w / 2) * this.mpp;
  }
  private toV(py: number) {
    const { y, h } = this.plot;
    return this.cv - (py - y - h / 2) * this.mpp;
  }
  private sx(u: number) {
    const { x, w } = this.plot;
    return x + w / 2 + (u - this.cu) / this.mpp;
  }
  private sy(v: number) {
    const { y, h } = this.plot;
    return y + h / 2 - (v - this.cv) / this.mpp;
  }

  /** Resolves every plot pixel to (Re, Im). Run when the view or slice changes. */
  private resample(): void {
    if (!this.params) return;
    if (!this.fitted) this.fit();
    const { w, h } = this.plot;
    const W = Math.round(w);
    const H = Math.round(h);
    const { u, v, re, im } = this.params.slice;
    const nu = u.length;
    const cols = Array.from({ length: W }, (_, i) => this.toU(M.left + i + 0.5));
    const rows = Array.from({ length: H }, (_, j) => this.toV(M.top + j + 0.5));
    const cu = cols.map((x) => locate(u, x));
    const rv = rows.map((y) => locate(v, y));
    const [u0, u1, v0, v1] = [u[0], u[nu - 1], v[0], v[v.length - 1]];
    // A grid one cell thick along u or v has no neighbour to blend with.
    const du = nu > 1 ? 1 : 0;
    const dv = v.length > 1 ? nu : 0;
    this.pixRe = new Float32Array(W * H);
    this.pixIm = new Float32Array(W * H);
    this.inside = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      if (rows[j] < v0 || rows[j] > v1) continue;
      const [jv, tv] = rv[j];
      for (let i = 0; i < W; i++) {
        if (cols[i] < u0 || cols[i] > u1) continue;
        const [iu, tu] = cu[i];
        const a = iu + nu * jv;
        const o = i + W * j;
        const w00 = (1 - tu) * (1 - tv);
        const w10 = tu * (1 - tv);
        const w01 = (1 - tu) * tv;
        const w11 = tu * tv;
        this.pixRe[o] = re[a] * w00 + re[a + du] * w10 + re[a + dv] * w01 + re[a + du + dv] * w11;
        if (im) this.pixIm[o] = im[a] * w00 + im[a + du] * w10 + im[a + dv] * w01 + im[a + du + dv] * w11;
        this.inside[o] = 1;
      }
    }
    this.buffer.width = W;
    this.buffer.height = H;
    this.image = new ImageData(W, H);
    this.draw();
  }

  /** Displayed (normalised) value at a resolved pixel. */
  private valueAt(o: number): number {
    const re = this.pixRe[o];
    const im = this.pixIm[o];
    const p = this.params!;
    if (p.quantity === 'magnitude') return p.slice.im ? Math.hypot(re, im) : Math.abs(re);
    return p.slice.im ? re * Math.cos(this.phase) + im * Math.sin(this.phase) : re;
  }

  private paintHeatmap(): void {
    const { legend } = this.params!;
    const d = this.image!.data;
    const lut = this.lut;
    const bg = this.colors.background;
    for (let o = 0; o < this.inside.length; o++) {
      const k = o * 4;
      if (!this.inside[o]) {
        d[k] = bg[0];
        d[k + 1] = bg[1];
        d[k + 2] = bg[2];
        d[k + 3] = 255;
        continue;
      }
      const t = lutIndex(this.valueAt(o), legend.valueMin, legend.valueMax, legend.logScale) * 4;
      d[k] = lut[t];
      d[k + 1] = lut[t + 1];
      d[k + 2] = lut[t + 2];
      d[k + 3] = 255;
    }
    this.buffer.getContext('2d')!.putImageData(this.image!, 0, 0);
  }

  draw(): void {
    if (!this.params || !this.image) return;
    const ctx = this.canvas.getContext('2d')!;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.colors.backgroundCss;
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    const plot = this.plot;
    this.paintHeatmap();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buffer, plot.x, plot.y, Math.round(plot.w), Math.round(plot.h));

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (this.params.showGrid) this.drawGrid(ctx);
    this.drawOutlines(ctx);
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box;
      ctx.strokeStyle = this.colors.accent;
      ctx.fillStyle = this.colors.accent;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.globalAlpha = 1;
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();

    this.drawAxes(ctx);
    this.drawColorbar(ctx);
  }

  private drawOutlines(ctx: CanvasRenderingContext2D): void {
    const seg = this.params!.outlines;
    if (!seg.length) return;
    ctx.strokeStyle = DIVERGING.has(this.params!.colormap) ? OUTLINE_ON_LIGHT : OUTLINE_ON_DARK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k + 3 < seg.length; k += 4) {
      ctx.moveTo(this.sx(seg[k]), this.sy(seg[k + 1]));
      ctx.lineTo(this.sx(seg[k + 2]), this.sy(seg[k + 3]));
    }
    ctx.stroke();
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const { u, v } = this.params!.slice;
    // Skip the grid once lines would be closer than 3 px; it would read as a fill.
    if (minSpacing(u) / this.mpp < 3 && minSpacing(v) / this.mpp < 3) return;
    ctx.strokeStyle = this.colors.line;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of u) {
      const X = Math.round(this.sx(x)) + 0.5;
      ctx.moveTo(X, this.sy(v[0]));
      ctx.lineTo(X, this.sy(v[v.length - 1]));
    }
    for (const y of v) {
      const Y = Math.round(this.sy(y)) + 0.5;
      ctx.moveTo(this.sx(u[0]), Y);
      ctx.lineTo(this.sx(u[u.length - 1]), Y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawAxes(ctx: CanvasRenderingContext2D): void {
    const plot = this.plot;
    const { uAxis, vAxis, u, v } = this.params!.slice;
    const x0 = plot.x;
    const y1 = plot.y + plot.h;
    // One unit for both axes, chosen from the slice's larger side.
    const [unit, unitName] = lengthUnit(Math.max(u[u.length - 1] - u[0], v[v.length - 1] - v[0]));

    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
    ctx.font = `11px ${this.colors.font}`;
    ctx.fillStyle = this.colors.ink2;

    const major = niceStep((TARGET_PX * this.mpp) / unit) * unit;
    const dec = stepDecimals(major / unit);
    const axis = (lo: number, hi: number, at: (t: number) => number, tick: (p: number, len: number) => void, label: (t: string, p: number) => void) => {
      ctx.beginPath();
      // Minor ticks every fifth of a step, 3 px; major ticks 6 px.
      for (const t of ticksIn(lo, hi, major / 5)) tick(Math.round(at(t)) + 0.5, Math.abs(t / major - Math.round(t / major)) < 1e-6 ? 6 : 3);
      ctx.stroke();
      for (const t of ticksIn(lo, hi, major)) label(formatTick(t / unit, dec), at(t));
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    axis(
      this.toU(plot.x),
      this.toU(plot.x + plot.w),
      (t) => this.sx(t),
      (X, len) => {
        ctx.moveTo(X, y1);
        ctx.lineTo(X, y1 + len);
      },
      (s, X) => ctx.fillText(s, X, y1 + 8),
    );
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    axis(
      this.toV(plot.y + plot.h),
      this.toV(plot.y),
      (t) => this.sy(t),
      (Y, len) => {
        ctx.moveTo(x0, Y);
        ctx.lineTo(x0 - len, Y);
      },
      (s, Y) => ctx.fillText(s, x0 - 8, Y),
    );

    ctx.fillStyle = this.colors.ink;
    ctx.font = `500 12px ${this.colors.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${AXIS[uAxis]} (${unitName})`, plot.x + plot.w / 2, this.canvas.clientHeight - 4);
    ctx.save();
    ctx.translate(14, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(`${AXIS[vAxis]} (${unitName})`, 0, 0);
    ctx.restore();
  }

  private drawColorbar(ctx: CanvasRenderingContext2D): void {
    const { legend } = this.params!;
    const plot = this.plot;
    const x = plot.x + plot.w + 18;
    const h = Math.min(plot.h, 320);
    const y = plot.y + (plot.h - h) / 2;
    const colour = getColormapFunc(legend.colormap);
    for (let j = 0; j < h; j++) {
      let t = 1 - j / Math.max(1, h - 1);
      // Same spacing as the viewport legend, so both bars read alike.
      if (legend.logScale) t = Math.log10(1 + 9 * t);
      const [r, g, b] = colour(t);
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fillRect(x, y + j, 12, 1);
    }
    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, 11, h - 1);
    ctx.fillStyle = this.colors.ink2;
    ctx.font = `11px ${this.colors.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const [at, text] of legendTicks(legend)) ctx.fillText(text, x + 17, y + (1 - at) * (h - 1));
    ctx.save();
    ctx.translate(x + 66, y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.colors.ink;
    ctx.font = `500 12px ${this.colors.font}`;
    ctx.fillText(legend.title, 0, 0);
    ctx.restore();
  }

  /** The current canvas pixels, for PNG export. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /** One optical period as `count` frames, scaled to at most `maxWidth` px, for GIF export. */
  captureFrames(count: number, maxWidth: number): ImageData[] {
    const phase0 = this.phase;
    const scale = Math.min(1, maxWidth / this.canvas.width);
    const c = document.createElement('canvas');
    c.width = Math.round(this.canvas.width * scale);
    c.height = Math.round(this.canvas.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const frames: ImageData[] = [];
    for (let k = 0; k < count; k++) {
      this.setPhase(phase0 + (2 * Math.PI * k) / count);
      ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
      frames.push(ctx.getImageData(0, 0, c.width, c.height));
    }
    this.setPhase(phase0);
    return frames;
  }

  // ---------- interaction ----------

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const u = this.toU(px);
    const v = this.toV(py);
    this.mpp *= Math.exp(e.deltaY * 0.0015);
    // Keep the point under the cursor fixed while zooming.
    this.cu += u - this.toU(px);
    this.cv += v - this.toV(py);
    this.resample();
  };

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Shift-drag draws a zoom box; plain drag pans.
    if (e.shiftKey) this.box = { x0: x, y0: y, x1: x, y1: y };
    else this.drag = { x: e.clientX, y: e.clientY, cu: this.cu, cv: this.cv };
  };

  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    if (this.box) {
      this.box.x1 = e.clientX - r.left;
      this.box.y1 = e.clientY - r.top;
      this.draw();
    } else if (this.drag) {
      this.cu = this.drag.cu - (e.clientX - this.drag.x) * this.mpp;
      this.cv = this.drag.cv + (e.clientY - this.drag.y) * this.mpp;
      this.resample();
    }
    this.hoverAt(e.clientX - r.left, e.clientY - r.top);
  };

  private onUp = (e: PointerEvent) => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    const b = this.box;
    this.box = null;
    if (b && Math.abs(b.x1 - b.x0) > 6 && Math.abs(b.y1 - b.y0) > 6) {
      const [ua, ub] = [this.toU(Math.min(b.x0, b.x1)), this.toU(Math.max(b.x0, b.x1))];
      const [va, vb] = [this.toV(Math.max(b.y0, b.y1)), this.toV(Math.min(b.y0, b.y1))];
      const { w, h } = this.plot;
      this.cu = (ua + ub) / 2;
      this.cv = (va + vb) / 2;
      this.mpp = Math.max((ub - ua) / w, (vb - va) / h);
      this.resample();
    } else if (b) {
      this.draw();
    }
  };

  private hoverAt(px: number, py: number): void {
    const plot = this.plot;
    const i = Math.floor(px - plot.x);
    const j = Math.floor(py - plot.y);
    const W = Math.round(plot.w);
    const o = i + W * j;
    if (!this.params || i < 0 || j < 0 || i >= W || j >= Math.round(plot.h) || !this.inside[o]) {
      this.onHover(null);
      return;
    }
    const { uAxis, vAxis } = this.params.slice;
    const value = formatLegendValue(legendDataValue(this.params.legend, this.valueAt(o)));
    this.onHover({ u: this.toU(px), v: this.toV(py), value, uLabel: AXIS[uAxis], vLabel: AXIS[vAxis] });
  }

  dispose(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
  }
}

function minSpacing(a: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 1; i < a.length; i++) m = Math.min(m, a[i] - a[i - 1]);
  return m;
}
