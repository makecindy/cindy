import {
  isInputDeviceCommandId,
  type InputDeviceCommandId,
  type InputDeviceDescriptor,
} from './inputDevices';

export const XBOX_GAMEPAD_DEVICE_ID = 'xbox-gamepad';
export const PLAYSTATION_GAMEPAD_DEVICE_ID = 'playstation-gamepad';
export const NINTENDO_GAMEPAD_DEVICE_ID = 'nintendo-gamepad';
export const GENERIC_GAMEPAD_DEVICE_ID = 'generic-gamepad';

const GAMEPAD_CAPABILITIES = [{ kind: 'commands' }, { kind: 'voice' }, { kind: 'stick' }] as const;

export const XBOX_GAMEPAD_DEVICE: InputDeviceDescriptor = {
  id: XBOX_GAMEPAD_DEVICE_ID,
  label: 'Xbox',
  capabilities: GAMEPAD_CAPABILITIES,
};

export const PLAYSTATION_GAMEPAD_DEVICE: InputDeviceDescriptor = {
  id: PLAYSTATION_GAMEPAD_DEVICE_ID,
  label: 'PlayStation',
  capabilities: GAMEPAD_CAPABILITIES,
};

export const NINTENDO_GAMEPAD_DEVICE: InputDeviceDescriptor = {
  id: NINTENDO_GAMEPAD_DEVICE_ID,
  label: 'Switch',
  capabilities: GAMEPAD_CAPABILITIES,
};

export const GENERIC_GAMEPAD_DEVICE: InputDeviceDescriptor = {
  id: GENERIC_GAMEPAD_DEVICE_ID,
  label: 'Gamepad',
  capabilities: GAMEPAD_CAPABILITIES,
};

export const XBOX_GAMEPAD_GET_STATE_CHANNEL = 'xbox-gamepad:get-state';
export const XBOX_GAMEPAD_SET_SETTINGS_CHANNEL = 'xbox-gamepad:set-settings';
export const XBOX_GAMEPAD_RESET_SETTINGS_CHANNEL = 'xbox-gamepad:reset-settings';
export const XBOX_GAMEPAD_PROBE_CHANNEL = 'xbox-gamepad:probe';
export const XBOX_GAMEPAD_STATE_CHANGED_CHANNEL = 'xbox-gamepad:state-changed';
export const XBOX_GAMEPAD_PREVIEW_INPUT_CHANNEL = 'xbox-gamepad:preview-input';
export const XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL = 'xbox-gamepad:set-layout-preview';

export const XBOX_GAMEPAD_BUTTON_IDS = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'lt',
  'rt',
  'view',
  'menu',
  'xbox',
  'ls',
  'rs',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
] as const;

export const XBOX_GAMEPAD_STICK_IDS = ['left', 'right'] as const;
export const XBOX_GAMEPAD_STICK_DIRECTIONS = ['up', 'right', 'down', 'left'] as const;
export const XBOX_GAMEPAD_STICK_MODES = ['conversation-scroll', 'custom'] as const;

export type XboxGamepadButtonId = (typeof XBOX_GAMEPAD_BUTTON_IDS)[number];
export type XboxGamepadStickId = (typeof XBOX_GAMEPAD_STICK_IDS)[number];
export type XboxGamepadStickDirection = (typeof XBOX_GAMEPAD_STICK_DIRECTIONS)[number];
export type XboxGamepadStickMode = (typeof XBOX_GAMEPAD_STICK_MODES)[number];

export type XboxGamepadBinding =
  | { type: 'command'; commandId: InputDeviceCommandId }
  | { type: 'skill'; skillId: string; name: string }
  | { type: 'voice' };

export interface XboxGamepadStickBinding {
  mode: XboxGamepadStickMode;
  directions: Record<XboxGamepadStickDirection, XboxGamepadBinding | null>;
}

export interface XboxGamepadLayout {
  version: 1;
  buttons: Record<XboxGamepadButtonId, XboxGamepadBinding | null>;
  sticks: Record<XboxGamepadStickId, XboxGamepadStickBinding>;
}

export type XboxGamepadConnectionStatus =
  'connecting' | 'connected' | 'not-detected' | 'disabled' | 'error' | 'unavailable';

export interface XboxGamepadSettings {
  deviceEnabled: boolean;
  layout: XboxGamepadLayout;
}

export type XboxGamepadSettingsPatch = Partial<XboxGamepadSettings>;

export type XboxGamepadTransport = 'usb' | 'bluetooth' | 'unknown';
export type XboxGamepadBatteryState = 'unknown' | 'discharging' | 'charging' | 'full';
export const GAMEPAD_FAMILIES = ['xbox', 'playstation', 'nintendo', 'generic'] as const;
export type GamepadFamily = (typeof GAMEPAD_FAMILIES)[number];
/** Settings currently lists Xbox and PlayStation only. Nintendo / generic stay implemented. */
export const VISIBLE_GAMEPAD_FAMILIES = [
  'xbox',
  'playstation',
] as const satisfies readonly GamepadFamily[];

export interface XboxGamepadDeviceInfo {
  name: string | null;
  category: string | null;
  family: GamepadFamily;
  transport: XboxGamepadTransport;
  batteryPercentage: number | null;
  batteryState: XboxGamepadBatteryState;
}

export const XBOX_GAMEPAD_EMPTY_DEVICE: XboxGamepadDeviceInfo = {
  name: null,
  category: null,
  family: 'xbox',
  transport: 'unknown',
  batteryPercentage: null,
  batteryState: 'unknown',
};

export function emptyGamepadDevice(family: GamepadFamily): XboxGamepadDeviceInfo {
  return { ...XBOX_GAMEPAD_EMPTY_DEVICE, family };
}

export function isGamepadFamily(value: unknown): value is GamepadFamily {
  return typeof value === 'string' && (GAMEPAD_FAMILIES as readonly string[]).includes(value);
}

/**
 * Bindings stay on Apple/Xbox positions (A=bottom, B=right, X=left, Y=top).
 * Family only changes the silhouette and the printed legends.
 */
export const GAMEPAD_DEVICES: Record<GamepadFamily, InputDeviceDescriptor> = {
  xbox: XBOX_GAMEPAD_DEVICE,
  playstation: PLAYSTATION_GAMEPAD_DEVICE,
  nintendo: NINTENDO_GAMEPAD_DEVICE,
  generic: GENERIC_GAMEPAD_DEVICE,
};

export function resolveGamepadFamily(input: {
  family?: unknown;
  name?: string | null;
  category?: string | null;
}): GamepadFamily {
  if (isGamepadFamily(input.family)) return input.family;
  const hay = `${input.name ?? ''} ${input.category ?? ''}`.toLowerCase();
  if (
    hay.includes('dualsense') ||
    hay.includes('dualshock') ||
    hay.includes('playstation') ||
    hay.includes('sony') ||
    /\bps[45]\b/.test(hay)
  ) {
    return 'playstation';
  }
  if (
    hay.includes('nintendo') ||
    hay.includes('switch') ||
    hay.includes('joy-con') ||
    hay.includes('joycon')
  ) {
    return 'nintendo';
  }
  // Wired Xbox pads often advertise USB product "Controller" and vendor Microsoft.
  if (
    hay.includes('xbox') ||
    hay.includes('elite') ||
    hay.includes('microsoft') ||
    /\bseries [xs]\b/.test(hay) ||
    (input.name ?? '').toLowerCase() === 'controller'
  ) {
    return 'xbox';
  }
  return 'generic';
}

export interface XboxGamepadState {
  connectionStatus: XboxGamepadConnectionStatus;
  devicePresent: boolean | null;
  deviceName: string | null;
  device: XboxGamepadDeviceInfo;
  settings: XboxGamepadSettings;
}

export type GamepadAccessoriesState = Record<GamepadFamily, XboxGamepadState>;

export interface XboxGamepadPreviewInput {
  family: GamepadFamily;
  buttons: Record<XboxGamepadButtonId, boolean>;
  sticks: Record<XboxGamepadStickId, { x: number; y: number }>;
  triggers: { lt: number; rt: number };
}

export const XBOX_GAMEPAD_STICK_PREVIEW_TRAVEL_PX = 10;

function emptyButtonBindings(): Record<XboxGamepadButtonId, XboxGamepadBinding | null> {
  return Object.fromEntries(XBOX_GAMEPAD_BUTTON_IDS.map((id) => [id, null])) as Record<
    XboxGamepadButtonId,
    XboxGamepadBinding | null
  >;
}

function emptyStickDirections(): Record<XboxGamepadStickDirection, XboxGamepadBinding | null> {
  return { up: null, right: null, down: null, left: null };
}

/**
 * Default map, split the way the Work Louder stick + encoder already work:
 * left stick is the task list, right stick is the conversation, left/right
 * open the panel on that side. Face / shoulder / system keys cover the rest
 * of a hands-on Cindy loop so every control does something.
 */
export const XBOX_GAMEPAD_DEFAULT_LAYOUT: XboxGamepadLayout = {
  version: 1,
  buttons: {
    ...emptyButtonBindings(),
    a: { type: 'command', commandId: 'composer.submit' },
    b: { type: 'command', commandId: 'navigateBack' },
    x: { type: 'command', commandId: 'composer.toggleFastMode' },
    y: { type: 'command', commandId: 'newTask' },
    lb: { type: 'command', commandId: 'composer.decreaseReasoningEffort' },
    rb: { type: 'command', commandId: 'composer.increaseReasoningEffort' },
    lt: { type: 'voice' },
    rt: { type: 'voice' },
    view: { type: 'command', commandId: 'toggleFullscreen' },
    menu: { type: 'command', commandId: 'settings' },
    xbox: { type: 'command', commandId: 'manageTasks' },
    ls: { type: 'command', commandId: 'composer.focus' },
    rs: { type: 'command', commandId: 'conversation.scrollBottom' },
    dpadUp: { type: 'command', commandId: 'conversation.scrollUp' },
    dpadDown: { type: 'command', commandId: 'conversation.scrollDown' },
    dpadLeft: { type: 'command', commandId: 'toggleSidebar' },
    dpadRight: { type: 'command', commandId: 'toggleRightSidebar' },
  },
  sticks: {
    left: {
      mode: 'custom',
      directions: {
        up: { type: 'command', commandId: 'session.selectPrevious' },
        down: { type: 'command', commandId: 'session.selectNext' },
        left: { type: 'command', commandId: 'toggleSidebar' },
        right: { type: 'command', commandId: 'toggleRightSidebar' },
      },
    },
    right: { mode: 'conversation-scroll', directions: emptyStickDirections() },
  },
};

export const XBOX_GAMEPAD_DEFAULT_SETTINGS: XboxGamepadSettings = {
  deviceEnabled: false,
  layout: XBOX_GAMEPAD_DEFAULT_LAYOUT,
};

export const XBOX_GAMEPAD_EMPTY_PREVIEW: XboxGamepadPreviewInput = {
  family: 'xbox',
  buttons: Object.fromEntries(XBOX_GAMEPAD_BUTTON_IDS.map((id) => [id, false])) as Record<
    XboxGamepadButtonId,
    boolean
  >,
  sticks: {
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  },
  triggers: { lt: 0, rt: 0 },
};

export function emptyGamepadPreview(family: GamepadFamily): XboxGamepadPreviewInput {
  return { ...XBOX_GAMEPAD_EMPTY_PREVIEW, family };
}

export function isXboxGamepadButtonId(value: unknown): value is XboxGamepadButtonId {
  return (
    typeof value === 'string' && (XBOX_GAMEPAD_BUTTON_IDS as readonly string[]).includes(value)
  );
}

export function isXboxGamepadStickId(value: unknown): value is XboxGamepadStickId {
  return typeof value === 'string' && (XBOX_GAMEPAD_STICK_IDS as readonly string[]).includes(value);
}

export function isXboxGamepadStickDirection(value: unknown): value is XboxGamepadStickDirection {
  return (
    typeof value === 'string' &&
    (XBOX_GAMEPAD_STICK_DIRECTIONS as readonly string[]).includes(value)
  );
}

export function isXboxGamepadStickMode(value: unknown): value is XboxGamepadStickMode {
  return (
    typeof value === 'string' && (XBOX_GAMEPAD_STICK_MODES as readonly string[]).includes(value)
  );
}

export function cloneXboxGamepadBinding(
  binding: XboxGamepadBinding | null,
): XboxGamepadBinding | null {
  return binding ? { ...binding } : null;
}

export function cloneXboxGamepadLayout(layout: XboxGamepadLayout): XboxGamepadLayout {
  return {
    version: 1,
    buttons: Object.fromEntries(
      XBOX_GAMEPAD_BUTTON_IDS.map((id) => [
        id,
        cloneXboxGamepadBinding(layout.buttons[id] ?? null),
      ]),
    ) as XboxGamepadLayout['buttons'],
    sticks: Object.fromEntries(
      XBOX_GAMEPAD_STICK_IDS.map((id) => {
        const stick = layout.sticks[id] ?? XBOX_GAMEPAD_DEFAULT_LAYOUT.sticks[id];
        return [
          id,
          {
            mode: isXboxGamepadStickMode(stick.mode) ? stick.mode : 'custom',
            directions: Object.fromEntries(
              XBOX_GAMEPAD_STICK_DIRECTIONS.map((direction) => [
                direction,
                cloneXboxGamepadBinding(stick.directions[direction] ?? null),
              ]),
            ) as XboxGamepadStickBinding['directions'],
          },
        ];
      }),
    ) as XboxGamepadLayout['sticks'],
  };
}

export function cloneXboxGamepadSettings(settings: XboxGamepadSettings): XboxGamepadSettings {
  return {
    deviceEnabled: settings.deviceEnabled,
    layout: cloneXboxGamepadLayout(settings.layout),
  };
}

export function createXboxGamepadDefaultLayout(): XboxGamepadLayout {
  return cloneXboxGamepadLayout(XBOX_GAMEPAD_DEFAULT_LAYOUT);
}

export function createXboxGamepadDefaultSettings(): XboxGamepadSettings {
  return cloneXboxGamepadSettings(XBOX_GAMEPAD_DEFAULT_SETTINGS);
}

export function isXboxGamepadBinding(value: unknown): value is XboxGamepadBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as {
    type?: unknown;
    commandId?: unknown;
    skillId?: unknown;
    name?: unknown;
  };
  if (record.type === 'command') return isInputDeviceCommandId(record.commandId);
  if (record.type === 'skill') {
    return (
      typeof record.skillId === 'string' &&
      record.skillId.length > 0 &&
      record.skillId.length <= 1_024 &&
      typeof record.name === 'string' &&
      record.name.length > 0 &&
      record.name.length <= 256
    );
  }
  return record.type === 'voice';
}

/**
 * Pixel offset for a drawn stick cap. GameController y is up-positive; the
 * screen's y grows down, so the preview flips that axis.
 */
export function xboxGamepadStickPreviewOffset(
  x: number,
  y: number,
  radius: number = XBOX_GAMEPAD_STICK_PREVIEW_TRAVEL_PX,
): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) {
    return { x: 0, y: 0 };
  }
  const cx = Math.max(-1, Math.min(1, x));
  const cy = Math.max(-1, Math.min(1, y));
  return {
    x: Math.round(cx * radius * 100) / 100,
    y: Math.round(-cy * radius * 100) / 100,
  };
}
