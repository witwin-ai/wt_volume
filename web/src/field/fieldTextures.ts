import type * as ThreeTypes from 'three';
import { THREE, useEffect, useState } from '../runtime';
import type { RenderResourceRef, ViewportAssetsApi } from '../sdk/types';
import { checkVolumeSupport, loadVolumeTexture } from '../assets/volumeTexture';

/**
 * Field data as the Field component publishes it.
 *
 * - `volume` is the real part (or the only part of a real field).
 * - `volumeIm`, when present, is the imaginary part on the same grid.
 * - `axisCoords`, when present, lists each axis's grid coordinates in metres
 *   (ascending); without it the grid is uniform between minBound and maxBound.
 */
export interface FieldSource {
  volume: RenderResourceRef | null;
  volumeIm?: RenderResourceRef | null;
  resolution: [number, number, number];
  axisCoords?: number[][] | null;
  minBound: number[];
  maxBound: number[];
}

export interface FieldTextures {
  re: ThreeTypes.Data3DTexture;
  im: ThreeTypes.Data3DTexture | null;
  /** Per-axis coordinates normalised to [0,1] in the field box; null for a uniform grid. */
  axes: [ThreeTypes.DataTexture, ThreeTypes.DataTexture, ThreeTypes.DataTexture] | null;
  resolution: [number, number, number];
}

export type FieldQuantity = 'value' | 'magnitude';

/** Normalised axis texture: R32F, one texel per grid point, read with texelFetch only. */
export function createAxisTexture(coords: ArrayLike<number>, lo: number, hi: number): ThreeTypes.DataTexture {
  const span = hi - lo || 1;
  const data = Float32Array.from(coords as ArrayLike<number>, (c) => (c - lo) / span);
  const texture = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** True when axisCoords describes a usable non-uniform grid for this resolution. */
function hasAxes(source: FieldSource): boolean {
  const axes = source.axisCoords;
  return !!axes && axes.length === 3 && axes.every((a, i) => Array.isArray(a) && a.length === source.resolution[i] && a.length >= 2);
}

let placeholders: { volume: ThreeTypes.Data3DTexture; axis: ThreeTypes.DataTexture } | null = null;

// Samplers must always be bound, even for a real field on a uniform grid.
function placeholderTextures() {
  if (!placeholders) {
    const volume = new THREE.Data3DTexture(new Float32Array(1), 1, 1, 1);
    volume.format = THREE.RedFormat;
    volume.type = THREE.FloatType;
    volume.needsUpdate = true;
    placeholders = { volume, axis: createAxisTexture([0, 1], 0, 1) };
  }
  return placeholders;
}

/** Uniform slots for FIELD_SAMPLING_GLSL. Spread into a ShaderMaterial's uniforms. */
export function createFieldUniforms(): Record<string, { value: unknown }> {
  const p = placeholderTextures();
  return {
    u_fieldRe: { value: p.volume },
    u_fieldIm: { value: p.volume },
    u_fieldComplex: { value: false },
    u_fieldUniformGrid: { value: true },
    u_fieldAxisX: { value: p.axis },
    u_fieldAxisY: { value: p.axis },
    u_fieldAxisZ: { value: p.axis },
    u_fieldQuantity: { value: 0 },
    u_fieldPhase: { value: 0 },
  };
}

export function bindFieldUniforms(
  uniforms: Record<string, { value: unknown }>,
  textures: FieldTextures,
  quantity: FieldQuantity = 'value',
  phase = 0,
): void {
  const p = placeholderTextures();
  uniforms.u_fieldRe.value = textures.re;
  uniforms.u_fieldIm.value = textures.im ?? p.volume;
  uniforms.u_fieldComplex.value = textures.im !== null;
  uniforms.u_fieldUniformGrid.value = textures.axes === null;
  uniforms.u_fieldAxisX.value = textures.axes?.[0] ?? p.axis;
  uniforms.u_fieldAxisY.value = textures.axes?.[1] ?? p.axis;
  uniforms.u_fieldAxisZ.value = textures.axes?.[2] ?? p.axis;
  uniforms.u_fieldQuantity.value = quantity === 'magnitude' ? 1 : 0;
  uniforms.u_fieldPhase.value = phase;
}

function disposeTextures(t: FieldTextures | null) {
  if (!t) return;
  t.re.dispose();
  t.im?.dispose();
  t.axes?.forEach((a) => a.dispose());
}

export interface FieldTextureState {
  textures: FieldTextures | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads a field's textures while `enabled`, and disposes them when the source
 * changes or the caller unmounts. `textures` is null until the real part (and
 * the imaginary part, if any) has loaded.
 */
export function useFieldTextures(assets: ViewportAssetsApi, source: FieldSource, enabled: boolean): FieldTextureState {
  const [state, setState] = useState<FieldTextureState>({ textures: null, loading: false, error: null });
  const { volume, volumeIm, resolution, axisCoords, minBound, maxBound } = source;
  const axesKey = hasAxes(source) ? JSON.stringify(axisCoords) + JSON.stringify([minBound, maxBound]) : '';

  useEffect(() => {
    if (!enabled || !volume) {
      setState({ textures: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let loaded: FieldTextures | null = null;
    const support = checkVolumeSupport(resolution);
    if (!support.supported) {
      setState({ textures: null, loading: false, error: support.message || 'Volume not supported' });
      return;
    }
    setState({ textures: null, loading: true, error: null });
    (async () => {
      try {
        const [re, im] = await Promise.all([
          loadVolumeTexture(assets, volume, resolution),
          volumeIm ? loadVolumeTexture(assets, volumeIm, resolution) : Promise.resolve(null),
        ]);
        const axes = axesKey
          ? ([0, 1, 2].map((a) => createAxisTexture(axisCoords![a], minBound[a], maxBound[a])) as FieldTextures['axes'])
          : null;
        loaded = { re: re.texture, im: im?.texture ?? null, axes, resolution: re.resolution };
        if (cancelled) disposeTextures(loaded);
        else setState({ textures: loaded, loading: false, error: null });
      } catch (err: any) {
        console.error('[wt_volume] Failed to load field volume:', err);
        if (!cancelled) setState({ textures: null, loading: false, error: err?.message || 'Failed to load volume' });
      }
    })();
    return () => {
      cancelled = true;
      disposeTextures(loaded);
    };
    // Resource identity, not object identity: refs are rebuilt on every scene sync.
    // Resolution is read from the loaded data, so a UI resolution edit alone does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, enabled, volume?.assetId, volume?.uri, volumeIm?.assetId, volumeIm?.uri, axesKey]);

  return state;
}
