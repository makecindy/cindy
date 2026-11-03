import type { AgentKind, DiscoveredModel } from '@cindy/model-providers';

/** Non-secret binding to the Main route/credential snapshot used for discovery. */
export interface CustomProviderDiscoverySnapshot {
  providerId: string;
  agent: AgentKind;
  ownerGeneration: number;
  ownerId: string;
  credentialRevision: number;
  routeSignature: string;
}

export interface CustomProviderDiscoveryDelta {
  snapshot: CustomProviderDiscoverySnapshot;
  models: DiscoveredModel[];
}

export interface SavedProviderModelsFetchInput {
  kind: 'saved';
  providerId: string;
  agent: AgentKind;
}

export type CodexImageGenerationRestartPolicy = 'interrupt';

export interface CustomProviderUpdateOptions {
  discovery?: CustomProviderDiscoveryDelta[];
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
