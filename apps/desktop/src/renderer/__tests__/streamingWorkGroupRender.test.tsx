// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, useSyncExternalStore, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/chat/AgentActionRow', () => ({
  AgentActionRow: (props: { toolResult?: string }) =>
    createElement('div', { 'data-testid': 'tool-result' }, props.toolResult),
}));
vi.mock('@/components/chat/WorkGroupBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/chat/WorkGroupBlock')>();
  return { ...actual, WorkGroupBlock: vi.fn(actual.WorkGroupBlock) };
});
vi.mock('@/lib/agent-actions/workActivityProjection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/agent-actions/workActivityProjection')>();
  return { ...actual, projectWorkActivities: vi.fn(actual.projectWorkActivities) };
});

import { HistoryViewController, projectHistoryView } from '@cindy/maker-shared/message-window';
import { buildMessageStreamRenderProjection, WorkGroupRenderItemView } from '@/components/chat/MessageStream';
import { WorkGroupBlock } from '@/components/chat/WorkGroupBlock';
import { projectWorkActivities } from '@/lib/agent-actions/workActivityProjection';
import { createWorkGroupProjection } from '@/components/chat/streamingMessageProjection';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { RenderItem } from '@/components/chat/messageWorkGroups';
import type { HistoryChatMessage } from '@/lib/makerChatStore';

type Group = Extract<RenderItem, { type: 'work_group' }>;
const context: ComponentProps<typeof WorkGroupRenderItemView>['context'] = {
  workingDir: '/project',
  isSessionStreaming: true,
  firstUserMessageClientId: 'u1',
  lastUserMessageClientId: 'u2',
  lastUserInputClientId: 'u2',
  continuationTurnClientId: null,
  continuationInFlightProjectionCapability: 'supported',
  localFileRefs: [],
  singleResultMap: new Map(),
  assistantsWithFollowingUserBoundary: new Set(),
  turnFinalAssistantClientIds: new Set(),
  subagentModelByToolUseId: new Map(),
  userTurnUsageDetailsByAssistantId: new Map(),
};
function fixture(): Group {
  return {
    type: 'work_group',
    key: 'work-tool',
    isStreaming: false,
    durationMs: 1000,
    children: [
      {
        type: 'tool_segment',
        key: 'tools',
        toolCalls: [
          {
            clientId: 'tool',
            role: 'tool_use',
            content: '',
            toolUseId: 'call_read',
            toolName: 'Read',
            toolInput: { file_path: '/project/a.ts' },
          },
        ],
        resultMap: new Map([['tool', 'original result']]),
        resultTsMap: new Map(),
        settledIds: new Set(['tool']),
      },
    ],
  };
}
beforeEach(() => {
  expandMemory.reset();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('completed work-group rendering during a text stream', () => {
  it.each([false, true])(
    'runs the real block and summary only when required (reuse=%s)',
    (reuse) => {
      const project = createWorkGroupProjection();
      const group = fixture();
      const element = () => {
        const fresh = { ...group, children: [...group.children] };
        const item = (reuse ? project([fresh])[0] : fresh) as Group;
        return <WorkGroupRenderItemView item={item} context={context} compact={false} />;
      };
      const view = render(element());
      for (let frame = 0; frame < 40; frame++) view.rerender(element());
      expect(WorkGroupBlock).toHaveBeenCalledTimes(reuse ? 1 : 41);
      expect(projectWorkActivities).toHaveBeenCalledTimes(reuse ? 1 : 41);
      // Memoizing the parent must not suppress the block's own expand/collapse state.
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByTestId('tool-result').textContent).toBe('original result');
    },
  );

  it('updates an expanded result and refreshes context instead of retaining stale closures', () => {
    const project = createWorkGroupProjection();
    const group = fixture();
    const element = (item: Group, ctx = context) => (
      <WorkGroupRenderItemView item={project([item])[0] as Group} context={ctx} compact={false} />
    );
    const view = render(element(group));
    fireEvent.click(screen.getByRole('button'));
    const tool = group.children[0];
    if (tool.type !== 'tool_segment') throw new Error('Expected tool fixture');
    view.rerender(
      element({
        ...group,
        children: [{ ...tool, resultMap: new Map([['tool', 'late correction']]) }],
      }),
    );
    expect(screen.getByTestId('tool-result').textContent).toBe('late correction');
    const previousRenders = vi.mocked(WorkGroupBlock).mock.calls.length;
    view.rerender(element(group, { ...context, workingDir: '/other' }));
    expect(vi.mocked(WorkGroupBlock).mock.calls.length).toBe(previousRenders + 1);
  });
});

describe('remote running work preview', () => {
  // Unit regression for the retain/release history contract introduced by #8066.
  // Existing preview coverage uses ordinary work groups, not the teammate journal.
  // One completed remote work range must release its Host detail interest on both
  // manual collapse and unmount; otherwise closed process records keep reading.
  it('releases teammate history details when collapsed or unmounted', async () => {
    const row = (id: number, role: HistoryChatMessage['role'], content: string): HistoryChatMessage => ({
      id: String(id), clientId: `c${id}`, role, content,
      createdAt: new Date(Date.UTC(2026, 9, 30) + id * 1000).toISOString(),
    });
    const rows = [row(1, 'user', 'Work'), row(2, 'thinking', 'Working'), row(3, 'assistant', 'Answer')];
    const view = new HistoryViewController<HistoryChatMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, hasMore: false, nextCursor: null, messages: [rows[1]!] }),
      expanded: async () => undefined,
    });
    await view.refresh();
    function RemoteJournal() {
      const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot);
      const projection = buildMessageStreamRenderProjection({
        historyView: view, historySnapshot: snapshot, historyLiveMessages: [], isSessionStreaming: false,
        generatedFilesItemCache: new Map(), buildRaw: () => ({ items: [], singleResultMap: new Map() }),
      });
      return projection.items.map((item) => item.type === 'work_group'
        ? <WorkGroupRenderItemView key={item.key} item={{ ...item, teammateJournal: true }} context={context} compact={false} />
        : null);
    }
    const mounted = render(<RemoteJournal />);
    const header = () => mounted.container.querySelector('[data-teammate-process] > button') as HTMLButtonElement;
    try {
      expect(header().getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(header());
      await waitFor(() => expect(view.getSnapshot().expanded.size).toBe(1));
      fireEvent.click(header());
      await waitFor(() => expect(view.getSnapshot().expanded.size).toBe(0));
      fireEvent.click(header());
      await waitFor(() => expect(view.getSnapshot().expanded.size).toBe(1));
      mounted.unmount();
      expect(view.getSnapshot().expanded.size).toBe(0);
    } finally {
      mounted.unmount();
      view.setActive(false);
    }
  });

  // Regression (React #185): a read preview tail ending in prose seals the regrouped
  // group, which released the preview, which reopened the running group, repeatedly.
  it('keeps the tail open when the read rows regroup the running block', async () => {
    const row = (id: number, role: HistoryChatMessage['role'], content: string): HistoryChatMessage => ({
      id: String(id), clientId: `c${id}`, role, content,
      createdAt: new Date(Date.UTC(2026, 9, 30) + id * 1000).toISOString(),
    });
    const rows = [row(1, 'user', 'Work'), ...[2, 3, 4, 5, 6, 7].map((id) => row(id, 'thinking', `step ${id}`))];
    const prose = row(8, 'assistant', 'Checking the build');
    const items = projectHistoryView(rows, true);
    const work = items.at(-1);
    if (work?.type !== 'work') throw new Error('Expected a running work summary');
    work.summary.preview = { ...work.summary, key: 'preview', firstMessageId: '5', lastMessageId: '8' };
    const view = new HistoryViewController<HistoryChatMessage>({
      page: async () => ({ version: 1, items, hasMore: false, nextCursor: null }),
      details: async (ref) => ({ version: 1, hasMore: false, nextCursor: null,
        messages: ref.key === 'preview' ? [...rows.slice(4), prose] : [...rows.slice(1), prose] }),
      expanded: async () => undefined,
    });
    await view.refresh();
    function RemoteStream() {
      const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot);
      const projection = buildMessageStreamRenderProjection({
        historyView: view, historySnapshot: snapshot, historyLiveMessages: [], isSessionStreaming: true,
        generatedFilesItemCache: new Map(), buildRaw: () => ({ items: [], singleResultMap: new Map() }),
      });
      return projection.items.map((item) => item.type === 'work_group'
        ? <WorkGroupRenderItemView key={item.key} item={item} context={context} compact={false} />
        : <div key={item.key}>{item.type === 'message' ? String(item.message.content) : null}</div>);
    }
    try {
      render(<RemoteStream />);
      await waitFor(() => expect(screen.getByText('Checking the build')).toBeTruthy());
      expect([...view.getSnapshot().expanded]).toEqual(['preview']);
    } finally {
      view.setActive(false);
    }
  });
});
