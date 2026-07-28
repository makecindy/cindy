// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LifecycleChanged = (payload: {
  entries: {
    id: string;
    name: string;
    enabled: boolean;
    readiness: 'ready' | 'needs_setup' | 'needs_reauth' | 'degraded' | 'blocked' | 'unknown';
  }[];
}) => void;

import { __resetLifecycleProjectionForTest, useGhostReadiness } from '../lifecycleProjection';

const unsubscribeLifecycleChanged = vi.fn();
const onLifecycleChanged = vi.fn((_callback: LifecycleChanged) => unsubscribeLifecycleChanged);
const lifecycle = vi.fn(async () => ({ entries: [] }));

beforeEach(() => {
  __resetLifecycleProjectionForTest();
  unsubscribeLifecycleChanged.mockReset();
  onLifecycleChanged.mockClear();
  lifecycle.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      lifecycle,
      onLifecycleChanged,
    },
  };
});

afterEach(() => {
  cleanup();
  __resetLifecycleProjectionForTest();
});

function Probe() {
  const readiness = useGhostReadiness('search');
  return <div>{readiness}</div>;
}

describe('lifecycleProjection', () => {
  it('模块重置时退订旧 lifecycle changed 回调', () => {
    const first = render(<Probe />);
    expect(onLifecycleChanged).toHaveBeenCalledTimes(1);
    first.unmount();

    __resetLifecycleProjectionForTest();
    expect(unsubscribeLifecycleChanged).toHaveBeenCalledTimes(1);

    render(<Probe />);
    expect(onLifecycleChanged).toHaveBeenCalledTimes(2);
  });

  it('初始化查询不覆盖订阅期间收到的最新投影', async () => {
    onLifecycleChanged.mockImplementationOnce((callback) => {
      callback({
        entries: [
          {
            id: 'search',
            name: 'Search',
            enabled: true,
            readiness: 'needs_setup',
          },
        ],
      });
      return unsubscribeLifecycleChanged;
    });

    let rendered: ReturnType<typeof render> | undefined;
    await act(async () => {
      rendered = render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rendered?.container.textContent).toBe('needs_setup');
  });
});
