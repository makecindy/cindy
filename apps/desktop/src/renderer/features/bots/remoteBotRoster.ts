export interface RemoteBot {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  avatar: string;
  avatarColor: string;
  description: string;
  preview: string;
  activityAt: number;
  sessionId: string | null;
  online: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof record(value).fallback === 'string'
      ? (record(value).fallback as string)
      : '';
}

/** Only consume the advertised Bot collection, never infer identity from task titles. */
export function parseRemoteBots(value: unknown, deviceId: string, deviceName: string): RemoteBot[] {
  const response = record(value);
  if (response.collectionId !== 'teammates' || !Array.isArray(response.items)) {
    throw new Error('Invalid teammate collection');
  }
  return response.items.map((value: unknown) => {
    const item = record(value);
    const ref = record(item.ref);
    const display = record(item.display);
    const avatar = record(display.avatar);
    if (
      ref.collectionId !== 'teammates' ||
      ref.kind !== 'bot' ||
      typeof ref.id !== 'string' ||
      !ref.id ||
      !text(display.title)
    ) {
      throw new Error('Invalid teammate identity');
    }
    const link = Array.isArray(item.links)
      ? item.links.find((value: unknown) => {
          const link = record(value);
          return link.rel === 'conversation' && record(link.target).kind === 'session';
        })
      : undefined;
    const sessionId = record(record(link).target).sessionId;
    return {
      id: ref.id,
      deviceId,
      deviceName,
      name: text(display.title),
      avatar: text(avatar.value),
      avatarColor: text(avatar.color),
      description: text(display.subtitle),
      preview: text(display.preview),
      activityAt: typeof display.timestamp === 'number' ? display.timestamp : 0,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      online: true,
    };
  });
}

export function remoteBotKey(bot: Pick<RemoteBot, 'deviceId' | 'id'>): string {
  return `${bot.deviceId}:${bot.id}`;
}
