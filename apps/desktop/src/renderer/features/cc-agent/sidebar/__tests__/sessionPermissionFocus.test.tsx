// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { createPortal } from 'react-dom';
import { cleanup, render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { PendingPermission } from '@/lib/makerChatStore';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
  // 某些传递依赖(renderer/i18n/index.ts)在 import 期就调 initReactI18next,
  // 提供最小 3rdParty 插件桩让它安静通过。
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'menu-owner', isAuthenticated: true }),
}));

vi.mock('@/contexts/PrRefsContext', () => {
  const EMPTY: unknown[] = [];
  // usePrActions 的真实实现保证 value 恒定;mock 同样给稳定引用,
  // 避免 effect deps 每渲染变化干扰本文件的重渲染计数断言。
  const ACTIONS = { registerPrConsumer: vi.fn(() => () => undefined) };
  return {
    usePrRefsForSession: () => EMPTY,
    usePrStatuses: () => ({ statuses: new Map(), fetchStatusesForSession: vi.fn() }),
    usePrActions: () => ACTIONS,
  };
});

vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => {
  const EMPTY: unknown[] = [];
  return {
    useSessionBoundSchedules: () => EMPTY,
    scheduleFocusPath: (id: string) => `/cc-agent/scheduled?focus=${id}`,
  };
});

vi.mock('@/features/scheduler/lib/scheduleSidebarIndexRuns', () => ({
  loadScheduleSidebarIndexRuns: async () => [],
  findLatestSidebarIndexRunForSession: () => undefined,
}));

vi.mock('@/components/sidebar/WorktreeBadge', () => ({
  WorktreeBadge: () => null,
}));

vi.mock('@/contexts/WorktreeContext', () => {
  const reportLiveness = vi.fn();
  const refreshObserved = vi.fn();
  return {
    useWorktreeForSession: () => null,
    useReportWorktreeLiveness: () => reportLiveness,
    useObservedWorktreeForSession: () => null,
    useRefreshObservedWorktree: () => refreshObserved,
  };
});

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    ensureInitialMessages: vi.fn(),
    hasPausedQueue: () => false,
    subscribeAll: () => () => {},
    getRunningSnapshot: () => new Map(),
  },
}));

import { SessionItem, hasSessionSelectionModifier } from '../SessionItem';
import { SessionCard } from '../SessionCard';
import { SessionEntryList } from '../SessionEntryList';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';

afterEach(cleanup);
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
const noop = () => {};
const sessions = ['A', 'B'].map(
  (id) =>
    ({
      id,
      title: `Task ${id}`,
      status: 'active',
      agent: 'claude-code',
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
      workingDir: '/synthetic',
      pinnedAt: null,
      _count: { messages: 1 },
    }) as unknown as Session,
);
const permission = (id: string): PendingPermission => ({
  requestId: `request-${id}`,
  toolName: 'Bash',
  input: { command: 'echo synthetic' },
  suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
      behavior: 'allow',
      destination: 'session',
    },
  ],
});
let Component: typeof SessionItem | typeof SessionCard = SessionItem;
function setup({
  deferred = false,
  initiallyPending = true,
  mountedOrder,
  fromFiles = false,
}: {
  deferred?: boolean;
  initiallyPending?: boolean;
  mountedOrder?: string[];
  fromFiles?: boolean;
} = {}) {
  const respond = vi.fn();
  const select = vi.fn();
  const rename = vi.fn();
  let finishNavigation = noop;
  let showPermission = noop;
  function Fixture() {
    const [active, setActive] = useState('A');
    const [routeReady, setRouteReady] = useState(!fromFiles);
    const onClick = (id: string, modifiers: Parameters<typeof hasSessionSelectionModifier>[0]) => {
      select(id, modifiers);
      if (hasSessionSelectionModifier(modifiers)) return;
      const navigate = () => {
        setActive(id);
        setRouteReady(true);
      };
      if (deferred) finishNavigation = navigate;
      else navigate();
    };
    const [pending, setPending] = useState(initiallyPending);
    showPermission = () => setPending(true);
    return (
      <>
        {fromFiles ? createPortal(
          <SessionEntryList
            sessions={sessions}
            activeSessionId={active}
            navigationActiveSessionId={routeReady ? active : null}
            sessionVariant={Component === SessionCard ? 'list' : 'text'}
            runningSessionIds={new Set()}
            attachedSessionIds={new Set()}
            notifications={new Set()}
            scheduleSessionIndex={new Map()}
            onSessionClick={onClick}
            onAction={noop}
            onRename={rename}
            onTogglePin={noop}
            onScheduleAction={noop}
          />, document.body,
        ) : sessions.map((session) => (
          <Component
            key={session.id}
            session={session}
            isActive={active === session.id}
            isRunning={false}
            hasAttentionNotification={false}
            onClick={onClick}
            onAction={noop}
            onTogglePin={noop}
            onRename={rename}
          />
        ))}
        <main data-testid="chat">
          {pending && (mountedOrder ?? [active]).map((id) => (
            <PermissionPrompt
              key={mountedOrder ? id : 'current'}
              keyboardShortcutsEnabled={active === id}
              permission={permission(id)}
              onRespond={(decision) => respond(id, `request-${id}`, decision)}
            />
          ))}
        </main>
      </>
    );
  }
  const view = render(<Fixture />);
  const row = (id: string) =>
    (fromFiles ? document : view.container).querySelector(`[data-session-id="${id}"]`)! as HTMLElement;
  return {
    ...view,
    respond,
    select,
    rename,
    row,
    finish: () => act(() => finishNavigation()),
    show: () => act(() => showPermission()),
  };
}

describe.each([
  ['row', SessionItem],
  ['card', SessionCard],
] as const)(
  '%s mouse navigation hands permission shortcuts to the displayed task',
  (_name, component) => {
    beforeEach(() => {
      Component = component;
    });
    it.each([
      ['{Enter}', 'allow', undefined],
      ['{Control>}{Enter}{/Control}', 'allow', 'user_permanent'],
      ['{Escape}', 'deny', 'user_reject'],
    ])('%s responds only to B after clicking its row', async (key, behavior, classification) => {
      const user = userEvent.setup();
      const f = setup();
      await user.click(f.row('B'));
      await user.keyboard(key);
      expect(f.respond.mock.calls).toEqual([
        [
          'B',
          'request-B',
          expect.objectContaining({
            behavior,
            ...(classification ? { decisionClassification: classification } : {}),
          }),
        ],
      ]);
    });

    describe.each([['A', 'B'], ['B', 'A']])('mounted order %s then %s', (first, second) => {
      it.each([
        ['{Enter}', 'allow', undefined],
        ['{Control>}{Enter}{/Control}', 'allow', 'user_permanent'],
        ['{Escape}', 'deny', 'user_reject'],
      ])('%s belongs only to the active request with both cards mounted', async (key, behavior, classification) => {
        const user = userEvent.setup();
        const f = setup({ mountedOrder: [first, second] });
        for (const id of ['B', 'A', 'B']) {
          await user.click(f.row(id));
          expect(document.activeElement).toBe(document.body);
          await user.keyboard(key);
          expect(f.respond.mock.calls).toEqual([
            [id, `request-${id}`, expect.objectContaining({
              behavior,
              ...(classification ? { decisionClassification: classification } : {}),
            })],
          ]);
          f.respond.mockClear();
        }
      });
    });

    it.each(['{Enter}', '{Control>}{Enter}{/Control}', '{Escape}'])(
      'hands %s over after files returns to the same visually active portal row', async (key) => {
        const user = userEvent.setup();
        const f = setup({ fromFiles: true });
        const row = f.row('A');
        expect(row.getAttribute('aria-current')).toBe('page');
        await user.click(row);
        expect(f.row('A')).toBe(row);
        expect(row.getAttribute('aria-current')).toBe('page');
        await user.keyboard(key);
        expect(f.respond).toHaveBeenCalledExactlyOnceWith('A', 'request-A',
          expect.objectContaining({ behavior: key === '{Escape}' ? 'deny' : 'allow' }));
      },
    );

    it('keeps a visually active files row focused until the real navigation completes', async () => {
      const user = userEvent.setup();
      const f = setup({ fromFiles: true, deferred: true });
      await user.click(f.row('A'));
      expect(document.activeElement).toBe(f.row('A'));
      await user.keyboard('{Escape}');
      expect(f.respond).not.toHaveBeenCalled();
      f.finish();
      await user.keyboard('{Enter}');
      expect(f.respond).toHaveBeenCalledExactlyOnceWith('A', 'request-A', { behavior: 'allow' });
    });

    it.each(['keyboard', 'focus'])('cancels files return handoff after %s ownership changes', async (kind) => {
      const user = userEvent.setup();
      const f = setup({ fromFiles: true, deferred: true });
      await user.click(f.row('A'));
      if (kind === 'keyboard') await user.keyboard('{Enter}');
      else await user.tab();
      const focus = document.activeElement;
      f.finish();
      expect(document.activeElement).toBe(focus);
      expect(f.respond).not.toHaveBeenCalled();
    });

    it('retains the row while navigation is pending, so A cannot receive B’s key', async () => {
      const user = userEvent.setup();
      const f = setup({ deferred: true });
      await user.click(f.row('B'));
      expect(document.activeElement).toBe(f.row('B'));
      await user.keyboard('{Escape}');
      expect(f.respond).not.toHaveBeenCalled();
      f.finish();
      await user.keyboard('{Enter}');
      expect(f.respond).toHaveBeenCalledExactlyOnceWith('B', 'request-B', { behavior: 'allow' });
    });

    it('keeps keyboard row activation focused and never authorizes a request', async () => {
      const user = userEvent.setup();
      const f = setup();
      f.row('B').focus();
      await user.keyboard('{Enter}{Escape}');
      expect(document.activeElement).toBe(f.row('B'));
      expect(f.respond).not.toHaveBeenCalled();
    });

    it.each(['Control', 'Meta', 'Shift'])('keeps %s multi-selection focused', async (modifier) => {
      const user = userEvent.setup();
      const f = setup();
      await user.keyboard(`{${modifier}>}`);
      await user.click(f.row('B'));
      await user.keyboard(`{/${modifier}}{Escape}`);
      expect(document.activeElement).toBe(f.row('B'));
      expect(f.respond).not.toHaveBeenCalled();
    });

    it('does not steal focus chosen while navigation is pending', async () => {
      const user = userEvent.setup();
      const f = setup({ deferred: true });
      await user.click(f.row('B'));
      const deny = screen.getByRole('button', { name: /agentIsland.native.deny/ });
      deny.focus();
      f.finish();
      expect(document.activeElement).toBe(deny);
      await user.keyboard('{Enter}');
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(
        'B',
        'request-B',
        expect.objectContaining({ behavior: 'deny' }),
      );
    });

    it('leaves in-place permission arrival working', async () => {
      const user = userEvent.setup();
      const f = setup({ initiallyPending: false });
      f.show();
      await user.keyboard('{Enter}');
      expect(f.respond).toHaveBeenCalledExactlyOnceWith('A', 'request-A', { behavior: 'allow' });
    });

    it('cancels the pointer handoff when the user activates the row by keyboard while waiting', async () => {
      const user = userEvent.setup();
      const f = setup({ deferred: true });
      await user.click(f.row('B'));
      await user.keyboard('{Enter}');
      f.finish();
      expect(document.activeElement).toBe(f.row('B'));
      await user.keyboard('{Escape}');
      expect(f.respond).not.toHaveBeenCalled();
    });

    it('binds a second navigation back to A to its own request', async () => {
      const user = userEvent.setup();
      const f = setup();
      await user.click(f.row('B'));
      await user.keyboard('{Enter}');
      await user.click(f.row('A'));
      await user.keyboard('{Escape}');
      expect(f.respond.mock.calls).toEqual([
        ['B', 'request-B', { behavior: 'allow' }],
        ['A', 'request-A', expect.objectContaining({ behavior: 'deny' })],
      ]);
    });

    it('preserves double-click rename and Escape cancellation', async () => {
      const user = userEvent.setup();
      const f = setup();
      await user.dblClick(f.row('B'));
      const input = screen.getByRole('textbox');
      expect(document.activeElement).toBe(input);
      await user.keyboard('draft{Escape}');
      expect(f.rename).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
    });
  },
);
