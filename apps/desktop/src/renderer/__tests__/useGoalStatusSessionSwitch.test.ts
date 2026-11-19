// @vitest-environment jsdom
/**
 * useGoalStatus 切换会话时的 state 重置(reviewer #354)。
 *
 * 关键不变量:切到新 sessionId 时,旧会话的目标必须在**本次 render 内**立即清空,
 * 不能在 async getGoalStatus 返回前把旧目标挂到新 sessionId 上——否则 GoalIndicator
 * 会拿新 sessionId 渲旧目标,pause/clear/edit 误发到错的会话。
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGoalStatus } from '@/hooks/useGoalStatus';
import { GoalIndicator } from '@/components/new-chat/GoalIndicator';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function goal(sessionId: string, objective: string): GoalStatusPayload {
  return { sessionId, objective, status: 'active' } as unknown as GoalStatusPayload;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// #11437: real GoalIndicator + useGoalStatus must expose the host's blocked reason.
// Existing hook tests only inspect payloads, not what users can read. Minimal input:
// one blocked goal with a reason, then an active update or a pending session switch.
// Tier: unit (in-memory host; no model, filesystem or network).
it('shows the blocked reason and removes it after recovery or switching tasks', async () => {
  const blocked = {
    ...goal('A', 'Goal A'),
    status: 'blocked',
    lastReason: 'Please provide the sample file',
    turnsUsed: 1,
    maxTurns: null,
    budgetTokens: null,
    noProgressLimit: null,
    usageResetAt: null,
  } as GoalStatusPayload;
  let push!: (payload: { sessionId: string; goal: GoalStatusPayload | null }) => void;
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        getGoalStatus: vi.fn((id: string) =>
          id === 'A' ? Promise.resolve(blocked) : new Promise(() => {}),
        ),
        onGoalStatusChanged: vi.fn((listener) => {
          push = listener;
          return () => {};
        }),
        resumeGoal: async () => {
          push({ sessionId: 'A', goal: { ...blocked, status: 'active', lastReason: null } });
        },
      },
    },
  });
  const { rerender } = render(createElement(GoalIndicator, { sessionId: 'A' }));
  await act(async () => {});
  expect(screen.getByText('Please provide the sample file')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'goal.resume' }));
  });
  expect(screen.queryByText('Please provide the sample file')).toBeNull();
  act(() => push({ sessionId: 'A', goal: blocked }));
  expect(screen.getByText('Please provide the sample file')).toBeTruthy();
  rerender(createElement(GoalIndicator, { sessionId: 'B' }));
  expect(screen.queryByText('Please provide the sample file')).toBeNull();
});

it.each([
  [null, 'goal.blockedReasonUnknown'],
  ['agent reported blocked', 'goal.blockedReasonUnknown'],
  ['turn failed: unknown error', 'goal.blockedReasonUnknown'],
  ['tool_use_loop_detected', 'logic.errors.toolUseLoopDetected'],
  ['model service at capacity', 'goal.status.capacityLimited'],
])(
  'explains blocked reason %s without showing internal sentinel text',
  async (reason, expected) => {
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          getGoalStatus: async () => ({
            ...goal('A', 'Goal A'),
            status: 'blocked',
            lastReason: reason,
          }),
          onGoalStatusChanged: () => () => {},
        },
      },
    });
    render(createElement(GoalIndicator, { sessionId: 'A' }));
    await act(async () => {});
    expect(screen.getByText(expected)).toBeTruthy();
  },
);

it.each([
  'turn failed: fixture connection closed',
  'turn dispatch failed: unable to restore the agent session',
])(
  'expands technical failure details and clears the goal through the existing control: %s',
  async (reason) => {
    let push!: (payload: { sessionId: string; goal: null }) => void;
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          getGoalStatus: async () => ({
            ...goal('A', 'Goal A'),
            status: 'blocked',
            lastReason: reason,
          }),
          onGoalStatusChanged: (listener: typeof push) => {
            push = listener;
            return () => {};
          },
          clearGoal: async () => {
            push({ sessionId: 'A', goal: null });
          },
        },
      },
    });
    render(createElement(GoalIndicator, { sessionId: 'A' }));
    await act(async () => {});
    expect(screen.getByText('goal.blockedTurnFailed')).toBeTruthy();
    expect(screen.queryByText(reason)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
    expect(screen.getByText(reason)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'goal.clear' }));
    });
    expect(screen.queryByText(reason)).toBeNull();
    expect(screen.queryByText('goal.status.blocked')).toBeNull();
  },
);

describe('useGoalStatus session switch', () => {
  it('clears the previous goal synchronously when sessionId changes, before the new fetch resolves', async () => {
    const goalA = goal('A', '整理 A');
    const goalB = goal('B', '整理 B');
    let resolveB: ((g: GoalStatusPayload | null) => void) | null = null;
    const getGoalStatus = vi.fn((sid: string) => {
      if (sid === 'A') return Promise.resolve(goalA);
      return new Promise<GoalStatusPayload | null>((res) => {
        resolveB = res; // B 的状态故意挂起,模拟 async 未返回的窗口
      });
    });
    const onGoalStatusChanged = vi.fn(() => () => {});
    vi.stubGlobal('window', { electronAPI: { maker: { getGoalStatus, onGoalStatusChanged } } });

    const { result, rerender } = renderHook(({ sid }) => useGoalStatus(sid), {
      initialProps: { sid: 'A' as string | null },
    });
    await act(async () => {}); // flush A 的 resolved promise
    expect(result.current).toBe(goalA);

    // 切到 B:B 的 getGoalStatus 仍挂起 —— 旧 A 目标必须立刻清掉,不得泄漏到 B。
    rerender({ sid: 'B' });
    expect(result.current).toBeNull();

    // B 返回后才显示 B 的目标。
    await act(async () => {
      resolveB?.(goalB);
    });
    expect(result.current).toBe(goalB);
  });

  it('clears the goal when sessionId becomes null', async () => {
    const goalA = goal('A', '整理 A');
    const getGoalStatus = vi.fn(() => Promise.resolve(goalA));
    const onGoalStatusChanged = vi.fn(() => () => {});
    vi.stubGlobal('window', { electronAPI: { maker: { getGoalStatus, onGoalStatusChanged } } });

    const { result, rerender } = renderHook(({ sid }) => useGoalStatus(sid), {
      initialProps: { sid: 'A' as string | null },
    });
    await act(async () => {});
    expect(result.current).toBe(goalA);

    rerender({ sid: null });
    expect(result.current).toBeNull();
  });
});
