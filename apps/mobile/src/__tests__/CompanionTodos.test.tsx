// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyTodoPatch, emptyTodoState, queryTodoItems } from '@cindy/maker-shared/teammate-todo';

const h = vi.hoisted(() => ({
  sheet: {} as any,
  get: vi.fn(),
  action: vi.fn(),
  invoke: vi.fn(),
  openLink: vi.fn(async () => {}),
  onChanged: vi.fn(() => () => {}),
  close: vi.fn(),
  appState: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  View: ({ children }: any) => createElement('div', null, children),
  ScrollView: ({ children }: any) => createElement('div', null, children),
  ActivityIndicator: () => null,
  Linking: { openURL: vi.fn() },
  AppState: { addEventListener: (_: string, fn: (state: string) => void) => {
    h.appState.add(fn); return { remove: () => h.appState.delete(fn) };
  } },
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) =>
    createElement(
      'button',
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel },
      children,
    ),
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (s: string) => s.replace('devices.teammateTodo.', ''),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ accountGeneration: 1 }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({
    invoke: h.invoke,
    openLink: h.openLink,
    onRemoteResourceChanged: h.onChanged,
  }),
}));
vi.mock('@/device-link/remoteResources', () => ({
  getRemoteResource: h.get,
  invokeRemoteResourceAction: h.action,
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => createElement('span', null, children),
  TextInput: ({ value, onChangeText, accessibilityLabel }: any) =>
    createElement('input', {
      value,
      onChange: (e: any) => onChangeText(e.target.value),
      'aria-label': accessibilityLabel,
    }),
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (fn: any) => fn(tokens.lightColors),
  };
});
vi.mock('lucide-react-native', () => ({
  Plus: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-request' }));
vi.mock('@/session/TodoDateInput', () => ({ TodoDateInput: () => null }));
vi.mock('@/session/CompanionSheet', () => ({
  CompanionSheet: (props: any) => {
    h.sheet = props;
    return props.children;
  },
}));
vi.mock('@/session/CompanionTodoRow', () => ({
  CompanionTodoRow: ({ item, busy, onAction }: any) =>
    createElement(
      'button',
      { 'data-testid': item.id, disabled: busy, onClick: onAction },
      item.title,
    ),
}));
import { CompanionTodos } from '@/session/CompanionTodos';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
const todo = applyTodoPatch(
  emptyTodoState(),
  {
    key: 'quote',
    title: 'Compare quote',
    outcome: 'Review the prepared comparison',
    next: {
      kind: 'advance',
      label: 'Compare',
      instruction: 'Prepare only, do not send',
    },
  },
  'todo-one',
);
const props = {
  visible: true,
  online: true,
  deviceId: 'host',
  deviceName: 'Computer',
  botId: 'teammate',
  onClose: h.close,
};
const flush = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
async function render(online = true) {
  await act(async () => root.render(<CompanionTodos {...props} online={online} />));
  await flush();
}
const row = () => host.querySelector<HTMLButtonElement>('[data-testid="todo-one"]')!;
const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === label,
  )!;
beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue({
    blocks: [
      {
        primitive: 'teammate-todos',
        data: {
          items: [todo],
          total: 1,
          completedTotal: 1,
          offset: 0,
          limit: 25,
        },
      },
    ],
  });
  h.action.mockResolvedValue({});
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('releases dismiss and button busy state on disconnect without replaying an in-flight action', async () => {
  let oldResult!: (result: unknown) => void, newResult!: (result: unknown) => void;
  h.action
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResult = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          newResult = resolve;
        }),
    );
  await render();
  await act(async () => row().click());
  expect(h.action).toHaveBeenCalledOnce();
  expect(row().disabled).toBe(true);
  expect(h.sheet.preventDismiss).toBe(true);
  await render(false);
  expect(h.sheet.preventDismiss).toBe(false);
  await render(true);
  expect(row().disabled).toBe(false);
  expect(h.action).toHaveBeenCalledOnce();
  await act(async () => row().click());
  expect(row().disabled).toBe(true);
  // A late success from the previous connection must not unlock or close the new request.
  await act(async () => oldResult({}));
  expect(row().disabled).toBe(true);
  expect(h.sheet.preventDismiss).toBe(true);
  await act(async () => newResult({}));
  expect(row().disabled).toBe(false);
  expect(h.sheet.preventDismiss).toBe(false);
});

it('routes Open from completed directly to open, and labels the hidden-list action by its destination', async () => {
  await render();
  expect(button('hidden')).toBeDefined();
  await act(async () => button('done · 1').click());
  await flush();
  expect(JSON.parse(h.get.mock.calls.at(-1)![5]).view).toBe('done');
  await act(async () => button('open').click());
  await flush();
  expect(JSON.parse(h.get.mock.calls.at(-1)![5]).view).toBe('open');
  await act(async () => button('hidden').click());
  await flush();
  expect(JSON.parse(h.get.mock.calls.at(-1)![5]).view).toBe('hidden');
  await act(async () => button('open').click());
  await flush();
  expect(JSON.parse(h.get.mock.calls.at(-1)![5]).view).toBe('open');
});

it('does not send a stale operation whose link opens only after disconnect', async () => {
  let finishLink!: () => void;
  await render();
  h.openLink.mockImplementationOnce(() => new Promise<void>(resolve => { finishLink = resolve; }));
  await act(async () => row().click());
  expect(h.sheet.preventDismiss).toBe(true);
  await render(false);
  await act(async () => finishLink());
  expect(h.action).not.toHaveBeenCalled();
  expect(h.sheet.preventDismiss).toBe(false);
  await render(true);
  expect(row().disabled).toBe(false);
});

it.each(['open', 'hidden'] as const)(
  'reloads %s at the nearest deferral expiry and cancels the timer when closed',
  async (view) => {
    vi.useFakeTimers();
    const start = new Date('2026-10-10T12:00:00Z');
    vi.setSystemTime(start);
    const deferred = {
      ...todo,
      decision: { kind: 'later' as const, until: '2026-10-10T12:02:00Z' },
    };
    h.get.mockImplementation(async (...args) => ({
      blocks: [
        {
          primitive: 'teammate-todos',
          data: queryTodoItems([deferred], JSON.parse(args[5]), new Date()),
        },
      ],
    }));
    await act(async () => root.render(<CompanionTodos {...props} />));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    if (view === 'hidden') {
      await act(async () => button('hidden').click());
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    expect(!!host.querySelector('[data-testid="todo-one"]')).toBe(view === 'hidden');
    const calls = h.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(h.get.mock.calls.length).toBe(calls + 1);
    expect(!!host.querySelector('[data-testid="todo-one"]')).toBe(view === 'open');
    expect(h.action).not.toHaveBeenCalled();
    await act(async () => root.render(<CompanionTodos {...props} visible={false} />));
    expect(h.appState.size).toBe(0);
    const closedCalls = h.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(h.get.mock.calls.length).toBe(closedCalls);
  },
);

it('rechecks expired deferrals on foreground without an action or a repeating scan', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  const deferred = { ...todo, decision: { kind: 'later' as const, until: '2026-10-10T12:02:00Z' } };
  h.get.mockImplementation(async (...args) => ({
    blocks: [
      {
        primitive: 'teammate-todos',
        data: queryTodoItems([deferred], JSON.parse(args[5]), new Date()),
      },
    ],
  }));
  await act(async () => root.render(<CompanionTodos {...props} />));
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(host.querySelector('[data-testid="todo-one"]')).toBeNull();
  const calls = h.get.mock.calls.length;
  vi.setSystemTime(new Date('2026-10-10T12:05:00Z'));
  await act(async () => h.appState.forEach((fn) => fn('active')));
  expect(h.get.mock.calls.length).toBe(calls + 1);
  expect(row()).toBeDefined();
  expect(h.action).not.toHaveBeenCalled();
});
