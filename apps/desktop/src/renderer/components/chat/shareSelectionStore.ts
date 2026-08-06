/**
 * shareSelectionStore — 「分享对话为图片」的选择模式状态(session-keyed)
 * ---------------------------------------------------------------------------
 * 为什么是模块级 store 而不是 context:消息侧的消费链是
 * MessageStream → MessageRow → AssistantMessage/UserMessage → MessageActionBar
 * 四层,且 MessageRow 是 memo。选中态放进 context 会让每次勾选都重渲染全部消息行
 * (大 session 有数百条),而勾选是高频动作。改成模块级 store + 细粒度订阅后:
 *   - 进出选择模式(低频)才让消息行重渲染(useShareSelectionActive);
 *   - 勾选(高频)只重渲染那一个复选框(useIsMessageSelected 按 clientId 自筛)。
 *
 * getSnapshot 一律返回原始值(boolean / number)。**不要**导出返回 Set / 数组的
 * hook —— useSyncExternalStore 会因每次新引用而无限重渲染。选中集合只在事件处理时
 * 用 `getSelectedIds` / `getSelectedIdsInOrder` 一次性读取。
 *
 * 不持久:纯 in-memory,切会话 / 刷新即清空(分享是一次性动作,没有恢复语义)。
 */

import { useSyncExternalStore } from 'react';
import { parseOrcaCommunicationContent } from './userMessageDisplayText';

/** 参与选择的消息最小结构 —— 只取判据用到的字段,不耦合完整 ChatMessage。 */
interface ShareableMessageLike {
  role: string;
  clientId?: string | undefined;
  content?: string | undefined;
  systemCardType?: unknown;
  isSyntheticTrigger?: boolean | undefined;
}

/**
 * 哪条消息可被勾选:仅正文对话(产品口径 —— 工具卡 / 思考 / 计划 / 错误卡不进图)。
 *   - role 只认 user / assistant;
 *   - 带 systemCardType 的行渲染成 SystemCard(自愈记录、分隔线),不是正文;
 *   - isSyntheticTrigger 行根本不渲染气泡。
 *   - Orca communication user 行渲染成默认折叠的任务卡,不是正文气泡。
 * 任一不满足就没有可克隆的正文 DOM。
 *
 * 「当前可选的全集」不在这里派生 —— 它以已渲染的 DOM 为准
 * (见 shareConversationImage.queryShareableMessageIds)。
 */
export function isShareableMessage(message: ShareableMessageLike): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (message.systemCardType) return false;
  if (message.isSyntheticTrigger) return false;
  if (message.role === 'user' && parseOrcaCommunicationContent(message.content ?? '')) return false;
  return true;
}

/** 选择模式所属会话;null = 未进入选择模式。 */
let activeSessionId: string | null = null;
const selected = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 静默:listener 抛错不应影响其它订阅者 */
    }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const shareSelectionStore = {
  subscribe,

  /** 当前处于选择模式的会话 id(null = 未进入)。 */
  getActiveSessionId(): string | null {
    return activeSessionId;
  },

  isActive(sessionId: string | undefined): boolean {
    return Boolean(sessionId) && activeSessionId === sessionId;
  },

  isSelected(clientId: string | undefined): boolean {
    return clientId ? selected.has(clientId) : false;
  },

  count(): number {
    return selected.size;
  },

  /** 当前完整选中集合的快照；用于「全选」临时覆盖后恢复用户原选择。 */
  getSelectedIds(): string[] {
    return Array.from(selected);
  },

  /**
   * 进入选择模式。`preselectClientId` 是入口那条消息 —— 用户从某条消息的操作栏
   * 点进来,那条天然应该已勾选(少一次点击)。切到另一个会话时清空旧选中态。
   */
  enter(sessionId: string, preselectClientId?: string): void {
    if (!sessionId) return;
    if (activeSessionId !== sessionId) selected.clear();
    activeSessionId = sessionId;
    if (preselectClientId) selected.add(preselectClientId);
    notify();
  },

  exit(): void {
    if (activeSessionId === null && selected.size === 0) return;
    activeSessionId = null;
    selected.clear();
    notify();
  },

  toggle(clientId: string): void {
    if (!clientId) return;
    if (selected.has(clientId)) selected.delete(clientId);
    else selected.add(clientId);
    notify();
  },

  /** 全选 / 覆盖式设置(⌘A)。 */
  setSelection(clientIds: readonly string[]): void {
    selected.clear();
    for (const id of clientIds) {
      if (id) selected.add(id);
    }
    notify();
  },

  clearSelection(): void {
    if (selected.size === 0) return;
    selected.clear();
    notify();
  },

  /**
   * 按**消息流顺序**返回已选 id。Set 的迭代顺序是点击顺序,直接用会让图片里的
   * 消息乱序;所以以调用方传入的有序全集为准过滤。
   */
  getSelectedIdsInOrder(orderedIds: readonly string[]): string[] {
    return orderedIds.filter((id) => selected.has(id));
  },

  /**
   * 会话切换时的收口:当前选择模式属于别的会话就退出。
   * (会话视图 remount 时调用 —— 选择态不跨会话保留。)
   */
  exitIfNotSession(sessionId: string | undefined): void {
    if (activeSessionId === null) return;
    if (activeSessionId === sessionId) return;
    shareSelectionStore.exit();
  },

  /** 仅供测试。 */
  reset(): void {
    activeSessionId = null;
    selected.clear();
    listeners.clear();
  },
};

/** 该会话是否处于选择模式(低频变化 —— 消息行订阅这个)。 */
export function useShareSelectionActive(sessionId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shareSelectionStore.isActive(sessionId),
    () => false,
  );
}

/** 单条消息是否已勾选(高频变化 —— 只有那一个复选框重渲染)。 */
export function useIsMessageSelected(clientId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shareSelectionStore.isSelected(clientId),
    () => false,
  );
}

/** 已选条数(底部操作条订阅)。 */
export function useShareSelectionCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => shareSelectionStore.count(),
    () => 0,
  );
}
