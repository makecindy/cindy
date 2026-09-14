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
  refreshOpenAiMedia(): Promise<boolean>;
  refreshXai(): Promise<boolean>;
  refreshXaiMedia(): Promise<boolean>;
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
    case 'openai': {
      let chatApplied = false;
      let chatError: unknown;
      try {
        chatApplied = await deps.refreshOpenAi();
      } catch (error) {
        chatError = error;
      }
      const mediaApplied = await deps.refreshOpenAiMedia();
      if (chatApplied || mediaApplied) return;
      if (chatError) throw chatError;
      throw new Error('OpenAI model discovery did not apply to the current runtime');
    }
    case 'xai':
      if (!(await deps.refreshXai())) {
        throw new Error('xAI account model discovery did not apply to the current runtime');
      }
      if (!(await deps.refreshXaiMedia())) {
        throw new Error('xAI media model discovery did not produce a current snapshot');
      }
      return;
  }
}
