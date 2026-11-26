// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实 ProjectNode 行菜单 + ProjectPinContext + useProjectPinFocusHandoff；
 *   键盘在行菜单里置顶／取消置顶后，document.activeElement 落在哪一行。
 * - 依据：DESIGN.md §14.2 焦点回归；项目置顶菜单评审发现项目行跨段重挂载后焦点掉到 body。
 * - 现有覆盖缺口：pinnedProjectSidebarIntegration 只覆盖置顶数据口径，不覆盖菜单关闭后的焦点。
 * - 最小失败输入：项目 a 在项目列表，行菜单 Enter 选「置顶项目」→ 修复前焦点为 body。
 * - tier：unit（jsdom 组件渲染，无网络与真实等待）；实测约 2–4 秒。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo, useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ProjectNode,
  ProjectPinContext,
  type ProjectNodeProps,
} from '../features/cc-agent/sidebar/sections/ProjectNode';
import { useProjectPinFocusHandoff } from '../features/cc-agent/sidebar/projectPinFocus';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../features/cc-agent/sidebar/SessionEntryList', () => ({ SessionEntryList: () => null }));

afterEach(cleanup);

function project(key: string): ProjectNodeProps['project'] {
  return {
    projectKey: key, displayName: key, workingDir: `/${key}`, scope: 'local', sessions: [],
    remoteHostId: null, deviceLinkDeviceId: null, deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null, segments: 1, latestActivityAt: '2026-09-10T00:00:00Z',
  };
}
function nodeProps(key: string): ProjectNodeProps {
  return {
    project: project(key), statusFilter: 'active', isCollapsed: true, parentSectionCollapsed: false,
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    scheduleSessionIndex: new Map(), disableSessionCollapse: false,
    onToggle: vi.fn(), onSettings: vi.fn(), onRenameProject: vi.fn(), onSessionClick: vi.fn(),
    onAction: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn(), onMoveSession: vi.fn(),
    projectOptions: [], onScheduleAction: vi.fn(), onCreateInProject: vi.fn(),
    onOpenConversationSearch: vi.fn(), onOpenInExplorer: vi.fn(), onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(),
  };
}

// 与 ExpandedView 同构：置顶项目进「置顶」段，其余进项目列表；两段是不同父节点。
// hiddenAfterMove：目标段不显示该项目（置顶段已收起／被筛选条件挡住）。
function Sidebar({ keys, hiddenAfterMove = false }: { keys: string[]; hiddenAfterMove?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set(['p']));
  const [moved, setMoved] = useState<string | null>(null);
  const capture = useProjectPinFocusHandoff(rootRef, pinned);
  const actions = useMemo(() => ({
    isPinned: (p: { projectKey: string }) => pinned.has(p.projectKey),
    toggle: (p: { projectKey: string }, was: boolean, options?: { restoreFocus?: boolean }) => {
      if (options?.restoreFocus) capture(p.projectKey);
      setMoved(p.projectKey);
      setPinned((prev) => {
        const next = new Set(prev);
        if (was) next.delete(p.projectKey); else next.add(p.projectKey);
        return next;
      });
    },
  }), [pinned, capture]);
  const shown = (k: string) => !(hiddenAfterMove && k === moved);
  return (
    <ProjectPinContext.Provider value={actions}>
      <div ref={rootRef}>
        <section data-testid="pinned">
          {keys.filter((k) => pinned.has(k) && shown(k)).map((k) => <ProjectNode key={k} {...nodeProps(k)} />)}
        </section>
        <section data-testid="projects">
          {keys.filter((k) => !pinned.has(k) && shown(k)).map((k) => <ProjectNode key={k} {...nodeProps(k)} />)}
        </section>
      </div>
    </ProjectPinContext.Provider>
  );
}

function header(section: string, key: string): HTMLElement {
  return screen.getByTestId(section)
    .querySelector<HTMLElement>(`[data-project-workingdir="${key}"] [data-project-header]`)!;
}

async function pinViaKeyboard(section: string, key: string, label: string) {
  const row = header(section, key);
  row.focus();
  fireEvent.contextMenu(row);
  const item = await screen.findByRole('menuitem', { name: label });
  item.focus();
  await act(async () => {
    fireEvent.keyDown(item, { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const PIN = 'ccAgent.sidebar.projectAction.pin';
const UNPIN = 'ccAgent.sidebar.projectAction.unpin';

it('keeps keyboard focus on the moved project row in both directions', async () => {
  render(<Sidebar keys={['p', 'a', 'b']} />);
  await pinViaKeyboard('projects', 'a', PIN);
  expect(document.activeElement).toBe(header('pinned', 'a'));
  await pinViaKeyboard('pinned', 'a', UNPIN);
  expect(document.activeElement).toBe(header('projects', 'a'));
});

it.each([
  { action: 'pin', from: 'projects', key: 'a', label: PIN, fallback: ['projects', 'b'] },
  { action: 'unpin', from: 'pinned', key: 'p', label: UNPIN, fallback: ['projects', 'a'] },
] as const)('falls back to the nearest visible row when the $action target is not shown', async ({ from, key, label, fallback }) => {
  render(<Sidebar keys={['p', 'a', 'b']} hiddenAfterMove />);
  await pinViaKeyboard(from, key, label);
  expect(document.activeElement).toBe(header(fallback[0], fallback[1]));
});
