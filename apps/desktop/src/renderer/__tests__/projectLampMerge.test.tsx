// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectNode,
  type ProjectNodeProps,
} from '../features/cc-agent/sidebar/sections/ProjectNode';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../features/cc-agent/sidebar/SessionEntryList', () => ({ SessionEntryList: () => null }));

afterEach(cleanup);

function props(): ProjectNodeProps {
  return {
    project: {
      projectKey: 'local:demo',
      displayName: 'Demo project',
      workingDir: '/demo',
      scope: 'local',
      sessions: [],
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
      deviceLinkConnectionStatus: null,
      segments: 1,
      latestActivityAt: '2026-09-10T00:00:00Z',
    },
    statusFilter: 'active',
    isCollapsed: true,
    parentSectionCollapsed: false,
    runningSessionIds: new Set(),
    attachedSessionIds: new Set(),
    notifications: new Set(),
    scheduleSessionIndex: new Map(),
    disableSessionCollapse: false,
    onToggle: vi.fn(),
    onSettings: vi.fn(),
    onRenameProject: vi.fn(),
    onSessionClick: vi.fn(),
    onAction: vi.fn(),
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onMoveSession: vi.fn(),
    projectOptions: [],
    onScheduleAction: vi.fn(),
    onCreateInProject: vi.fn(),
    onOpenConversationSearch: vi.fn(),
    onOpenInExplorer: vi.fn(),
    onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(),
  };
}

/**
 * 极简侧栏(2026-11-19):收起的项目头不再画彩色点。运行中只在行尾右侧状态槽放一个转圈,
 * 出错 / 等你回复 / 完成未读改为加粗项目名,并在名字上带 data-sidebar-right-status。
 */
function headerParts(container: HTMLElement) {
  const header = container.querySelector<HTMLElement>('[data-project-header]')!;
  const name = header.querySelector<HTMLElement>('span[data-sidebar-right-status]');
  const slot = header.querySelector<HTMLElement>('.group\\/slot')!;
  return {
    header,
    name,
    statusKinds: Array.from(header.querySelectorAll('[data-sidebar-right-status]')).map((node) =>
      node.getAttribute('data-sidebar-right-status'),
    ),
    slotSpinner: slot.querySelector('[data-sidebar-right-status="running"]'),
  };
}

describe('project lamp after upstream sidebar merge', () => {
  it('keeps one unread indicator on the bold name while a sibling task runs in the trailing slot', () => {
    const { container } = render(
      <ProjectNode
        {...props()}
        collapsedAttentionTone="done"
        lamp={{ running: true, dotTone: 'done' }}
      />,
    );
    const { header, name, statusKinds, slotSpinner } = headerParts(container);
    expect(slotSpinner).not.toBeNull();
    expect(name?.textContent).toBe('Demo project');
    expect(name?.getAttribute('data-sidebar-right-status')).toBe('done');
    expect(name?.className).toContain('font-semibold');
    expect(statusKinds.sort()).toEqual(['done', 'running']);
    expect(header.querySelectorAll('.rounded-full')).toHaveLength(0);
  });

  it.each([null, 'done', 'error'] as const)(
    'shows awaiting ahead of %s unless an error needs attention',
    (collapsedAttentionTone) => {
      const { container } = render(
        <ProjectNode
          {...props()}
          collapsedAttentionTone={collapsedAttentionTone}
          lamp={{ running: false, dotTone: 'awaiting' }}
        />,
      );
      const { header, name, statusKinds, slotSpinner } = headerParts(container);
      const tone = collapsedAttentionTone === 'error' ? 'error' : 'awaiting';
      expect(name?.getAttribute('data-sidebar-right-status')).toBe(tone);
      expect(name?.className).toContain('font-semibold');
      expect(statusKinds).toEqual([tone]);
      expect(slotSpinner).toBeNull();
      expect(header.querySelectorAll('.rounded-full')).toHaveLength(0);
    },
  );

  it.each(['error', 'awaiting', 'done'] as const)('leaves expanded project %s attention and running state to its child rows', (dotTone) => {
    const { container } = render(
      <ProjectNode
        {...props()}
        isCollapsed={false}
        collapsedAttentionTone="error"
        lamp={{ running: true, dotTone }}
      />,
    );
    const { header, statusKinds } = headerParts(container);
    expect(statusKinds).toEqual([]);
    expect(header.querySelector('.font-semibold')).toBeNull();
  });
});
