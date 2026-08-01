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
import { acquirePendingAgentSwitchForDirectSend } from '../../maker-ipc/register';
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
}

/** 渠道名 → orchestrator 注册表 — composition root (im/index.ts) 查询用。 */
const registry = new Map<ImChannelName, ImOrchestrator>();

/**
 * 创建并接线一个渠道编排器:所有渠道订阅 im.onMessage；只有 rich-card
 * 渠道订阅 onCardAction。每个渠道只允许调一次(重复调说明 wiring 层 bug,
 * 直接抛)。
 */
export function createImOrchestrator(adapter: ImChannelAdapter): ImOrchestrator {
  if (registry.has(adapter.channel)) {
    throw new Error(`im orchestrator for channel=${adapter.channel} already created`);
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

  const repo = createImSessionRepo(adapter.config, adapter.sessions);
  const cards = createCardBuilders(adapter.ui, repo.getDefaultEffortFor);
  const turnRunner = createTurnRunner(adapter, repo, cards, {
    acquirePendingAgentSwitch: acquirePendingAgentSwitchForDirectSend,
  });
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
  };
  registry.set(adapter.channel, orchestrator);
  log.info(`im orchestrator wired for channel=${adapter.channel}`);
  return orchestrator;
}

export function getImOrchestrator(channel: string): ImOrchestrator | undefined {
  return registry.get(channel as ImChannelName);
}

export function listImOrchestrators(): ImOrchestrator[] {
  return Array.from(registry.values());
}
