/** macOS Local Network privacy, read and requested by this computer's own window only. */
export const LOCAL_NETWORK_LOCAL = {
  STATUS: 'local-network:status',
  REQUEST: 'local-network:request',
  CHANGED: 'local-network:changed',
} as const;

export type LocalNetworkAccess = 'granted' | 'denied' | 'unknown' | 'notRequired';

export type LocalNetworkSettingsStage = 'none' | 'standard' | 'separate';

export interface LocalNetworkRequestOptions {
  /** Open System Settings directly instead of only triggering the OS permission prompt. */
  openSettings?: boolean;
  /** Open a fresh System Settings window to bypass an unrelated sheet or sub-pane. */
  separateWindow?: boolean;
}

/**
 * Why the sidebar should remind the user. Only set while access is denied.
 * `controlEnabled`: the user just allowed same-account devices to control this computer.
 * `relayOnly`: same-account devices are connected but only through the relay.
 * `deviceIds` is always the current relay-only set, so one dismissal covers what was on screen.
 */
export type LocalNetworkReminder =
  | { reason: 'controlEnabled'; at: number; deviceIds: string[] }
  | { reason: 'relayOnly'; deviceIds: string[] };

export interface LocalNetworkState {
  access: LocalNetworkAccess;
  reminder: LocalNetworkReminder | null;
  /** Running macOS .app bundle path for local "Show in Finder" guidance. */
  appBundlePath?: string;
  /** Tracks whether System Settings was already opened while denied, for separate-window retry. */
  settingsOpenStage?: LocalNetworkSettingsStage;
}

export interface LocalNetworkApi {
  /**
   * Current state; never opens System Settings. `probe: false` returns what Main already knows
   * without touching the LAN, so merely showing the app never triggers the system prompt.
   */
  status(options?: { probe?: boolean }): Promise<LocalNetworkState>;
  /**
   * Without `openSettings`, probes the LAN in the foreground to trigger the one-time macOS
   * prompt without stealing focus to System Settings. Pass `{ openSettings: true }` to open
   * Privacy & Security in System Settings (and `{ openSettings: true, separateWindow: true }`
   * to open a fresh System Settings window).
   */
  request(options?: LocalNetworkRequestOptions): Promise<LocalNetworkState>;
  onChanged(callback: (state: LocalNetworkState) => void): () => void;
}
