/**
 * main/im/discord/adapter.ts
 * ---------------------------------------------------------------------------
 * Discord 渠道的 ImChannelAdapter — P1 只接 DM, 不启用 threadScoped。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { DiscordIM } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { claimLegacyImPath, ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { ui, PROCESSING_EMOJI } from './uiText';

function ensureWorkingDir(appId: string): string {
  const leaf = `discord-${appId}`;
  const dir = ownerScopedImUserDataPath('im-working-dir', leaf);
  claimLegacyImPath(path.join(app.getPath('userData'), 'im-working-dir', leaf), dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildDiscordAdapter(
  discordIm: DiscordIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'discord',
    im: discordIm,
    output: { kind: 'rich-card', im: discordIm },
    config,
    ui,
    sessions: {
      source: 'discord',
      sessionIdFor: (appId, userId) => `discord_${appId}_${userId}`,
      defaultTitle: (userId) => `Discord · ${userId.slice(-6)}`,
      generatedTitlePrefix: 'Discord · ',
      // Discord personal DMs use Cindy-managed working directories just like
      // Feishu/Telegram DMs. Keep them in the global "dialogue" bucket instead
      // of making `discord-{appId}` look like a user project.
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (appId, userId) => ({
        imBotContextId: appId,
        imUserId: userId,
      }),
    },
    processingEmoji: PROCESSING_EMOJI,
    buildVendorOptions: (userId) => ({ discordChatId: userId, source: 'discord' }),
  };
}
