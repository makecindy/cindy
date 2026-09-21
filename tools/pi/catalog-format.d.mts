import type { ProviderModelRecord } from '../../packages/model-providers/src/providerModelCatalog.js';
export interface PiImportModel {
  id: string;
  provider: string;
  api: string;
  baseUrl?: string;
  name?: string;
  contextWindow: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
}
export function toCindyProviderModel(row: PiImportModel): ProviderModelRecord;
export function toCindyCatalog(providers: Record<string, PiImportModel[]>, generatedAt: string): {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  providers: Record<string, ProviderModelRecord[]>;
};
