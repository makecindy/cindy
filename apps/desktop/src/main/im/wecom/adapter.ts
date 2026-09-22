import type { WecomIM } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import {
  ensureWecomManagedWorkingDir,
  resolveWecomWorkingDirForNewConversation,
} from './channelSettings';
import { ui } from './uiText';
import type { WecomTextInteractions } from './textInteractions';

function sessionSafeUserId(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

export function buildWecomAdapter(
  wecomIm: WecomIM,
  interactions: WecomTextInteractions,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'wecom',
    im: wecomIm,
    output: {
      kind: 'chunked-text',
      im: wecomIm,
      beginReply: (userId) => wecomIm.beginReply(userId),
      commitFinal: (output) => wecomIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'wecom',
      sessionIdFor: (botId, userId) =>
        `wecom_${sessionSafeUserId(botId)}_${sessionSafeUserId(userId)}`,
      defaultTitle: (userId) =>
        userId.startsWith('group/')
          ? `企微群 · ${userId.slice(-6)}`
          : `企业微信 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '企业微信 · ',
      workspaceKind: 'dialogue',
      // 同步兜底只回稳定托管目录; 实际目录(读配置+探测用户盘)在首次对话 /
      // /new 边界经 resolveWorkingDirForNew 异步解析。
      ensureWorkingDir: ensureWecomManagedWorkingDir,
      resolveWorkingDirForNew: resolveWecomWorkingDirForNewConversation,
      // 设置页可改渠道托管目录: /new 边界刷新到最新解析结果。
      refreshWorkingDirOnNew: true,
      extraInsertColumns: (botId, userId) => ({
        imBotContextId: botId,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    buildVendorOptions: (userId) => ({
      source: 'wecom',
      wecomConversationId: userId,
    }),
    handleTextInteraction: (userId, request) => interactions.handle(userId, request),
  };
}
