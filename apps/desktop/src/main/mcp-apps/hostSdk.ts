import source from '@modelcontextprotocol/ext-apps/app-with-deps?raw';
import viewStateSource from './viewStateSdk.js?raw';
import viewStateReactSource from './viewStateSdkReact.js?raw';

// Vite embeds the same pinned dependency as AppBridge. Only transient View
// documents carry these bytes when they fit the remote budget, never persisted cards.
export const hostAppSdkAsset = {
  source,
  addons: { 'cindy/view-state': { source: viewStateSource, reactSource: viewStateReactSource } },
};
