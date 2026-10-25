import { createManagedOllamaProvider } from '@cindy/model-providers/local-runtime/managedOllamaProvider';
import * as host from '../maker-host/custom-provider-store.js';
export * from '@cindy/model-providers/local-runtime/managedOllamaProvider';
export const {
  markManagedOllamaRemoved,
  managedOllamaRemovalGeneration,
  emptyPiRuntime,
  emptyClaudeRuntime,
  emptyCodexRuntime,
  buildEmptyManagedOllamaProvider,
  toPlainRuntimeModel,
  toQwenRuntimeModel,
  migrateManagedOllamaProvider,
  migrateManagedOllamaOnCatalogLoad,
  syncManagedOllamaAgentProjections,
  readManagedOllamaProvider,
  ensureManagedOllamaProvider,
  upsertManagedOllamaModel,
  upsertManagedOllamaModels,
  removeManagedOllamaModel,
} = createManagedOllamaProvider(host);
