import { useEffect, useThree } from '../runtime';
import { getColormapFunc } from '../shaders/volumeShaders';

/**
 * Colour bar for a field shown in the viewport: title, gradient and values
 * at the ends (and 0 in the middle of a signed range).
 *
 * Values are real data values when the publisher sent `value_range`
 * (normalised display value n maps to lo + n (hi - lo) for a real grid,
 * n * peak for a complex one); otherwise the bar shows the normalised values
 * and says "arbitrary units".
 *
 * Plain DOM over the WebGL canvas, not React: the visualizer renders inside
 * the R3F tree, which cannot hold DOM. All fields share one stack in the
 * viewport's bottom-left corner, above the scene label.
 */

export interface FieldLegendSpec {
  title: string;
  colormap: string;
  /** Normalised display range, as the slice shader gets it. */
  valueMin: number;
  valueMax: number;
  signed: boolean;
  logScale: boolean;
  complex: boolean;
  valueRange: number[] | null;
}

const BAR_WIDTH = 168;
const BAR_HEIGHT = 10;

export function legendTitle(name: string, unit: string, complex: boolean, magnitude: boolean, hasRange: boolean): string {
  const quantity = name || (complex ? (magnitude ? '|E|' : 'Re(E)') : 'Value');
  if (unit) return `${quantity} (${unit})`;
  return hasRange ? quantity : `${quantity}, arbitrary units`;
}

export function formatLegendValue(v: number): string {
  if (v === 0 || Math.abs(v) < 1e-12) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-2) return v.toExponential(1).replace('e+', 'e');
  return String(Number(v.toPrecision(2)));
}

/** Data value for normalised display value `n`: real units when the publisher sent value_range. */
export function legendDataValue(spec: FieldLegendSpec, n: number): number {
  const range = spec.valueRange;
  if (!range || range.length !== 2) return n;
  if (spec.complex) return n * Math.max(Math.abs(range[0]), Math.abs(range[1]));
  return range[0] + n * (range[1] - range[0]);
}

/** The Field component fields that decide how its values are displayed. */
export interface FieldDisplaySource {
  volume_im?: unknown;
  field_quantity?: string;
  display_range?: number[];
  colormap?: string;
  log_colormap?: boolean;
  value_range?: number[] | null;
  legend_title?: string;
  field_unit?: string;
}

/**
 * Display mapping of a Field: shared by the viewport slice and the 2D slice
 * panel so both colour the same value the same way.
 *
 * Volume data arrives normalised (a real field to 0..1, a complex field by
 * its peak |E| so re and im lie in -1..1), so display_range (0..1) is the
 * value range directly. Re(E e^{-i phase}) is signed: it shows -max..max.
 */
export function fieldLegendSpec(data: FieldDisplaySource): FieldLegendSpec {
  const complex = !!data.volume_im;
  const magnitude = data.field_quantity === 'magnitude';
  const signed = complex && !magnitude;
  const range = data.display_range ?? [0, 1];
  return {
    title: legendTitle(data.legend_title ?? '', data.field_unit ?? '', complex, magnitude, !!data.value_range),
    colormap: data.colormap ?? 'inferno',
    valueMin: signed ? -range[1] : range[0],
    valueMax: range[1],
    signed,
    logScale: !!data.log_colormap,
    complex,
    valueRange: data.value_range ?? null,
  };
}

/** Ticks as [position along the bar 0..1, label]. */
export function legendTicks(spec: FieldLegendSpec): Array<[number, string]> {
  const ticks: Array<[number, string]> = [
    [0, formatLegendValue(legendDataValue(spec, spec.valueMin))],
    [1, formatLegendValue(legendDataValue(spec, spec.valueMax))],
  ];
  if (spec.signed && !spec.logScale) ticks.splice(1, 0, [0.5, '0']);
  return ticks;
}

const stacks = new WeakMap<HTMLElement, { el: HTMLDivElement; users: number }>();

function acquireStack(parent: HTMLElement): HTMLDivElement {
  let entry = stacks.get(parent);
  if (!entry) {
    const el = document.createElement('div');
    el.dataset.testid = 'field-legends';
    Object.assign(el.style, {
      position: 'absolute',
      left: '12px',
      bottom: '44px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      pointerEvents: 'none',
      zIndex: '2',
    });
    parent.appendChild(el);
    entry = { el, users: 0 };
    stacks.set(parent, entry);
  }
  entry.users += 1;
  return entry.el;
}

function releaseStack(parent: HTMLElement): void {
  const entry = stacks.get(parent);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users <= 0) {
    entry.el.remove();
    stacks.delete(parent);
  }
}

function renderCard(card: HTMLDivElement, spec: FieldLegendSpec): void {
  card.replaceChildren();
  const title = document.createElement('div');
  title.textContent = spec.title;
  Object.assign(title.style, { fontWeight: '500', marginBottom: '6px', color: 'var(--text-primary)' });

  const bar = document.createElement('canvas');
  bar.width = BAR_WIDTH;
  bar.height = 1;
  Object.assign(bar.style, { display: 'block', width: `${BAR_WIDTH}px`, height: `${BAR_HEIGHT}px`, borderRadius: '2px' });
  const ctx = bar.getContext('2d');
  if (ctx) {
    const colour = getColormapFunc(spec.colormap);
    const img = ctx.createImageData(BAR_WIDTH, 1);
    for (let x = 0; x < BAR_WIDTH; x++) {
      let t = x / (BAR_WIDTH - 1);
      // Same mapping as fieldNormalize's log option, so the bar matches the plot.
      if (spec.logScale) t = Math.log10(1 + 9 * t);
      const [r, g, b] = colour(t);
      img.data.set([r * 255, g * 255, b * 255, 255], x * 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  const ticks = document.createElement('div');
  Object.assign(ticks.style, { position: 'relative', height: '14px', marginTop: '4px', color: 'var(--text-secondary)' });
  for (const [at, text] of legendTicks(spec)) {
    const label = document.createElement('span');
    label.textContent = text;
    const anchor = at === 0 ? '0%' : at === 1 ? '-100%' : '-50%';
    Object.assign(label.style, { position: 'absolute', left: `${at * 100}%`, transform: `translateX(${anchor})` });
    ticks.appendChild(label);
  }
  card.append(title, bar, ticks);
}

/** Shows `spec` as a colour bar while it is non-null. */
export function useFieldLegend(spec: FieldLegendSpec | null): void {
  const gl = useThree((s) => s.gl);
  const key = spec ? JSON.stringify(spec) : '';

  useEffect(() => {
    const parent = gl.domElement.parentElement;
    if (!spec || !parent) return undefined;
    const stack = acquireStack(parent);
    const card = document.createElement('div');
    Object.assign(card.style, {
      background: 'var(--gray-3)',
      border: '1px solid var(--border-subtle)',
      borderRadius: '6px',
      padding: '8px 10px',
      font: '11px var(--font-family)',
    });
    renderCard(card, spec);
    stack.appendChild(card);
    return () => {
      card.remove();
      releaseStack(parent);
    };
    // `key` carries every field of spec.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, key]);
}
