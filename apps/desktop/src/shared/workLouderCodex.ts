/** Work Louder Codex Micro settings, device state, and IPC contracts. */

export const WORKLOUDER_CODEX_GET_STATE_CHANNEL = 'worklouder-codex:get-state';
export const WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL = 'worklouder-codex:set-settings';
export const WORKLOUDER_CODEX_RESET_SETTINGS_CHANNEL = 'worklouder-codex:reset-settings';
export const WORKLOUDER_CODEX_OPEN_INPUT_MONITORING_CHANNEL =
  'worklouder-codex:open-input-monitoring-settings';
export const WORKLOUDER_CODEX_PROBE_CHANNEL = 'worklouder-codex:probe';
export const WORKLOUDER_CODEX_PUBLISH_TASKS_CHANNEL = 'worklouder-codex:publish-tasks';

/** One sidebar task, as the renderer reports it for the agent keys. */
export interface WorkLouderCodexPublishedTask {
  id: string;
  title: string | null;
  /** Epoch ms when it was pinned, or null when it is not. */
  pinnedAt: number | null;
}
export const WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL = 'worklouder-codex:state-changed';
export const WORKLOUDER_CODEX_ACTION_CHANNEL = 'worklouder-codex:action';

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

export const WORKLOUDER_CODEX_AGENT_SOURCES = ['recent', 'pinned', 'priority', 'custom'] as const;

export const WORKLOUDER_CODEX_COMMAND_SLOTS = [
  'ACT06',
  'ACT07',
  'ACT08',
  'ACT09',
  'ACT10',
  'ACT11',
  'ACT10_ACT11',
  'ACT12',
] as const;

export const WORKLOUDER_CODEX_ANALOG_DIRECTIONS = ['up', 'right', 'down', 'left'] as const;
export const WORKLOUDER_CODEX_ENCODER_ACTIONS = ['left', 'right', 'click', 'longPress'] as const;
export const WORKLOUDER_CODEX_ENCODER_MODES = [
  'session-switch',
  'composer-navigation',
  'reasoning',
  'conversation-scroll',
  'custom',
] as const;

export const WORKLOUDER_CODEX_COMMAND_IDS = [
  'composer.toggleFastMode',
  'approval.approve',
  'approval.decline',
  'forkTask',
  'composer.submit',
  'feedback',
  'toggleTerminal',
  'copyConversationMarkdown',
  'archiveTask',
  'newTask',
  'openBrowserTab',
  'toggleTaskPin',
  'toggleReviewTab',
  'composer.addPhotos',
  'settings',
  'manageTasks',
  'composer.increaseReasoningEffort',
  'composer.decreaseReasoningEffort',
  'openFolder',
  'composer.addFiles',
  'openSkills',
  'composer.togglePlanMode',
  'navigateForward',
  'toggleSidebar',
  'toggleRightSidebar',
  'navigateBack',
  'composer.focus',
  'conversation.scrollUp',
  'conversation.scrollDown',
  'conversation.scrollBottom',
  'session.selectPrevious',
  'session.selectNext',
] as const;

export const WORKLOUDER_CODEX_KEYCAP_IDS = [
  'FAST',
  'APPR',
  'REJ',
  'SPLIT',
  'MIC',
  'MIC1',
  'CODEX',
  'BUG',
  'OAI',
  'TERM',
  'DWN',
  'DEL',
  'NEW',
  'NAV',
  'MAGIC',
  'DIFF',
  'PLAY',
  'GIT',
  'BRCH',
  'BRANCH',
  'MRG',
  'PR',
  'PAINT',
  'LAB',
  'PARTY',
  'TIME',
  'MIND+',
  'MIND-',
  'EMPT1',
  'EMPT2',
  'EMPT3',
  'EMPT4',
  'EMPT5',
  'SETUP',
  'FOLD',
  'UPL',
  'APPS',
  'YOLO',
  'YEET',
] as const;

export type WorkLouderCodexAutoDim = (typeof WORKLOUDER_CODEX_AUTO_DIM_OPTIONS)[number];
export type WorkLouderCodexAgentSource = (typeof WORKLOUDER_CODEX_AGENT_SOURCES)[number];
export type WorkLouderCodexCommandSlot = (typeof WORKLOUDER_CODEX_COMMAND_SLOTS)[number];
export type WorkLouderCodexAnalogDirection = (typeof WORKLOUDER_CODEX_ANALOG_DIRECTIONS)[number];
export type WorkLouderCodexEncoderAction = (typeof WORKLOUDER_CODEX_ENCODER_ACTIONS)[number];
export type WorkLouderCodexEncoderMode = (typeof WORKLOUDER_CODEX_ENCODER_MODES)[number];
export type WorkLouderCodexCommandId = (typeof WORKLOUDER_CODEX_COMMAND_IDS)[number];
export type WorkLouderCodexKeycapId = (typeof WORKLOUDER_CODEX_KEYCAP_IDS)[number];

export type WorkLouderCodexAction =
  | { type: 'command'; commandId: WorkLouderCodexCommandId }
  | { type: 'task'; sessionId: string }
  | { type: 'keycap'; keycapId: WorkLouderCodexKeycapId }
  | { type: 'skill'; skillId: string; name: string }
  | { type: 'composer-text'; text: string }
  | { type: 'external-url'; url: string };

export interface WorkLouderCodexKeyAssignment {
  keycapId: WorkLouderCodexKeycapId;
  /** Null means use the physical keycap's built-in Cindy action. */
  action: WorkLouderCodexAction | null;
}

export interface WorkLouderCodexLayout {
  version: 1;
  slots: Record<WorkLouderCodexCommandSlot, WorkLouderCodexKeyAssignment>;
  analogStick: Record<WorkLouderCodexAnalogDirection, WorkLouderCodexAction | null>;
  encoder: Record<WorkLouderCodexEncoderAction, WorkLouderCodexAction | null>;
  encoderMode: WorkLouderCodexEncoderMode;
  separateMicrophoneKeys: boolean;
}

export interface WorkLouderCodexSettings {
  /** Overall lighting intensity, in percent. Zero keeps HID input active with LEDs off. */
  lightingBrightness: number;
  lightingAutoDim: WorkLouderCodexAutoDim;
  agentSource: WorkLouderCodexAgentSource;
  customAgentKeys: Array<WorkLouderCodexAction | null>;
  /** When false, a single press switches tasks and a double press brings Cindy forward. */
  singleTapAgentKeys: boolean;
  layout: WorkLouderCodexLayout;
}

export type WorkLouderCodexSettingsPatch = Partial<WorkLouderCodexSettings>;

export type WorkLouderCodexConnectionStatus =
  'connecting' | 'connected' | 'not-detected' | 'error' | 'unavailable';

export type WorkLouderCodexConnectionReason =
  'connection-timeout' | 'connection-failed' | 'permission-required' | 'sdk-unavailable' | null;

export interface WorkLouderCodexDeviceState {
  deviceType: 'codex-micro' | 'creator-micro-2' | null;
  isUsbConnection: boolean | null;
  firmwareVersion: string | null;
  batteryPercentage: number | null;
  isCharging: boolean | null;
  inputMonitoringPermission: 'granted' | 'denied' | 'unknown' | 'not-required';
}

export interface WorkLouderCodexTaskOption {
  id: string;
  title: string;
  pinned: boolean;
}

export interface WorkLouderCodexAgentSlotState {
  slot: number;
  sessionId: string | null;
  title: string | null;
  action: WorkLouderCodexAction | null;
}

export interface WorkLouderCodexState {
  connectionStatus: WorkLouderCodexConnectionStatus;
  connectionReason: WorkLouderCodexConnectionReason;
  device: WorkLouderCodexDeviceState;
  settings: WorkLouderCodexSettings;
  agentSlots: WorkLouderCodexAgentSlotState[];
  taskOptions: WorkLouderCodexTaskOption[];
  agentSlotCount: typeof WORKLOUDER_CODEX_AGENT_SLOT_COUNT;
}

export type WorkLouderCodexRendererAction =
  | Exclude<WorkLouderCodexAction, { type: 'task' }>
  // The microphone key behaves like Cindy's own microphone: a tap starts and a
  // second tap stops, holding it records until release. Both come out of the
  // same press/release pair, so the key has no mode to choose between.
  | { type: 'voice'; phase: 'press' | 'release' }
  // Held-stick scrolling. The stick reports how far it is pushed, and scrolling
  // should follow that continuously rather than jumping once per flick, so this
  // carries the pressure instead of collapsing to a one-shot command. Renderers
  // scroll every frame until `scroll-stop` arrives.
  | {
      type: 'scroll';
      direction: 'up' | 'down';
      /** How hard the stick is pushed, 0 at the activation point to 1 at full. */
      intensity: number;
    }
  | { type: 'scroll-stop' }
  | { type: 'keyboard'; key: 'ArrowUp' | 'ArrowDown' | 'Enter' };

/** Built-in Cindy behavior printed on each official Work Louder keycap. */
export const WORKLOUDER_CODEX_KEYCAP_ACTIONS: Readonly<
  Partial<Record<WorkLouderCodexKeycapId, WorkLouderCodexAction>>
> = {
  FAST: { type: 'command', commandId: 'composer.toggleFastMode' },
  APPR: { type: 'command', commandId: 'approval.approve' },
  REJ: { type: 'command', commandId: 'approval.decline' },
  SPLIT: { type: 'command', commandId: 'forkTask' },
  CODEX: { type: 'command', commandId: 'composer.submit' },
  BUG: { type: 'command', commandId: 'feedback' },
  OAI: { type: 'external-url', url: 'https://developers.openai.com' },
  TERM: { type: 'command', commandId: 'toggleTerminal' },
  DWN: { type: 'command', commandId: 'copyConversationMarkdown' },
  DEL: { type: 'command', commandId: 'archiveTask' },
  NEW: { type: 'command', commandId: 'newTask' },
  NAV: { type: 'command', commandId: 'openBrowserTab' },
  MAGIC: { type: 'command', commandId: 'toggleTaskPin' },
  DIFF: { type: 'command', commandId: 'toggleReviewTab' },
  PAINT: { type: 'command', commandId: 'composer.addPhotos' },
  LAB: { type: 'command', commandId: 'settings' },
  TIME: { type: 'command', commandId: 'manageTasks' },
  'MIND+': { type: 'command', commandId: 'composer.increaseReasoningEffort' },
  'MIND-': { type: 'command', commandId: 'composer.decreaseReasoningEffort' },
  SETUP: { type: 'command', commandId: 'settings' },
  FOLD: { type: 'command', commandId: 'openFolder' },
  UPL: { type: 'command', commandId: 'composer.addFiles' },
  APPS: { type: 'command', commandId: 'openSkills' },
  YOLO: { type: 'composer-text', text: ':yolo:' },
  YEET: { type: 'composer-text', text: ':yeet:' },
};

export const WORKLOUDER_CODEX_DEFAULT_LAYOUT: WorkLouderCodexLayout = {
  version: 1,
  slots: {
    ACT06: { keycapId: 'FAST', action: null },
    ACT07: { keycapId: 'APPR', action: null },
    ACT08: { keycapId: 'REJ', action: null },
    ACT09: { keycapId: 'SPLIT', action: null },
    ACT10: { keycapId: 'MIC1', action: null },
    ACT11: { keycapId: 'EMPT1', action: null },
    ACT10_ACT11: { keycapId: 'MIC', action: null },
    ACT12: { keycapId: 'CODEX', action: null },
  },
  // The stick maps to the two axes of the screen: up/down moves through the
  // conversation, left/right opens and closes the panel on that side.
  analogStick: {
    up: { type: 'command', commandId: 'conversation.scrollUp' },
    right: { type: 'command', commandId: 'toggleRightSidebar' },
    down: { type: 'command', commandId: 'conversation.scrollDown' },
    left: { type: 'command', commandId: 'toggleSidebar' },
  },
  encoder: { left: null, right: null, click: null, longPress: null },
  encoderMode: 'session-switch',
  separateMicrophoneKeys: false,
};

export const WORKLOUDER_CODEX_DEFAULT_SETTINGS: WorkLouderCodexSettings = {
  lightingBrightness: 100,
  lightingAutoDim: '3-minutes',
  agentSource: 'recent',
  customAgentKeys: Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, () => null),
  singleTapAgentKeys: false,
  layout: WORKLOUDER_CODEX_DEFAULT_LAYOUT,
};

export const WORKLOUDER_CODEX_EMPTY_DEVICE_STATE: WorkLouderCodexDeviceState = {
  deviceType: null,
  isUsbConnection: null,
  firmwareVersion: null,
  batteryPercentage: null,
  isCharging: null,
  inputMonitoringPermission: 'unknown',
};

export function cloneWorkLouderCodexLayout(layout: WorkLouderCodexLayout): WorkLouderCodexLayout {
  return {
    ...layout,
    slots: Object.fromEntries(
      WORKLOUDER_CODEX_COMMAND_SLOTS.map((slot) => [
        slot,
        {
          ...layout.slots[slot],
          action: cloneWorkLouderCodexAction(layout.slots[slot].action),
        },
      ]),
    ) as WorkLouderCodexLayout['slots'],
    analogStick: Object.fromEntries(
      WORKLOUDER_CODEX_ANALOG_DIRECTIONS.map((direction) => [
        direction,
        cloneWorkLouderCodexAction(layout.analogStick[direction]),
      ]),
    ) as WorkLouderCodexLayout['analogStick'],
    encoder: Object.fromEntries(
      WORKLOUDER_CODEX_ENCODER_ACTIONS.map((action) => [
        action,
        cloneWorkLouderCodexAction(layout.encoder[action]),
      ]),
    ) as WorkLouderCodexLayout['encoder'],
  };
}

export function cloneWorkLouderCodexSettings(
  settings: WorkLouderCodexSettings,
): WorkLouderCodexSettings {
  return {
    ...settings,
    customAgentKeys: settings.customAgentKeys.map(cloneWorkLouderCodexAction),
    layout: cloneWorkLouderCodexLayout(settings.layout),
  };
}

export function createWorkLouderCodexDefaultSettings(): WorkLouderCodexSettings {
  return cloneWorkLouderCodexSettings(WORKLOUDER_CODEX_DEFAULT_SETTINGS);
}

export function isWorkLouderCodexAutoDim(value: unknown): value is WorkLouderCodexAutoDim {
  return isStringOption(value, WORKLOUDER_CODEX_AUTO_DIM_OPTIONS);
}

export function isWorkLouderCodexAgentSource(value: unknown): value is WorkLouderCodexAgentSource {
  return isStringOption(value, WORKLOUDER_CODEX_AGENT_SOURCES);
}

export function isWorkLouderCodexCommandId(value: unknown): value is WorkLouderCodexCommandId {
  return isStringOption(value, WORKLOUDER_CODEX_COMMAND_IDS);
}

export function isWorkLouderCodexKeycapId(value: unknown): value is WorkLouderCodexKeycapId {
  return isStringOption(value, WORKLOUDER_CODEX_KEYCAP_IDS);
}

export function isWorkLouderCodexMicrophoneKeycap(
  keycapId: WorkLouderCodexKeycapId | null | undefined,
): boolean {
  return keycapId === 'MIC' || keycapId === 'MIC1';
}

export function isWorkLouderCodexEncoderMode(value: unknown): value is WorkLouderCodexEncoderMode {
  return isStringOption(value, WORKLOUDER_CODEX_ENCODER_MODES);
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

function isStringOption<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function cloneWorkLouderCodexAction(
  action: WorkLouderCodexAction | null,
): WorkLouderCodexAction | null {
  return action ? { ...action } : null;
}
