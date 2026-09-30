// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('expo-router/react-navigation', async () => {
  const { createContext } = await import('react');
  return { HeaderHeightContext: createContext<number | undefined>(undefined) };
});

import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useOptionalHeaderHeight } from '@/session/useOptionalHeaderHeight';

it('allows the embedded home to render without a navigation header and reads the native height when present', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement('div'));
  let height = -1;
  function Probe() {
    height = useOptionalHeaderHeight();
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(height).toBe(0);

    await act(async () =>
      root.render(createElement(HeaderHeightContext.Provider, { value: 82 }, createElement(Probe))),
    );
    expect(height).toBe(82);
  } finally {
    await act(async () => root.unmount());
  }
});
