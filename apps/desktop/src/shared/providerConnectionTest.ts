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
  /** 实际发出探测的模型 ID：已保存供应商由 Main 自己挑，渲染层据此标明「测的是哪个模型」。 */
  modelId?: string;
  decision?: ProtocolProbeDecision;
  selected?: ProviderProtocolCandidate;
  attempts?: ProtocolProbeAttempt[];
}
