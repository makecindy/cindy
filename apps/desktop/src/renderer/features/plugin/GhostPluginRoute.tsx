import type { ComponentType } from 'react';

type PluginPageLoader = () => Promise<{ GhostPluginPage: ComponentType }>;

export function createPluginPageLoader(importPage: PluginPageLoader) {
  let pageRequest: ReturnType<PluginPageLoader> | undefined;
  const loadPluginPage = () => (pageRequest ??= importPage());

  function preloadPluginPage() {
    // An intent alone must not show an error. Navigation observes the same
    // rejected promise and lets the existing section error boundary render it.
    if (!pageRequest) void loadPluginPage().catch(() => {});
  }

  return { loadPluginPage, preloadPluginPage };
}

export const { loadPluginPage, preloadPluginPage } = createPluginPageLoader(() =>
  import('./GhostPluginPage'),
);
