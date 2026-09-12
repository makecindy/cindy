import type { AgentKind, ProviderWireProtocol } from '@cindy/model-providers';

export interface ProviderImportRuntimePreview {
  agent: AgentKind;
  protocol: ProviderWireProtocol;
  baseUrl: string;
  modelCount: number;
  willFetchModels: boolean;
  hasApiKey: boolean;
  headerNames: string[];
  modelsUrl?: string;
}

export interface ProviderImportPreview {
  importId: string;
  kind: 'builtin' | 'custom';
  name: string;
  authMethod: 'apiKey' | 'oauth' | 'none';
  action: 'create' | 'update' | 'replace-key';
  providerId: string;
  existingProviderName?: string;
  runtimes: ProviderImportRuntimePreview[];
  updateTargets: { id: string; name: string }[];
  oauth?: {
    flow: 'authorization-code' | 'device-code';
    authorizeHost: string;
    tokenHost: string;
  };
}

export type ProviderImportConfirmResult =
  | {
      ok: true;
      providerId: string;
      authMethod: 'apiKey' | 'oauth' | 'none';
      modelsPending?: boolean;
    }
  | Extract<import('./customProviderUpdate').CustomProviderUpdateResult, { ok: false }>;
