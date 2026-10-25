/**
 * main/im/shared/imBotBindingRoute.ts
 * ---------------------------------------------------------------------------
 * 连接交给伙伴后的路由契约(纯函数 + 注入接口, 不 import 数据库 / Electron)。
 *
 * turnRunner 在「找任务」这一步多做一次归属解析: 连接已交给伙伴 → 主人私聊走
 * 伙伴主任务, 群 / 话题 / 获准的陌生人私聊走伙伴的 `channel` 专线; 未交出或伙伴
 * 解析失败 → 原逻辑。真实实现见 imBotBindingRuntime.ts(由 orchestrator 注入),
 * 单测直接注入替身。
 */

import type { ImCompanionLane } from "./types";

export type ImCompanionSessionTarget =
  { kind: "canonical" } | { kind: "channel"; routeKey: string; title: string };

export type ImCompanionSessionResult =
  | { ok: true; sessionId: string; created: boolean }
  | { ok: false; errorCode: string; message: string };

export interface ImCompanionRouteDeps {
  /** 连接(本渠道 + botContextId)已交给的伙伴 id; 未交出返回 null。同步、可在热路径调用。 */
  readBinding(botContextId: string): string | null;
  /**
   * 解析伙伴的落点任务。create=false 只查已有的(不建行、不恢复主任务), 查不到返回 null;
   * create=true 时确保存在(主任务走伙伴主任务恢复入口, 专线幂等创建)。
   */
  resolveSession(input: {
    botId: string;
    target: ImCompanionSessionTarget;
    create: boolean;
  }): Promise<ImCompanionSessionResult | null>;
  /** 归档一条专线(群里 `/new`), 返回被归档的任务 id。 */
  archiveLane(routeKey: string): Promise<string[]>;
  /**
   * 发送前守卫(伙伴暂停 / 归档 → 返回原因, 不发送; 否则对齐模型链、刷新能力纪元)。
   * 必须在拿 send 锁之前调用。
   */
  prepareSend?(sessionId: string): Promise<string | null>;
}

/** 一条连接下所有专线共用的 route key 前缀(整条连接收回 / 改绑时按它归档)。 */
export function companionConnectionRouteKeyPrefix(
  channel: string,
  botContextId: string,
): string {
  return `im:${channel}:${botContextId}:`;
}

/**
 * 专线 route key:
 *   群   `im:<channel>:<botContextId>:g:<chatId>`
 *   话题 `im:<channel>:<botContextId>:g:<chatId>:t:<threadId>`
 *   私聊 `im:<channel>:<botContextId>:dm:<userId>`(获准的非主人)
 */
export function companionLaneRouteKey(
  channel: string,
  botContextId: string,
  lane: Exclude<ImCompanionLane, { kind: "owner-dm" }>,
): string {
  const prefix = companionConnectionRouteKeyPrefix(channel, botContextId);
  if (lane.kind === "guest-dm") return `${prefix}dm:${lane.userId}`;
  return lane.threadId
    ? `${prefix}g:${lane.chatId}:t:${lane.threadId}`
    : `${prefix}g:${lane.chatId}`;
}
