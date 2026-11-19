import type { AgentKind } from '@cindy/model-providers';

export type CodexImageGenerationRestartPolicy = 'interrupt';

export interface CustomProviderUpdateOptions {
  source?: 'manual-settings';
  /** Local Settings additions, merged against the latest connection in Main. */
  appendSpeechModelsOnly?: true;
  /** Successful manual discovery routes; Main classifies the merged config before filling a reference. */
  speechReferenceRefreshAgents?: AgentKind[];
  codexImageGenerationRestartPolicy?: CodexImageGenerationRestartPolicy;
  /**
   * #11298: confirmed withdrawals. Main applies them to the latest saved connection
   * inside the provider mutation queue and removes only rows still marked
   * `listedUpstream` (not routed, not manual); the submitted config is ignored.
   */
  removeWithdrawnModels?: WithdrawnModelTarget[];
}

export interface WithdrawnModelTarget {
  agent: AgentKind;
  modelId: string;
}

export type CustomProviderUpdateResult =
  | {
      ok: true;
      speechReferenceAdded?: true;
      /** Rows actually removed by `removeWithdrawnModels` (may be fewer than requested). */
      withdrawnRemoved?: WithdrawnModelTarget[];
      /** Removed IDs no runtime keeps any more; provider-wide choices may be cleared. */
      withdrawnGoneIds?: string[];
    }
  | {
      ok: false;
      confirmationRequired: 'codex-image-generation-reload';
      busyCount: number;
    };
