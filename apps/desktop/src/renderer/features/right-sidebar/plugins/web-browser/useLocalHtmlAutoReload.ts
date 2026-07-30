/**
 * 一轮会话结束时，按该轮文件编辑产物刷新当前 HTML 预览。
 *
 * 不监听磁盘。只有当前会话从 running 变为 idle，且最近一轮确实修改了正在预览的
 * 本地 HTML 文件时，才触发一次 webview.reload()。
 */

import { useEffect, useRef } from 'react';

import { makerChatStore, type AgentStatus, type ChatMessage } from '@/lib/makerChatStore';

import { wasFileChangedInLastTurn } from '../../lib/lastTurnChangedFiles';
import { fileUrlToAbsPath, isLocalHtmlFileUrl } from '../../lib/openInSidebarBrowser';

export interface UseLocalHtmlAutoReloadOptions {
  sessionId: string;
  workdir: string;
  /** 当前 webview / plugin state 的 URL。 */
  url: string;
  /** 触发 webview.reload。 */
  reload: () => void;
  /** false 时不订阅（非激活 tab、远程会话或 guest 已崩溃）。 */
  enabled?: boolean;
}

function isTurnRunning(status: AgentStatus): boolean {
  return status.isRunning && status.sideTaskRunning !== true;
}

function latestUserMessageIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return 0;
}

export function useLocalHtmlAutoReload({
  sessionId,
  workdir,
  url,
  reload,
  enabled = true,
}: UseLocalHtmlAutoReloadOptions): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!enabled || !isLocalHtmlFileUrl(url)) return;
    const absPath = fileUrlToAbsPath(url);
    if (!absPath) return;

    const initialSnapshot = makerChatStore.getSnapshot(sessionId);
    let wasRunning = isTurnRunning(initialSnapshot.agentStatus);
    let turnStartMessageIndex = wasRunning
      ? latestUserMessageIndex(initialSnapshot.messages)
      : initialSnapshot.messages.length;
    return makerChatStore.subscribe(sessionId, () => {
      const snapshot = makerChatStore.getSnapshot(sessionId);
      const running = isTurnRunning(snapshot.agentStatus);
      if (!wasRunning && running) {
        turnStartMessageIndex = snapshot.messages.length;
      } else if (wasRunning && !running) {
        const currentTurnMessages = snapshot.messages.slice(
          Math.min(turnStartMessageIndex, snapshot.messages.length),
        );
        if (wasFileChangedInLastTurn(currentTurnMessages, workdir, absPath)) {
          reloadRef.current();
        }
        turnStartMessageIndex = snapshot.messages.length;
      }
      wasRunning = running;
    });
  }, [enabled, sessionId, url, workdir]);
}
