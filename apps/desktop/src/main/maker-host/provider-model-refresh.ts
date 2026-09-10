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
      // Images API key discovery must not wait on Codex chat refresh. ChatGPT
      // model/list is chat-only; a missing OAuth login still has to hit /v1/models.
      const chatApplied = await deps.refreshOpenAi();
      await deps.refreshOpenAiMedia();
      if (!chatApplied) {
        throw new Error('OpenAI model discovery did not apply to the current runtime');
      }
      return;
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
