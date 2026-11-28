import type { ProviderView } from '@cindy/model-providers';

declare function createLegacyReceiver(options: {
  id: string;
  model: string;
  providerId: string | null;
  effort: string;
  fastMode: boolean;
  models: NonNullable<NonNullable<ProviderView['models']>['codex']>;
}): {
  capabilities(agent: 'codex'): {
    supportsSessionAgentSwitch: true;
    supportsSessionAgentSwitchCas?: true;
    hasFastMode: true;
    availableModels: unknown[];
  };
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  evidence(): Record<string, unknown>;
  close(): void;
};
export { createLegacyReceiver };
