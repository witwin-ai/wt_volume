import type ReactTypes from 'react';
import { React } from './runtime';
import type { HostSceneObject, ViewportHost } from './sdk/types';
import VolumeVisualizer, { volumeVisualizerConfig } from './gizmos/VolumeVisualizer';
import SDFVisualizer, { sdfVisualizerConfig } from './gizmos/SDFVisualizer';
import PointCloudVisualizer, { pointCloudVisualizerConfig } from './gizmos/PointCloudVisualizer';
import FieldVisualizer, { fieldVisualizerConfig } from './gizmos/FieldVisualizer';
import FieldGizmo from './gizmos/FieldGizmo';
import { getComponentValue } from './gizmos/utils';

function findComponent(object: HostSceneObject, predicate: (component: any) => boolean): any | null {
  const components = Array.isArray(object.components) ? object.components : [];
  return components.find(predicate) || null;
}

function hasFieldComponent(object: HostSceneObject): boolean {
  return !!findComponent(object, (component) =>
    component?.name === 'Field' || component?.base_classes?.includes?.('Field')
  );
}

function fieldData(component: any, object: HostSceneObject): any {
  return fieldVisualizerConfig.extractor(component, object);
}

function FieldBoundsGizmoObject({
  object,
  selected,
  host,
}: {
  object: HostSceneObject;
  selected: boolean;
  hovered: boolean;
  host: ViewportHost;
}) {
  if (!selected) return null;
  const component = findComponent(object, (c) => c?.name === 'Field' || c?.base_classes?.includes?.('Field'));
  if (!component) return null;
  return (
    <FieldGizmo
      objectId={object.id}
      fieldData={fieldData(component, object)}
      isLocked={!!(object as any).locked}
      getObject={(objectId) => host.scene.getObjects()[objectId]}
      interaction={host.interaction}
      sceneWrites={host.sceneWrites}
    />
  );
}

function createFieldRenderingObject(host: ViewportHost): ReactTypes.FC<{
  object: HostSceneObject;
  selected: boolean;
  hovered: boolean;
}> {
  return function FieldRenderingObject({ object, selected }) {
    const component = findComponent(object, (c) => c?.name === 'Field' || c?.base_classes?.includes?.('Field'));
    if (!component) return null;
    const data = fieldData(component, object);
    const renderMode = data.render_mode || 'None';
    const volume = getComponentValue(component, 'volume', null);
    const min = data.min_bound || [-5, -5, -5];
    const max = data.max_bound || [5, 5, 5];
    const renderSize: [number, number, number] = [
      max[0] - min[0],
      max[1] - min[1],
      max[2] - min[2],
    ];
    const renderCenter: [number, number, number] = [
      (max[0] + min[0]) / 2,
      (max[1] + min[1]) / 2,
      (max[2] + min[2]) / 2,
    ];
    const sharedVolumeData = {
      volume,
      resolution: getComponentValue(component, 'resolution', [128, 128, 128]),
      colormap: data.colormap || 'inferno',
      log_colormap: data.log_colormap || false,
      opacity_scale: getComponentValue(component, 'opacity_scale', 1.0),
      density_scale: getComponentValue(component, 'density_scale', 1.0),
      display_range: getComponentValue(component, 'display_range', [0.0, 1.0]),
      ray_steps: getComponentValue(component, 'ray_steps', 128),
    };

    return (
      <>
        <FieldVisualizer
          fieldData={data}
          assets={host.assets}
          selected={selected}
          isGizmoDragging={host.interaction.isGizmoDragging()}
        />
        {renderMode === 'Volume' && volume && (
          <group position={renderCenter} scale={renderSize}>
            <VolumeVisualizer volumeData={sharedVolumeData} assets={host.assets} selected={false} hovered={false} />
          </group>
        )}
        {renderMode === 'SDF' && volume && (
          <group position={renderCenter} scale={renderSize}>
            <SDFVisualizer
              sdfData={{
                ...sharedVolumeData,
                ray_steps: getComponentValue(component, 'sdf_ray_steps', 128),
                render_technique: getComponentValue(component, 'sdf_technique', 'sdf'),
                iso_value: getComponentValue(component, 'iso_value', 0.0),
                enable_lighting: getComponentValue(component, 'enable_lighting', true),
              }}
              assets={host.assets}
              selected={false}
              hovered={false}
            />
          </group>
        )}
      </>
    );
  };
}

export function activateRenderingViewport(host: ViewportHost): void {
  host.registerVisualizer({
    id: 'witwin.volume.field',
    priority: 100,
    skipStandardGeometry: true,
    match: hasFieldComponent,
    component: createFieldRenderingObject(host),
  });
  host.registerGizmo({
    id: 'witwin.volume.field.bounds',
    priority: 100,
    match: hasFieldComponent,
    component: (props) => <FieldBoundsGizmoObject {...props} host={host} />,
  });
  host.registerVisualizer({
    id: 'witwin.volume.volume',
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, volumeVisualizerConfig.matcher),
    component: ({ object, selected, hovered }) => {
      const component = findComponent(object, volumeVisualizerConfig.matcher);
      const data = component ? volumeVisualizerConfig.extractor(component, object) : null;
      return data ? <VolumeVisualizer volumeData={data} assets={host.assets} selected={selected} hovered={hovered} /> : null;
    },
  });
  host.registerVisualizer({
    id: 'witwin.volume.sdf',
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, sdfVisualizerConfig.matcher),
    component: ({ object, selected, hovered }) => {
      const component = findComponent(object, sdfVisualizerConfig.matcher);
      const data = component ? sdfVisualizerConfig.extractor(component, object) : null;
      return data ? <SDFVisualizer sdfData={data} assets={host.assets} selected={selected} hovered={hovered} /> : null;
    },
  });
  host.registerVisualizer({
    id: 'witwin.volume.pointcloud',
    priority: 90,
    skipStandardGeometry: true,
    match: (object) => !!findComponent(object, pointCloudVisualizerConfig.matcher),
    component: ({ object, selected, hovered }) => {
      const component = findComponent(object, pointCloudVisualizerConfig.matcher);
      const data = component ? pointCloudVisualizerConfig.extractor(component, object) : null;
      return data ? <PointCloudVisualizer componentData={data} assets={host.assets} selected={selected} hovered={hovered} /> : null;
    },
  });
}
