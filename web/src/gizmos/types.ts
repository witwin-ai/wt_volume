import type React from 'react';
import type { HostSceneObject } from '../sdk/types';

export interface VisualizerProps<T = unknown> {
  data: T;
  selected?: boolean;
  hovered?: boolean;
}

export type ComponentMatcher = (component: any) => boolean;
export type DataExtractor<T> = (component: any, object: HostSceneObject) => T | null;

export interface VisualizerConfig<T = unknown> {
  name: string;
  matcher: ComponentMatcher;
  extractor: DataExtractor<T>;
  component: React.ComponentType<any>;
  priority?: number;
  skipStandardGeometry?: boolean;
  labelOffset?: number;
}
