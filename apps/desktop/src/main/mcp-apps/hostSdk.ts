import source from '@modelcontextprotocol/ext-apps/app-with-deps?raw';

// Vite embeds the same pinned dependency as AppBridge. Only transient View
// documents carry these bytes when they fit the remote budget, never persisted cards.
export const hostAppSdkAsset = {
  source,
};
