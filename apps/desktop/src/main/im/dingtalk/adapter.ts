import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DingTalkIM, RichChannelIM } from '@cindy/im';
import { decodeDingTalkLaneUserId } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { handleDingTalkTextInteraction } from './interaction';
import { createDingTalkTurnPermissionPolicy } from './permissionPolicy';
import { ui } from './uiText';

function ensureWorkingDir(appKey: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', dingtalkManagedWorkingDirName(appKey));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dingtalkManagedWorkingDirName(appKey: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(appKey)) return `dingtalk-${appKey}`;
  const digest = createHash('sha256').update(appKey, 'utf8').digest('hex').slice(0, 24);
  return `dingtalk-external-${digest}`;
}

export function dingtalkSessionIdFor(appKey: string, userId: string): string {
  const encodedIdentity = Buffer.from(JSON.stringify([appKey, userId]), 'utf8').toString(
    'base64url',
  );
  return `dingtalk_${encodedIdentity}`;
}

function sanitizeSpeaker(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b]/g, ' ')
    .trim()
    .slice(0, 64);
}

export function buildDingTalkAdapter(
  dingtalkIm: DingTalkIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'dingtalk',
    // The shared card-action subscription still expects the rich interface.
    // Normal turn output is discriminated below and never calls card methods.
    im: dingtalkIm as RichChannelIM,
    output: {
      kind: 'chunked-text',
      im: dingtalkIm,
      commitFinal: (output) => dingtalkIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'dingtalk',
      sessionIdFor: dingtalkSessionIdFor,
      defaultTitle: (userId) =>
        decodeDingTalkLaneUserId(userId)
          ? `钉钉群聊 · ${userId.slice(-6)}`
          : `钉钉 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '钉钉 · ',
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (appKey, userId) => ({
        imBotContextId: appKey,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    buildVendorOptions: (userId) => ({ dingtalkChatId: userId, source: 'dingtalk' }),
    handleTextInteraction: (userId, request) =>
      handleDingTalkTextInteraction(dingtalkIm, userId, request),
    // 对齐 Telegram / 飞书的边界：主人私聊完全遵循 session.permissionMode，
    // 因而可以显式选择 bypassPermissions（完全访问）；群聊携带成员可控上下文，
    // 无论谁 @ bot 都附加强确认策略，危险操作仍须主人在群里确认。
    turnPermissionPolicyFor: (event) =>
      event.speaker ? createDingTalkTurnPermissionPolicy(event.messageId) : undefined,
    prepareAgentTurnText: async (event) => {
      if (!event.speaker) return null;
      const speaker = sanitizeSpeaker(event.speaker.name);
      return {
        agentText: `[发言人] ${speaker} · id:${event.speaker.id}${event.speaker.isOwner ? ' · 主人' : ''}\n${event.text}`,
      };
    },
  };
}
