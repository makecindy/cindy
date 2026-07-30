/**
 * Built-in provider model-list refresh dispatcher.
 *
 * Each provider keeps its existing source-specific discovery implementation; this
 * module only gives the Settings IPC one deterministic, testable entry point.
 */

import type { BuiltinRefreshableProviderId } from '../../shared/providerModelRefresh.js';

export interface BuiltinProviderModelRefreshDeps {
  refreshXd(): Promise<void>;
  refreshAnthropic(): Promise<boolean>;
  refreshOpenAi(): Promise<boolean>;
  refreshXaiCatalog(): Promise<void>;
}

export async function refreshBuiltinProviderModels(
  providerId: BuiltinRefreshableProviderId,
  deps: BuiltinProviderModelRefreshDeps,
): Promise<void> {
  switch (providerId) {
    case 'xd':
      await deps.refreshXd();
      return;
    case 'anthropic':
      if (!(await deps.refreshAnthropic())) {
        throw new Error('Anthropic model discovery did not produce a current snapshot');
      }
      return;
    case 'openai':
      if (!(await deps.refreshOpenAi())) {
        throw new Error('OpenAI model discovery did not apply to the current runtime');
      }
      return;
    case 'xai':
      await deps.refreshXaiCatalog();
  }
}
