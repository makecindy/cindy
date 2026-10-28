/**
 * main/im/shared/orchestrator.ts
 * ---------------------------------------------------------------------------
 * IM 渠道编排器组合根:按 adapter 实例化 sessionRepo / cardBuilders /
 * turnRunner / slash / messageHandler / cardActionHandler, 并维护全局注册表
 * 供 main/im/index.ts 的 binding cleanup hook / dispose 路径按渠道名取用。
 *
 * 一个渠道一个 orchestrator 实例;实例内部状态(sessionStates / userLocks)
 * 互相隔离。pendingInteractions / controlState 是跨渠道共享的模块级单例
 * (key 全局唯一, 见各自文件头)。
 */

import { createLogger } from '../../logger';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { onChannelTurn } from '../../maker-ipc/channelTurnSignal';
import { captureImAccountGeneration, isImAccountGenerationCurrent } from '../accountBoundary';
import { bindingStore } from '../binding';
import {
  acquirePendingAgentSwitchForDirectSend,
  acquirePendingAgentSwitchForImSend,
  prepareUnhealthySessionForSend,
  registerSwitchedSessionVendorOptionsResolver,
} from '../../maker-ipc/register';
import { createImChannelDefaultRouteSync } from './channelDefaultRouteSync';
import { createImCompanionRouteDeps } from './imBotBindingRuntime';
import { createImSessionRepo, type ImSessionRepo } from './sessionRepo';
import { createCardBuilders, type ImCardBuilders } from './cardBuilders';
import { createTurnRunner, type ImTurnRunner } from './turnRunner';
import { createSlashHandlers } from './slashCommands';
import { createMessageHandler } from './messageHandler';
import { createCardActionHandler } from './cardActionHandler';
import type { ImChannelAdapter, ImChannelName } from './types';

const log = createLogger('im:orchestrator');

export interface ImOrchestrator {
  readonly channel: ImChannelName;
  readonly adapter: ImChannelAdapter;
  readonly repo: ImSessionRepo;
  readonly cards: ImCardBuilders;
  readonly turnRunner: ImTurnRunner;
  /** 接管 detach 清理 — binding cleanup hook 调用。 */
  detachFromSession(sessionId: string): void;
  /** Stop IM-owned turns and release all account-scoped session hooks. */
  disposeAllSessions(): Promise<void>;
  /** 从注册表摘掉并注销跨模块挂钩(伙伴自有连接移除 / 停止时)。 */
  unregister(): void;
}

export interface CreateImOrchestratorOptions {
  /**
   * 注册表键。缺省 = 渠道名(设置页那份个人连接, 每渠道一份); 伙伴自有连接每条一个
   * 独立键(`<channel>#<connectionId>`), 与设置页那份并存。
   */
  instanceKey?: string;
  /**
   * 这条连接属于哪位伙伴: 主人私聊进伙伴主任务, 群 / 话题 / 外部私聊进伙伴的隐藏
   * 专线(需 adapter.companionLane)。缺省 = 渠道自己的路由。
   */
  companionBotId?: string | ((botContextId: string, userId?: string) => string | null);
  companionFailClosed?: boolean | ((userId?: string) => boolean);
}

/**
 * 注册表 — composition root (im/index.ts) 按渠道名查设置页那份; 伙伴自有连接按
 * instanceKey 登记, `listImOrchestrators` 两者都含。
 */
const registry = new Map<string, ImOrchestrator>();

// Background sends can be the first activity after restart: restore only output
// routing from the saved channel identity, without creating/resuming a session.
onChannelTurn(async (session, phase, source) => {
  if (phase !== 'starting') return;
  if (source === 'provider-wake' || source === 'provider-wake-local') {
    // No send precedes a harness wake-up: its first event fans out right after this synchronous
    // call. Only output already wired for a channel can be marked in time; a cold route restored
    // after the row query would relay from mid-turn, so it is not attempted. Same admission as
    // below: a logged-out or replaced account, or a disconnected channel, relays nothing.
    if (captureImAccountGeneration() === null) return;
    for (const orchestrator of registry.values()) {
      if (orchestrator.adapter.im.getStatus().kind === 'connected') orchestrator.turnRunner.noteChannelTurnSource(session, source);
    }
    return;
  }
  const generation = captureImAccountGeneration();
  if (generation === null || ![...registry.values()].some((o) => o.adapter.im.getStatus().kind === 'connected')) return;
  const [row] = await getDbClient().drizzle.select().from(sessions)
    .where(eq(sessions.id, session.id)).limit(1);
  if (!row || row.status === 'deleted' || row.status === 'archived' || !isImAccountGenerationCurrent(generation)) return;
  if (row.source === 'bot') {
    // 伙伴任务没有渠道身份列: 只标记已接好输出的伙伴专线(连接交给伙伴后的群 /
    // 话题), 是否回传由 turnRunner 按专线 / 主任务判定。冷路径(重启后先来的后台
    // 结果)不恢复, 下一条渠道消息接线后照常。
    for (const orchestrator of registry.values()) {
      if (orchestrator.adapter.im.getStatus().kind === 'connected') {
        orchestrator.turnRunner.noteChannelTurnSource(session, source);
      }
    }
    return;
  }
  const binding = bindingStore.findByTarget(session.id);
  const orchestrator = registry.get((binding?.channel ?? row.source) as ImChannelName);
  if (!orchestrator) return;
  const status = orchestrator.adapter.im.getStatus();
  const botId = binding?.botContextId ?? (row.source === 'feishu' ? row.feishuBotAppId : row.imBotContextId);
  if (status.kind !== 'connected') return;
  const connectedBotId = orchestrator.adapter.getBotContextId?.() ?? status.appId;
  if (!connectedBotId || connectedBotId !== botId) return;
  const userId = binding?.userId ?? (row.source === 'feishu' ? row.feishuOpenId : row.imUserId);
  if (userId) orchestrator.turnRunner.attachSessionOutput(session, userId, {
    attached: binding !== null,
    scopeKey: binding?.scopeKey,
  }, source);
});

/**
 * 创建并接线一个渠道编排器:所有渠道订阅 im.onMessage；只有 rich-card
 * 渠道订阅 onCardAction。每个渠道只允许调一次(重复调说明 wiring 层 bug,
 * 直接抛)。
 */
export function createImOrchestrator(
  adapter: ImChannelAdapter,
  options: CreateImOrchestratorOptions = {},
): ImOrchestrator {
  const instanceKey = options.instanceKey ?? adapter.channel;
  if (registry.has(instanceKey)) {
    throw new Error(`im orchestrator ${instanceKey} already created`);
  }
  if (options.companionBotId && !adapter.companionLane) {
    throw new Error(`im orchestrator ${instanceKey}: companionBotId requires adapter.companionLane`);
  }
  // threadScoped 渠道的能力配对断言 — thread 文案组与 messageId→threadKey
  // 提取能力缺一不可, 接线期 fail-fast 好过运行时静默坏掉。
  if (
    adapter.threadScoped &&
    (adapter.output.kind !== 'rich-card' ||
      !adapter.ui.thread ||
      !adapter.output.im.threadKeyForMessage)
  ) {
    throw new Error(
      `im orchestrator channel=${adapter.channel}: threadScoped requires ui.thread + im.threadKeyForMessage`,
    );
  }
  // projectSwitching 渠道的能力配对断言 — /project 卡文案缺失会在按钮回流时
  // 静默失效, 接线期 fail-fast。
  if (adapter.projectSwitching && !adapter.ui.cards.project) {
    throw new Error(
      `im orchestrator channel=${adapter.channel}: projectSwitching requires ui.cards.project`,
    );
  }

  const repo = createImSessionRepo(adapter.config, adapter.sessions, {
    // 归属能否按路径推断, 取决于这个渠道有没有 `/project` —— 唯一真相在 adapter 上,
    // 不在 sessions 里再抄一份, 免得两处漂移。
    projectSwitching: adapter.projectSwitching === true,
  });
  const cards = createCardBuilders(adapter.ui, repo.getDefaultEffortFor);
  const defaultRouteSync = createImChannelDefaultRouteSync({
    source: adapter.sessions.source,
    config: adapter.config,
    isRouteUsable: (route) => turnRunner.hasAuthForRoute(route),
  });
  const turnRunner = createTurnRunner(adapter, repo, cards, {
    acquirePendingAgentSwitch: (sessionId, opts) =>
      opts?.channelOwned
        ? acquirePendingAgentSwitchForImSend(sessionId, () => defaultRouteSync.syncUnderLock(sessionId))
        : acquirePendingAgentSwitchForDirectSend(sessionId),
    channelDefaultRoute: defaultRouteSync,
    // 发送前故障恢复与桌面直发同源；健康上下文交给 Session 原生压缩。
    prepareUnhealthySession: (sessionId) => prepareUnhealthySessionForSend(sessionId),
    // 伙伴自有连接: 消息落在伙伴的主任务 / 隐藏专线上。
    ...(options.companionBotId
      ? { companion: { ...createImCompanionRouteDeps(options.companionBotId), failClosed: options.companionFailClosed } }
      : {}),
  });
  // 切换引擎重建会话时补回本渠道的 vendorOptions(bot 专属工具依赖它)。
  const unregisterVendorOptionsResolver = registerSwitchedSessionVendorOptionsResolver(
    (sessionId) => turnRunner.vendorOptionsForSession(sessionId),
  );
  const slash = createSlashHandlers(adapter, repo, cards, turnRunner);
  const attachMessageHandler = createMessageHandler(adapter, slash, turnRunner);

  attachMessageHandler(adapter.im);
  if (adapter.output.kind === 'rich-card') {
    const attachCardActionHandler = createCardActionHandler(adapter, cards, turnRunner);
    attachCardActionHandler(adapter.output.im);
  }

  const orchestrator: ImOrchestrator = {
    channel: adapter.channel,
    adapter,
    repo,
    cards,
    turnRunner,
    detachFromSession: (sessionId) => turnRunner.detachFromSession(sessionId),
    disposeAllSessions: () => turnRunner.disposeAllSessions(),
    unregister: () => {
      unregisterVendorOptionsResolver();
      if (registry.get(instanceKey) === orchestrator) registry.delete(instanceKey);
    },
  };
  registry.set(instanceKey, orchestrator);
  log.info(`im orchestrator wired for ${instanceKey}`);
  return orchestrator;
}

/** 设置页那份个人连接的编排器(按渠道名); 伙伴自有连接不在这里查。 */
export function getImOrchestrator(channel: string): ImOrchestrator | undefined {
  return registry.get(channel);
}

export function listImOrchestrators(): ImOrchestrator[] {
  return Array.from(registry.values());
}
