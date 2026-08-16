export type RemoteBotLifecycleStatus = 'active' | 'paused' | 'error' | 'archived' | 'deleting';

export interface RemoteBotChannel {
  kind: string;
  enabled: boolean;
}

export interface RemoteBotProfile {
  id: string;
  name: string;
  description: string;
  avatar: string;
  avatarColor: string;
  status: RemoteBotLifecycleStatus;
  currentVersion: number;
  canonicalSessionId?: string;
  channels: RemoteBotChannel[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function status(value: unknown): RemoteBotLifecycleStatus {
  return value === 'active'
    || value === 'paused'
    || value === 'error'
    || value === 'archived'
    || value === 'deleting'
    ? value
    : 'error';
}

/** Device-link is an untrusted wire boundary. Keep only the fields Mobile renders. */
export function normalizeRemoteBotProfiles(value: unknown): RemoteBotProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const id = text(item.id).trim();
    const name = text(item.name).trim();
    if (!id || !name) return [];
    const channels = Array.isArray(item.channels)
      ? item.channels.flatMap((rawChannel) => {
          if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) return [];
          const channel = rawChannel as Record<string, unknown>;
          const kind = text(channel.kind).trim();
          return kind ? [{ kind, enabled: channel.enabled === true }] : [];
        })
      : [];
    return [{
      id,
      name,
      description: text(item.description),
      avatar: text(item.avatar) || '🤖',
      avatarColor: text(item.avatarColor),
      status: status(item.status),
      currentVersion: Number.isInteger(item.currentVersion) && Number(item.currentVersion) > 0
        ? Number(item.currentVersion)
        : 1,
      ...(text(item.canonicalSessionId).trim()
        ? { canonicalSessionId: text(item.canonicalSessionId).trim() }
        : {}),
      channels,
    }];
  });
}

export function isRemoteBotsUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return code === 'CHANNEL_NOT_ALLOWED'
    || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
    || message.includes('CHANNEL_NOT_ALLOWED')
    || message.includes('DEVICE_LINK_CHANNEL_NOT_ALLOWED');
}

export function remoteBotCanOpen(bot: RemoteBotProfile): boolean {
  return bot.status === 'active' && !!bot.canonicalSessionId;
}

export function resolveRemoteBotAvatarColor(
  value: string,
  colors: {
    cta: string;
    inputCaret: string;
    textSecondary: string;
    textPrimary: string;
    surfaceElevated: string;
  },
): string {
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (value === 'violet') return colors.cta;
  if (value === 'blue') return colors.inputCaret;
  if (value === 'amber') return colors.textSecondary;
  if (value === 'graphite') return colors.textPrimary;
  return colors.surfaceElevated;
}
