import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

/**
 * 群轮次的 per-turn 收紧(D1/D2, 2026-07-30 一群一会话版; review 修订后
 * **所有群轮次**都挂, 含 owner 触发 — 群窗口/引用块携带成员可控文本, 注入
 * 可借 owner 轮次的宽松档执行危险操作)。读/搜/答自由通过; 破坏性调用与
 * 不透明写(file_change / permissions 升权)强制弹确认卡, 而卡片点击只认
 * owner — 即"谁都能问, 动手要主人拍板"。
 *
 * 判定逻辑与个人微信 / 钉钉共用 channelForceConfirmToolCall(嵌套解包覆盖
 * Claude call_tool、Codex MCP elicitation 与 Pi 桥接 MCP / 二级分派插件)。
 * 会话权限档为 acceptEdits/bypassPermissions 时 maker 会拒绝本策略(fail-closed):
 * guest 轮次直接报错不跑, 不会放开。
 */
export function createTelegramGuestTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'telegram', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
