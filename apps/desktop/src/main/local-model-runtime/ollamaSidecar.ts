import { createOllamaSidecar } from '@cindy/model-providers/local-runtime/ollamaSidecar';
export * from '@cindy/model-providers/local-runtime/ollamaSidecar';
export const { stopManagedSidecar, spawnManagedSidecar, registerManagedSidecarQuitHook } =
  createOllamaSidecar();
