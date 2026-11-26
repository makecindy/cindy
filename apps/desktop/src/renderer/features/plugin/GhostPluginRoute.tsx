import type { ComponentType } from 'react';

type PluginPageLoader = () => Promise<{ GhostPluginPage: ComponentType }>;

export function createPluginPageLoader(importPage: PluginPageLoader) {
  let pageRequest: ReturnType<PluginPageLoader> | undefined;
  const loadPluginPage = () => (pageRequest ??= importPage().catch((error: unknown) => {
    pageRequest = undefined;
    throw error;
  }));

  function preloadPluginPage() {
    // An intent alone must not show an error. A navigation already waiting on
    // the same request observes that error through its section boundary.
    if (!pageRequest) void loadPluginPage().catch(() => {});
  }

  return { loadPluginPage, preloadPluginPage };
}

export const { loadPluginPage, preloadPluginPage } = createPluginPageLoader(() =>
  import('./GhostPluginPage'),
);
