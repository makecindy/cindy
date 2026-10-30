/** Work Louder Codex Micro settings, device state, and IPC contracts. */

import {
  INPUT_DEVICE_COMMAND_IDS,
  isInputDeviceCommandId,
  type InputDeviceAction,
  type InputDeviceCommandId,
  type InputDeviceDescriptor,
  type InputDevicePublishedTask,
  type InputDeviceRendererAction,
} from './inputDevices';

export const WORKLOUDER_CODEX_DEVICE_ID = 'worklouder-codex-micro';
export const WORKLOUDER_CREATOR_MICRO_2_DEVICE_ID = 'worklouder-creator-micro-2';

export const WORKLOUDER_MODELS = ['codex-micro', 'creator-micro-2'] as const;
export type WorkLouderModel = (typeof WORKLOUDER_MODELS)[number];
/** Settings currently lists both Work Louder boards. */
export const VISIBLE_WORKLOUDER_MODELS = WORKLOUDER_MODELS;

export const WORKLOUDER_CODEX_DEVICE: InputDeviceDescriptor = {
  id: WORKLOUDER_CODEX_DEVICE_ID,
  label: 'Work Louder Codex Micro',
  capabilities: [
    { kind: 'task-slots', count: 6 },
    { kind: 'commands' },
    { kind: 'voice' },
    { kind: 'encoder' },
    { kind: 'stick' },
    { kind: 'lighting', model: 'task-slots' },
  ],
};

export const WORKLOUDER_CREATOR_MICRO_2_DEVICE: InputDeviceDescriptor = {
  id: WORKLOUDER_CREATOR_MICRO_2_DEVICE_ID,
  label: 'Work Louder Creator Micro 2',
  capabilities: WORKLOUDER_CODEX_DEVICE.capabilities,
};

export const WORKLOUDER_DEVICES: Record<WorkLouderModel, InputDeviceDescriptor> = {
  'codex-micro': WORKLOUDER_CODEX_DEVICE,
  'creator-micro-2': WORKLOUDER_CREATOR_MICRO_2_DEVICE,
};

export function isWorkLouderModel(value: unknown): value is WorkLouderModel {
  return typeof value === 'string' && (WORKLOUDER_MODELS as readonly string[]).includes(value);
}

export const WORKLOUDER_CODEX_GET_STATE_CHANNEL = 'worklouder-codex:get-state';
export const WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL = 'worklouder-codex:set-settings';
export const WORKLOUDER_CODEX_RESET_SETTINGS_CHANNEL = 'worklouder-codex:reset-settings';
export const WORKLOUDER_CODEX_OPEN_INPUT_MONITORING_CHANNEL =
  'worklouder-codex:open-input-monitoring-settings';
export const WORKLOUDER_CODEX_PROBE_CHANNEL = 'worklouder-codex:probe';
export const WORKLOUDER_CODEX_PUBLISH_TASKS_CHANNEL = 'worklouder-codex:publish-tasks';
export const WORKLOUDER_CODEX_SET_LAYOUT_PREVIEW_CHANNEL = 'worklouder-codex:set-layout-preview';

/** One sidebar task, as the renderer reports it for the agent keys. */
export type WorkLouderCodexPublishedTask = InputDevicePublishedTask;
export const WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL = 'worklouder-codex:state-changed';
export const WORKLOUDER_CODEX_ACTION_CHANNEL = 'worklouder-codex:action';
export const WORKLOUDER_CODEX_PREVIEW_INPUT_CHANNEL = 'worklouder-codex:preview-input';

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

export const WORKLOUDER_CODEX_AGENT_SOURCES = ['sidebar', 'last-sent', 'priority', 'custom'] as const;

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

/** Physical 1U keys on Creator Micro 2, in board order. */
export const WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS = [
  'AG00',
  'AG01',
  'AG02',
  'AG03',
  'AG04',
  'AG05',
  'ACT06',
  'ACT07',
  'ACT08',
  'ACT09',
  'ACT10',
  'ACT11',
  'ACT12',
] as const;
export type WorkLouderCreatorProgrammableKey =
  (typeof WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS)[number];

export const WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS = [
  'AG00',
  'AG01',
  'AG02',
  'AG03',
  'AG04',
  'AG05',
] as const satisfies readonly WorkLouderCreatorProgrammableKey[];

export const WORKLOUDER_CREATOR_KEYMAP_LAYOUT: readonly (readonly WorkLouderCreatorProgrammableKey[])[] =
  [
    ['AG00', 'AG01'],
    ['AG02', 'AG03', 'AG04', 'AG05'],
    ['ACT06', 'ACT07', 'ACT08', 'ACT09'],
    ['ACT10', 'ACT11', 'ACT12'],
  ];

/** 4×4 board cells. Encoder, analog stick, and status lights occupy the other three. */
export const WORKLOUDER_KEY_CELL: Record<
  WorkLouderCreatorProgrammableKey,
  { row: number; col: number }
> = {
  AG00: { row: 0, col: 1 },
  AG01: { row: 0, col: 2 },
  AG02: { row: 1, col: 0 },
  AG03: { row: 1, col: 1 },
  AG04: { row: 1, col: 2 },
  AG05: { row: 1, col: 3 },
  ACT06: { row: 2, col: 0 },
  ACT07: { row: 2, col: 1 },
  ACT08: { row: 2, col: 2 },
  ACT09: { row: 2, col: 3 },
  ACT10: { row: 3, col: 1 },
  ACT11: { row: 3, col: 2 },
  ACT12: { row: 3, col: 3 },
};

export type WorkLouderMergeDirection = 'right' | 'down';

/** A 2U cap covering `origin` and the neighbor `cover` (right or down). */
export interface WorkLouderKeyMerge {
  origin: WorkLouderCreatorProgrammableKey;
  cover: WorkLouderCreatorProgrammableKey;
}

function workLouderKeyAt(row: number, col: number): WorkLouderCreatorProgrammableKey | null {
  for (const key of WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS) {
    const cell = WORKLOUDER_KEY_CELL[key];
    if (cell.row === row && cell.col === col) return key;
  }
  return null;
}

export function workLouderMergeNeighbor(
  origin: WorkLouderCreatorProgrammableKey,
  direction: WorkLouderMergeDirection,
): WorkLouderCreatorProgrammableKey | null {
  const cell = WORKLOUDER_KEY_CELL[origin];
  return direction === 'right'
    ? workLouderKeyAt(cell.row, cell.col + 1)
    : workLouderKeyAt(cell.row + 1, cell.col);
}

export function workLouderMergeDirectionOf(
  merge: WorkLouderKeyMerge,
): WorkLouderMergeDirection | null {
  if (workLouderMergeNeighbor(merge.origin, 'right') === merge.cover) return 'right';
  if (workLouderMergeNeighbor(merge.origin, 'down') === merge.cover) return 'down';
  return null;
}

export function normalizeWorkLouderMerges(raw: unknown): WorkLouderKeyMerge[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<WorkLouderCreatorProgrammableKey>();
  const merges: WorkLouderKeyMerge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as { origin?: unknown; cover?: unknown };
    if (!isWorkLouderCreatorProgrammableKey(record.origin)) continue;
    if (!isWorkLouderCreatorProgrammableKey(record.cover)) continue;
    if (!workLouderMergeDirectionOf({ origin: record.origin, cover: record.cover })) continue;
    if (used.has(record.origin) || used.has(record.cover)) continue;
    used.add(record.origin);
    used.add(record.cover);
    merges.push({ origin: record.origin, cover: record.cover });
  }
  return merges;
}

export function workLouderMergesFromMicrophoneFlag(
  separateMicrophoneKeys: boolean,
): WorkLouderKeyMerge[] {
  return separateMicrophoneKeys ? [] : [{ origin: 'ACT10', cover: 'ACT11' }];
}

export function workLouderLayoutMerges(layout: {
  merges?: unknown;
  separateMicrophoneKeys: boolean;
}): WorkLouderKeyMerge[] {
  if (layout.merges !== undefined) return normalizeWorkLouderMerges(layout.merges);
  return workLouderMergesFromMicrophoneFlag(layout.separateMicrophoneKeys);
}

export function workLouderMicrophoneKeysSeparate(
  merges: readonly WorkLouderKeyMerge[],
): boolean {
  return !merges.some((merge) => merge.origin === 'ACT10' && merge.cover === 'ACT11');
}

export function workLouderMergeForKey(
  merges: readonly WorkLouderKeyMerge[],
  key: string,
): WorkLouderKeyMerge | null {
  return merges.find((merge) => merge.origin === key || merge.cover === key) ?? null;
}

export function workLouderAvailableMergeDirections(
  merges: readonly WorkLouderKeyMerge[],
  origin: WorkLouderCreatorProgrammableKey,
): WorkLouderMergeDirection[] {
  const used = new Set(merges.flatMap((merge) => [merge.origin, merge.cover]));
  used.delete(origin);
  const current = workLouderMergeForKey(merges, origin);
  if (current?.origin === origin) used.delete(current.cover);
  const directions: WorkLouderMergeDirection[] = [];
  for (const direction of ['right', 'down'] as const) {
    const cover = workLouderMergeNeighbor(origin, direction);
    if (cover && !used.has(cover)) directions.push(direction);
  }
  return directions;
}

export function addWorkLouderMerge(
  merges: readonly WorkLouderKeyMerge[],
  origin: WorkLouderCreatorProgrammableKey,
  direction: WorkLouderMergeDirection,
): WorkLouderKeyMerge[] {
  const cover = workLouderMergeNeighbor(origin, direction);
  if (!cover) return [...merges];
  return [
    ...merges.filter(
      (merge) =>
        merge.origin !== origin &&
        merge.cover !== origin &&
        merge.origin !== cover &&
        merge.cover !== cover,
    ),
    { origin, cover },
  ];
}

export function removeWorkLouderMerge(
  merges: readonly WorkLouderKeyMerge[],
  key: string,
): WorkLouderKeyMerge[] {
  return merges.filter((merge) => merge.origin !== key && merge.cover !== key);
}

/** Firmware thread id N lights KV_OAI_AG0N. Extra task keys have no AG thread. */
export const WORKLOUDER_HID_AG_CODES = [
  'AG00',
  'AG01',
  'AG02',
  'AG03',
  'AG04',
  'AG05',
  'AG06',
  'AG07',
  'AG08',
  'AG09',
  'AG10',
  'AG11',
  'AG12',
] as const;
export const WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT = WORKLOUDER_HID_AG_CODES.length;
const WORKLOUDER_HID_ACT_CODES = [
  'ACT06',
  'ACT07',
  'ACT08',
  'ACT09',
  'ACT10',
  'ACT11',
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

export const WORKLOUDER_CODEX_COMMAND_IDS = INPUT_DEVICE_COMMAND_IDS;

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
export type WorkLouderCodexPreviewPart =
  | WorkLouderCodexCommandSlot
  | `AG0${0 | 1 | 2 | 3 | 4 | 5}`
  | 'analog'
  | 'encoder';

export interface WorkLouderCodexPreviewInput {
  part: WorkLouderCodexPreviewPart;
  pressed: boolean;
  /** Encoder detents: +1 is firmware ENC_CW, −1 is ENC_CC. Visual rotation flips this. */
  turn?: number;
  /** Stick angle on the hardware circle, 0–1. 0 is right, 0.25 down, 0.5 left, 0.75 up. */
  angle?: number;
  /** Stick deflection, 0–1. */
  distance?: number;
}

/** One detent on the drawn encoder. The hardware reports ticks, not a continuous angle. */
export const WORKLOUDER_CODEX_ENCODER_DETENT_DEG = 18;

/** How far the drawn stick cap travels at full deflection, in pixels. */
export const WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX = 10;

/**
 * Pixel offset for the settings-page stick cap.
 *
 * The hardware circle is clockwise from the right, which matches screen
 * coordinates: x grows right, y grows down.
 */
export function workLouderCodexStickPreviewOffset(
  angle: number,
  distance: number,
  radius: number = WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
): { x: number; y: number } {
  if (!Number.isFinite(angle) || !Number.isFinite(distance) || !Number.isFinite(radius)) {
    return { x: 0, y: 0 };
  }
  const travel = Math.max(0, Math.min(1, distance));
  const theta = angle * Math.PI * 2;
  return {
    x: snapPreviewPx(Math.cos(theta) * travel * radius),
    y: snapPreviewPx(Math.sin(theta) * travel * radius),
  };
}

function snapPreviewPx(value: number): number {
  return Math.round(value * 100) / 100;
}
export type WorkLouderCodexAnalogDirection = (typeof WORKLOUDER_CODEX_ANALOG_DIRECTIONS)[number];
export type WorkLouderCodexEncoderAction = (typeof WORKLOUDER_CODEX_ENCODER_ACTIONS)[number];
export type WorkLouderCodexEncoderMode = (typeof WORKLOUDER_CODEX_ENCODER_MODES)[number];
export type WorkLouderCodexCommandId = InputDeviceCommandId;
export type WorkLouderCodexKeycapId = (typeof WORKLOUDER_CODEX_KEYCAP_IDS)[number];

export type WorkLouderCodexAction =
  | InputDeviceAction
  | { type: 'keycap'; keycapId: WorkLouderCodexKeycapId }
  /** Push-to-talk. Voice is press/release, so it only works on physical keys. */
  | { type: 'voice' };

export interface WorkLouderCodexKeyAssignment {
  keycapId: WorkLouderCodexKeycapId;
  /** Null means use the physical keycap's built-in Cindy action. */
  action: WorkLouderCodexAction | null;
}

export interface WorkLouderCodexLayout {
  version: 1;
  slots: Record<WorkLouderCodexCommandSlot, WorkLouderCodexKeyAssignment> &
    Partial<Record<WorkLouderCreatorProgrammableKey, WorkLouderCodexKeyAssignment>>;
  analogStick: Record<WorkLouderCodexAnalogDirection, WorkLouderCodexAction | null>;
  encoder: Record<WorkLouderCodexEncoderAction, WorkLouderCodexAction | null>;
  encoderMode: WorkLouderCodexEncoderMode;
  separateMicrophoneKeys: boolean;
  /** 2U caps covering a right or down neighbor. Source of truth; the mic flag is derived. */
  merges?: WorkLouderKeyMerge[];
  /** Which physical 1U keys are task keys, in board order. */
  taskKeys?: WorkLouderCreatorProgrammableKey[];
}

export interface WorkLouderCodexSettings {
  /** When false, this Cindy instance does not occupy the HID device. */
  deviceEnabled: boolean;
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
  | 'connecting'
  | 'connected'
  | 'not-detected'
  | 'disabled'
  | 'error'
  | 'unavailable';

export type WorkLouderCodexConnectionReason =
  | 'connection-timeout'
  | 'connection-failed'
  | 'permission-required'
  | 'device-in-use'
  | 'sdk-unavailable'
  | null;

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
  title: string | null;
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
  /** USB/Bluetooth presence, independent of whether this Cindy occupies HID. */
  devicePresent: boolean | null;
  device: WorkLouderCodexDeviceState;
  settings: WorkLouderCodexSettings;
  agentSlots: WorkLouderCodexAgentSlotState[];
  taskOptions: WorkLouderCodexTaskOption[];
  agentSlotCount: number;
}

export type WorkLouderAccessoriesState = Record<WorkLouderModel, WorkLouderCodexState>;

export type WorkLouderCodexRendererAction =
  | InputDeviceRendererAction
  | { type: 'keycap'; keycapId: WorkLouderCodexKeycapId };

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
    ACT10: { keycapId: 'MIC', action: null },
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
  merges: [{ origin: 'ACT10', cover: 'ACT11' }],
  taskKeys: [...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS],
};

export const WORKLOUDER_CODEX_DEFAULT_SETTINGS: WorkLouderCodexSettings = {
  deviceEnabled: false,
  lightingBrightness: 100,
  lightingAutoDim: '3-minutes',
  agentSource: 'last-sent',
  customAgentKeys: Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, () => null),
  singleTapAgentKeys: true,
  layout: WORKLOUDER_CODEX_DEFAULT_LAYOUT,
};

/**
 * Creator's factory kit is thirteen blank 1U caps (no 2U MIC). Same PCB as
 * Codex: merge/split is a layout choice. Push-to-talk defaults to ACT10
 * because a blank cap has no printed microphone fallback.
 */
export const WORKLOUDER_CREATOR_MICRO_2_DEFAULT_LAYOUT: WorkLouderCodexLayout = {
  version: 1,
  slots: {
    ACT06: { keycapId: 'EMPT1', action: { type: 'command', commandId: 'composer.toggleFastMode' } },
    ACT07: { keycapId: 'EMPT2', action: { type: 'command', commandId: 'approval.approve' } },
    ACT08: { keycapId: 'EMPT3', action: { type: 'command', commandId: 'approval.decline' } },
    ACT09: { keycapId: 'EMPT4', action: { type: 'command', commandId: 'forkTask' } },
    ACT10: { keycapId: 'EMPT1', action: { type: 'voice' } },
    ACT11: { keycapId: 'EMPT2', action: null },
    ACT10_ACT11: { keycapId: 'EMPT5', action: null },
    ACT12: { keycapId: 'EMPT3', action: { type: 'command', commandId: 'composer.submit' } },
  },
  analogStick: {
    up: { type: 'command', commandId: 'conversation.scrollUp' },
    right: { type: 'command', commandId: 'toggleRightSidebar' },
    down: { type: 'command', commandId: 'conversation.scrollDown' },
    left: { type: 'command', commandId: 'toggleSidebar' },
  },
  encoder: { left: null, right: null, click: null, longPress: null },
  encoderMode: 'session-switch',
  separateMicrophoneKeys: true,
  merges: [],
  taskKeys: [...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS],
};

export const WORKLOUDER_CREATOR_MICRO_2_DEFAULT_SETTINGS: WorkLouderCodexSettings = {
  deviceEnabled: false,
  lightingBrightness: 100,
  lightingAutoDim: '3-minutes',
  agentSource: 'last-sent',
  customAgentKeys: Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, () => null),
  singleTapAgentKeys: true,
  layout: WORKLOUDER_CREATOR_MICRO_2_DEFAULT_LAYOUT,
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
  const slotKeys = new Set<string>([
    ...WORKLOUDER_CODEX_COMMAND_SLOTS,
    ...WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.filter((key) => layout.slots[key]),
  ]);
  return {
    ...layout,
    slots: Object.fromEntries(
      [...slotKeys].map((slot) => {
        const assignment = layout.slots[slot as WorkLouderCodexCommandSlot];
        return [
          slot,
          {
            ...assignment,
            action: cloneWorkLouderCodexAction(assignment?.action ?? null),
          },
        ];
      }),
    ) as WorkLouderCodexLayout['slots'],
    taskKeys: layout.taskKeys ? [...layout.taskKeys] : undefined,
    merges: layout.merges ? layout.merges.map((merge) => ({ ...merge })) : undefined,
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

export function createWorkLouderCodexDefaultSettings(
  model: WorkLouderModel = 'codex-micro',
): WorkLouderCodexSettings {
  return cloneWorkLouderCodexSettings(
    model === 'creator-micro-2'
      ? WORKLOUDER_CREATOR_MICRO_2_DEFAULT_SETTINGS
      : WORKLOUDER_CODEX_DEFAULT_SETTINGS,
  );
}

export function isWorkLouderCodexAutoDim(value: unknown): value is WorkLouderCodexAutoDim {
  return isStringOption(value, WORKLOUDER_CODEX_AUTO_DIM_OPTIONS);
}

export function isWorkLouderCodexAgentSource(value: unknown): value is WorkLouderCodexAgentSource {
  return isStringOption(value, WORKLOUDER_CODEX_AGENT_SOURCES);
}

/**
 * Saved values from older builds: `recent` was the visible sidebar, `pinned`
 * was a separate pinned-only list. Both now mean sidebar order.
 */
export function normalizeWorkLouderCodexAgentSource(value: unknown): WorkLouderCodexAgentSource {
  if (value === 'recent' || value === 'pinned') return 'sidebar';
  return isWorkLouderCodexAgentSource(value) ? value : WORKLOUDER_CODEX_DEFAULT_SETTINGS.agentSource;
}

export function isWorkLouderCodexCommandId(value: unknown): value is WorkLouderCodexCommandId {
  return isInputDeviceCommandId(value);
}

export function isWorkLouderCodexKeycapId(value: unknown): value is WorkLouderCodexKeycapId {
  return isStringOption(value, WORKLOUDER_CODEX_KEYCAP_IDS);
}

export function isWorkLouderCodexMicrophoneKeycap(
  keycapId: WorkLouderCodexKeycapId | null | undefined,
): boolean {
  return keycapId === 'MIC' || keycapId === 'MIC1';
}

/** Voice is carried either by a printed MIC keycap (Codex) or a bound action. */
export function isWorkLouderCodexVoiceAssignment(
  assignment: Pick<WorkLouderCodexKeyAssignment, 'keycapId' | 'action'> | null | undefined,
): boolean {
  if (!assignment) return false;
  if (assignment.action) return assignment.action.type === 'voice';
  return isWorkLouderCodexMicrophoneKeycap(assignment.keycapId);
}

export function isWorkLouderCodexDoubleKeycap(
  keycapId: WorkLouderCodexKeycapId | null | undefined,
): boolean {
  return keycapId === 'EMPT5';
}

/** Unprinted caps in the hardware catalogue. They carry no legend. */
export function isWorkLouderCodexBlankKeycap(
  keycapId: WorkLouderCodexKeycapId | null | undefined,
): boolean {
  return (
    keycapId === 'EMPT1' ||
    keycapId === 'EMPT2' ||
    keycapId === 'EMPT3' ||
    keycapId === 'EMPT4' ||
    keycapId === 'EMPT5'
  );
}

/** Extra 1U blanks. EMPT1 is the only one the picker needs to show. */
export function isWorkLouderCodexDuplicateBlankKeycap(
  keycapId: WorkLouderCodexKeycapId | null | undefined,
): boolean {
  return keycapId === 'EMPT2' || keycapId === 'EMPT3' || keycapId === 'EMPT4';
}

/** Fold identical catalogue SKUs onto one picker item. */
export function canonicalizeWorkLouderCodexKeycapId(
  keycapId: WorkLouderCodexKeycapId,
): WorkLouderCodexKeycapId {
  if (keycapId === 'MIC1') return 'MIC';
  return isWorkLouderCodexDuplicateBlankKeycap(keycapId) ? 'EMPT1' : keycapId;
}

export function isWorkLouderCreatorProgrammableKey(
  value: unknown,
): value is WorkLouderCreatorProgrammableKey {
  return (
    typeof value === 'string' &&
    (WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS as readonly string[]).includes(value)
  );
}

export function normalizeWorkLouderCreatorTaskKeys(
  raw: unknown,
): WorkLouderCreatorProgrammableKey[] {
  const selected = new Set<WorkLouderCreatorProgrammableKey>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isWorkLouderCreatorProgrammableKey(item)) selected.add(item);
    }
  } else if (raw == null) {
    for (const key of WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS) selected.add(key);
  }
  return WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.filter((key) => selected.has(key));
}

/** A 2U cap covers two switches; neither can be a task key. */
export function workLouderTaskKeysForLayout(
  layout: Pick<WorkLouderCodexLayout, 'separateMicrophoneKeys' | 'merges'> & {
    taskKeys?: unknown;
  },
): WorkLouderCreatorProgrammableKey[] {
  const keys = normalizeWorkLouderCreatorTaskKeys(layout.taskKeys);
  const blocked = new Set(
    workLouderLayoutMerges(layout).flatMap((merge) => [merge.origin, merge.cover]),
  );
  return keys.filter((key) => !blocked.has(key));
}

export function creatorTaskKeySet(
  layout: Pick<WorkLouderCodexLayout, 'taskKeys'>,
): Set<WorkLouderCreatorProgrammableKey> {
  return new Set(normalizeWorkLouderCreatorTaskKeys(layout.taskKeys));
}

export function isCreatorTaskKey(
  layout: Pick<WorkLouderCodexLayout, 'taskKeys'>,
  key: string,
): boolean {
  return isWorkLouderCreatorProgrammableKey(key) && creatorTaskKeySet(layout).has(key);
}

export function assignCreatorHidCodes(
  taskKeys: readonly WorkLouderCreatorProgrammableKey[],
): Map<WorkLouderCreatorProgrammableKey, string> {
  const task = normalizeWorkLouderCreatorTaskKeys(taskKeys);
  const taskSet = new Set(task);
  const command = WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.filter((key) => !taskSet.has(key));
  const assigned = new Map<WorkLouderCreatorProgrammableKey, string>();
  // Firmware only emits AG00–AG05. Extra task keys keep ACT codes; Cindy maps
  // those HID reports onto the remaining task slots in software.
  const firmwareAg = WORKLOUDER_HID_AG_CODES.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
  const litCount = Math.min(task.length, firmwareAg.length);
  for (let index = 0; index < litCount; index += 1) {
    assigned.set(task[index]!, firmwareAg[index]!);
  }
  const leftoverAg = firmwareAg.slice(litCount);
  const restCodes = [...WORKLOUDER_HID_ACT_CODES, ...leftoverAg];
  const rest = [...task.slice(litCount), ...command];
  rest.forEach((key, index) => {
    assigned.set(key, restCodes[index]!);
  });
  return assigned;
}

const WORKLOUDER_FIRMWARE_AGENT_KEYS = WORKLOUDER_HID_AG_CODES.slice(
  0,
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
) as WorkLouderCreatorProgrammableKey[];

/**
 * The shared `keys` zone paints every keycap. Mute it unless the six firmware
 * AG keys are exactly the task-key set — otherwise a demoted AG key still
 * washes green, and extra ACT task keys inherit the same wash.
 */
export function workLouderShouldMuteKeyZone(
  taskKeys: readonly WorkLouderCreatorProgrammableKey[] | undefined,
): boolean {
  const keys = normalizeWorkLouderCreatorTaskKeys(taskKeys);
  return (
    keys.length > WORKLOUDER_CODEX_AGENT_SLOT_COUNT ||
    WORKLOUDER_FIRMWARE_AGENT_KEYS.some((key) => !keys.includes(key))
  );
}

export function buildCreatorMicro2AgentKeymap(
  taskKeys: readonly WorkLouderCreatorProgrammableKey[] = WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS,
): string[][] {
  const hid = assignCreatorHidCodes(normalizeWorkLouderCreatorTaskKeys(taskKeys));
  return WORKLOUDER_CREATOR_KEYMAP_LAYOUT.map((row) =>
    row.map((physical) => `KV_OAI_${hid.get(physical)}`),
  );
}

export type CreatorHidRole =
  | { role: 'task'; slot: number; physical: WorkLouderCreatorProgrammableKey }
  | { role: 'command'; physical: WorkLouderCreatorProgrammableKey };

export function resolveCreatorHidRole(
  hidKey: string,
  taskKeys: readonly WorkLouderCreatorProgrammableKey[],
): CreatorHidRole | null {
  const normalized = normalizeWorkLouderCreatorTaskKeys(taskKeys);
  const assigned = assignCreatorHidCodes(normalized);
  for (const physical of WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS) {
    if (assigned.get(physical) !== hidKey) continue;
    const slot = normalized.indexOf(physical);
    if (slot >= 0) return { role: 'task', slot, physical };
    return { role: 'command', physical };
  }
  // Older keymaps wrote AG06–AG12 onto extra keys. Firmware may still emit those.
  const leftoverAg = /^AG(0[0-9]|1[0-2])$/.exec(hidKey);
  if (leftoverAg) {
    const slot = Number(leftoverAg[1]);
    const physical = normalized[slot];
    if (physical) return { role: 'task', slot, physical };
  }
  return null;
}

/** Codex keeps factory AG/ACT codes. HID key name is the physical key. */
export function resolveFactoryHidRole(
  hidKey: string,
  taskKeys: readonly WorkLouderCreatorProgrammableKey[],
): CreatorHidRole | null {
  if (!isWorkLouderCreatorProgrammableKey(hidKey)) return null;
  const normalized = normalizeWorkLouderCreatorTaskKeys(taskKeys);
  const slot = normalized.indexOf(hidKey);
  if (slot >= 0) return { role: 'task', slot, physical: hidKey };
  return { role: 'command', physical: hidKey };
}

export function resolveWorkLouderHidRole(
  hidKey: string,
  taskKeys: readonly WorkLouderCreatorProgrammableKey[],
  deviceType?: string | null,
): CreatorHidRole | null {
  if (deviceType === 'codex-micro') return resolveFactoryHidRole(hidKey, taskKeys);
  return resolveCreatorHidRole(hidKey, taskKeys);
}

const DEFAULT_CREATOR_COMMAND_ASSIGNMENT: WorkLouderCodexKeyAssignment = {
  keycapId: 'EMPT1',
  action: null,
};

export function creatorCommandAssignment(
  layout: WorkLouderCodexLayout,
  key: WorkLouderCreatorProgrammableKey,
): WorkLouderCodexKeyAssignment {
  return layout.slots[key] ?? DEFAULT_CREATOR_COMMAND_ASSIGNMENT;
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
