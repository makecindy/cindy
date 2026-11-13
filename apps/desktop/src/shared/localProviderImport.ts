import type { AgentKind, ProviderWireProtocol } from '@cindy/model-providers';

export type LocalProviderSource = 'alma' | 'cc-switch' | 'claude-code' | 'codex' | 'opencode';
export type LocalProviderIssue =
  | 'missing'
  | 'readFailed'
  | 'invalid'
  | 'limit'
  | 'unsupported'
  | 'needsInput'
  | 'changed'
  | 'duplicate';
/** Secret-free projection, never a filesystem grant. */
export interface LocalProviderImportItem {
  importId: string;
  source: LocalProviderSource;
  name: string;
  issue?: LocalProviderIssue;
  disabled?: boolean;
  endpoints: {
    agent: AgentKind;
    protocol?: ProviderWireProtocol;
    baseUrl: string;
    hasCredential: boolean;
  }[];
}
export interface LocalProviderImportScan {
  items: LocalProviderImportItem[];
  sources: { source: LocalProviderSource; issue?: LocalProviderIssue }[];
}
/** Only allowed fields and an explicitly entered replacement key can be edited. */
export interface LocalProviderImportEdit {
  name: string;
  endpoints: { baseUrl: string; protocol: ProviderWireProtocol; apiKey?: string }[];
}
