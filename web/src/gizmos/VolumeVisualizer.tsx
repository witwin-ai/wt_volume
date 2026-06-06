import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, useEffect, useMemo, useRef, useState, useThree, useFrame, Html } from '../runtime';
import { loadVolumeTexture, checkVolumeSupport } from '../assets/volumeTexture';
import {
  volumeVertexShader,
  volumeFragmentShader,
  createColormapTexture
} from '../shaders/volumeShaders';
import { getBlueNoiseTexture } from '../shaders/blueNoise';
import { VisualizerConfig, VisualizerProps } from './types';
import { getComponentValue } from './utils';
import { VOLUME_DEPTH_SKIP_FLAG, getVolumeDepthTexture } from './VolumeDepthPrepass';
import type { RenderResourceRef, ViewportAssetsApi } from '../sdk/types';

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

interface VolumeComponentData {
  volume?: RenderResourceRef | null;
  resolution?: number[];
  render_mode?: string;
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

interface VolumeVisualizerProps {
  volumeData: VolumeComponentData;
  assets: ViewportAssetsApi;
  selected?: boolean;
  hovered?: boolean;
}

const VolumeVisualizer: ReactTypes.FC<VolumeVisualizerProps> = ({
  volumeData,
  assets,
  selected = false,
  hovered = false
}) => {
  const { camera, gl } = useThree();
  const absorptionScale = 1.0;

  const [volumeTexture, setVolumeTexture] = useState<ThreeTypes.Data3DTexture | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Store actual texture resolution (from loaded data, not UI)
  const [textureResolution, setTextureResolution] = useState<[number, number, number]>([128, 128, 128]);

  const volumeTextureRef = useRef<ThreeTypes.Data3DTexture | null>(null);
  const colormapTextureRef = useRef<ThreeTypes.DataTexture | null>(null);
  const meshRef = useRef<ThreeTypes.Mesh | null>(null);
  const drawingBufferSize = useMemo(() => new THREE.Vector2(), []);

  // Extract volume properties with defaults
  const {
    volume,
    resolution = [128, 128, 128],
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
  } = volumeData;

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
        console.error('[VolumeVisualizer] Failed to load volume:', err);
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
  const volumeMaterial = useMemo(() => {
    if (!volumeTexture || !colormapTextureRef.current) return null;

    // Create identity matrix for modelMatrixInverse (will be updated in mesh)
    const modelMatrixInverse = new THREE.Matrix4();
    const dummyDepth = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
    dummyDepth.needsUpdate = true;
    const initialViewportSize = gl.getDrawingBufferSize(new THREE.Vector2());

    // Get shared blue noise texture for stochastic jittering
    const blueNoiseTexture = getBlueNoiseTexture();

    return new THREE.ShaderMaterial({
      uniforms: {
        volumeTexture: { value: volumeTexture },
        colormapTexture: { value: colormapTextureRef.current },
        blueNoiseTexture: { value: blueNoiseTexture },
        modelMatrixInverse: { value: modelMatrixInverse },
        uModelMatrix: { value: new THREE.Matrix4() },
        uViewMatrix: { value: new THREE.Matrix4() },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        volumeResolution: { value: new THREE.Vector3(textureResolution[0], textureResolution[1], textureResolution[2]) },
        opacityScale: { value: opacity_scale },
        densityScale: { value: density_scale },
        absorptionScale: { value: absorptionScale },
        valueMin: { value: value_min },
        valueMax: { value: value_max },
        logColormap: { value: log_colormap },
        raySteps: { value: ray_steps },
        showSlice: { value: show_slice },
        slicePlane: { value: slicePlaneInt },
        slicePosition: { value: slice_position },
        sceneDepthTexture: { value: dummyDepth },
        viewportSize: { value: initialViewportSize },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far }
      },
      vertexShader: volumeVertexShader,
      fragmentShader: volumeFragmentShader,
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
      if (volumeMaterial) {
        volumeMaterial.dispose();
      }
    };
  }, [volumeMaterial]);

  // Mark the mesh so the depth prepass can skip raymarching cubes
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.userData[VOLUME_DEPTH_SKIP_FLAG] = true;
    }
  }, [volumeMaterial]);

  // Update all uniforms every frame to ensure synchronization
  useFrame(() => {
    if (!meshRef.current || !volumeMaterial) return;

    // Update modelMatrixInverse uniform with mesh's world matrix inverse
    meshRef.current.updateMatrixWorld();
    const invMatrix = meshRef.current.matrixWorld.clone().invert();
    volumeMaterial.uniforms.modelMatrixInverse.value.copy(invMatrix);
    volumeMaterial.uniforms.uModelMatrix.value.copy(meshRef.current.matrixWorld);
    volumeMaterial.uniforms.uViewMatrix.value.copy(camera.matrixWorldInverse);
    volumeMaterial.uniforms.uProjectionMatrix.value.copy(camera.projectionMatrix);

    // Update all parameter uniforms every frame (ensures real-time response)
    // Use actual texture resolution, not UI resolution (for correct gradient calculation)
    volumeMaterial.uniforms.volumeResolution.value.set(textureResolution[0], textureResolution[1], textureResolution[2]);
    volumeMaterial.uniforms.opacityScale.value = opacity_scale;
    volumeMaterial.uniforms.densityScale.value = density_scale;
    volumeMaterial.uniforms.absorptionScale.value = absorptionScale;
    volumeMaterial.uniforms.valueMin.value = value_min;
    volumeMaterial.uniforms.valueMax.value = value_max;
    volumeMaterial.uniforms.logColormap.value = log_colormap;
    volumeMaterial.uniforms.raySteps.value = ray_steps;
    volumeMaterial.uniforms.showSlice.value = show_slice;
    volumeMaterial.uniforms.slicePlane.value = slicePlaneInt;
    volumeMaterial.uniforms.slicePosition.value = slice_position;
    gl.getDrawingBufferSize(drawingBufferSize);
    volumeMaterial.uniforms.viewportSize.value.copy(drawingBufferSize);
    volumeMaterial.uniforms.cameraNear.value = camera.near;
    volumeMaterial.uniforms.cameraFar.value = camera.far;

    const depthTexture = getVolumeDepthTexture();
    if (depthTexture) {
      volumeMaterial.uniforms.sceneDepthTexture.value = depthTexture;
    }

    if (colormapTextureRef.current) {
      volumeMaterial.uniforms.colormapTexture.value = colormapTextureRef.current;
    }
  });

  // Render error state or placeholder
  const showPlaceholder = error || !volume || !volumeMaterial;

  // Loading state: show 2D spinner
  if (loading && !volumeMaterial) {
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
      {/* Main volume rendering - raycast disabled (pure renderer, no click handling) */}
      <mesh ref={meshRef} material={volumeMaterial} raycast={() => null}>
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
export type { VolumeComponentData };

/**
 * Adapter component that wraps VolumeVisualizer with unified VisualizerProps interface
 */
const VolumeVisualizerAdapter: ReactTypes.FC<VisualizerProps<VolumeComponentData> & { assets: ViewportAssetsApi }> = ({
  data,
  assets,
  selected,
  hovered
}) => {
  return <VolumeVisualizer volumeData={data} assets={assets} selected={selected} hovered={hovered} />;
};

/**
 * Registration configuration for Volume visualizer
 */
export const volumeVisualizerConfig: VisualizerConfig<VolumeComponentData> = {
  name: 'volume',
  priority: 12,

  // Only match VolumeRenderer component (pure renderer)
  // Field components handle their own Volume rendering via FieldVisualizer + field3DRenderData
  matcher: (c) => c.name === 'VolumeRenderer',

  // Extract visualization data from component
  extractor: (comp) => {
    const volume = getComponentValue(comp, 'volume', null);
    // Only render if a volume resource is provided
    if (!volume) return null;

    return {
      volume,
      resolution: getComponentValue(comp, 'resolution', [128, 128, 128]),
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

  component: VolumeVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.6,
};

export default VolumeVisualizer;
