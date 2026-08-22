import type { SchedulerChannelIdentity } from './state';

export const IM_SCHEDULER_PUSH_CHANNEL = 'cindy:discord-scheduler:v1';
export const IM_SCHEDULER_CHANNELS = ['discord'] as const;

export interface SchedulerRuntimeFrame {
  identity: string;
  generation: string;
  state: 'active' | 'dirty' | 'clean';
  /** Dirty generation whose compensation responsibility moved to this active runtime. */
  predecessor?: string;
}

export interface SchedulerAdvertisementFrame {
  kind: 'advertisement';
  sentAt: number;
  channels: SchedulerChannelIdentity[];
  runtime?: SchedulerRuntimeFrame;
  /** Bounded unresolved dirty runtime generations. */
  runtimeGaps?: SchedulerRuntimeFrame[];
  /** Echoes a discovery probe so the receiver knows this view is current. */
  inReplyTo?: string;
}

export interface SchedulerProbeFrame {
  kind: 'probe';
  sentAt: number;
  nonce: string;
  channels: SchedulerChannelIdentity[];
  runtime?: SchedulerRuntimeFrame;
  runtimeGaps?: SchedulerRuntimeFrame[];
}

export type ImSchedulerFrame = SchedulerAdvertisementFrame | SchedulerProbeFrame;

const DISCORD_ID_PATTERN = /^[1-9][0-9]{16,19}$/;
const RUNTIME_GENERATION_PATTERN = /^[a-f0-9]{32}$/;
export const MAX_RUNTIME_GAPS = 8;

/** Only a non-secret Discord application id may cross Device Link. */
export function isSchedulerChannelIdentity(value: unknown): value is SchedulerChannelIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return (
    Object.keys(identity).length === 2
    && identity.channel === 'discord'
    && typeof identity.identity === 'string'
    && DISCORD_ID_PATTERN.test(identity.identity)
  );
}

export function isSchedulerRuntimeFrame(value: unknown): value is SchedulerRuntimeFrame {
  if (!value || typeof value !== 'object') return false;
  const runtime = value as Record<string, unknown>;
  if (Object.keys(runtime).some((key) => ![
    'identity',
    'generation',
    'state',
    'predecessor',
  ].includes(key))) return false;
  if (typeof runtime.identity !== 'string' || !DISCORD_ID_PATTERN.test(runtime.identity)) return false;
  if (typeof runtime.generation !== 'string' || !RUNTIME_GENERATION_PATTERN.test(runtime.generation)) return false;
  if (
    typeof runtime.state !== 'string'
    || !['active', 'dirty', 'clean'].includes(runtime.state)
  ) return false;
  if (
    runtime.predecessor !== undefined
    && (runtime.state !== 'active'
      || typeof runtime.predecessor !== 'string'
      || !RUNTIME_GENERATION_PATTERN.test(runtime.predecessor)
      || runtime.predecessor === runtime.generation)
  ) return false;
  return true;
}

export function isImSchedulerFrame(value: unknown): value is ImSchedulerFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { return false; }
  if (size > 8_192) return false;
  if (typeof frame.sentAt !== 'number' || !Number.isFinite(frame.sentAt)) return false;
  if (frame.kind === 'probe') {
    if (Object.keys(frame).some((key) => !['kind', 'sentAt', 'nonce', 'channels', 'runtime', 'runtimeGaps'].includes(key))) return false;
    if (typeof frame.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(frame.nonce)) return false;
    return Array.isArray(frame.channels)
      && frame.channels.length <= 1
      && frame.channels.every(isSchedulerChannelIdentity)
      && (frame.runtime === undefined || isSchedulerRuntimeFrame(frame.runtime))
      && isSchedulerRuntimeGaps(frame.runtimeGaps);
  }
  if (frame.kind !== 'advertisement') return false;
  if (Object.keys(frame).some((key) => !['kind', 'sentAt', 'channels', 'runtime', 'runtimeGaps', 'inReplyTo'].includes(key))) return false;
  if (
    frame.inReplyTo !== undefined
    && (typeof frame.inReplyTo !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(frame.inReplyTo))
  ) return false;
  if (!Array.isArray(frame.channels) || frame.channels.length > 1) return false;
  return frame.channels.every(isSchedulerChannelIdentity)
    && (frame.runtime === undefined || isSchedulerRuntimeFrame(frame.runtime))
    && isSchedulerRuntimeGaps(frame.runtimeGaps);
}

function isSchedulerRuntimeGaps(value: unknown): value is SchedulerRuntimeFrame[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_GAPS) return false;
  const generations = new Set<string>();
  return value.every((runtime) => {
    if (!isSchedulerRuntimeFrame(runtime) || runtime.state !== 'dirty') return false;
    const key = `${runtime.identity}\0${runtime.generation}`;
    if (generations.has(key)) return false;
    generations.add(key);
    return true;
  });
}
