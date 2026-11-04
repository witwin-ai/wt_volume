import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, useEffect, useMemo, useRef, useState, useThree, useFrame, Html } from '../runtime';
import { loadVolumeTexture, checkVolumeSupport } from '../assets/volumeTexture';
import {
  sdfVertexShader,
  sdfFragmentShader,
  createColormapTexture
} from '../shaders/sdfShaders';
import { VisualizerConfig, VisualizerProps } from './types';
import { getComponentValue } from './utils';
import { VOLUME_DEPTH_SKIP_FLAG } from './VolumeDepthPrepass';
import type { RenderResourceRef, ViewportAssetsApi } from '@witwin/host';

// 2D Loading spinner component
const LoadingSpinner: ReactTypes.FC = () => (
  <Html center>
    <div style={{
      width: 32,
      height: 32,
      border: '3px solid rgba(100, 150, 255, 0.3)',
      borderTop: '3px solid #4488ff',
      borderRadius: '50%',
      animation: 'spin 1s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  </Html>
);

interface SDFComponentData {
  volume?: RenderResourceRef | null;
  resolution?: number[];
  render_technique?: string;
  iso_value?: number;
  enable_lighting?: boolean;
  colormap?: string;
  log_colormap?: boolean;  // Apply logarithmic scaling to colormap
  opacity_scale?: number;
  density_scale?: number;
  display_range?: number[];  // [min, max] - normalized (0-1)
  ray_steps?: number;
  show_slice?: boolean;
  slice_plane?: string;
  slice_position?: number;
  // Field bounds (for Field-like components)
  min_bound?: number[];
  max_bound?: number[];
}

interface SDFVisualizerProps {
  sdfData: SDFComponentData;
  assets: ViewportAssetsApi;
  selected?: boolean;
  hovered?: boolean;
}

const SDFVisualizer: ReactTypes.FC<SDFVisualizerProps> = ({
  sdfData,
  assets,
  selected = false,
  hovered = false
}) => {
  const { camera } = useThree();

  const [volumeTexture, setVolumeTexture] = useState<ThreeTypes.Data3DTexture | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Store actual texture resolution (from loaded data, not UI)
  const [textureResolution, setTextureResolution] = useState<[number, number, number]>([128, 128, 128]);

  const volumeTextureRef = useRef<ThreeTypes.Data3DTexture | null>(null);
  const colormapTextureRef = useRef<ThreeTypes.DataTexture | null>(null);
  const meshRef = useRef<ThreeTypes.Mesh | null>(null);

  // Extract SDF properties with defaults
  const {
    volume,
    resolution = [128, 128, 128],
    render_technique = 'sdf',
    iso_value = 0.0,
    enable_lighting = true,
    colormap = 'viridis',
    log_colormap = false,
    opacity_scale = 1.0,
    density_scale = 1.0,
    display_range = [0.0, 1.0],
    ray_steps = 128,
    show_slice = false,
    slice_plane = 'XZ',
    slice_position = 0.5,
    min_bound,
    max_bound
  } = sdfData;

  // Volume data is already normalized to 0-1 in backend (set_volume_data)
  // So display_range (0-1) maps directly to valueMin/valueMax shader uniforms
  const value_min = display_range[0];
  const value_max = display_range[1];

  // Calculate box size and center from bounds (for Field-like components)
  const boxSize = useMemo(() => {
    if (min_bound && max_bound) {
      return [
        max_bound[0] - min_bound[0],
        max_bound[1] - min_bound[1],
        max_bound[2] - min_bound[2]
      ] as [number, number, number];
    }
    return [1, 1, 1] as [number, number, number];  // Default unit cube
  }, [min_bound, max_bound]);

  const boxCenter = useMemo(() => {
    if (min_bound && max_bound) {
      return [
        (min_bound[0] + max_bound[0]) / 2,
        (min_bound[1] + max_bound[1]) / 2,
        (min_bound[2] + max_bound[2]) / 2
      ] as [number, number, number];
    }
    return [0, 0, 0] as [number, number, number];  // Default center
  }, [min_bound, max_bound]);

  // Convert render technique to shader mode int
  const renderModeInt = useMemo(() => {
    return render_technique === 'isosurface' ? 2 : 1;
  }, [render_technique]);


  // Load volume data when the resource ref changes (not when resolution changes)
  useEffect(() => {
    if (!volume) {
      // No volume to load - clear texture but don't return null
      setVolumeTexture(null);
      setError(null);
      setLoading(false);
      return;
    }

    const loadVolume = async () => {
      setLoading(true);
      setError(null);

      try {
        // Use current resolution for loading (will be stored as actual texture resolution)
        const loadResolution = resolution as [number, number, number];

        // Check WebGL2 support
        const support = checkVolumeSupport(loadResolution);
        if (!support.supported) {
          throw new Error(support.message || 'Volume not supported');
        }

        // Cleanup old texture
        if (volumeTextureRef.current) {
          volumeTextureRef.current.dispose();
          volumeTextureRef.current = null;
        }

        // Load volume
        const result = await loadVolumeTexture(
          assets,
          volume,
          loadResolution,
          undefined
        );

        volumeTextureRef.current = result.texture;
        setVolumeTexture(result.texture);
        // Store the actual texture resolution for shader calculations
        setTextureResolution(result.resolution);
        setLoading(false);

      } catch (err: any) {
        console.error('[SDFVisualizer] Failed to load SDF:', err);
        setError(err.message || 'Failed to load volume');
        setLoading(false);
      }
    };

    loadVolume();

    // Cleanup on unmount
    return () => {
      if (volumeTextureRef.current) {
        volumeTextureRef.current.dispose();
        volumeTextureRef.current = null;
      }
    };
  }, [assets, volume?.assetId, volume?.uri]); // Only reload when resource changes, not resolution

  // Create/update colormap texture when colormap changes
  useEffect(() => {
    // Cleanup old texture
    if (colormapTextureRef.current) {
      colormapTextureRef.current.dispose();
    }

    // Create new colormap texture
    const texture = createColormapTexture(colormap);
    colormapTextureRef.current = texture;

    return () => {
      if (colormapTextureRef.current) {
        colormapTextureRef.current.dispose();
      }
    };
  }, [colormap]);

  // Convert slice plane string to int
  const slicePlaneInt = useMemo(() => {
    switch (slice_plane) {
      case 'XY': return 0;
      case 'XZ': return 1;
      case 'YZ': return 2;
      default: return 1;
    }
  }, [slice_plane]);

  // Create shader material (only recreate when textures change)
  const sdfMaterial = useMemo(() => {
    if (!volumeTexture || !colormapTextureRef.current) return null;

    // Create identity matrix for modelMatrixInverse (will be updated in mesh)
    const modelMatrixInverse = new THREE.Matrix4();

    return new THREE.ShaderMaterial({
      uniforms: {
        volumeTexture: { value: volumeTexture },
        colormapTexture: { value: colormapTextureRef.current },
        modelMatrixInverse: { value: modelMatrixInverse },
        uModelMatrix: { value: new THREE.Matrix4() },
        uViewMatrix: { value: new THREE.Matrix4() },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        volumeResolution: { value: new THREE.Vector3(textureResolution[0], textureResolution[1], textureResolution[2]) },
        renderMode: { value: renderModeInt },
        isoValue: { value: iso_value },
        enableLighting: { value: enable_lighting },
        opacityScale: { value: opacity_scale },
        densityScale: { value: density_scale },
        valueMin: { value: value_min },
        valueMax: { value: value_max },
        logColormap: { value: log_colormap },
        raySteps: { value: ray_steps },
        showSlice: { value: show_slice },
        slicePlane: { value: slicePlaneInt },
        slicePosition: { value: slice_position }
      },
      vertexShader: sdfVertexShader,
      fragmentShader: sdfFragmentShader,
      // DoubleSide allows rendering when camera is inside or outside the volume
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
  }, [volumeTexture]); // Only recreate when texture changes!

  // Cleanup ShaderMaterial on unmount or when material changes
  useEffect(() => {
    return () => {
      if (sdfMaterial) {
        sdfMaterial.dispose();
      }
    };
  }, [sdfMaterial]);

  // Mark the raymarching mesh so the depth prepass skips it
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.userData[VOLUME_DEPTH_SKIP_FLAG] = true;
    }
  }, [sdfMaterial]);

  // Update all uniforms every frame to ensure synchronization
  useFrame(() => {
    if (!meshRef.current || !sdfMaterial) return;

    // Update modelMatrixInverse uniform with mesh's world matrix inverse
    meshRef.current.updateMatrixWorld();
    const invMatrix = meshRef.current.matrixWorld.clone().invert();
    sdfMaterial.uniforms.modelMatrixInverse.value.copy(invMatrix);
    sdfMaterial.uniforms.uModelMatrix.value.copy(meshRef.current.matrixWorld);
    sdfMaterial.uniforms.uViewMatrix.value.copy(camera.matrixWorldInverse);
    sdfMaterial.uniforms.uProjectionMatrix.value.copy(camera.projectionMatrix);

    // Update all parameter uniforms every frame (ensures real-time response)
    // Use actual texture resolution, not UI resolution (for correct gradient calculation)
    sdfMaterial.uniforms.volumeResolution.value.set(textureResolution[0], textureResolution[1], textureResolution[2]);
    sdfMaterial.uniforms.renderMode.value = renderModeInt;
    sdfMaterial.uniforms.isoValue.value = iso_value;
    sdfMaterial.uniforms.enableLighting.value = enable_lighting;
    sdfMaterial.uniforms.opacityScale.value = opacity_scale;
    sdfMaterial.uniforms.densityScale.value = density_scale;
    sdfMaterial.uniforms.valueMin.value = value_min;
    sdfMaterial.uniforms.valueMax.value = value_max;
    sdfMaterial.uniforms.logColormap.value = log_colormap;
    sdfMaterial.uniforms.raySteps.value = ray_steps;
    sdfMaterial.uniforms.showSlice.value = show_slice;
    sdfMaterial.uniforms.slicePlane.value = slicePlaneInt;
    sdfMaterial.uniforms.slicePosition.value = slice_position;

    if (colormapTextureRef.current) {
      sdfMaterial.uniforms.colormapTexture.value = colormapTextureRef.current;
    }
  });

  // Render error state or placeholder
  const showPlaceholder = error || !volume || !sdfMaterial;

  // Loading state: show 2D spinner
  if (loading && !sdfMaterial) {
    return <LoadingSpinner />;
  }

  if (showPlaceholder) {
    // Determine placeholder color based on state
    let placeholderColor = "#666666"; // Default: no volume resource
    if (error) placeholderColor = "#ff0000";   // Red: error

    return (
      <group position={boxCenter} scale={boxSize}>
        {/* Placeholder box edges (only 12 edges, no triangle diagonals) */}
        <lineSegments ref={meshRef as any}>
          <edgesGeometry args={[new THREE.BoxGeometry(1, 1, 1)]} />
          <lineBasicMaterial
            color={placeholderColor}
            transparent
            opacity={0.5}
          />
        </lineSegments>

        {/* Selection outline - box edges */}
        {(selected || hovered) && (
          <lineSegments>
            <edgesGeometry args={[new THREE.BoxGeometry(1.02, 1.02, 1.02)]} />
            <lineBasicMaterial
              color={selected ? 0xff8800 : 0xffaa00}
              transparent
              opacity={selected ? 1 : 0.6}
              linewidth={2}
            />
          </lineSegments>
        )}
      </group>
    );
  }

  // Render volume cube with shader material
  return (
    <group position={boxCenter} scale={boxSize}>
      {/* Main SDF rendering - raycast disabled (pure renderer, no click handling) */}
      <mesh ref={meshRef} material={sdfMaterial} raycast={() => null}>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>

      {/* Selection outline - box edges */}
      {(selected || hovered) && (
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(1.02, 1.02, 1.02)]} />
          <lineBasicMaterial
            color={selected ? 0xff8800 : 0xffaa00}
            transparent
            opacity={selected ? 1 : 0.6}
            linewidth={2}
          />
        </lineSegments>
      )}
    </group>
  );
};

// Export the data type for external use
export type { SDFComponentData };

/**
 * Adapter component that wraps SDFVisualizer with unified VisualizerProps interface
 */
const SDFVisualizerAdapter: ReactTypes.FC<VisualizerProps<SDFComponentData> & { assets: ViewportAssetsApi }> = ({
  data,
  assets,
  selected,
  hovered
}) => {
  return <SDFVisualizer sdfData={data} assets={assets} selected={selected} hovered={hovered} />;
};

/**
 * Registration configuration for SDF visualizer
 */
export const sdfVisualizerConfig: VisualizerConfig<SDFComponentData> = {
  name: 'sdf',
  priority: 13,

  // Only match SDFRenderer component (pure renderer)
  // Field components handle their own SDF rendering via FieldVisualizer + field3DRenderData
  matcher: (c) => c.name === 'SDFRenderer',

  // Extract visualization data from component
  extractor: (comp) => {
    const volume = getComponentValue(comp, 'volume', null);
    // Only render if a volume resource is provided
    if (!volume) return null;

    return {
      volume,
      resolution: getComponentValue(comp, 'resolution', [128, 128, 128]),
      render_technique: getComponentValue(comp, 'render_technique', 'sdf'),
      iso_value: getComponentValue(comp, 'iso_value', 0.0),
      enable_lighting: getComponentValue(comp, 'enable_lighting', true),
      colormap: getComponentValue(comp, 'colormap', 'viridis'),
      log_colormap: getComponentValue(comp, 'log_colormap', false),
      opacity_scale: getComponentValue(comp, 'opacity_scale', 1.0),
      density_scale: getComponentValue(comp, 'density_scale', 1.0),
      display_range: getComponentValue(comp, 'display_range', [0.0, 1.0]),
      ray_steps: getComponentValue(comp, 'ray_steps', 128),
      show_slice: getComponentValue(comp, 'show_slice', false),
      slice_plane: getComponentValue(comp, 'slice_plane', 'XZ'),
      slice_position: getComponentValue(comp, 'slice_position', 0.5),
      // Field bounds (for Field-like components)
      min_bound: getComponentValue(comp, 'min_bound', undefined),
      max_bound: getComponentValue(comp, 'max_bound', undefined),
    };
  },

  component: SDFVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.6,
};

export default SDFVisualizer;
