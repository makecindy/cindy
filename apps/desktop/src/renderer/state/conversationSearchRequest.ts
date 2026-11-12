/**
 * conversationSearchRequest —— 请求在项目或任务组内打开搜索的跨层信号。
 *
 * 背景:展开侧栏的会话搜索是常驻内联框(CCAgentSidebarUpper 的 SidebarInlineSearch
 * + useConversationSearch);rail 态是 ConversationSearchBox 图标弹窗。"在此项目内搜索"
 * 这个动作的生产者是项目树右键菜单(ProjectNode → CCAgentSidebarUpper.handleOpenConversationSearch),
 * 消费方是同组件里的 useConversationSearch。用这个 module-level store 解耦生产/消费
 * (与 state/pendingProjectFocus.ts 同款 useSyncExternalStore),也便于 rail 弹窗复用同一信号。
 *
 * requestId 单调递增:同一 project 连续两次"搜索"也要各触发一次 —— 消费方据 requestId
 * 变化锁定该 project 并聚焦/打开搜索。
 */

import { useSyncExternalStore } from 'react';

export interface ConversationSearchProjectRequest {
  kind?: 'project';
  projectKey: string;
  projectName: string;
  sessionIds: string[];
  workingDir?: string | null;
  deviceLinkDeviceId?: string | null;
  requestId: number;
}

export interface ConversationSearchSessionGroupRequest {
  kind: 'session-group';
  groupName: string;
  sessionIds: string[];
  requestId: number;
}

export type ConversationSearchScopeRequest =
  ConversationSearchProjectRequest | ConversationSearchSessionGroupRequest;

let current: ConversationSearchScopeRequest | null = null;
let nextRequestId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 项目或任务组菜单发起搜索；自增 requestId 保证同一范围可反复打开。 */
export function requestConversationSearch(
  req:
    | Omit<ConversationSearchProjectRequest, 'requestId'>
    | Omit<ConversationSearchSessionGroupRequest, 'requestId'>,
): void {
  current = { ...req, requestId: nextRequestId++ };
  emit();
}

export function getConversationSearchRequest(): ConversationSearchScopeRequest | null {
  return current;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Hook —— 消费方(useConversationSearch)用它订阅 projectFilterRequest。 */
export function useConversationSearchRequest(): ConversationSearchScopeRequest | null {
  return useSyncExternalStore(
    subscribe,
    getConversationSearchRequest,
    getConversationSearchRequest,
  );
}

/**
 * 消费方(useConversationSearch)处理完一次请求后调用,把 current 清零。与
 * state/pendingProjectFocus.ts 的 consumePendingProjectFocus 同款:避免组件卸载后重挂时,
 * 开框 effect 在挂载阶段读到 stale current 而误弹搜索框(PR #246 review)。
 */
export function consumeConversationSearchRequest(): void {
  if (current === null) return;
  current = null;
  emit();
}
