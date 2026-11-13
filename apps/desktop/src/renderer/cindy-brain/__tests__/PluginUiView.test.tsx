// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../../shared/ghost';

const presenter = vi.hoisted(() => ({ active: true, updates: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/chat/McpAppCard', () => ({ McpAppCard: ({ contextSource }: {
  contextSource: { read(): Record<string, unknown>; subscribe(changed: () => void): () => void };
}) => {
  useEffect(() => {
    if (presenter.active) return contextSource.subscribe(() => presenter.updates.push(contextSource.read()));
  }, [contextSource, presenter.active]);
  return null;
} }));
import { PluginUiView } from '../PluginUiView';

// Opus F3：显式展示流式正文时，每个 token 都触发全文传输；旧覆盖只测试卡片自身。
// 真实 View 的上下文订阅边界，替换 iframe presenter；分散 token 和同值重渲染。tier: unit。
afterEach(() => { cleanup(); vi.useRealTimers(); presenter.active = true; presenter.updates = []; });
const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
  approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
    kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
      ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
      host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }], capabilities: ['context'] },
    } } };
ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest);

it('coalesces streaming content, flushes completion, and skips unchanged message values', () => {
  vi.useFakeTimers();
  const view = (content: string, isStreaming: boolean) => <PluginUiView ghost={ghost} viewId="view" sessionId="task"
    context={() => ({ message: { clientId: 'message', role: 'assistant', content, isStreaming } })} />;
  const h = render(view('', true));
  for (let token = 1; token <= 10; token++) {
    h.rerender(view('x'.repeat(token), true));
    act(() => vi.advanceTimersByTime(16));
  }
  expect(presenter.updates.length).toBeLessThanOrEqual(2);
  h.rerender(view('Completed', false));
  expect(presenter.updates.at(-1)).toMatchObject({ context: { message: { content: 'Completed', isStreaming: false } } });
  const count = presenter.updates.length;
  for (let render = 0; render < 10; render++) h.rerender(view('Completed', false));
  act(() => vi.runAllTimers());
  expect(presenter.updates).toHaveLength(count);
});

it('does no context work without a visible presenter and cancels a pending update on release', () => {
  vi.useFakeTimers(); presenter.active = false;
  const context = vi.fn(() => ({ message: { content: 'Streaming', isStreaming: true } }));
  const view = () => <PluginUiView ghost={ghost} viewId="view" sessionId="task" context={context} />;
  const h = render(view());
  h.rerender(view());
  expect(context).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  presenter.active = true; h.rerender(view());
  context.mockReturnValue({ message: { content: 'Next', isStreaming: true } });
  h.rerender(<PluginUiView ghost={ghost} viewId="view" sessionId="task" context={() => context()} />);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  h.unmount(); const count = presenter.updates.length;
  act(() => vi.runAllTimers());
  expect(presenter.updates).toHaveLength(count);
});
