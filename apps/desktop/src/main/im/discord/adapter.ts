import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { claimLegacyImPath, ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { buildDiscordAdapter as buildSharedAdapter } from '@cindy/im-runtime/channels/discord/adapter';
export type { DiscordAdapterOptions } from '@cindy/im-runtime/channels/discord/adapter';

function ensureWorkingDir(appId: string): string {
  const leaf = `discord-${appId}`;
  const dir = ownerScopedImUserDataPath('im-working-dir', leaf);
  claimLegacyImPath(path.join(app.getPath('userData'), 'im-working-dir', leaf), dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const buildDiscordAdapter = (
  im: Parameters<typeof buildSharedAdapter>[0],
  config: Parameters<typeof buildSharedAdapter>[1],
  options: Parameters<typeof buildSharedAdapter>[3] = {},
) => buildSharedAdapter(im, config, ensureWorkingDir, options);
