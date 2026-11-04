import type { ComponentType, ReactNode } from 'react';

export interface Disposable {
  dispose(): void;
}

export type OverlayZone =
  | 'toolbar.left'
  | 'toolbar.right'
  | 'toolbar.bottom'
  | 'overlay.topLeft'
  | 'overlay.topRight'
  | 'overlay.bottomLeft'
  | 'overlay.bottomRight';

export interface HostSceneObject {
  id: string;
  name: string;
  components?: unknown[];
  [key: string]: unknown;
}

export interface VisualizerConfig {
  id: string;
  match: (object: HostSceneObject) => boolean;
  component: ComponentType<{ object: HostSceneObject; selected: boolean; hovered: boolean }>;
  priority?: number;
  skipStandardGeometry?: boolean;
}

/** Viewport tool (Q/W/E/R/T); Studio hosts from the Bounds tool on pass it to gizmos. */
export type TransformToolName = 'select' | 'translate' | 'rotate' | 'scale' | 'bounds';

export interface GizmoProvider {
  id: string;
  match: (object: HostSceneObject) => boolean;
  /** `tool` is the active viewport tool while the object is selected; older hosts omit it. */
  component: ComponentType<{ object: HostSceneObject; selected: boolean; hovered: boolean; tool?: TransformToolName }>;
  priority?: number;
}

export interface RenderPass {
  id: string;
  component: ComponentType<Record<string, unknown>>;
  priority?: number;
  params?: Record<string, unknown>;
}

export interface ViewportTool {
  id: string;
  label: string;
  icon?: string;
  editMode?: boolean;
  subObjectModes?: Array<'object' | 'vertex' | 'edge' | 'face'>;
  onPointer?: (event: unknown) => void;
  onCommit?: () => void;
}

export interface RenderResourceRef {
  assetId: string;
  uri: string;
  kind: 'volume' | 'sdf' | 'gaussian_splats' | 'mesh' | 'ray_batch' | string;
  format: string;
  byteLength?: number;
  contentHash?: string;
  version?: number;
  sceneId?: string;
  shape?: number[];
  bounds?: [number, number, number, number, number, number] | number[];
  attributes?: Record<string, unknown>;
}

export interface BinaryFetchOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total?: number) => void;
}

export interface VolumeTextureResource {
  ref: RenderResourceRef;
  data: Float32Array;
  resolution: [number, number, number];
  sizeBytes: number;
  dispose?: () => void;
}

export interface ViewportAssetsApi {
  resolve(ref: RenderResourceRef | string): string;
  fetchBinary(ref: RenderResourceRef | string, options?: BinaryFetchOptions): Promise<ArrayBuffer>;
  loadVolume(ref: RenderResourceRef, options?: BinaryFetchOptions): Promise<VolumeTextureResource>;
  release(resource: { dispose?: () => void }): void;
}

export interface ViewportInteractionApi {
  setGizmoDragging(active: boolean): void;
  isGizmoDragging(): boolean;
}

export interface ViewportSceneWriteApi {
  updateComponentField(
    objectId: string,
    componentName: string,
    fieldName: string,
    value: unknown
  ): Promise<void>;
  updateObjectTransform(
    objectId: string,
    transform: {
      position?: [number, number, number];
      rotation?: [number, number, number, number] | [number, number, number];
      scale?: [number, number, number];
    }
  ): Promise<void>;
}

/** A native React panel (host SDK RFC-014; layout fields since SDK 1.8). */
export interface PanelConfig {
  id: string;
  title: string;
  /** lucide-react icon name. */
  icon?: string;
  component: ComponentType<{ panelId: string }>;
  track?: 'side' | 'bottom' | 'peer';
  family?: string;
}

export interface ViewportHost {
  readonly version: string;
  readonly pluginId: string;
  registerVisualizer(cfg: VisualizerConfig): Disposable;
  registerGizmo(cfg: GizmoProvider): Disposable;
  registerOverlay(zone: OverlayZone, render: () => ReactNode): Disposable;
  registerPass(pass: RenderPass): Disposable;
  registerTool(tool: ViewportTool): Disposable;
  registerPanel(cfg: PanelConfig): Disposable;
  readonly scene: {
    getObjects(): Record<string, HostSceneObject>;
    getSelection(): string[];
    subscribe(listener: () => void): () => void;
  };
  readonly commands: { execute(id: string, args?: unknown): Promise<unknown> };
  readonly contextKeys: { set(k: string, v: unknown): void; get(k: string): unknown };
  readonly assets: ViewportAssetsApi;
  readonly interaction: ViewportInteractionApi;
  readonly sceneWrites: ViewportSceneWriteApi;
  /** Host widgets for native panels; Button since SDK 1.2. */
  readonly ui: { Button?: ComponentType<any> };
}

export interface ViewportHostModule {
  sdkVersion?: string;
  activate(host: ViewportHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
