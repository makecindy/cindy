import type { AgentKind, CustomProviderConfig, DeploymentProvider, DiscoveredModel, ProviderPreset } from '@cindy/model-providers';
import type { ProviderErrorCode } from './providerErrors.js';

export interface DetectionCatalog {
  ok: boolean;
  models?: DiscoveredModel[];
  code?: ProviderErrorCode;
  status?: number;
}
export interface DeploymentDetectionResult {
  candidates: DeploymentProvider[];
  reason: 'matched' | 'conflict' | 'insufficient_evidence' | 'budget_exhausted';
  catalog?: DetectionCatalog;
}
/** In-memory handoff only. Never persisted or logged. */
export interface DetectedProviderDraft {
  preset: ProviderPreset;
  agent: AgentKind;
  config: CustomProviderConfig;
  apiKey: string;
  keys?: Partial<Record<AgentKind, string>>;
  catalog?: DetectionCatalog;
}
