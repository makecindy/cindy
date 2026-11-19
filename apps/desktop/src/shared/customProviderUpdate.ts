import type { AgentKind } from '@cindy/model-providers';

export type CodexImageGenerationRestartPolicy = 'interrupt';

export interface CustomProviderUpdateOptions {
  /** Explicit opt-in from the Google Gemini API add wizard, on create only. */
  bindGeminiImages?: true;
  source?: 'manual-settings';
  /** Local Settings additions, merged against the latest connection in Main. */
  appendSpeechModelsOnly?: true;
  /** Successful manual discovery routes; Main classifies the merged config before filling a reference. */
  speechReferenceRefreshAgents?: AgentKind[];
  codexImageGenerationRestartPolicy?: CodexImageGenerationRestartPolicy;
}

export type CustomProviderUpdateResult =
  | { ok: true; speechReferenceAdded?: true }
  | {
      ok: false;
      confirmationRequired: 'codex-image-generation-reload';
      busyCount: number;
    };
