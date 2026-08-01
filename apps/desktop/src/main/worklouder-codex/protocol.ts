import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';

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
  | { kind: 'apply'; frame: WorkLouderCodexLightingFrame }
  | { kind: 'stop' };

export type WorkLouderCodexHostMessage =
  | { kind: 'state'; status: 'connected' | 'not-detected' | 'error' }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { kind: 'stopped' };

const COLORS = {
  running: 0x4c6fff,
  'needs-interaction': 0xffa000,
  completed: 0x35c759,
  error: 0xff453a,
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
): WorkLouderCodexLightingFrame {
  const visible = activity.filter(isLightingVisibleActivity).slice(0, 6);
  const aggregate = visible.reduce<AgentIslandSessionActivity['phase'] | null>(
    (current, item) =>
      current === null || PHASE_PRIORITY[item.phase] > PHASE_PRIORITY[current]
        ? item.phase
        : current,
    null,
  );

  return {
    ambient: aggregate ? ambientForPhase(aggregate) : { ...OFF_SIDE },
    keys: aggregate ? keysForPhase(aggregate) : { ...OFF_SIDE },
    threads: Array.from({ length: 6 }, (_, id) => threadForActivity(id, visible[id])),
  };
}

export function isWorkLouderCodexLightingFrameOff(frame: WorkLouderCodexLightingFrame): boolean {
  return (
    frame.ambient.brightness === 0 &&
    frame.keys.brightness === 0 &&
    frame.threads.every((thread) => thread.brightness === 0)
  );
}

export function isWorkLouderCodexHostMessage(value: unknown): value is WorkLouderCodexHostMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as { kind?: unknown; status?: unknown; level?: unknown; message?: unknown };
  if (message.kind === 'stopped') return true;
  if (message.kind === 'state') {
    return (
      message.status === 'connected' ||
      message.status === 'not-detected' ||
      message.status === 'error'
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
