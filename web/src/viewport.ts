import type { PluginDefinition } from '@witwin/host';
import { activateRenderingViewport } from './activate';

export const sdkVersion = '2.0.0';

const plugin: PluginDefinition = {
  id: 'witwin.volume',
  inject: ['scene'],
  activate(host) {
    activateRenderingViewport(host);
  },
};

export default plugin;
