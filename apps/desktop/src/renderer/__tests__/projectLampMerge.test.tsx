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
    isProjectPinned: false,
    onToggle: vi.fn(),
    onToggleProjectPin: vi.fn(),
    onRenameProject: vi.fn(),
    onRemoveFromSidebar: vi.fn(),
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
    onLinkCodexProject: vi.fn(),
    linkingCodexProject: false,
    onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(),
  };
}

describe('project lamp after upstream sidebar merge', () => {
  it('keeps one unread indicator in the trailing slot while a sibling task runs', () => {
    const { container } = render(
      <ProjectNode
        {...props()}
        collapsedAttentionTone="done"
        lamp={{ running: true, dotTone: 'done' }}
      />,
    );
    const header = container.querySelector('[data-project-header]')!;
    const slot = header.querySelector('.group\\/slot')!;
    const titleGroup = header.querySelector('.flex-1')!;
    expect(slot.querySelectorAll('.rounded-full').length).toBe(1);
    expect(titleGroup.querySelectorAll('.rounded-full').length).toBe(0);
    expect(header.querySelector('.session-status-breathing')).not.toBeNull();
  });

  it('leaves expanded project attention to its child rows', () => {
    const { container } = render(
      <ProjectNode
        {...props()}
        isCollapsed={false}
        collapsedAttentionTone="error"
        lamp={{ running: false, dotTone: 'error' }}
      />,
    );
    const header = container.querySelector('[data-project-header]')!;
    expect(header.querySelectorAll('.rounded-full').length).toBe(0);
    expect(header.querySelector('.session-status-breathing')).toBeNull();
  });
});
