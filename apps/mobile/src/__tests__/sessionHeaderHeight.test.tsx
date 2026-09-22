// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ focused: true, height: 82,
  listener: undefined as undefined | ((event: { data: { closing: boolean } }) => void),
  navigation: { addListener: vi.fn() },
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => state.height }));
vi.mock('expo-router', () => ({
  useNavigation: () => state.navigation,
  useFocusEffect: (callback: () => void | (() => void)) => {
    useEffect(() => state.focused ? callback() : undefined, [callback, state.focused]);
  },
}));
import { useSessionHeaderHeight } from '@/session/useSessionHeaderHeight';

describe('task header geometry during native preload', () => {
  let root: Root;
  let height = 0;
  let key = '';
  function Probe() { height = useSessionHeaderHeight(key); return null; }
  async function render() { await act(async () => root.render(<Probe />)); }
  async function settle() { await act(async () => state.listener?.({ data: { closing: false } })); }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.focused = true; state.height = 82; state.listener = undefined;
    state.navigation.addListener.mockImplementation((_event, listener) => {
      state.listener = listener; return () => { state.listener = undefined; };
    });
    key = expect.getState().currentTestName!;
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => { await act(async () => root.unmount()); });
  it('keeps the measured height through preload and push instead of adopting the estimate', async () => {
    await render(); await settle(); expect(height).toBe(82);
    await act(async () => root.render(null));
    state.focused = false; state.height = 120.67;
    await render(); expect(height).toBe(82);
    state.focused = true; await render(); expect(height).toBe(82);
    state.height = 82; await render(); await settle(); expect(height).toBe(82);
  });
  it('does not share measurements across window geometry and follows later real resize', async () => {
    await render(); await settle();
    await act(async () => root.render(null));
    key += '-rotated'; state.focused = false; state.height = 44;
    await render(); expect(height).toBe(44);
    state.focused = true; await render(); await settle();
    state.height = 50; await render(); expect(height).toBe(50);
  });
  it('does not record offscreen estimates or a closing transition as measured geometry', async () => {
    await render();
    await act(async () => state.listener?.({ data: { closing: true } }));
    await act(async () => root.render(null));
    state.focused = false; state.height = 120;
    await render(); expect(height).toBe(120);
    state.height = 130; await render(); expect(height).toBe(130);
  });
});
