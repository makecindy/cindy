import { createManagedLlamaCppProvider } from '@cindy/model-providers/local-runtime/managedLlamaCppProvider';
import {
  createCustomProvider,
  getCustomProvider,
  updateCustomProviderIfUnchanged,
} from '../maker-host/custom-provider-store.js';
export * from '@cindy/model-providers/local-runtime/managedLlamaCppProvider';
export const { assertManagedLlamaCppProvider, ensureManagedLlamaCppProvider } =
  createManagedLlamaCppProvider({
    createCustomProvider,
    getCustomProvider,
    updateCustomProviderIfUnchanged,
  });
