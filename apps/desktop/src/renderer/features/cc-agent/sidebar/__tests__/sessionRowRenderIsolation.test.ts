// @vitest-environment jsdom

/**
 * sessionRowRenderIsolation — 侧边栏会话行的性能不变量回归测试
 * ---------------------------------------------------------------------------
 * 背景:2026-07 切换会话卡顿,实测左侧列表整栏重画单次 80-96ms、每次切换连跑 3 遍。
 * 根源是行内订阅了"整张表"快照(attention Map / urgency Set 每次广播换新引用),
 * 且 SessionItem 无 memo —— 任何一个任务的状态变化都让几百行全部重渲染。
 *
 * 本测试钉住修复后的三条不变量(谁改坏了这里就红):
 *   1. SessionItem 必须保持 React.memo 包裹;
 *   2. 某个任务的 attention 变化只重渲染它自己那一行,其它行不动;
 *   3. urgency 集合内容不变时(即便上游产了新 Set 引用)任何行都不重渲染,
 *      变化时只重渲染受影响的行。
 *
 * 渲染计数手段:mock 掉 SessionStatusIcon(SessionItem 每次真实渲染必然执行它),
 * 按 session.id 计数 —— memo 命中(bail out)时函数体不执行,计数不涨。
 */

import { createElement, Fragment } from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Session } from '@/lib/ccAgent.types';
import {
  addSessionAttention,
  clearSessionAttention,
} from '@/lib/sessionAttentionStore';
import { SessionAttentionUrgencyProvider } from '../../contexts/SessionAttentionUrgencyContext';
import { SPLIT_GROUP_SESSION_MIME } from '../../splitGroupDnd';

// ── mocks:剥离与"渲染隔离"无关的重依赖,只留计数探针 ──────────────────────────

const renderCounts = new Map<string, number>();
const sessionStatusIconSource = readFileSync(
  resolve(__dirname, '..', 'SessionStatusIcon.tsx'),
  'utf8',
);

vi.mock('../SessionStatusIcon', () => ({
  SessionStatusIcon: ({ session }: { session: { id: string } }) => {
    renderCounts.set(session.id, (renderCounts.get(session.id) ?? 0) + 1);
    return null;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string' ? fallback : key,
  }),
  // 某些传递依赖(renderer/i18n/index.ts)在 import 期就调 initReactI18next,
  // 提供最小 3rdParty 插件桩让它安静通过。
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
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

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktreeForSession: () => null,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { ensureInitialMessages: vi.fn() },
}));

// mock 之后再 import,确保 SessionItem 拿到的是探针版依赖。
import { SessionItem } from '../SessionItem';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeSession(id: string, status: Session['status'] | 'idle' = 'idle'): Session {
  return {
    id,
    title: `Session ${id}`,
    status,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    userSendAt: '2026-07-01T00:00:00.000Z',
    pinnedAt: null,
    sdkSessionId: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    workspaceKind: 'project',
    workingDir: 'E:/repo',
    _count: { messages: 3 },
  } as unknown as Session;
}

const noop = () => {};

function rowsElement(sessions: readonly Session[], urgentSessionIds: ReadonlySet<string>) {
  return createElement(SessionAttentionUrgencyProvider, {
    urgentSessionIds,
    children: createElement(
      Fragment,
      null,
      ...sessions.map((s) =>
        createElement(SessionItem, {
          key: s.id,
          session: s,
          isActive: false,
          isRunning: false,
          hasAttentionNotification: false,
          onClick: noop,
          onAction: noop,
          onRename: noop,
          onTogglePin: noop,
        }),
      ),
    ),
  });
}

const sessionA = makeSession('session-a');
const sessionB = makeSession('session-b');
const BOTH = [sessionA, sessionB] as const;

beforeEach(() => {
  renderCounts.clear();
});

afterEach(() => {
  cleanup();
  // attention store 是模块级单例,测试间必须清干净,否则串台。
  clearSessionAttention('session-a');
  clearSessionAttention('session-b');
});

// ── 不变量 1:memo 包裹(结构断言 + 源码断言双保险) ──────────────────────────

describe('SessionItem — memo 包裹', () => {
  it('导出的是 React.memo 组件', () => {
    expect((SessionItem as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('源码不得出现整表订阅 hook(必须按行精准订阅)', () => {
    const source = readFileSync(resolve(__dirname, '..', 'SessionItem.tsx'), 'utf8');
    expect(source).not.toMatch(/useSessionAttentionKinds\s*\(/);
    expect(source).not.toMatch(/useSessionAttentionSnapshot\s*\(/);
    expect(source).not.toMatch(/useSessionAttentionUrgencySet\s*\(/);
    expect(source).toMatch(/useSessionAttentionKind\s*\(\s*session\.id\s*\)/);
  });
});

describe('SessionItem — 归档视觉', () => {
  it('标题保留正文色，并用主题感知的 Archive 图标区分归档行', () => {
    const regularSession = makeSession('regular-session');
    const archivedSession = makeSession('archived-session', 'archived');
    const { container } = render(rowsElement([regularSession, archivedSession], new Set()));

    const regularRow = container.querySelector('[data-session-id="regular-session"]');
    const archivedRow = container.querySelector('[data-session-id="archived-session"]');

    expect(regularRow?.className).toContain('text-foreground');
    expect(archivedRow?.className).toContain('text-foreground');
    expect(archivedRow?.className).not.toContain('text-[var(--sidebar-list-muted)]');

    const archivedIconBranch = sessionStatusIconSource.slice(
      sessionStatusIconSource.indexOf('{isArchived ? ('),
      sessionStatusIconSource.indexOf(') : isOrcaLead ? ('),
    );
    expect(archivedIconBranch).toContain('<Archive');
    expect(archivedIconBranch).toContain('text-[var(--sidebar-item-active-foreground)]');
    expect(archivedIconBranch).toContain('strokeWidth={1.75}');
    expect(archivedIconBranch).toContain('text-[var(--cmd-palette-item-meta)]');
  });
});

describe('SessionItem — 任务菜单', () => {
  it('不再暴露分栏打开入口', () => {
    render(rowsElement([makeSession('menu-session')], new Set()));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'ccAgent.sidebar.sessionMenu.moreActions',
      }),
    );

    const menu = screen.getByRole('menu');
    expect(
      within(menu).getByRole('menuitem', {
        name: 'ccAgent.sidebar.sessionMenu.rename',
      }),
    ).toBeTruthy();
    expect(
      within(menu).queryByRole('menuitem', {
        name: /(?:splitGroup\.openInSplit|在分栏中打开)/,
      }),
    ).toBeNull();
  });
});

describe('SessionItem — 置顶分屏拖拽', () => {
  it('原生整行拖拽保留普通内容起手，并排除内部操作按钮', () => {
    const pinnedSession = {
      ...makeSession('pinned-session'),
      pinnedAt: '2026-08-08T00:00:00.000Z',
    };
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      setData: (format: string, data: string) => values.set(format, data),
    };
    const openOutside = vi.fn().mockResolvedValue(false);
    const electronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { openSessionInNewWindowIfDroppedOutside: openOutside } },
    });
    const { container } = render(
      createElement(SessionAttentionUrgencyProvider, {
        urgentSessionIds: new Set<string>(),
        children: createElement(
          'div',
          {
            'data-sortable-id': pinnedSession.id,
            'data-sortable-native-dnd': 'true',
          },
          createElement(SessionItem, {
            session: pinnedSession,
            isActive: false,
            isRunning: false,
            hasAttentionNotification: false,
            onClick: noop,
            onAction: noop,
            onRename: noop,
            onTogglePin: noop,
          }),
        ),
      }),
    );

    const row = container.querySelector<HTMLElement>('[data-session-id="pinned-session"]');
    const title = row?.querySelector<HTMLElement>('.sidebar-title-marquee__ellipsis');
    const actionButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="ccAgent.sidebar.sessionMenu.moreActions"]',
    );
    expect(row?.draggable).toBe(true);
    expect(row?.className).toContain('cursor-pointer');
    expect(row?.className).not.toContain('cursor-grab');
    expect(row?.querySelector('[data-split-group-drag-handle="true"]')).toBeNull();
    expect(title).not.toBeNull();
    expect(title?.className).not.toContain('cursor-grab');
    expect(actionButton).not.toBeNull();

    fireEvent.pointerDown(title!, { button: 0, pointerType: 'mouse' });
    fireEvent.dragStart(row!, { dataTransfer });

    expect(values.get(SPLIT_GROUP_SESSION_MIME)).toBe(pinnedSession.id);
    expect(dataTransfer.effectAllowed).toBe('copyMove');

    fireEvent.dragEnd(row!, { dataTransfer });
    expect(openOutside).toHaveBeenCalledWith(pinnedSession.id, null);

    values.clear();
    dataTransfer.effectAllowed = 'none';
    fireEvent.pointerDown(actionButton!, { button: 0, pointerType: 'mouse' });
    const blockedDragStart = createEvent.dragStart(row!, { dataTransfer });
    const preventDefault = vi.spyOn(blockedDragStart, 'preventDefault');
    fireEvent(row!, blockedDragStart);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(values.has(SPLIT_GROUP_SESSION_MIME)).toBe(false);
    expect(dataTransfer.effectAllowed).toBe('none');

    if (electronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', electronApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });
});

// ── 不变量 2:attention 变化只惊动自己那一行 ──────────────────────────────────

describe('SessionItem — attention 渲染隔离', () => {
  it('A 行 attention 置位/清除,B 行零重渲染', () => {
    render(rowsElement(BOTH, new Set()));
    const baselineA = renderCounts.get('session-a') ?? 0;
    const baselineB = renderCounts.get('session-b') ?? 0;
    expect(baselineA).toBeGreaterThan(0);
    expect(baselineB).toBeGreaterThan(0);

    act(() => {
      addSessionAttention('session-a', 'awaiting');
    });
    expect(renderCounts.get('session-a')).toBe(baselineA + 1);
    expect(renderCounts.get('session-b')).toBe(baselineB);

    act(() => {
      clearSessionAttention('session-a');
    });
    expect(renderCounts.get('session-a')).toBe(baselineA + 2);
    expect(renderCounts.get('session-b')).toBe(baselineB);
  });

  it('同一行 kind 未变化的重复置位不触发任何重渲染', () => {
    render(rowsElement(BOTH, new Set()));
    act(() => {
      addSessionAttention('session-a', 'awaiting');
    });
    const afterFirstA = renderCounts.get('session-a');
    const afterFirstB = renderCounts.get('session-b');

    act(() => {
      addSessionAttention('session-a', 'awaiting');
    });
    expect(renderCounts.get('session-a')).toBe(afterFirstA);
    expect(renderCounts.get('session-b')).toBe(afterFirstB);
  });
});

// ── 不变量 3:父层重渲染 / urgency 集合更新的隔离 ────────────────────────────

describe('SessionItem — 父层与 urgency 隔离', () => {
  it('父层以相同 props 重渲染,所有行被 memo 挡住', () => {
    const { rerender } = render(rowsElement(BOTH, new Set()));
    const baselineA = renderCounts.get('session-a');
    const baselineB = renderCounts.get('session-b');

    rerender(rowsElement(BOTH, new Set()));
    expect(renderCounts.get('session-a')).toBe(baselineA);
    expect(renderCounts.get('session-b')).toBe(baselineB);
  });

  it('urgency 集合换新引用但内容相同 → 零重渲染;真变化 → 只惊动相关行', () => {
    const { rerender } = render(rowsElement(BOTH, new Set(['session-a'])));
    const baselineA = renderCounts.get('session-a');
    const baselineB = renderCounts.get('session-b');

    // 新 Set 引用、同内容 —— store 内容级去重,不广播。
    rerender(rowsElement(BOTH, new Set(['session-a'])));
    expect(renderCounts.get('session-a')).toBe(baselineA);
    expect(renderCounts.get('session-b')).toBe(baselineB);

    // A 的 urgent 撤掉 —— 只有 A 行重渲染,B 行不动。
    rerender(rowsElement(BOTH, new Set()));
    expect(renderCounts.get('session-a')).toBe((baselineA ?? 0) + 1);
    expect(renderCounts.get('session-b')).toBe(baselineB);
  });
});

// ── 不变量 4:父层传给行的 props 必须运行期引用稳定 ──────────────────────────
//
// 上面三条都在「隔离环境 + 稳定 noop props」下成立,抓不到真正的历史 bug:
// 真实父组件(CCAgentSidebarUpper)把每渲染换引用的东西放进 handler 的 useCallback
// deps,memo 在生产里从未生效。渲染真实父组件需要 mock 掉 router + 十几个 store,
// 成本远超收益,故这里退一步做源码级断言 —— 脆,但能钉住确切的回归点。
//
// 历史:2026-07 单击切换卡顿排查发现两处
//   a) useSessionRunningStatus 的 runningSessionIds 裸调 deriveRunningSet,每渲染 new Set;
//   b) 5 个行级 handler 的 deps 里带着 sessions / sessionsById(它们随每条消息换引用)。
// 两者都会让 onAction / onMoveSession / onClick 等 prop 每渲染换引用,打穿整表 memo。

/** 取 `const <name> = useCallback(...)` 的 deps 数组文本(括号配平扫描)。 */
function useCallbackDeps(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  if (start < 0) throw new Error(`未找到 handler: ${name}`);
  let depth = 0;
  let i = source.indexOf('(', start);
  const open = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(open, i);
  const depsStart = body.lastIndexOf('[');
  const depsEnd = body.lastIndexOf(']');
  if (depsStart < 0 || depsEnd < depsStart) throw new Error(`${name} 没有 deps 数组`);
  return body.slice(depsStart, depsEnd + 1);
}

describe('父层 — 行级 handler 的引用稳定性', () => {
  /** 这 5 个是 SessionItem 的直接 props(onClick/onAction/onRename/onTogglePin/onMoveSession)。 */
  const ROW_HANDLERS = [
    'handleSessionClick',
    'handleRename',
    'handleTogglePin',
    'handleMoveSession',
    'handleActionClick',
  ];

  it('deps 里不得出现每条消息都换引用的 sessions / sessionsById', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'CCAgentSidebarUpper.tsx'),
      'utf8',
    );
    for (const name of ROW_HANDLERS) {
      const deps = useCallbackDeps(source, name);
      // 词边界保证 sessionsRef / sessionsByIdRef 不误伤。
      expect(deps, `${name} 的 deps 不得含裸 sessions`).not.toMatch(/\bsessions\b/);
      expect(deps, `${name} 的 deps 不得含裸 sessionsById`).not.toMatch(/\bsessionsById\b/);
    }
  });

  it('deps 里不得出现每渲染重建的 hook 返回对象(filter / collapse)', () => {
    // useSidebarFilter / useCollapsedProjects 都返回裸对象字面量,每次调用换引用。
    // 必须依赖到具体成员(filter.promotePin、collapse.expand …),故用 (?!\.) 放行
    // 成员访问、只拦整个对象。
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'CCAgentSidebarUpper.tsx'),
      'utf8',
    );
    for (const name of ROW_HANDLERS) {
      const deps = useCallbackDeps(source, name);
      expect(deps, `${name} 的 deps 不得含整个 filter`).not.toMatch(/\bfilter\b(?!\.)/);
      expect(deps, `${name} 的 deps 不得含整个 collapse`).not.toMatch(/\bcollapse\b(?!\.)/);
    }
  });

  it('deps 里不得出现随路由切换而变的 viewedSessionId', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'CCAgentSidebarUpper.tsx'),
      'utf8',
    );
    for (const name of ROW_HANDLERS) {
      const deps = useCallbackDeps(source, name);
      expect(deps, `${name} 的 deps 不得含 viewedSessionId`).not.toMatch(
        /\bviewedSessionId\b/,
      );
    }
  });

  it('handleSessionClick 的 deps 不得含每次点击/切换都变的选择态', () => {
    // 这三个只在点击那一刻读,却会被 setSelectionAnchorSessionId(每次点击必调)
    // 和路由切换带着变 —— 留在 deps 里等于每切换一次就整表重画一遍。
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'CCAgentSidebarUpper.tsx'),
      'utf8',
    );
    const deps = useCallbackDeps(source, 'handleSessionClick');
    expect(deps).not.toMatch(/\bactiveSessionId\b/);
    expect(deps).not.toMatch(/\bselectedSessionIds\b/);
    expect(deps).not.toMatch(/\bselectionAnchorSessionId\b/);
  });

  it('runningSessionIds 必须 memo 化(否则每渲染 new Set 打穿整表)', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'hooks', 'useSessionRunningStatus.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /const runningSessionIds = useMemo\(\s*\(\)\s*=>\s*deriveRunningSet\(statusMap\),\s*\[statusMap\]\s*\)/,
    );
  });
});
