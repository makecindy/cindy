import { describe, expect, it, vi } from 'vitest';
import { HistoryViewController, projectHistoryView, type HistoryWorkSummary } from '@cindy/maker-shared/message-window';
import { buildMobileHistoryRenderItems } from '../session/mobileHistoryRender';
import { buildMobileMessageRenderItems, type MobileMessageRenderItem } from '../session/messageRenderModel';
import type { RemoteMessage } from '../session/types';

function row(index: number, role: RemoteMessage['role'], content: unknown, toolUseId: string | null = null): RemoteMessage {
  return { id: `id-${index}`, clientId: `client-${index}`, sessionId: 'session', role, content, toolUseId,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), agentMeta: null };
}
const call = (index: number, name = 'Read', id = `tool-${index}`) => row(index, 'tool_use', { toolUseId: id, toolName: name, input: {} }, id);
const thought = (index: number) => row(index, 'thinking', { text: 'reasoning', durationMs: 500 });
const outline = (items: MobileMessageRenderItem[]): unknown[] => items.map((item) => item.type === 'work_group'
  ? { key: item.key, type: item.type, children: outline(item.children.filter((child) => child.type === 'work_group' || child.type === 'message')) }
  : { key: item.key, type: item.type });

function harness(rows: RemoteMessage[], streaming = false) {
  const details = vi.fn(async (summary: HistoryWorkSummary, after?: string) => {
    const start = rows.findIndex((item) => item.id === (after ?? summary.firstMessageId)) + (after ? 1 : 0);
    const end = rows.findIndex((item) => item.id === summary.lastMessageId) + 1;
    const messages = rows.slice(start, Math.min(start + 2, end));
    return { version: 1 as const, messages, hasMore: start + 2 < end, nextCursor: messages.at(-1)?.id ?? null };
  });
  const expanded = vi.fn(async (_refs: readonly HistoryWorkSummary[]) => undefined);
  const view = new HistoryViewController<RemoteMessage>({
    page: async () => ({ version: 1, items: projectHistoryView(rows, streaming), hasMore: false, nextCursor: null }),
    details, expanded,
  });
  const render = () => buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(), messages: [], streaming, sessionId: 'session' });
  return { view, details, expanded, render };
}

describe('remote history preserves original folding', () => {
  it('clips retained detail bodies when a visible media tool splits the old range', async () => {
    const rows = [row(0, 'user', 'Work'), call(1), row(2, 'tool_result', 'ok', 'tool-1'), thought(3),
      call(4), row(5, 'tool_result', 'pending', 'tool-4'), thought(6), call(7), row(8, 'tool_result', 'ok', 'tool-7'), row(9, 'assistant', 'Done')];
    const { view, render } = harness(rows);
    await view.refresh();
    const work = render()[1];
    if (work.type !== 'work_group') throw new Error('Missing work');
    work.deferred!.setVisible!(true, false);
    await vi.waitFor(() => expect([...view.getSnapshot().details.values()].every((state) => state.complete)).toBe(true));
    const current = rows.map((item) => item.id === 'id-5' ? { ...item, content: JSON.stringify({ xdt_image_url: 'cindy-media://blobs/image.png' }) } : item);
    const snapshot = { ...view.getSnapshot(), items: projectHistoryView(current, false) };
    const output = buildMobileHistoryRenderItems({ view, snapshot, messages: [], streaming: false, sessionId: 'session' });
    const tools = (items: MobileMessageRenderItem[]): string[] => items.flatMap((item): string[] => item.type === 'work_group' ? tools(item.children)
      : item.type === 'tool_group' || item.type === 'tool_media' ? item.tools.map((tool) => tool.source.clientId) : []);
    expect(tools(output)).toContain('client-1');
    expect(tools(output).filter((id) => id === 'client-1')).toHaveLength(1);
    expect(tools(output)).not.toContain('client-7');
    expect(outline(output)).toEqual(outline(buildMobileMessageRenderItems(current)));
    view.setActive(false);
  });

  it('uses current visible source rows when an old detail range becomes a media result', async () => {
    const rows = [row(0, 'user', 'Work'), thought(1), call(2), row(3, 'tool_result', 'pending', 'tool-2'), row(4, 'assistant', 'Done')];
    const { view, render } = harness(rows);
    await view.refresh();
    const work = render()[1];
    if (work.type !== 'work_group') throw new Error('Missing work');
    work.deferred!.setVisible!(true, false);
    await vi.waitFor(() => expect([...view.getSnapshot().details.values()].every((state) => state.complete)).toBe(true));
    const current = rows.map((item) => item.id === 'id-3' ? { ...item, content: JSON.stringify({ xdt_image_url: 'cindy-media://blobs/image.png' }) } : item);
    const snapshot = { ...view.getSnapshot(), items: projectHistoryView(current, false) };
    const output = buildMobileHistoryRenderItems({ view, snapshot, messages: [], streaming: false, sessionId: 'session' });
    expect(outline(output)).toEqual(outline(buildMobileMessageRenderItems(current)));
    view.setActive(false);
  });

  it('keeps true child-agent ownership and untagged paired results intact', async () => {
    const rows = [row(0, 'user', 'Work'), call(1, 'Agent', 'agent'),
      { ...call(2, 'Read', 'child-tool'), agentMeta: { parentUuid: 'agent' } },
      row(3, 'tool_result', 'child result', 'child-tool'),
      { ...row(4, 'assistant', 'child answer'), agentMeta: { parentUuid: 'agent' } },
      row(5, 'tool_result', 'agent done', 'agent'), row(6, 'assistant', 'Done')];
    const { view, render } = harness(rows);
    await view.refresh();
    expect(render().find((item) => item.type === 'subagent_group'))
      .toEqual(buildMobileMessageRenderItems(rows).find((item) => item.type === 'subagent_group'));
    view.setActive(false);
  });

  it.each([
    ['media inside a contiguous tool segment', [row(0, 'user', 'Work'), call(1), row(2, 'tool_result', 'ok', 'tool-1'),
      call(3), row(4, 'tool_result', JSON.stringify({ xdt_image_url: 'cindy-media://blobs/image.png' }), 'tool-3'),
      call(5), row(6, 'tool_result', 'ok', 'tool-5'), row(7, 'assistant', 'Done')]],
    ['progress and source-code markers', [row(0, 'user', 'Work'), row(1, 'assistant', 'Checking'), call(2),
      row(3, 'tool_result', 'source contains <tool_use_error> and cindy-media:', 'tool-2'), thought(4),
      row(5, 'assistant', 'Next'), call(6), row(7, 'tool_result', 'ok', 'tool-6'), row(8, 'assistant', 'Done')]],
    ['pure actions', [row(0, 'user', 'Work'), thought(1), call(2), row(3, 'tool_result', 'ok', 'tool-2'), row(4, 'assistant', 'Done')]],
    ['omitted thinking', [row(0, 'user', 'Work'), row(1, 'thinking', { text: '', durationMs: 0 }), row(2, 'assistant', 'Done')]],
    ['omitted thinking before action', [row(0, 'user', 'Work'), row(1, 'thinking', { text: '', durationMs: 0 }), call(2), row(3, 'assistant', 'Done')]],
    ['late result after progress', [row(0, 'user', 'Work'), call(1), row(2, 'assistant', 'Checking'), row(3, 'tool_result', 'ok', 'tool-1'), row(4, 'assistant', 'Done')]],
    ['Workflow and delivery prose', [row(0, 'user', 'Work'), thought(1), call(2, 'Workflow'), row(3, 'tool_result', 'done', 'tool-2'),
      row(4, 'assistant', '# Deliverable\nKeep this visible'), thought(5), row(6, 'assistant', 'Done')]],
    ['explicit user boundary', [row(0, 'user', 'First'), thought(1), row(2, 'assistant', 'Done'), row(3, 'user', 'Second'), thought(4), row(5, 'assistant', 'Done')]],
  ] as const)('keeps the same group identities and nesting: %s', async (_name, fixture) => {
    const rows = [...fixture];
    const { view, render, details } = harness(rows);
    await view.refresh();
    expect(outline(render())).toEqual(outline(buildMobileMessageRenderItems(rows, { isSessionStreaming: false })));
    expect(details).not.toHaveBeenCalled();
    view.setActive(false);
  });

  it('opens only the chosen inner group, reads all pages, and retains the outer hierarchy', async () => {
    const rows = [row(0, 'user', 'Work'), row(1, 'assistant', 'Checking'), thought(2), call(3),
      row(4, 'tool_result', 'ok', 'tool-3'), thought(5), row(6, 'assistant', 'Next'), thought(7), row(8, 'assistant', 'Done')];
    const { view, render, details } = harness(rows);
    await view.refresh();
    const outer = render()[1];
    expect(outer.type).toBe('work_group');
    if (outer.type !== 'work_group') throw new Error('Missing outer group');
    expect(outer.deferred).toBeUndefined();
    const inner = outer.children.find((item) => item.type === 'work_group');
    if (inner?.type !== 'work_group') throw new Error('Missing inner group');
    inner.deferred!.setVisible!(true, false);
    await vi.waitFor(() => expect([...view.getSnapshot().details.values()].every((state) => state.complete)).toBe(true));
    expect(details).toHaveBeenCalledTimes(2);
    expect(view.getSnapshot().expanded.size).toBe(1);
    expect(outline(render())).toEqual(outline(buildMobileMessageRenderItems(rows, { isSessionStreaming: false })));
    const loaded = render()[1];
    if (loaded.type !== 'work_group') throw new Error('Missing loaded group');
    const loadedInner = loaded.children.find((item) => item.type === 'work_group');
    if (loadedInner?.type !== 'work_group') throw new Error('Missing loaded inner group');
    expect(loadedInner.children.length).toBeGreaterThan(0);
    loadedInner.deferred!.setVisible!(false, false);
    await view.refresh();
    expect(details).toHaveBeenCalledTimes(2);
    expect(view.getSnapshot().expanded.size).toBe(0);
    view.setActive(false);
  });

  it('uses the same bounded detail reader for desktop preview without opening the full range', async () => {
    const rows = [row(0, 'user', 'Work'), ...Array.from({ length: 12 }, (_, index) => thought(index + 1))];
    const { view, render, details } = harness(rows, true);
    await view.refresh();
    const group = render()[1];
    if (group.type !== 'work_group') throw new Error('Missing active group');
    group.deferred!.setVisible!(false, false);
    expect(details).not.toHaveBeenCalled();
    group.deferred!.setVisible!(false, true);
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(3));
    const state = [...view.getSnapshot().details.values()][0];
    expect(state.messages.map((item) => item.id)).toEqual(rows.slice(-5).map((item) => item.id));
    expect([...view.getSnapshot().expanded]).toEqual([`preview-work-client-1`]);
    group.deferred!.setVisible!(false, false);
    view.setActive(false);
  });
});
