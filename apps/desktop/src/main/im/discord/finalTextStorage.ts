import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DiscordFinalTextStorage } from '@cindy/im';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState';
import { ownerScopedImSecretRevision, ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile';
import { personalDiscordFinalTextAuthorization } from './channelAccessStore';
import { botDiscordFinalTextAuthorization } from '../shared/botImConnectionStore';

/** Each call captures one owner; awaited old operations cannot write into the next owner's folder. */
export function discordFinalTextStorage(connectionKey: string, personal: boolean): DiscordFinalTextStorage {
  const owner = activeOwnerScopeKey();
  const root = ownerScopedImUserDataPath('discord-final-text');
  const key = createHash('sha256').update(connectionKey).digest('hex');
  const file = path.join(root, `${key}.json`);
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throw new Error('DISCORD_ACCOUNT_CHANGED');
  };
  const credentialStamp = () => {
    assertCurrent();
    const prefix = personal ? '' : connectionKey;
    return `${ownerScopedImSecretRevision(`${prefix}discord-bot-token`)}:${ownerScopedImSecretRevision(`${prefix}discord-owner-user-id`)}`;
  };
  return {
    key: file,
    assertCurrent,
    credentialStamp,
    read: () => { assertCurrent(); return readAtomicFileSync(file); },
    write: contents => { assertCurrent(); atomicWriteFileSync(file, contents); },
    authorizationStamp: lane => {
      assertCurrent();
      const id = /^bot-im-([a-f0-9]{12})-$/.exec(connectionKey)?.[1];
      if (!personal && !id) throw new Error('DISCORD_CONNECTION_INVALID');
      return `${credentialStamp()}:${personal ? personalDiscordFinalTextAuthorization(lane) : botDiscordFinalTextAuthorization(id!, lane)}`;
    },
  };
}
