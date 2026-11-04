import type ReactTypes from 'react';
import { Clapperboard, Film, ImageDown, Pause, Play, Video } from 'lucide-react';
import { React, useEffect, useMemo, useRef, useState } from '../runtime';
import type { FrontendHost, HostSceneObject, VolumeTextureResource } from '@witwin/host';
import { fieldVisualizerConfig } from '../gizmos/FieldVisualizer';
import { fieldLegendSpec } from '../field/fieldLegend';
import { encodeGif } from '../media/gif';
import { encodeCanvasMovie, recordCanvas, saveBlob } from '../media/movie';
import { gridCoords, lengthUnit, sliceGrid, type FieldGrid, type SlicePlane } from './fieldGrid';
import { sliceOutlines } from './outlines';
import { PERIOD_MS, phaseClock, usePhaseClock } from './phaseClock';
import { SlicePlot, type SliceHover } from './slicePlot';
import { viewportHandle } from './viewportHandle';

/*
 * Field Slice panel: the 2D plot of the slice the viewport shows, with
 * phase animation and PNG / GIF / WebM export.
 *
 * It shows the selected Field object, else the one it showed last, else the
 * first Field with data. Slice plane, colormap, range and quantity come from
 * the Field component, so the panel and the viewport always agree; the panel
 * owns only the view (zoom and pan) and the playing phase.
 */

const GIF_FRAMES = 24;
const GIF_MAX_WIDTH = 720;
const MOVIE_FRAMES = 60;

type FieldData = NonNullable<ReturnType<typeof fieldVisualizerConfig.extractor>>;

function fieldComponent(object: HostSceneObject): any | null {
  const components = Array.isArray(object.components) ? object.components : [];
  return components.find((c: any) => c?.name === 'Field' || c?.base_classes?.includes?.('Field')) ?? null;
}

function fieldOf(object: HostSceneObject | undefined): FieldData | null {
  const component = object && fieldComponent(object);
  if (!component) return null;
  const data = fieldVisualizerConfig.extractor(component, object);
  return data?.volume ? data : null;
}

function pickField(host: FrontendHost, previous: string | null): string | null {
  const scene = host.services.get('scene');
  const objects = scene.getObjects();
  const selected = scene.getSelection().find((id) => fieldOf(objects[id]));
  if (selected) return selected;
  if (previous && fieldOf(objects[previous])) return previous;
  return Object.keys(objects).find((id) => fieldOf(objects[id])) ?? null;
}

/** Re-renders on every scene or selection change. */
function useSceneVersion(host: FrontendHost): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const subscription = host.services.get('scene').subscribe(() => setVersion((v) => v + 1));
    return () => subscription.dispose();
  }, [host]);
  return version;
}

/** The field's re and im volumes on the CPU, reloaded when the published resources change. */
function useFieldGrid(host: FrontendHost, data: FieldData | null): { grid: FieldGrid | null; error: string | null } {
  const [state, setState] = useState<{ grid: FieldGrid | null; error: string | null }>({ grid: null, error: null });
  const re = data?.volume ?? null;
  const im = data?.volume_im ?? null;
  const axesKey = data ? JSON.stringify([data.axis_coords, data.min_bound, data.max_bound]) : '';

  useEffect(() => {
    if (!re || !data) {
      setState({ grid: null, error: null });
      return undefined;
    }
    let cancelled = false;
    const loaded: VolumeTextureResource[] = [];
    (async () => {
      try {
        const [r, i] = await Promise.all([host.assets.loadVolume(re), im ? host.assets.loadVolume(im) : Promise.resolve(null)]);
        loaded.push(r, ...(i ? [i] : []));
        if (cancelled) return;
        const coords = gridCoords(r.resolution, data.min_bound ?? [-5, -5, -5], data.max_bound ?? [5, 5, 5], data.axis_coords ?? null);
        setState({ grid: { coords, re: r.data, im: i?.data ?? null }, error: null });
      } catch (err: any) {
        if (!cancelled) setState({ grid: null, error: err?.message || 'Failed to load the field' });
      }
    })();
    return () => {
      cancelled = true;
      loaded.forEach((r) => host.assets.release(r));
    };
    // Resource identity, not object identity: refs are rebuilt on every scene sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, re?.assetId, re?.uri, im?.assetId, im?.uri, axesKey]);

  return state;
}

function useElementSize(ref: ReactTypes.RefObject<HTMLElement>, onResize: () => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => onResize());
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), 'image/png'));
}

function fileStem(name: string): string {
  return (name || 'field').replace(/[^\w.-]+/g, '_');
}

const styles: Record<string, ReactTypes.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--gray-2)', color: 'var(--text-primary)', font: '12px var(--font-family)' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: 'var(--header-h)',
    boxSizing: 'border-box',
    padding: '0 8px',
    background: 'var(--gray-3)',
    borderBottom: '1px solid var(--border-subtle)',
    flex: 'none',
  },
  name: { fontWeight: 500, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  status: { marginLeft: 'auto', color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  stage: { position: 'relative', flex: 1, minHeight: 0 },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' },
  empty: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' },
};

export function createFieldSlicePanel(host: FrontendHost): ReactTypes.FC<{ panelId: string }> {
  const HostButton = host.ui?.Button;

  function ToolButton({ label, icon, onClick, disabled, active }: { label: string; icon: ReactTypes.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) {
    const content = (
      <>
        {icon}
        <span>{label}</span>
      </>
    );
    return HostButton ? (
      <HostButton variant="ghost" size="sm" onClick={onClick} disabled={disabled} active={active} aria-label={label}>
        {content}
      </HostButton>
    ) : (
      <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={active}>
        {content}
      </button>
    );
  }

  return function FieldSlicePanel() {
    const version = useSceneVersion(host);
    const shownRef = useRef<string | null>(null);
    const objectId = useMemo(() => {
      shownRef.current = pickField(host, shownRef.current);
      return shownRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version]);
    const object = objectId ? host.services.get('scene').getObjects()[objectId] : undefined;
    const data = fieldOf(object);
    const { grid, error } = useFieldGrid(host, data);

    const plane = (data?.dimension === '2D' ? data.plane : data?.plane_axis) as SlicePlane | undefined;
    const position = data?.dimension === '2D' ? 0.5 : data?.plane_position ?? 0.5;
    const slice = useMemo(() => (grid && plane ? sliceGrid(grid, plane, position) : null), [grid, plane, position]);
    // Outlines follow scene edits too, so they depend on the scene version.
    const outlines = useMemo(() => {
      const scene = viewportHandle()?.scene;
      return slice && scene ? sliceOutlines(scene, slice.normal, slice.position, slice.uAxis, slice.vAxis) : new Float32Array(0);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slice, version]);

    const legend = data ? fieldLegendSpec(data) : null;
    const legendKey = JSON.stringify(legend);
    const animatable = !!grid?.im && data?.field_quantity !== 'magnitude';
    const clock = usePhaseClock();
    const phase = clock.playing ? clock.phase : data?.field_phase ?? 0;

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const plotRef = useRef<SlicePlot | null>(null);
    const [hover, setHover] = useState<SliceHover>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      const plot = new SlicePlot(canvas, setHover);
      plotRef.current = plot;
      // The stage observer fired before this canvas existed; size it now.
      plot.resize();
      return () => {
        plot.dispose();
        plotRef.current = null;
      };
    }, [slice !== null]);

    useElementSize(stageRef, () => plotRef.current?.resize());

    // Refit when another field or plane is shown; keep the view when only data or styling changes.
    const fitKey = `${objectId}|${plane}`;
    const lastFit = useRef('');
    useEffect(() => {
      const plot = plotRef.current;
      if (!plot || !slice || !legend || !data) return;
      const refit = lastFit.current !== fitKey;
      lastFit.current = fitKey;
      plot.set({ slice, quantity: data.field_quantity ?? 'value', colormap: data.colormap ?? 'inferno', showGrid: !!data.show_grid, legend, outlines }, refit);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slice, legendKey, outlines, data?.field_quantity, data?.colormap, data?.show_grid, fitKey]);

    useEffect(() => {
      plotRef.current?.setPhase(phase);
    }, [phase, slice]);

    // Stop the shared clock when this panel goes away; nothing else drives it.
    useEffect(() => () => void (phaseClock.get().playing && phaseClock.pause()), []);

    const writePhase = (value: number) => {
      if (!objectId || !data?.componentName) return;
      void host.services.get('scene').updateComponentField(objectId, data.componentName, 'field_phase', value);
    };

    const togglePlay = () => {
      if (clock.playing) writePhase(phaseClock.pause());
      else phaseClock.play(data?.field_phase ?? 0);
    };

    const run = async (label: string, job: () => Promise<void>) => {
      setBusy(label);
      setMessage(null);
      try {
        await job();
      } catch (err: any) {
        setMessage(err?.message || `${label} failed`);
      } finally {
        setBusy(null);
      }
    };

    const stem = fileStem(object?.name ?? 'field');
    const plot = plotRef.current;

    const exportPng = () =>
      run('Saving PNG', async () => {
        if (plot) saveBlob(await canvasBlob(plot.element), `${stem}-slice.png`);
      });

    const exportGif = () =>
      run('Encoding GIF', async () => {
        if (!plot) return;
        // Let the status render before the encoder blocks the thread.
        await new Promise((r) => setTimeout(r, 30));
        const frames = plot.captureFrames(GIF_FRAMES, GIF_MAX_WIDTH);
        const bytes = encodeGif(frames, PERIOD_MS / GIF_FRAMES);
        saveBlob(new Blob([bytes as BlobPart], { type: 'image/gif' }), `${stem}-slice.gif`);
      });

    const exportMovie = () =>
      run('Recording WebM', async () => {
        if (!plot) return;
        const phase0 = phase;
        const blob = await encodeCanvasMovie(plot.element, (f) => plot.setPhase(phase0 + (2 * Math.PI * f) / MOVIE_FRAMES), {
          frames: MOVIE_FRAMES,
          fps: 30,
        });
        plot.setPhase(phase0);
        saveBlob(blob, `${stem}-slice.webm`);
      });

    // Records the 3D viewport over one period; complex fields animate while it runs.
    const recordViewport = () =>
      run('Recording viewport', async () => {
        const handle = viewportHandle();
        if (!handle) throw new Error('The viewport is not open');
        const wasPlaying = phaseClock.get().playing;
        if (animatable && !wasPlaying) phaseClock.play(phase);
        handle.invalidate();
        try {
          saveBlob(await recordCanvas(handle.canvas, PERIOD_MS), `${stem}-viewport.webm`);
        } finally {
          if (animatable && !wasPlaying) phaseClock.pause();
        }
      });

    const unit = slice ? lengthUnit(Math.max(slice.u[slice.u.length - 1] - slice.u[0], slice.v[slice.v.length - 1] - slice.v[0])) : null;
    const readout =
      hover && unit
        ? `${hover.uLabel} ${(hover.u / unit[0]).toFixed(3)}  ${hover.vLabel} ${(hover.v / unit[0]).toFixed(3)} ${unit[1]}   ${hover.value}`
        : null;
    const status = busy ? `${busy}…` : message ?? readout ?? (error ? error : '');
    const disabled = !slice || !!busy;

    return (
      <div style={styles.root} data-testid="field-slice-panel">
        <div style={styles.toolbar}>
          <span style={styles.name}>{object?.name ?? 'Field Slice'}</span>
          <ToolButton
            label={clock.playing ? 'Pause' : 'Play'}
            icon={clock.playing ? <Pause size={14} /> : <Play size={14} />}
            onClick={togglePlay}
            disabled={disabled || !animatable}
            active={clock.playing}
          />
          <ToolButton label="PNG" icon={<ImageDown size={14} />} onClick={exportPng} disabled={disabled} />
          <ToolButton label="GIF" icon={<Film size={14} />} onClick={exportGif} disabled={disabled || !animatable} />
          <ToolButton label="WebM" icon={<Clapperboard size={14} />} onClick={exportMovie} disabled={disabled || !animatable} />
          <ToolButton label="Viewport" icon={<Video size={14} />} onClick={recordViewport} disabled={!!busy} />
          <span style={styles.status}>{status}</span>
        </div>
        <div style={styles.stage} ref={stageRef}>
          {slice ? <canvas ref={canvasRef} style={styles.canvas} /> : <div style={styles.empty}>{error ?? 'No field data'}</div>}
        </div>
      </div>
    );
  };
}
