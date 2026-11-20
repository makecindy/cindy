// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { remoteWaitingScope } from '@/features/cc-agent/lib/localizeAgentStatus';
import { useRemoteStartFeedback } from '@/features/cc-agent/lib/useRemoteStartFeedback';
import type { ChatMessage } from '@/lib/makerChatStore';
import {
  getStartingSessionIds,
  markSessionStarting,
  noteStartingTerminal,
  resetSessionStartingStoreForTests,
} from '@/lib/sessionStartingStore';

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
}));

/**
 * 测试价值
 * - 生产入口与可观察结果：CCAgentSessionView 实际调用的 useRemoteStartFeedback；状态栏显示
 *   等待远端响应，running／响应／终态后恢复正常状态，真实 starting 标记被吸收。
 * - Bug／规则依据：#11720；engineering-conventions.md §3.2，SSH 预检期间不能空白或残留 starting。
 * - 现有覆盖缺口：agentStatusI18n 只覆盖运行中的远端文案，sessionStartingStore 只覆盖吸收机制，
 *   原源码字符串守卫不执行会话视图的状态派生。
 * - 最小失败输入：agentDeviceId 为空、remoteHostId 有值，发送后尚无 running／响应／终态。
 * - tier：unit（jsdom），生产 hook + 内存 starting store，无传输、真实等待或源码读取。
 * - 实测耗时：本机单文件首次运行 2.06s（6 项测试）。
 */
describe('remoteWaitingScope', () => {
  it('本机会话不算在等远端', () => {
    expect(remoteWaitingScope(null, null)).toBe(false);
    expect(remoteWaitingScope(undefined, undefined)).toBe(false);
  });

  it('device-link 会话按 agentDeviceId 算', () => {
    expect(remoteWaitingScope('remote-device', null)).toBe(true);
  });

  it('SSH 远端会话按 remoteHostId 算', () => {
    expect(remoteWaitingScope(null, 'ssh-host-1')).toBe(true);
  });
});

type Props = Parameters<typeof useRemoteStartFeedback>[0];
type Settlement = 'running' | 'response' | 'terminal';

describe('SSH 会话发送后的等待反馈', () => {
  beforeEach(() => {
    resetSessionStartingStoreForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    resetSessionStartingStoreForTests();
    vi.useRealTimers();
  });

  it.each<Settlement>(['running', 'response', 'terminal'])(
    '发送后显示等待态，收到 %s 后等待与 starting 收口',
    (settlement) => {
      const sessionId = `ssh-${settlement}`;
      const clientId = `input-${settlement}`;
      const input = {
        role: 'user', clientId, content: 'run', createdAt: new Date(1000).toISOString(),
      } as ChatMessage;
      const initialProps: Props = {
        sessionId,
        agentDeviceId: null,
        remoteHostId: 'ssh-host-1',
        status: '',
        isRunning: false,
        messages: [input],
        queuePaused: false,
        credentialSwitchWait: null,
        pendingPermission: null,
        pendingAskUser: null,
        pendingPluginSetup: null,
        pendingPlanReview: null,
      };
      markSessionStarting(sessionId, clientId);
      const { result, rerender } = renderHook(
        (props: Props) => useRemoteStartFeedback(props),
        { initialProps },
      );

      expect(result.current).toEqual({
        waitingRemoteStart: true,
        status: 'Waiting for remote response',
      });
      expect(getStartingSessionIds().has(sessionId)).toBe(true);

      if (settlement === 'running') {
        rerender({ ...initialProps, isRunning: true, status: 'Thinking...' });
      } else if (settlement === 'response') {
        const response = {
          role: 'assistant', clientId: 'reply', content: 'done', createdAt: new Date(1100).toISOString(),
        } as ChatMessage;
        rerender({ ...initialProps, messages: [input, response], status: 'Thinking...' });
      } else {
        act(() => noteStartingTerminal(sessionId, clientId));
      }

      expect(result.current.waitingRemoteStart).toBe(false);
      expect(result.current.status).toBe(settlement === 'terminal' ? '' : 'Thinking...');
      expect(getStartingSessionIds().has(sessionId)).toBe(false);
    },
  );
});
