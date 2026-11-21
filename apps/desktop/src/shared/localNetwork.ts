/** macOS Local Network privacy, read and requested by this computer's own window only. */
export const LOCAL_NETWORK_LOCAL = {
  STATUS: 'local-network:status',
  REQUEST: 'local-network:request',
  CHANGED: 'local-network:changed',
} as const;

export type LocalNetworkAccess = 'granted' | 'denied' | 'unknown' | 'notRequired';

/**
 * Why the sidebar should remind the user. Only set while access is denied.
 * `controlEnabled`: the user just allowed same-account devices to control this computer.
 * `relayOnly`: same-account devices are connected but only through the relay.
 */
export type LocalNetworkReminder =
  | { reason: 'controlEnabled'; at: number }
  | { reason: 'relayOnly'; deviceIds: string[] };

export interface LocalNetworkState {
  access: LocalNetworkAccess;
  reminder: LocalNetworkReminder | null;
}

export interface LocalNetworkApi {
  /**
   * Current state; never opens System Settings. `probe: false` returns what Main already knows
   * without touching the LAN, so merely showing the app never triggers the system prompt.
   */
  status(options?: { probe?: boolean }): Promise<LocalNetworkState>;
  /** Shows the system prompt when macOS has not decided, otherwise opens System Settings. */
  request(): Promise<LocalNetworkState>;
  onChanged(callback: (state: LocalNetworkState) => void): () => void;
}
