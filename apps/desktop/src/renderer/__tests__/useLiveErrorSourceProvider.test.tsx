// @vitest-environment jsdom

/**
 * live 错误来源快照的三条不变量:
 *   1. 快照:错误出现时取当时的 provider,错误存续期间切 provider 不跟随;
 *   2. 任务边界:同一组件实例跨 sessionId 复用、错误文本恰好相同时,快照必须
 *      按新任务重新取值(review 实锤:只跟 error 走会沿用上一任务的来源,
 *      把错误引向错误的充值入口);
 *   3. 错误清除 → 快照归零。
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';

import { useLiveErrorSourceProvider } from '@/hooks/useLiveErrorSourceProvider';

let latest: string | null = null;

function Probe({
  error,
  sessionId,
  providerId,
}: {
  error: string | null;
  sessionId: string;
  providerId: string | null;
}) {
  latest = useLiveErrorSourceProvider(error, sessionId, providerId);
  return null;
}

afterEach(() => {
  cleanup();
  latest = null;
});

describe('useLiveErrorSourceProvider', () => {
  it('错误出现时快照当时的 provider,之后切 provider 不跟随', () => {
    const { rerender } = render(
      createElement(Probe, { error: null, sessionId: 's1', providerId: 'xd' }),
    );
    expect(latest).toBeNull();

    act(() => {
      rerender(createElement(Probe, { error: 'insufficient_quota', sessionId: 's1', providerId: 'xd' }));
    });
    expect(latest).toBe('xd');

    // 报错后切到 openai:快照保持 xd —— 充值入口不丢。
    act(() => {
      rerender(createElement(Probe, { error: 'insufficient_quota', sessionId: 's1', providerId: 'openai' }));
    });
    expect(latest).toBe('xd');
  });

  it('同一错误文本跨任务复用组件实例时,按新任务重新取值', () => {
    const { rerender } = render(
      createElement(Probe, { error: 'insufficient_quota', sessionId: 's1', providerId: 'xd' }),
    );
    expect(latest).toBe('xd');

    // 切到另一个任务,错误文本恰好相同、provider 是 openai:
    // 快照必须重取,不能把 s1 的 xd 来源带给 s2 的错误。
    act(() => {
      rerender(createElement(Probe, { error: 'insufficient_quota', sessionId: 's2', providerId: 'openai' }));
    });
    expect(latest).toBe('openai');
  });

  it('错误清除后快照归零;再次报错重新取值', () => {
    const { rerender } = render(
      createElement(Probe, { error: 'quota exceeded', sessionId: 's1', providerId: 'xd' }),
    );
    expect(latest).toBe('xd');

    act(() => {
      rerender(createElement(Probe, { error: null, sessionId: 's1', providerId: 'openai' }));
    });
    expect(latest).toBeNull();

    act(() => {
      rerender(createElement(Probe, { error: 'quota exceeded again', sessionId: 's1', providerId: 'openai' }));
    });
    expect(latest).toBe('openai');
  });
});
