import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmMutatingToolCall } from '../shared/channelToolPolicy';

/**
 * 飞书群轮次的 per-turn 收紧。
 *
 * 群历史前缀把群成员可控文本注入 owner 触发的轮次, 提示注入可借 owner 轮次
 * 的宽松档执行危险操作。读/列目录/搜文件自由通过; 凡会改磁盘、跑命令、发本地
 * 文件、开浏览器或调插件的调用一律强制弹确认卡。授权卡走 deliverToOwnerDm
 * 改投 owner 私聊 — 卡片点击本就只认 owner(cardActionParser 白名单), 双保险。
 *
 * 比 Telegram / 钉钉更严: 那两侧仍只对破坏性 / 不透明写强确认, Write / 无删词
 * Bash 在 auto 档可能被分类器放行。飞书群上下文会拉最多 250 条外人消息, 所以
 * 这里按「非只读即确认」收口。
 *
 * 会话权限档为 acceptEdits/bypassPermissions 时 maker 拒跑本策略(fail-closed)。
 */
export function createFeishuGroupTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'feishu', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmMutatingToolCall,
  };
}
