import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryViewController } from '../historyViewController.js';
import type { HistoryDetailPage, HistoryMessageSource, HistoryViewPage, HistoryWorkPatch, HistoryWorkSummary } from '../historyView.js';
import { renderHistoryView } from '../historyViewRender.js';
import { HISTORY_WORK_LINE_MAX_BYTES, HISTORY_WORK_LINES_MAX_BYTES, projectHistoryWorkLines } from '../historyWorkLines.js';

let n = 0;
function row(role: string, content: unknown, extra: Partial<HistoryMessageSource> = {}): HistoryMessageSource {
  n += 1;
  return { id: `m${n}`, clientId: `c${n}`, role, content, createdAt: new Date(1_700_000_000_000 + n).toISOString(), ...extra };
}
function tool(name: string, input: unknown, extra: Partial<HistoryMessageSource> = {}) {
  const use = row('tool_use', { toolName: name, toolUseId: `t${n + 1}`, input }, extra);
  return use;
}
function result(use: HistoryMessageSource, content: string) {
  return row('tool_result', content, { toolUseId: (use.content as { toolUseId: string }).toolUseId });
}

describe('projectHistoryWorkLines', () => {
  it('uses the shared latest-five projection: Codex split actions and repeated reads', () => {
    const codex = tool('exec', {
      command: 'cat a.ts && rg needle && ls src',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat a.ts', name: 'a.ts', path: 'a.ts' },
        { type: 'search', command: 'rg needle', query: 'needle' },
        { type: 'listFiles', command: 'ls src', path: 'src' },
      ],
    });
    const readA = tool('Read', { file_path: '/repo/a.ts' });
    const readAAgain = tool('Read', { file_path: '/repo/a.ts' });
    const lines = projectHistoryWorkLines([codex, result(codex, 'ok'), readA, result(readA, 'x'), readAAgain], true);
    // `cat a.ts` in /repo and both later reads open the same file: only the newest read stays.
    expect(lines.map((line) => line.key)).toEqual([
      `${codex.clientId}:action:1`, `${codex.clientId}:action:2`, readAAgain.clientId,
    ]);
    expect(lines.at(-1)).toMatchObject({ kind: 'tool', status: 'running' });
    expect(lines[0]).toMatchObject({ kind: 'tool', status: 'done', descriptor: { intent: { action: 'search' } } });
  });

  it('keeps child-agent rows inside their own card', () => {
    const parent = tool('Task', { description: 'investigate' });
    const child = tool('Read', { file_path: '/repo/child.ts' }, { agentMeta: { parentUuid: 'task-1' } });
    const lines = projectHistoryWorkLines([parent, child], true);
    expect(lines.map((line) => line.key)).toEqual([parent.clientId]);
  });

  it('marks failed results with the row failure rules and never ships results or diffs', () => {
    const failing = tool('Bash', { command: 'pnpm build' });
    const edit = tool('apply_patch', { changes: [{ path: 'a.ts', kind: 'update', diff: '+'.repeat(5000) }] });
    const lines = projectHistoryWorkLines([failing, result(failing, 'Error: exit code 2'), edit], true);
    expect(lines[0]).toMatchObject({ kind: 'tool', hasError: true });
    expect(JSON.stringify(lines)).not.toContain('+++++');
    expect(JSON.stringify(lines)).not.toContain('exit code 2');
  });

  it('collapses and caps a thought, and drops older lines before exceeding the window budget', () => {
    const thought = row('thinking', `first\n\n   second ${'word '.repeat(100)}`);
    const [line] = projectHistoryWorkLines([thought], true);
    expect(line).toMatchObject({ kind: 'thinking', truncated: true });
    expect(line.kind === 'thinking' && line.text.startsWith('first second')).toBe(true);
    const wide = Array.from({ length: 5 }, (_, index) => tool('mcp__srv__do_it', { query: `${index}${'界'.repeat(2000)}` }));
    const lines = projectHistoryWorkLines(wide, true);
    expect(lines).toHaveLength(5);
    expect(Buffer.byteLength(JSON.stringify(lines), 'utf8')).toBeLessThanOrEqual(HISTORY_WORK_LINES_MAX_BYTES);
  });

  it.each([
    ['ASCII', (index: number) => `/repo/${'nested/'.repeat(40)}file${index}.ts`],
    ['CJK', (index: number) => `/仓库/${'深层目录/'.repeat(60)}文件${index}.ts`],
  ])('keeps every real file_change line, including the newest, inside the byte budget (%s paths)', (_label, path) => {
    const change = (count: number) => tool('file_change', { changes: Array.from({ length: count }, (_, index) => ({
      path: path(index), kind: { type: 'update', move_path: path(index + 100) }, diff: '+x\n'.repeat(500),
    })) });
    const lines = projectHistoryWorkLines([change(20), change(20), change(3), change(20), change(15)], true);
    expect(lines).toHaveLength(5);
    expect(Buffer.byteLength(JSON.stringify(lines), 'utf8')).toBeLessThanOrEqual(HISTORY_WORK_LINES_MAX_BYTES);
    for (const line of lines) expect(Buffer.byteLength(JSON.stringify(line), 'utf8')).toBeLessThanOrEqual(HISTORY_WORK_LINE_MAX_BYTES);
    const newest = lines.at(-1)!;
    if (newest.kind !== 'tool') throw new Error('expected a tool line');
    // The count a multi-file row shows survives the reduction.
    expect(newest.descriptor.kind === 'fileChange' ? newest.descriptor.changes.length : newest.descriptor.kind).toBe(15);
  });
});

function summary(key: string, revision: string, lines?: HistoryWorkSummary['lines']): HistoryWorkSummary {
  return {
    key, firstMessageId: 'm-first', lastMessageId: 'm-last', startedAtMs: 1, endedAtMs: 2,
    isStreaming: true, messageCount: 2, toolCount: 1, revision, ...(lines ? { lines } : {}),
  };
}
const answer = { type: 'messages' as const, key: 'c0', messages: [row('user', 'go')] };
function page(items: HistoryViewPage<HistoryMessageSource>['items']): HistoryViewPage<HistoryMessageSource> {
  return { version: 1, items, hasMore: false, nextCursor: null };
}
function patch(baseRevision: string, revision: string): HistoryWorkPatch {
  return { version: 1, sessionId: 's', baseRevision,
    item: { type: 'work', key: 'work-c1', summary: summary('work-c1', revision, [{ kind: 'thinking', key: 'c9', text: 'next' }]) } };
}

describe('HistoryViewController.applyWorkPatch', () => {
  afterEach(() => vi.useRealTimers());

  async function fixture() {
    const transport = {
      page: vi.fn(async () => page([answer, { type: 'work', key: 'work-c1', summary: summary('work-c1', 'r1', []) }])),
      details: vi.fn(async (): Promise<HistoryDetailPage<HistoryMessageSource>> => ({ version: 1, messages: [], hasMore: false, nextCursor: null })),
      expanded: vi.fn(async () => undefined),
    };
    const view = new HistoryViewController(transport);
    await view.refresh();
    return { view, transport };
  }

  it('replaces the running item in place without reading the page or any details', async () => {
    const { view, transport } = await fixture();
    const before = view.getSnapshot().items;
    view.applyWorkPatch(patch('r1', 'r2'));
    const items = view.getSnapshot().items;
    expect(items[0]).toBe(before[0]);
    expect(items[1]).toMatchObject({ summary: { revision: 'r2', lines: [{ text: 'next' }] } });
    expect(transport.page).toHaveBeenCalledTimes(1);
    expect(transport.details).not.toHaveBeenCalled();
  });

  it('still reloads an expanded running group, exactly like a page read would', async () => {
    const { view, transport } = await fixture();
    view.setExpanded('work-c1', true);
    await vi.waitFor(() => expect(transport.details).toHaveBeenCalledTimes(1));
    view.applyWorkPatch(patch('r1', 'r2'));
    await vi.waitFor(() => expect(transport.details).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['another base revision', () => patch('stale', 'r2')],
    ['an unknown item', () => ({ ...patch('r1', 'r2'), item: { ...patch('r1', 'r2').item, key: 'work-other' } })],
    ['a different range start', () => {
      const value = patch('r1', 'r2');
      return { ...value, item: { ...value.item, summary: { ...value.item.summary, firstMessageId: 'm-elsewhere' } } };
    }],
  ])('falls back to the page refresh for %s', async (_label, build) => {
    const { view, transport } = await fixture();
    vi.useFakeTimers();
    view.applyWorkPatch(build());
    expect(view.getSnapshot().items[1]).toMatchObject({ summary: { revision: 'r1' } });
    await vi.advanceTimersByTimeAsync(600);
    expect(transport.page).toHaveBeenCalledTimes(2);
  });

  it('never applies over a page read in flight', async () => {
    const { view, transport } = await fixture();
    let finish!: (value: HistoryViewPage<HistoryMessageSource>) => void;
    transport.page.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reading = view.refresh(false, true);
    view.applyWorkPatch(patch('r1', 'r2'));
    expect(view.getSnapshot().items[1]).toMatchObject({ summary: { revision: 'r1' } });
    finish(page([answer, { type: 'work', key: 'work-c1', summary: summary('work-c1', 'r3', []) }]));
    await reading;
    expect(view.getSnapshot().items[1]).toMatchObject({ summary: { revision: 'r3' } });
  });

  it('hands the Host lines to the renderer through the deferred binding', async () => {
    const { view } = await fixture();
    view.applyWorkPatch(patch('r1', 'r2'));
    type Item = { key: string; ids: string[]; children?: Item[]; deferred?: { lines?: unknown } };
    const items = renderHistoryView<HistoryMessageSource, Item>({
      view, snapshot: view.getSnapshot(), liveMessages: [], streaming: true,
      build: (rows) => [{ key: 'work', ids: [], children: rows.map((r) => ({ key: r.clientId, ids: [r.clientId] })) }],
      structure: {
        placeholder: (value) => row('thinking', '', { clientId: `placeholder-${value.key}` }),
        children: (item) => item.children,
        sourceIds: (item) => item.ids,
        rebuild: (item, children, deferred) => ({ ...item, children, deferred }),
      },
    });
    expect(items[0].deferred?.lines).toEqual([{ kind: 'thinking', key: 'c9', text: 'next' }]);
  });

  it('reports a group as awaiting details until its first detail rows land', async () => {
    const { view, transport } = await fixture();
    let finish!: (value: HistoryDetailPage<HistoryMessageSource>) => void;
    transport.details.mockImplementationOnce(() => new Promise<HistoryDetailPage<HistoryMessageSource>>((resolve) => { finish = resolve; }));
    type Item = { key: string; ids: string[]; children?: Item[]; deferred?: { awaitingDetails?: boolean } };
    const awaiting = () => renderHistoryView<HistoryMessageSource, Item>({
      view, snapshot: view.getSnapshot(), liveMessages: [], streaming: true,
      build: (rows) => [{ key: 'work', ids: [], children: rows.map((r) => ({ key: r.clientId, ids: [r.clientId] })) }],
      structure: {
        placeholder: (value) => row('thinking', '', { clientId: `placeholder-${value.key}` }),
        children: (item) => item.children,
        sourceIds: (item) => item.ids,
        rebuild: (item, children, deferred) => ({ ...item, children, deferred }),
      },
    })[0].deferred?.awaitingDetails;
    expect(awaiting()).toBe(true);
    view.setExpanded('work-c1', true);
    expect(awaiting()).toBe(true);
    finish({ version: 1, messages: [row('thinking', 'first', { id: 'm1', clientId: 'm1' })], hasMore: false, nextCursor: null });
    await vi.waitFor(() => expect(awaiting()).toBe(false));
  });
});
