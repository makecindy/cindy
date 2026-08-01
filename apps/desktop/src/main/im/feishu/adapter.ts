/**
 * main/im/feishu/adapter.ts
 * ---------------------------------------------------------------------------
 * 飞书渠道的 ImChannelAdapter — im/shared 编排层所需的全部渠道差异在此收敛:
 *   - session 行策略: id `feishu_{botAppId}_{openId}` / source='feishu' /
 *     feishu 专属列 / im-working-dir/{botAppId} 共享工作目录
 *   - vendorOptions: { feishuChatId, source:'feishu' } → 注入 cindy_feishu_bot
 *     MCP (send_file_to_user)
 *   - ack emoji: REACTION_PROCESSING
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { FeishuIM } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { claimLegacyImPath, ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { ui, REACTION_PROCESSING } from './uiText';

/**
 * 飞书 bot 的 workingDir = `userData/im-working-dir/{botAppId}/`
 * 同 bot 下所有 feishu session 共享这个目录 —— 与老系统对齐
 * (sessionBridge.ts:200-209)。设计取舍:
 *   - 共享: 模型可以跨 turn / 跨 session 引用之前生成的文件 ("看下我们刚做的那个")
 *   - 不分:每个 session 自己一坨工作目录, 跨 session 引用文件需要绝对路径
 * 在 owner 私聊场景下共享更符合直觉。
 */
function ensureWorkingDir(botAppId: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', botAppId);
  claimLegacyImPath(path.join(app.getPath('userData'), 'im-working-dir', botAppId), dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildFeishuAdapter(
  feishuIm: FeishuIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  const conversationPrefix = () => (feishuIm.getService() === 'lark' ? '[Lark·DM] ' : '[飞书·DM] ');
  return {
    channel: 'feishu',
    im: feishuIm,
    output: { kind: 'rich-card', im: feishuIm },
    config,
    ui,
    sessions: {
      source: 'feishu',
      /**
       * Deterministic session id derived from feishu identity.
       *
       * Stable across restarts and credential save/load cycles: the same
       * (botAppId, openId) pair always resolves to the same DB row。Format:
       * `feishu_{botAppId}_{openId}` — long but human-readable, easy to grep。
       */
      sessionIdFor: (botAppId, openId) => `feishu_${botAppId}_${openId}`,
      defaultTitle: (openId) => `${conversationPrefix()}${openId.slice(-6)}`,
      // 首条消息(含每次 /new 后的首条)oneshot 起名的前缀 —— 与 hook Slack 的
      // `[Slack·DM]` 同款视觉, 在「对话」分组里一眼认出渠道
      generatedTitlePrefix: conversationPrefix,
      // 飞书 bot 私聊会话进侧边栏「对话」分组; workingDir 是 app 托管的
      // im-working-dir, 不该以它聚成假项目组
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (botAppId, openId) => ({
        feishuBotAppId: botAppId,
        feishuOpenId: openId,
      }),
    },
    processingEmoji: REACTION_PROCESSING,
    buildVendorOptions: (openId) => ({ feishuChatId: openId, source: 'feishu' }),
  };
}
