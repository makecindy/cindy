// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
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

import { WorkGroupRenderItemView } from '@/components/chat/MessageStream';
import { WorkGroupBlock } from '@/components/chat/WorkGroupBlock';
import { projectWorkActivities } from '@/lib/agent-actions/workActivityProjection';
import { createWorkGroupProjection } from '@/components/chat/streamingMessageProjection';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { RenderItem } from '@/components/chat/messageWorkGroups';

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
