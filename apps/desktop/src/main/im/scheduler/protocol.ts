import type { SchedulerChannelIdentity } from './state';

export const IM_SCHEDULER_PUSH_CHANNEL = 'cindy:discord-scheduler:v1';
export const IM_SCHEDULER_CHANNELS = ['discord'] as const;

export interface SchedulerAdvertisementFrame {
  kind: 'advertisement';
  sentAt: number;
  channels: SchedulerChannelIdentity[];
  /** Echoes a discovery probe so the receiver knows this view is current. */
  inReplyTo?: string;
}

export interface SchedulerProbeFrame {
  kind: 'probe';
  sentAt: number;
  nonce: string;
  channels: SchedulerChannelIdentity[];
}

export type ImSchedulerFrame = SchedulerAdvertisementFrame | SchedulerProbeFrame;

const DISCORD_ID_PATTERN = /^[1-9][0-9]{16,19}$/;

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

export function isImSchedulerFrame(value: unknown): value is ImSchedulerFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { return false; }
  if (size > 8_192) return false;
  if (typeof frame.sentAt !== 'number' || !Number.isFinite(frame.sentAt)) return false;
  if (frame.kind === 'probe') {
    if (Object.keys(frame).some((key) => !['kind', 'sentAt', 'nonce', 'channels'].includes(key))) return false;
    if (typeof frame.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(frame.nonce)) return false;
    return Array.isArray(frame.channels)
      && frame.channels.length <= 1
      && frame.channels.every(isSchedulerChannelIdentity);
  }
  if (frame.kind !== 'advertisement') return false;
  if (Object.keys(frame).some((key) => !['kind', 'sentAt', 'channels', 'inReplyTo'].includes(key))) return false;
  if (
    frame.inReplyTo !== undefined
    && (typeof frame.inReplyTo !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(frame.inReplyTo))
  ) return false;
  if (!Array.isArray(frame.channels) || frame.channels.length > 1) return false;
  return frame.channels.every(isSchedulerChannelIdentity);
}
