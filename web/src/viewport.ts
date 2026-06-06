import type { ViewportHost } from './sdk/types';
import { activateRenderingViewport } from './activate';

export const sdkVersion = '1.0.0';

export function activate(host: ViewportHost): void {
  activateRenderingViewport(host);
}
