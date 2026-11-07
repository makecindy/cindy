/**
 * custom/adapter.ts — 自定义 HTTP 渠道的编排适配。
 *
 * 与其它渠道的差别只有三处: 渠道名、会话维度键(conversationId 当 scopeKey)、
 * 以及没有表情/卡片/slash 的平台能力。其余(会话查找、投递、收口、附件)全部走
 * 共享的 ImOrchestrator。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CustomIM } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { ui } from './uiText';

function ensureWorkingDir(connectionId: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', `custom-${connectionId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 会话 id 由 conversationId 决定: 同一个外部会话跨重启复用同一间 Cindy 会话。 */
export function customSessionIdFor(connectionId: string, conversationId: string): string {
  const encoded = Buffer.from(JSON.stringify([connectionId, conversationId]), 'utf8').toString(
    'base64url',
  );
  return `custom_${encoded}`;
}

export function buildCustomAdapter(
  customIm: CustomIM,
  config: ImOrchestratorConfig,
  options: { connectionId: string; displayName: string; ownerConversationId?: string | null },
): ImChannelAdapter {
  return {
    channel: 'custom',
    // 与其他 IM 渠道同一套语义: 指定为主人的 conversationId 落伙伴主任务(Bots 面板
    // 可见), 其余 conversationId 各走一条隐藏专线。
    companionLane: (conversationId) =>
      options.ownerConversationId && conversationId === options.ownerConversationId
        ? { kind: 'owner-dm' }
        : { kind: 'guest-dm', userId: conversationId },
    im: customIm,
    output: {
      kind: 'chunked-text',
      im: customIm,
      commitFinal: (output) => customIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'custom',
      sessionIdFor: (_contextId, userId) => customSessionIdFor(options.connectionId, userId),
      defaultTitle: (conversationId) => `${options.displayName} · ${conversationId.slice(-8)}`,
      generatedTitlePrefix: `${options.displayName} · `,
      workspaceKind: 'dialogue',
      ensureWorkingDir: () => ensureWorkingDir(options.connectionId),
      extraInsertColumns: (_contextId, userId) => ({
        imBotContextId: options.connectionId,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    buildVendorOptions: (userId) => ({
      source: 'custom',
      customConnectionId: options.connectionId,
      customConversationId: userId,
    }),
  };
}

export function customAttachmentMeta(absPath: string): { name: string; mimeType: string } | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    return { name: path.basename(absPath), mimeType: guessMime(absPath) };
  } catch {
    return null;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

function guessMime(absPath: string): string {
  return MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
}
