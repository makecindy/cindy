import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import {
  ensureWechatManagedWorkingDir,
  resolveWechatWorkingDirForNewConversation,
} from './channelSettings';
import { ui } from './uiText';
import { sessionIdFor, type WechatIM } from './WechatIM';

export function buildWechatAdapter(
  wechatIm: WechatIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'wechat',
    im: wechatIm,
    output: {
      kind: 'chunked-text',
      im: wechatIm,
      commitFinal: (output) => wechatIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'wechat',
      sessionIdFor,
      defaultTitle: (peerId) => `微信 · ${peerId.slice(-6)}`,
      generatedTitlePrefix: '微信 · ',
      workspaceKind: 'dialogue',
      // 同步兜底只回稳定托管目录; 实际目录(读配置+探测用户盘)在首次对话 /
      // /new 边界经 resolveWorkingDirForNew 异步解析。
      ensureWorkingDir: ensureWechatManagedWorkingDir,
      resolveWorkingDirForNew: resolveWechatWorkingDirForNewConversation,
      // 设置页可改渠道托管目录: /new 边界刷新到最新解析结果。
      refreshWorkingDirOnNew: true,
      extraInsertColumns: (botId, peerId) => ({
        imBotContextId: botId,
        imUserId: peerId,
      }),
    },
    processingEmoji: '',
    buildVendorOptions: (userId) => ({ source: 'wechat', wechatPeerId: userId }),
    handleTextInteraction: (userId, request, options) =>
      wechatIm.handleTextInteraction(userId, request, options),
    cancelTextInteraction: (userId, requestId, decision) =>
      wechatIm.cancelTextInteraction(userId, requestId, decision),
    onUserMessagePersisted: (args) => wechatIm.onUserMessagePersisted(args),
  };
}
