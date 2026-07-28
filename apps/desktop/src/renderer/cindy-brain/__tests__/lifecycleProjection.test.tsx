// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetLifecycleProjectionForTest, useGhostReadiness } from '../lifecycleProjection';

const unsubscribeLifecycleChanged = vi.fn();
const onLifecycleChanged = vi.fn(() => unsubscribeLifecycleChanged);
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
});
