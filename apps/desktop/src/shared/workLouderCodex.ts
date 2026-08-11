/** Work Louder Codex Micro settings and IPC contract. */

export const WORKLOUDER_CODEX_GET_STATE_CHANNEL = 'worklouder-codex:get-state';
export const WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL = 'worklouder-codex:set-settings';
export const WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL = 'worklouder-codex:state-changed';

export const WORKLOUDER_CODEX_AGENT_SLOT_COUNT = 6;

export const WORKLOUDER_CODEX_AUTO_DIM_OPTIONS = [
  'off',
  '30-seconds',
  '1-minute',
  '3-minutes',
  '10-minutes',
  '30-minutes',
  '1-hour',
] as const;

export type WorkLouderCodexAutoDim = (typeof WORKLOUDER_CODEX_AUTO_DIM_OPTIONS)[number];

export interface WorkLouderCodexSettings {
  /** Overall lighting intensity, in percent. Zero keeps HID input active with LEDs off. */
  lightingBrightness: number;
  lightingAutoDim: WorkLouderCodexAutoDim;
  /** False requires two presses of the same Agent key within the double-tap window. */
  singleTapAgentKeys: boolean;
}

export type WorkLouderCodexSettingsPatch = Partial<WorkLouderCodexSettings>;

export type WorkLouderCodexConnectionStatus =
  'connecting' | 'connected' | 'not-detected' | 'error' | 'unavailable';

export interface WorkLouderCodexState {
  connectionStatus: WorkLouderCodexConnectionStatus;
  settings: WorkLouderCodexSettings;
  agentSource: 'recent';
  agentSlotCount: typeof WORKLOUDER_CODEX_AGENT_SLOT_COUNT;
}

export const WORKLOUDER_CODEX_DEFAULT_SETTINGS: WorkLouderCodexSettings = {
  lightingBrightness: 100,
  lightingAutoDim: '3-minutes',
  // Cindy shipped single-tap activation before this setting existed. Preserve that behavior.
  singleTapAgentKeys: true,
};

export function isWorkLouderCodexAutoDim(value: unknown): value is WorkLouderCodexAutoDim {
  return (
    typeof value === 'string' &&
    (WORKLOUDER_CODEX_AUTO_DIM_OPTIONS as readonly string[]).includes(value)
  );
}

export function workLouderCodexAutoDimMs(value: WorkLouderCodexAutoDim): number | null {
  switch (value) {
    case 'off':
      return null;
    case '30-seconds':
      return 30_000;
    case '1-minute':
      return 60_000;
    case '3-minutes':
      return 180_000;
    case '10-minutes':
      return 600_000;
    case '30-minutes':
      return 1_800_000;
    case '1-hour':
      return 3_600_000;
  }
}
