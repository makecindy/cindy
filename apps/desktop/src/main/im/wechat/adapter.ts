import type { RichChannelIM } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { resolveWechatWorkingDir } from './channelSettings';
import { ui } from './uiText';
import { sessionIdFor, type WechatIM } from './WechatIM';

function ensureWorkingDir(botId: string): string {
  return resolveWechatWorkingDir(botId);
}

export function buildWechatAdapter(
  wechatIm: WechatIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'wechat',
    // The shared adapter type still includes rich-card methods. WechatIM makes
    // those methods fail closed, while this output discriminator guarantees
    // normal turn output only invokes commitFinal.
    im: wechatIm as RichChannelIM,
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
      ensureWorkingDir,
      extraInsertColumns: (botId, peerId) => ({
        imBotContextId: botId,
        imUserId: peerId,
      }),
    },
    processingEmoji: '',
    buildVendorOptions: (userId) => ({ source: 'wechat', wechatPeerId: userId }),
    handleTextInteraction: (userId, request) =>
      wechatIm.handleTextInteraction(userId, request),
    onUserMessagePersisted: (args) => wechatIm.onUserMessagePersisted(args),
  };
}
