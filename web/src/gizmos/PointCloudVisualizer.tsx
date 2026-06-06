/**
 * Point Cloud Visualizer Component
 *
 * High-performance rendering of large point clouds using THREE.Points.
 * Features:
 * - Billboard circle particles (2D appearance)
 * - Heat-based color mapping with colormaps
 * - Mouse hover detection with tooltip
 * - Flexible metadata support
 */

import type ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import { React, THREE, useCallback, useEffect, useMemo, useRef, useState, useThree } from '../runtime';
import type { ThreeEvent } from '../runtime';
import { VisualizerConfig, VisualizerProps } from './types';
import { getComponentValue } from './utils';
import type { RenderResourceRef, ViewportAssetsApi } from '../sdk/types';

interface PointCloudComponentData {
  point_count: number;
  point_size: number;
  colormap: string;
  heat_min: number;
  heat_max: number;
  show_points: boolean;
  opacity: number;
  point_scale: number;
  space_mode: 'world' | 'screen';
  cloud: RenderResourceRef | null;
}

interface PointCloudRenderData {
  positions: Float32Array;
  heat: Float32Array;
  extra_data: Array<Record<string, unknown>>;
  count: number;
  point_size: number;
  colormap: string;
  heat_min: number;
  heat_max: number;
  show_points: boolean;
  opacity: number;
  point_scale: number;
  space_mode: 'world' | 'screen';
}

interface PointCloudVisualizerProps {
  componentData: PointCloudComponentData;
  assets: ViewportAssetsApi;
  selected?: boolean;
  hovered?: boolean;
}

// ===== Colormap Functions =====

type ColormapFunc = (v: number) => [number, number, number];

function infernoColormap(v: number): [number, number, number] {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.001 + t * 0.15, 0.001 + t * 0.06, 0.014 + t * 0.34];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.15 + t * 0.45, 0.07 + t * 0.09, 0.35 + t * 0.15];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.60 + t * 0.35, 0.16 + t * 0.36, 0.50 - t * 0.40];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.03, 0.52 + t * 0.42, 0.10 - t * 0.03];
  }
}

function plasmaColormap(v: number): [number, number, number] {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.05 + t * 0.35, 0.03 + t * 0.02, 0.53 + t * 0.17];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.40 + t * 0.40, 0.05 + t * 0.10, 0.70 - t * 0.20];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.80 + t * 0.15, 0.15 + t * 0.35, 0.50 - t * 0.30];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.95 + t * 0.05, 0.50 + t * 0.40, 0.20 - t * 0.10];
  }
}

function viridisColormap(v: number): [number, number, number] {
  if (v < 0.25) {
    const t = v / 0.25;
    return [0.267 + t * 0.015, 0.004 + t * 0.136, 0.329 + t * 0.128];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0.282 - t * 0.155, 0.140 + t * 0.426, 0.457 + t * 0.093];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [0.127 + t * 0.614, 0.566 + t * 0.307, 0.550 - t * 0.400];
  } else {
    const t = (v - 0.75) / 0.25;
    return [0.741 + t * 0.252, 0.873 + t * 0.033, 0.150 - t * 0.006];
  }
}

function jetColormap(v: number): [number, number, number] {
  if (v < 0.125) {
    const t = v / 0.125;
    return [0, 0, 0.5 + t * 0.5];
  } else if (v < 0.375) {
    const t = (v - 0.125) / 0.25;
    return [0, t, 1];
  } else if (v < 0.625) {
    const t = (v - 0.375) / 0.25;
    return [t, 1, 1 - t];
  } else if (v < 0.875) {
    const t = (v - 0.625) / 0.25;
    return [1, 1 - t, 0];
  } else {
    const t = (v - 0.875) / 0.125;
    return [1 - t * 0.5, 0, 0];
  }
}

function coolwarmColormap(v: number): [number, number, number] {
  if (v < 0.5) {
    const t = v / 0.5;
    return [0.23 + t * 0.77, 0.30 + t * 0.70, 0.75 + t * 0.25];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1.0, 1.0 - t * 0.70, 1.0 - t * 0.75];
  }
}

function bwrColormap(v: number): [number, number, number] {
  if (v < 0.5) {
    const t = v / 0.5;
    return [t, t, 1];
  } else {
    const t = (v - 0.5) / 0.5;
    return [1, 1 - t, 1 - t];
  }
}

function getColormapFunc(name: string): ColormapFunc {
  switch (name) {
    case 'inferno': return infernoColormap;
    case 'plasma': return plasmaColormap;
    case 'viridis': return viridisColormap;
    case 'jet': return jetColormap;
    case 'coolwarm': return coolwarmColormap;
    case 'bwr': return bwrColormap;
    default: return viridisColormap;
  }
}

// ===== Shader for circular billboard particles =====

const vertexShader = `
  attribute vec3 color;
  varying vec3 vColor;
  uniform float pointSize;      // base size (already *100 for screen mode)
  uniform float worldPointSize; // raw point_size for world mode (in world units)
  uniform float pointScale;
  uniform float pixelRatio;
  uniform float spaceMode;  // 0 = screen space, 1 = world space
  uniform float viewportHeight;

  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    float size;
    if (spaceMode > 0.5) {
      // World Space: size is in world units, gets smaller with perspective
      // Calculate pixel size based on world unit at this depth
      // projectionMatrix[1][1] = 1 / tan(fov/2), relates to vertical field of view
      float worldUnitInPixels = viewportHeight * projectionMatrix[1][1] / (-mvPosition.z * 2.0);
      // worldPointSize is the actual world size (e.g., 0.05 = 0.05 units)
      size = worldPointSize * pointScale * worldUnitInPixels * pixelRatio;
    } else {
      // Screen Space: constant screen size regardless of distance
      size = pointSize * pointScale * pixelRatio * 10.0;
    }

    gl_PointSize = clamp(size, 1.0, 256.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  varying vec3 vColor;
  uniform float opacity;

  void main() {
    // Create circular shape
    vec2 center = gl_PointCoord - vec2(0.5);
    float dist = length(center);

    // Smooth circle edge
    float alpha = 1.0 - smoothstep(0.4, 0.5, dist);

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(vColor, alpha * opacity);
  }
`;

// ===== Main Component =====

// Global tooltip element (created once)
let tooltipElement: HTMLDivElement | null = null;

// Remove any stale tooltip on module load
if (typeof document !== 'undefined') {
  const existing = document.querySelector('.pointcloud-tooltip');
  if (existing) {
    existing.remove();
  }
}

function getOrCreateTooltip(): HTMLDivElement {
  if (!tooltipElement || !document.body.contains(tooltipElement)) {
    tooltipElement = document.createElement('div');
    tooltipElement.className = 'pointcloud-tooltip';
    // Apply all styles inline to avoid CSS inheritance issues
    tooltipElement.style.position = 'fixed';
    tooltipElement.style.pointerEvents = 'none';
    tooltipElement.style.zIndex = '9999';
    tooltipElement.style.display = 'none';
    tooltipElement.style.background = '#2a2a2a';
    tooltipElement.style.color = '#ffffff';
    tooltipElement.style.border = '1px solid #444';
    tooltipElement.style.borderRadius = '4px';
    tooltipElement.style.padding = '8px';
    tooltipElement.style.fontSize = '11px';
    tooltipElement.style.fontFamily = '-apple-system, BlinkMacSystemFont, sans-serif';
    tooltipElement.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    tooltipElement.style.minWidth = '180px';
    tooltipElement.style.maxWidth = '300px';
    document.body.appendChild(tooltipElement);
  }
  return tooltipElement;
}

function showTooltip(x: number, y: number, position: [number, number, number], heat: number, extraData: Record<string, any>) {
  const tooltip = getOrCreateTooltip();

  // Use inline styles to avoid CSS issues
  const sectionStyle = 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:2px 0;line-height:1.4;';
  const labelStyle = 'color:#aaa;font-weight:500;flex-shrink:0;';
  const valueStyle = 'color:#fff;font-family:monospace;font-size:11px;text-align:right;';
  const dividerStyle = 'height:1px;background:#444;margin:4px 0;';

  let html = `
    <div style="${sectionStyle}">
      <span style="${labelStyle}">Position:</span>
      <span style="${valueStyle}">(${position[0].toFixed(2)}, ${position[1].toFixed(2)}, ${position[2].toFixed(2)})</span>
    </div>
    <div style="${sectionStyle}">
      <span style="${labelStyle}">Heat:</span>
      <span style="${valueStyle}">${heat.toFixed(3)}</span>
    </div>
  `;

  const entries = Object.entries(extraData || {});
  if (entries.length > 0) {
    html += `<div style="${dividerStyle}"></div>`;
    for (const [key, value] of entries) {
      html += `
        <div style="${sectionStyle}">
          <span style="${labelStyle}">${key}:</span>
          <span style="${valueStyle}">${String(value)}</span>
        </div>
      `;
    }
  }

  tooltip.innerHTML = html;
  tooltip.style.left = (x + 15) + 'px';
  tooltip.style.top = (y + 15) + 'px';
  tooltip.style.display = 'block';
}

function hideTooltip() {
  const tooltip = getOrCreateTooltip();
  tooltip.style.display = 'none';
}

function getPointPosition(
  positions: Float32Array,
  index: number
): [number, number, number] {
  return [
    positions[index * 3],
    positions[index * 3 + 1],
    positions[index * 3 + 2]
  ];
}

function getPointHeat(heat: Float32Array, index: number): number {
  return heat[index];
}

const PointCloudVisualizer: ReactTypes.FC<PointCloudVisualizerProps> = ({
  componentData,
  assets,
  selected,
  hovered
}) => {
  const pointsRef = useRef<ThreeTypes.Points>(null);
  const [pointData, setPointData] = useState<PointCloudRenderData | null>(null);
  const [loading, setLoading] = useState(false);
  const { gl, raycaster } = useThree();

  // Load point cloud data from server when the cloud resource changes
  useEffect(() => {
    if (!componentData.cloud) {
      setPointData(null);
      return;
    }

    setLoading(true);
    assets.loadPointCloud(componentData.cloud)
      .then(data => {
        setPointData({
          positions: data.positions,
          heat: data.heat,
          extra_data: data.extraData,
          count: data.count,
          point_size: componentData.point_size,
          colormap: componentData.colormap,
          heat_min: componentData.heat_min,
          heat_max: componentData.heat_max,
          show_points: componentData.show_points,
          opacity: componentData.opacity,
          point_scale: componentData.point_scale ?? 1.0,
          space_mode: componentData.space_mode ?? 'screen'
        });
      })
      .catch(err => {
        console.error('Failed to load point cloud:', err);
        setPointData(null);
      })
      .finally(() => setLoading(false));
  }, [assets, componentData.cloud?.assetId, componentData.cloud?.uri, componentData.point_size, componentData.colormap, componentData.heat_min, componentData.heat_max]);

  // Get colormap function
  const colormapFunc = useMemo(() => {
    return getColormapFunc(componentData.colormap);
  }, [componentData.colormap]);

  // Create geometry with positions and colors
  const geometry = useMemo(() => {
    if (!pointData) return null;

    const geo = new THREE.BufferGeometry();

    // Positions (already in Float32Array format)
    geo.setAttribute('position', new THREE.BufferAttribute(pointData.positions, 3));

    // Colors based on heat values
    const colors = new Float32Array(pointData.count * 3);
    for (let i = 0; i < pointData.count; i++) {
      const heatValue = pointData.heat[i];
      const normalized = (heatValue - pointData.heat_min) /
                        (pointData.heat_max - pointData.heat_min || 1);
      const clampedNormalized = Math.max(0, Math.min(1, normalized));
      const [r, g, b] = colormapFunc(clampedNormalized);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return geo;
  }, [pointData, colormapFunc]);

  // Create shader material
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        pointSize: { value: componentData.point_size * 100 },
        worldPointSize: { value: componentData.point_size },
        pointScale: { value: componentData.point_scale ?? 1.0 },
        opacity: { value: componentData.opacity },
        pixelRatio: { value: gl.getPixelRatio() },
        spaceMode: { value: componentData.space_mode === 'world' ? 1.0 : 0.0 },
        viewportHeight: { value: gl.domElement.clientHeight }
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending
    });
  }, [gl]);

  // Configure raycaster threshold for Points
  useEffect(() => {
    raycaster.params.Points = raycaster.params.Points || {};
    raycaster.params.Points.threshold = componentData.point_size * 2;
  }, [raycaster, componentData.point_size]);

  // Update material uniforms when props change
  useEffect(() => {
    if (material) {
      material.uniforms.pointSize.value = componentData.point_size * 100;
      material.uniforms.worldPointSize.value = componentData.point_size;
      material.uniforms.pointScale.value = componentData.point_scale ?? 1.0;
      material.uniforms.opacity.value = componentData.opacity;
      material.uniforms.spaceMode.value = componentData.space_mode === 'world' ? 1.0 : 0.0;
      material.uniforms.viewportHeight.value = gl.domElement.clientHeight;
    }
  }, [material, gl, componentData.point_size, componentData.point_scale, componentData.opacity, componentData.space_mode]);

  // Handle pointer move for hover detection
  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!pointData || !pointsRef.current) return;

    event.stopPropagation();

    // R3F already provides intersection in event
    const intersection = event.intersections.find(i => i.object === pointsRef.current);

    if (intersection && intersection.index !== undefined) {
      const idx = intersection.index;
      const position = getPointPosition(pointData.positions, idx);
      const heat = getPointHeat(pointData.heat, idx);
      const extraData = pointData.extra_data?.[idx] || {};

      showTooltip(event.clientX, event.clientY, position, heat, extraData);
    } else {
      hideTooltip();
    }
  }, [pointData]);

  // Handle pointer leave
  const handlePointerLeave = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    hideTooltip();
  }, []);

  // Hide tooltip on unmount
  useEffect(() => {
    return () => hideTooltip();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      geometry?.dispose();
      material?.dispose();
    };
  }, [geometry, material]);

  // Return null if no data or not showing
  if (!pointData || !geometry || !componentData.show_points) return null;
  if (loading) return null;

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    />
  );
};

/**
 * Adapter component that wraps PointCloudVisualizer with unified VisualizerProps interface
 */
const PointCloudVisualizerAdapter: ReactTypes.FC<VisualizerProps<PointCloudComponentData> & { assets: ViewportAssetsApi }> = ({
  data,
  assets,
  selected,
  hovered
}) => {
  return <PointCloudVisualizer componentData={data} assets={assets} selected={selected} hovered={hovered} />;
};

/**
 * Registration configuration for PointCloud visualizer
 */
export const pointCloudVisualizerConfig: VisualizerConfig<PointCloudComponentData> = {
  name: 'pointcloud',
  priority: 5,

  // Match PointClouds component
  matcher: (c) => c.name === 'PointClouds',

  // Extract visualization data from component
  // Always return data (even without a cloud resource) so object is selectable
  extractor: (comp) => ({
    point_count: getComponentValue(comp, 'point_count', 0),
    point_size: getComponentValue(comp, 'point_size', 0.05),
    colormap: getComponentValue(comp, 'colormap', 'viridis'),
    heat_min: getComponentValue(comp, 'heat_min', 0.0),
    heat_max: getComponentValue(comp, 'heat_max', 1.0),
    show_points: getComponentValue(comp, 'show_points', true),
    opacity: getComponentValue(comp, 'opacity', 1.0),
    point_scale: getComponentValue(comp, 'point_scale', 1.0),
    space_mode: getComponentValue(comp, 'space_mode', 'screen'),
    cloud: getComponentValue(comp, 'cloud', null),
  }),

  component: PointCloudVisualizerAdapter,
  skipStandardGeometry: true,
  labelOffset: 0.6,
};

export default PointCloudVisualizer;
