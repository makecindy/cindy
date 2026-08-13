import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  type WorkLouderCodexConnectionReason,
  type WorkLouderCodexDeviceState,
} from '../../shared/workLouderCodex.js';

export { WORKLOUDER_CODEX_AGENT_SLOT_COUNT } from '../../shared/workLouderCodex.js';

export const enum WorkLouderLightingEffect {
  Off = 0,
  Solid = 1,
  Snake = 2,
  Rainbow = 3,
  Breath = 4,
  Gradient = 5,
  ShallowBreath = 6,
}

export interface WorkLouderLightingSide {
  effect: WorkLouderLightingEffect;
  brightness: number;
  speed: number;
  magic: number;
  color: number;
}

export interface WorkLouderThreadLighting {
  id: number;
  color: number;
  brightness: number;
  effect: WorkLouderLightingEffect;
  speed: number;
  syncKeysLighting: boolean;
  syncAmbientLighting: boolean;
}

export interface WorkLouderCodexLightingFrame {
  ambient: WorkLouderLightingSide;
  keys: WorkLouderLightingSide;
  threads: WorkLouderThreadLighting[];
}

export type WorkLouderCodexHostRequest =
  | { kind: 'init'; sdkEntry: string }
  | { kind: 'listen' }
  | { kind: 'apply'; frame: WorkLouderCodexLightingFrame }
  // Ask the host to verify the device is still there. The SDK has no
  // disconnect event, so unplugging goes unnoticed until something tries to
  // talk to the device — this is that something, driven by whoever is
  // currently showing connection state.
  | { kind: 'probe' }
  | { kind: 'stop' };

export type WorkLouderCodexHostMessage =
  | {
      kind: 'state';
      status: 'connected' | 'not-detected' | 'error';
      reason?: Exclude<WorkLouderCodexConnectionReason, 'sdk-unavailable'>;
    }
  /** Legacy utility-host message retained for older host fakes and upgrades. */
  | { kind: 'agent-key'; slot: number }
  | { kind: 'device'; device: WorkLouderCodexDeviceState }
  | { kind: 'hid'; event: WorkLouderCodexHidEvent }
  | { kind: 'joystick'; event: WorkLouderCodexJoystickEvent }
  | { kind: 'activity' }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { kind: 'stopped' };

export interface WorkLouderCodexHidEvent {
  key: string;
  act: 0 | 1 | 2;
}

export interface WorkLouderCodexJoystickEvent {
  angle: number;
  distance: number;
}

const COLORS = {
  running: 0x4c6fff,
  'needs-interaction': 0xffa000,
  completed: 0x35c759,
  error: 0xff453a,
  /**
   * Window-reopen red tuned for these LEDs.
   * UI brand red `#DF0C27` / `#A61629` wash pink on the board.
   */
  brand: 0xd0060c,
} as const;

const OFF_SIDE: WorkLouderLightingSide = {
  effect: WorkLouderLightingEffect.Off,
  brightness: 0,
  speed: 0,
  magic: 0,
  color: 0,
};

const PHASE_PRIORITY: Readonly<Record<AgentIslandSessionActivity['phase'], number>> = {
  'needs-interaction': 4,
  error: 3,
  running: 2,
  completed: 1,
};

/**
 * Projects Cindy's process-wide task activity into the two Codex Micro lighting
 * zones plus its six per-thread indicators.
 */
export function createWorkLouderCodexLightingFrame(
  activity: readonly AgentIslandSessionActivity[],
  slotSessionIds?: readonly string[],
): WorkLouderCodexLightingFrame {
  const slots = projectWorkLouderCodexSlotActivity(activity, slotSessionIds);
  const aggregate = slots.reduce<AgentIslandSessionActivity['phase'] | null>((current, item) => {
    if (!item) return current;
    return current === null || PHASE_PRIORITY[item.phase] > PHASE_PRIORITY[current]
      ? item.phase
      : current;
  }, null);

  return {
    ambient: aggregate ? ambientForPhase(aggregate) : { ...OFF_SIDE },
    keys: aggregate ? keysForPhase(aggregate) : { ...OFF_SIDE },
    threads: Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, (_, id) =>
      threadForActivity(id, slots[id]),
    ),
  };
}

/** The ordered task assignment shared by the six LEDs and their physical keys. */
export function selectWorkLouderCodexSlotActivity(
  activity: readonly AgentIslandSessionActivity[],
): AgentIslandSessionActivity[] {
  return activity.filter(isLightingVisibleActivity).slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
}

/** Aligns activity LEDs with an explicit six-task key assignment when one is available. */
export function projectWorkLouderCodexSlotActivity(
  activity: readonly AgentIslandSessionActivity[],
  slotSessionIds?: readonly string[],
): Array<AgentIslandSessionActivity | undefined> {
  if (slotSessionIds === undefined) return selectWorkLouderCodexSlotActivity(activity);
  const visibleBySessionId = new Map(
    activity.filter(isLightingVisibleActivity).map((item) => [item.sessionId, item] as const),
  );
  return Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, (_, slot) => {
    const sessionId = slotSessionIds[slot];
    return sessionId ? visibleBySessionId.get(sessionId) : undefined;
  });
}

/** Accept only press events for the six official Agent keys (AG00 through AG05). */
export function parseWorkLouderCodexAgentKeyPress(value: unknown): number | null {
  const event = parseWorkLouderCodexHidEvent(value);
  if (!event || event.act !== 1) return null;
  const match = /^AG0([0-5])$/.exec(event.key);
  return match ? Number(match[1]) : null;
}

export function parseWorkLouderCodexHidEvent(value: unknown): WorkLouderCodexHidEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as { key?: unknown; act?: unknown };
  if (
    typeof event.key !== 'string' ||
    event.key.length > 32 ||
    (event.act !== 0 && event.act !== 1 && event.act !== 2)
  ) {
    return null;
  }
  if (
    !/^AG0[0-5]$/.test(event.key) &&
    !/^ACT(?:0[6-9]|1[0-2])$/.test(event.key) &&
    !/^ENC[A-Z0-9_]*$/.test(event.key)
  ) {
    return null;
  }
  return { key: event.key, act: event.act };
}

export function parseWorkLouderCodexJoystickEvent(
  value: unknown,
): WorkLouderCodexJoystickEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as { angle?: unknown; distance?: unknown };
  if (
    typeof event.angle !== 'number' ||
    !Number.isFinite(event.angle) ||
    event.angle < 0 ||
    event.angle > 1 ||
    typeof event.distance !== 'number' ||
    !Number.isFinite(event.distance) ||
    event.distance < 0 ||
    event.distance > 1
  ) {
    return null;
  }
  return { angle: event.angle, distance: event.distance };
}

export function isWorkLouderCodexLightingFrameOff(frame: WorkLouderCodexLightingFrame): boolean {
  return (
    frame.ambient.brightness === 0 &&
    frame.keys.brightness === 0 &&
    frame.threads.every((thread) => thread.brightness === 0)
  );
}

/** Applies the user-facing overall brightness without mutating the semantic frame. */
export function applyWorkLouderCodexLightingBrightness(
  frame: WorkLouderCodexLightingFrame,
  brightnessPercent: number,
): WorkLouderCodexLightingFrame {
  const factor = Math.max(0, Math.min(100, brightnessPercent)) / 100;
  return {
    ambient: { ...frame.ambient, brightness: frame.ambient.brightness * factor },
    keys: { ...frame.keys, brightness: frame.keys.brightness * factor },
    threads: frame.threads.map((thread) => ({
      ...thread,
      brightness: thread.brightness * factor,
    })),
  };
}

export function createWorkLouderCodexOffFrame(): WorkLouderCodexLightingFrame {
  return {
    ambient: { ...OFF_SIDE },
    keys: { ...OFF_SIDE },
    threads: Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, (_, id) => ({
      id,
      color: 0,
      brightness: 0,
      effect: WorkLouderLightingEffect.Off,
      speed: 0,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    })),
  };
}

/**
 * A short hello on the whole board — used when Cindy's window comes back
 * after being hidden or minimized. Snake and breath are the two animated
 * effects already proven on this hardware (running / waiting). Rainbow is
 * not: on an idle board it can look like the lights never came on.
 */
export function createWorkLouderCodexWindowRevealFrame(): WorkLouderCodexLightingFrame {
  return {
    ambient: side(WorkLouderLightingEffect.Snake, 0.78, 0.55, COLORS.brand),
    keys: side(WorkLouderLightingEffect.Breath, 0.34, 0.55, COLORS.brand),
    threads: Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, (_, id) => ({
      id,
      color: COLORS.brand,
      brightness: 0.72,
      effect: WorkLouderLightingEffect.Breath,
      speed: 0.55,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    })),
  };
}

export function isWorkLouderCodexHostMessage(value: unknown): value is WorkLouderCodexHostMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as { kind?: unknown; status?: unknown; level?: unknown; message?: unknown };
  if (message.kind === 'stopped') return true;
  if (message.kind === 'activity') return true;
  if (message.kind === 'agent-key') {
    const slot = (message as { slot?: unknown }).slot;
    return (
      typeof slot === 'number' &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot < WORKLOUDER_CODEX_AGENT_SLOT_COUNT
    );
  }
  if (message.kind === 'hid')
    return parseWorkLouderCodexHidEvent((message as { event?: unknown }).event) !== null;
  if (message.kind === 'joystick') {
    return parseWorkLouderCodexJoystickEvent((message as { event?: unknown }).event) !== null;
  }
  if (message.kind === 'device')
    return isWorkLouderCodexDeviceState((message as { device?: unknown }).device);
  if (message.kind === 'state') {
    const validStatus =
      message.status === 'connected' ||
      message.status === 'not-detected' ||
      message.status === 'error';
    const reason = (message as { reason?: unknown }).reason;
    return (
      validStatus &&
      (reason === undefined ||
        reason === null ||
        reason === 'connection-timeout' ||
        reason === 'connection-failed' ||
        reason === 'permission-required')
    );
  }
  if (message.kind === 'log') {
    return (
      (message.level === 'debug' ||
        message.level === 'info' ||
        message.level === 'warn' ||
        message.level === 'error') &&
      typeof message.message === 'string'
    );
  }
  return false;
}

function isWorkLouderCodexDeviceState(value: unknown): value is WorkLouderCodexDeviceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const device = value as WorkLouderCodexDeviceState;
  return (
    (device.deviceType === null ||
      device.deviceType === 'codex-micro' ||
      device.deviceType === 'creator-micro-2') &&
    (device.isUsbConnection === null || typeof device.isUsbConnection === 'boolean') &&
    (device.firmwareVersion === null || typeof device.firmwareVersion === 'string') &&
    (device.batteryPercentage === null ||
      (typeof device.batteryPercentage === 'number' &&
        Number.isFinite(device.batteryPercentage) &&
        device.batteryPercentage >= 0 &&
        device.batteryPercentage <= 100)) &&
    (device.isCharging === null || typeof device.isCharging === 'boolean') &&
    (device.inputMonitoringPermission === 'granted' ||
      device.inputMonitoringPermission === 'denied' ||
      device.inputMonitoringPermission === 'unknown' ||
      device.inputMonitoringPermission === 'not-required')
  );
}

function isLightingVisibleActivity(activity: AgentIslandSessionActivity): boolean {
  return (
    activity.phase === 'running' ||
    activity.phase === 'needs-interaction' ||
    activity.attention === true
  );
}

function ambientForPhase(phase: AgentIslandSessionActivity['phase']): WorkLouderLightingSide {
  switch (phase) {
    case 'running':
      return side(WorkLouderLightingEffect.Snake, 0.7, 0.4, COLORS.running);
    case 'needs-interaction':
      return side(WorkLouderLightingEffect.Breath, 0.95, 0.35, COLORS['needs-interaction']);
    case 'completed':
      return side(WorkLouderLightingEffect.Solid, 0.7, 0, COLORS.completed);
    case 'error':
      return side(WorkLouderLightingEffect.Breath, 1, 0.45, COLORS.error);
  }
}

function keysForPhase(phase: AgentIslandSessionActivity['phase']): WorkLouderLightingSide {
  const effect =
    phase === 'error' ? WorkLouderLightingEffect.Breath : WorkLouderLightingEffect.Solid;
  const brightness = phase === 'needs-interaction' || phase === 'error' ? 0.28 : 0.16;
  return side(effect, brightness, phase === 'error' ? 0.45 : 0, COLORS[phase]);
}

function threadForActivity(
  id: number,
  activity: AgentIslandSessionActivity | undefined,
): WorkLouderThreadLighting {
  if (!activity) {
    return {
      id,
      color: 0,
      brightness: 0,
      effect: WorkLouderLightingEffect.Off,
      speed: 0,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    };
  }
  const animated =
    activity.phase === 'running' ||
    activity.phase === 'needs-interaction' ||
    activity.phase === 'error';
  return {
    id,
    color: COLORS[activity.phase],
    brightness: 0.8,
    effect: animated ? WorkLouderLightingEffect.Breath : WorkLouderLightingEffect.Solid,
    speed: animated ? 0.35 : 0,
    syncKeysLighting: false,
    syncAmbientLighting: false,
  };
}

function side(
  effect: WorkLouderLightingEffect,
  brightness: number,
  speed: number,
  color: number,
): WorkLouderLightingSide {
  return { effect, brightness, speed, magic: 0, color };
}
