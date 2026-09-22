import type { AgentKind, ProviderWireProtocol } from '@cindy/model-providers';

import type { CustomProviderUpdateResult } from './customProviderUpdate.js';

export type CcSwitchSourceApp = 'claude' | 'codex' | 'pi';

export interface CcSwitchProviderSyncItemPreview {
  providerId: string;
  name: string;
  sourceApp: CcSwitchSourceApp;
  agent: AgentKind;
  baseUrl: string;
  protocol: ProviderWireProtocol;
  modelCount: number;
  hasApiKey: boolean;
  headerCount: number;
  action: 'create' | 'update';
}

export interface CcSwitchProviderSyncPreview {
  importId: string;
  items: CcSwitchProviderSyncItemPreview[];
  skippedCount: number;
}

export type CcSwitchProviderSyncResult =
  | {
      ok: true;
      created: number;
      updated: number;
      modelsPending: number;
      failed: number;
      providerIds: string[];
    }
  | Extract<CustomProviderUpdateResult, { ok: false }>;
