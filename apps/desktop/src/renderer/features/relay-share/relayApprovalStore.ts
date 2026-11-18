/**
 * 中转页「处理」按钮手动打开的审批:页面只登记要看哪条申请,弹窗由 `RelayShareGlobalHost` 统一显示,
 * 与自动弹出的审批共用一个窗口,不会叠两层。
 */
import { useSyncExternalStore } from 'react';

export interface RelayApprovalSelection {
  requestId: string;
  /** 关闭后把焦点还给它(按钮已从页面移除时不抢焦点)。 */
  trigger: HTMLElement | null;
}

let selection: RelayApprovalSelection | null = null;
const listeners = new Set<() => void>();

function publish(next: RelayApprovalSelection | null): void {
  selection = next;
  for (const listener of listeners) listener();
}

export function presentRelayApproval(requestId: string, trigger: HTMLElement | null): void {
  publish({ requestId, trigger });
}

export function closeRelayApproval(requestId: string): void {
  if (selection?.requestId === requestId) publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => selection;

export function useRelayApprovalSelection(): RelayApprovalSelection | null {
  return useSyncExternalStore(subscribe, read, read);
}
