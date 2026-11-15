/** Local settings projection. This does not expose bearer credentials or native session ids. */
export interface LocalAgentConnection {
  id: string;
  name: string;
  clientId?: string;
  createVisibleSessions?: boolean;
}

export interface LocalAgentSettingsApi {
  developerConnection(): Promise<LocalAgentDeveloperConnection | null>;
  connections(): Promise<LocalAgentConnection[]>;
  revoke(connectionId?: string): Promise<boolean>;
  setCreateVisibleSessions(connectionId: string, enabled: boolean): Promise<boolean>;
  onConnectionsChanged(listener: () => void): () => void;
  onConfirmation(listener: (request: LocalAgentConfirmation) => void): () => void;
  onConfirmationDismissed(listener: (requestId: string) => void): () => void;
  answerConfirmation(requestId: string, confirmed: boolean): Promise<boolean>;
}

/** Main-owned display copy. No grant, token or permission decision is sent here. */
export interface LocalAgentConfirmation {
  requestId: string;
  title: string;
  message: string;
  detail: string;
  confirmText: string;
  cancelText: string;
}

/** Unauthenticated build self-description; never proof of a publisher or an app grant. */
export interface LocalAgentInstanceInfo {
  kind: 'installed' | 'development';
  region: 'global' | 'cn' | 'dev';
}

export type LocalAgentDeveloperConnection =
  | { state: 'ready'; code: string }
  | { state: 'starting' | 'owner-unavailable' | 'host-in-use' | 'failed' | 'stopped' };

/** A locator for this API generation, not a credential. No persistent mapping is needed. */
export function formatLocalAgentConnectionCode(rpc: { port: number; instance: string }): string {
  if (
    !Number.isInteger(rpc.port) ||
    rpc.port < 1 ||
    rpc.port > 65535 ||
    !/^[A-Za-z0-9_-]{43}$/.test(rpc.instance)
  )
    throw new Error('Invalid local endpoint');
  return `cindy-local:v1:${rpc.port}:${rpc.instance}`;
}
