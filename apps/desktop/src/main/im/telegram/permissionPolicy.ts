import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

/**
 * 群轮次的 per-turn 收紧(D1/D2, 2026-07-30 一群一会话版; review 修订后
 * 除显式 Full access 外的所有群轮次都挂, 含 owner 触发 — 群窗口/引用块携带成员可控文本, 注入
 * 可借 owner 轮次的宽松档执行危险操作)。读/搜/答自由通过; 破坏性调用与
 * 不透明写(file_change / permissions 升权)强制弹确认卡, 而卡片点击只认
 * owner — 即"谁都能问, 动手要主人拍板"。
 *
 * 判定逻辑与个人微信 / 钉钉共用 channelForceConfirmToolCall(嵌套解包覆盖
 * Claude call_tool、Codex MCP elicitation 与 Pi 桥接 MCP / 二级分派插件)。
 * maker 不支持某个会话权限档时会拒绝本策略(fail-closed), 不会静默放开。
 * 唯一例外是用户显式选择 Full access(bypassPermissions): adapter 会在 dispatch
 * 前取缔本策略, 直接按该档执行；群历史 lane 隔离仍独立生效。
 */
export function createTelegramGuestTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'telegram', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
