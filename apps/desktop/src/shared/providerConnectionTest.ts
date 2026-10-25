import type { AgentKind, PiModelApi, ProviderWireProtocol, ProviderProtocolCandidate } from '@cindy/model-providers';
import type { ProviderErrorCode } from './providerErrors';

/** Public probe contract: saved secrets are resolved exclusively in Main. */
export interface ProviderConnectionProbeSpec {
  agent: AgentKind;
  baseUrl: string;
  modelId: string;
  authMethod?: 'apiKey' | 'oauth' | 'none';
  wireProtocol?: ProviderWireProtocol;
  api?: PiModelApi;
  catalogPresetId?: string;
  requestPath?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
}
export type ProviderConnectionTestInput = (
  | { kind: 'saved'; providerId: string; agent: AgentKind }
  | { kind: 'adhoc'; spec: ProviderConnectionProbeSpec }
) & { requestId?: string; strategy?: 'auto' };
export type ProviderConnectionTestRequest = ProviderConnectionTestInput | { kind: 'cancel'; requestId: string };
export type ProtocolProbeDecision = 'success' | 'next' | 'blocked' | 'inconclusive' | 'cancelled';
export interface ProtocolProbeAttempt extends ProviderProtocolCandidate {
  code?: ProviderErrorCode;
  status?: number;
  decision: ProtocolProbeDecision;
}
export interface ProviderConnectionTestResult {
  ok: boolean;
  code?: ProviderErrorCode;
  status?: number;
  latencyMs: number;
  detail?: string;
  decision?: ProtocolProbeDecision;
  selected?: ProviderProtocolCandidate;
  attempts?: ProtocolProbeAttempt[];
}
