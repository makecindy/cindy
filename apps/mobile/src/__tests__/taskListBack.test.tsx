// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTaskListBack } from '@/utils/useTaskListBack';

const h = vi.hoisted(() => ({ dismiss: vi.fn(), dismissTo: vi.fn(), reset: vi.fn(),
  focused: true, routes: [] as { name: string; key?: string; params?: object }[] }));
vi.mock('react-native', () => ({ Keyboard: { dismiss: vi.fn() } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ dismiss: h.dismiss, dismissTo: h.dismissTo }),
  useNavigation: () => ({ isFocused: () => h.focused, getState: () => ({ routes: h.routes, index: h.routes.length - 1 }), reset: h.reset }) }));
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
function BackButton() { return createElement('button', { onClick: useTaskListBack() }, 'back'); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); h.focused = true;
  host = document.createElement('div'); root = createRoot(host); });
afterEach(() => act(() => root.unmount()));
it.each(['sessions/[sessionId]', 'companions/groups/[groupId]', 'companions/cloud/[actorId]'])('returns from %s straight to the existing task list', name => {
  h.routes = [{ name: 'index', key: 'original-home', params: { search: 'kept' } },
    { name: 'sessions/[sessionId]' }, { name: 'companions/groups/[groupId]' }, { name }];
  act(() => root.render(createElement(BackButton)));
  act(() => host.querySelector('button')!.click());
  expect(h.dismiss).toHaveBeenCalledExactlyOnceWith(3);
  expect(h.dismissTo).not.toHaveBeenCalled();
  expect(h.reset).not.toHaveBeenCalled();
});
it('returns a cold deep link to the task list without backing into another conversation', () => {
  h.routes = [{ name: 'companions/groups/[groupId]' }];
  act(() => root.render(createElement(BackButton)));
  act(() => host.querySelector('button')!.click());
  expect(h.dismissTo).toHaveBeenCalledExactlyOnceWith('/devices');
});
it('ignores a delayed return from a conversation that is no longer focused', () => {
  h.routes = [{ name: 'index' }, { name: 'sessions/[sessionId]' }]; h.focused = false;
  act(() => root.render(createElement(BackButton)));
  act(() => host.querySelector('button')!.click());
  expect(h.dismiss).not.toHaveBeenCalled();
  expect(h.dismissTo).not.toHaveBeenCalled();
});
