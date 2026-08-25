import { encodeMessageId } from './codec.js';
import { chunkDiscordText } from './chunk.js';

export interface SentMessageLike {
  id: string;
}

export interface DMChannelLike {
  id: string;
  send(payload: unknown): Promise<SentMessageLike>;
}

export interface UserLike {
  createDM(): Promise<DMChannelLike>;
}

export interface ClientLike {
  users: {
    fetch(userId: string): Promise<UserLike>;
  };
}

export function createDmResolver(client: ClientLike): (userId: string) => Promise<DMChannelLike> {
  const cache = new Map<string, Promise<DMChannelLike>>();

  return (userId: string) => {
    let found = cache.get(userId);
    if (!found) {
      found = client.users.fetch(userId).then((user) => user.createDM());
      found.catch(() => {
        if (cache.get(userId) === found) cache.delete(userId);
      });
      cache.set(userId, found);
    }
    return found;
  };
}

export async function sendChunked(
  ch: DMChannelLike,
  text: string,
  assertCurrent: () => void = () => {},
): Promise<{ firstMessageId: string }> {
  const chunks = chunkDiscordText(text);
  let firstMessageId = '';

  for (const chunk of chunks) {
    assertCurrent();
    const sent = await ch.send(chunk);
    assertCurrent();
    if (!firstMessageId) firstMessageId = encodeMessageId(ch.id, sent.id);
  }

  return { firstMessageId };
}
