/**
 * codexTranslator.test.ts (路线 A 重写)
 * ---------------------------------------------------------------------------
 * 契约测试 — 覆盖 packages/maker-core/src/agents/codex/translator.ts
 * 把 app-server v2 Notification 翻成 maker-core 语义 AgentEvent 的映射 + 防御分支。
 *
 * 与上一版差异:
 *  - 输入从 SDK ThreadEvent 换成 app-server 的 ItemStartedNotification['params'] 等
 *  - item 类型用 camelCase tag (agentMessage / commandExecution / ...)
 *  - reasoning 用 summary[] 数组
 *  - 没有 todo_list 测试 (v2 协议级删除)
 *  - 没有 thread.started / turn.* 测试 (translator 不处理, 由 index.ts 直接处)
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  translateItemNotification,
  translateErrorNotification,
  newCodexRuntimeState,
  type CodexRuntimeState,
} from '../../../../../packages/maker-core/src/agents/codex/translator';
import type { AgentEvent } from '../../../../../packages/maker-core/src/types/events';
import type { AsyncQueue } from '../../../../../packages/maker-core/src/agents/shared/async-queue';

// ── 收集器 ──────────────────────────────────────────────────────────────────
function makeCollector(): { events: AgentEvent[]; queue: AsyncQueue<AgentEvent> } {
  const events: AgentEvent[] = [];
  const queue: AsyncQueue<AgentEvent> = {
    push: (e) => {
      events.push(e);
      return true;
    },
    end: () => {},
    clear: () => {},
    get pending() { return 0; },
    [Symbol.asyncIterator]: () => { throw new Error('not used in tests'); },
  };
  return { events, queue };
}

const log = { info: () => {}, warn: () => {}, debug: () => {} };

let rt: CodexRuntimeState;
let coll: ReturnType<typeof makeCollector>;

beforeEach(() => {
  rt = newCodexRuntimeState();
  coll = makeCollector();
});

// helper: 构造 item notification params
function itemParams(item: Record<string, unknown>): { threadId: string; turnId: string; item: { id: string; type: string; [k: string]: unknown } } {
  return { threadId: 't1', turnId: 'turn-1', item: item as { id: string; type: string; [k: string]: unknown } };
}

function feedItem(phase: 'started' | 'updated' | 'completed', item: Record<string, unknown>): void {
  translateItemNotification(phase, itemParams(item), coll.queue, { rt, log });
}

// ── agentMessage ────────────────────────────────────────────────────────────

describe('agentMessage', () => {
  it('started + updated + completed 出 text delta + final', () => {
    feedItem('started', { type: 'agentMessage', id: 'a1', text: 'Hello' });
    feedItem('updated', { type: 'agentMessage', id: 'a1', text: 'Hello world' });
    feedItem('completed', { type: 'agentMessage', id: 'a1', text: 'Hello world!' });
    expect(coll.events.map((e) => e.type)).toEqual(['text', 'text', 'text']);
    expect((coll.events[0].data as { text: string }).text).toBe('Hello');
    expect((coll.events[1].data as { text: string }).text).toBe(' world');
    expect((coll.events[2].data as { text: string; isFinal: boolean }).isFinal).toBe(true);
    expect((coll.events[2].data as { text: string }).text).toBe('Hello world!');
  });

  it('updated 时 text 没增长不 emit', () => {
    feedItem('started', { type: 'agentMessage', id: 'a2', text: 'foo' });
    coll.events.length = 0;
    feedItem('updated', { type: 'agentMessage', id: 'a2', text: 'foo' });
    expect(coll.events).toHaveLength(0);
  });
});

// ── reasoning ───────────────────────────────────────────────────────────────

describe('reasoning', () => {
  it('summary[] join 成 text 流, started→delta→completed', () => {
    feedItem('started', { type: 'reasoning', id: 'r1', summary: [] });
    feedItem('updated', { type: 'reasoning', id: 'r1', summary: ['line one'] });
    feedItem('updated', { type: 'reasoning', id: 'r1', summary: ['line one', 'line two'] });
    feedItem('completed', { type: 'reasoning', id: 'r1', summary: ['line one', 'line two'] });

    const types = coll.events.map((e) => e.type);
    expect(types).toContain('thinking');
    const stages = coll.events.map((e) => (e.data as { stage?: string }).stage);
    expect(stages[0]).toBe('start');
    expect(stages.at(-1)).toBe('final');
    // 中间至少有 delta
    expect(stages.includes('delta')).toBe(true);
  });

  it('content[] 兜底 (summary 空)', () => {
    feedItem('started', { type: 'reasoning', id: 'r2', summary: [], content: ['hidden'] });
    const startEv = coll.events[0];
    expect((startEv.data as { stage: string }).stage).toBe('start');
    // content 不为空时 started 应该跟一个 delta 立刻发出
    expect(coll.events.length).toBe(2);
    expect((coll.events[1].data as { stage: string; text: string }).text).toBe('hidden');
  });

  it('防御: 直接 updated 没 started → lazy-init start', () => {
    feedItem('updated', { type: 'reasoning', id: 'r3', summary: ['oops'] });
    const stages = coll.events.map((e) => (e.data as { stage: string }).stage);
    expect(stages[0]).toBe('start');
    expect(stages[1]).toBe('delta');
  });
});

// ── commandExecution ────────────────────────────────────────────────────────

describe('commandExecution', () => {
  it('started 出 tool_use, completed 出 tool_result_full + tool_result', () => {
    feedItem('started', {
      type: 'commandExecution',
      id: 'cmd1',
      command: 'ls -la',
      cwd: '/tmp',
      status: 'inProgress',
    });
    feedItem('completed', {
      type: 'commandExecution',
      id: 'cmd1',
      command: 'ls -la',
      cwd: '/tmp',
      status: 'completed',
      aggregatedOutput: 'total 0',
      exitCode: 0,
    });
    const types = coll.events.map((e) => e.type);
    expect(types).toEqual(['tool_use', 'tool_result_full', 'tool_result']);
    expect((coll.events[0].data as { toolName: string }).toolName).toBe('exec');
    expect((coll.events[0].data as { input: { command: string } }).input.command).toBe('ls -la');
    expect((coll.events[1].data as { fullText: string; isError: boolean }).fullText).toBe('total 0');
    expect((coll.events[2].data as { summary: string }).summary).toBe('Exit 0');
  });

  it('failed 状态 → isError=true', () => {
    feedItem('completed', {
      type: 'commandExecution',
      id: 'cmd2',
      command: 'false',
      status: 'failed',
      aggregatedOutput: '',
      exitCode: 1,
    });
    // 防御补发 tool_use
    expect(coll.events[0].type).toBe('tool_use');
    expect((coll.events[1].data as { isError: boolean }).isError).toBe(true);
  });

  it('started 后第二次 started 不重发 tool_use (同 id 防重)', () => {
    feedItem('started', { type: 'commandExecution', id: 'cmd3', command: 'echo', status: 'inProgress' });
    coll.events.length = 0;
    feedItem('started', { type: 'commandExecution', id: 'cmd3', command: 'echo', status: 'inProgress' });
    expect(coll.events).toHaveLength(0);
  });
});

// ── mcpToolCall ─────────────────────────────────────────────────────────────

describe('mcpToolCall', () => {
  it('started 出 tool_use (toolName=mcp:server:tool), completed 出 result', () => {
    feedItem('started', {
      type: 'mcpToolCall',
      id: 'mcp1',
      server: 'fs',
      tool: 'read',
      status: 'inProgress',
      arguments: { path: '/etc/hostname' },
    });
    feedItem('completed', {
      type: 'mcpToolCall',
      id: 'mcp1',
      server: 'fs',
      tool: 'read',
      status: 'completed',
      arguments: { path: '/etc/hostname' },
      result: { content: [{ type: 'text', text: 'localhost' }] },
    });
    expect((coll.events[0].data as { toolName: string }).toolName).toBe('mcp:fs:read');
    expect(coll.events[1].type).toBe('tool_result_full');
    expect((coll.events[1].data as { fullText: string }).fullText).toContain('localhost');
    expect((coll.events[2].data as { summary: string }).summary).toBe('completed');
  });

  it('展平 MCP text content, 保留 lizi_art 返回的顶层 xdt_image_urls', () => {
    const artResult = '{"ok":true,"xdt_image_urls":["xdt-image://lizi-art-media-images/abc.png"]}';
    feedItem('started', {
      type: 'mcpToolCall',
      id: 'mcp-art-1',
      server: 'lizi_art',
      tool: 'call_tool',
      status: 'inProgress',
      arguments: { name: 'image_generate', args: { prompt: '画图' } },
    });
    feedItem('completed', {
      type: 'mcpToolCall',
      id: 'mcp-art-1',
      server: 'lizi_art',
      tool: 'call_tool',
      status: 'completed',
      arguments: { name: 'image_generate', args: { prompt: '画图' } },
      result: { content: [{ type: 'text', text: artResult }] },
    });

    expect(coll.events[1].type).toBe('tool_result_full');
    expect((coll.events[1].data as { fullText: string }).fullText).toBe(artResult);
    expect((coll.events[1].data as { fullText: string }).fullText).toContain('xdt_image_urls');
  });

  it('error 字段 → isError + summary=failed (无 started → 只 2 个 event)', () => {
    feedItem('completed', {
      type: 'mcpToolCall',
      id: 'mcp2',
      server: 'fs',
      tool: 'read',
      status: 'failed',
      arguments: {},
      error: { message: 'permission denied' },
    });
    // mcpToolCall 没 started 防御补发 — completed 只 emit tool_result_full + tool_result
    expect(coll.events.map((e) => e.type)).toEqual(['tool_result_full', 'tool_result']);
    expect((coll.events[0].data as { isError: boolean; fullText: string }).isError).toBe(true);
    expect((coll.events[0].data as { fullText: string }).fullText).toBe('permission denied');
    expect((coll.events[1].data as { summary: string }).summary).toBe('failed');
  });
});

// ── webSearch ───────────────────────────────────────────────────────────────

describe('webSearch', () => {
  it('started + completed 出 tool_use + tool_result', () => {
    feedItem('started', { type: 'webSearch', id: 'ws1', query: 'codex', action: { type: 'search', query: 'codex' } });
    feedItem('completed', { type: 'webSearch', id: 'ws1', query: 'codex' });
    expect((coll.events[0].data as { toolName: string }).toolName).toBe('web_search');
    expect((coll.events[0].data as { input: { query: string } }).input.query).toBe('codex');
    expect(coll.events[2].type).toBe('tool_result');
  });

  it('updated 不 emit', () => {
    feedItem('started', { type: 'webSearch', id: 'ws2', query: 'x' });
    coll.events.length = 0;
    feedItem('updated', { type: 'webSearch', id: 'ws2', query: 'x' });
    expect(coll.events).toHaveLength(0);
  });

  it('优先从 action 归一实际查询内容并保留完整参数', () => {
    const action = {
      type: 'search',
      query: 'actual query',
      queries: ['actual query', 'backup query'],
    };
    feedItem('started', { type: 'webSearch', id: 'ws-action', query: '', action });

    expect(coll.events).toHaveLength(1);
    expect((coll.events[0].data as { input: unknown }).input).toEqual({
      query: 'actual query',
      action,
    });
  });

  it('兼容 app-server snake_case 与历史 camelCase action 并生成可读摘要', () => {
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-many',
      query: '',
      action: { type: 'search', query: null, queries: ['', 'first query', 'second query'] },
    });
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-open',
      query: '',
      action: { type: 'open_page', url: 'https://example.com/page' },
    });
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-find',
      query: '',
      action: { type: 'find_in_page', url: 'https://example.com/page', pattern: 'needle' },
    });
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-find-escaped',
      query: '',
      action: { type: 'findInPage', url: 'https://example.com/page', pattern: "foo'\\bar" },
    });

    expect(coll.events.map((event) => (
      event.data as { input: { query: string } }
    ).input.query)).toEqual([
      'first query ...',
      'https://example.com/page',
      "'needle' in https://example.com/page",
      "'foo\\'\\\\bar' in https://example.com/page",
    ]);
  });

  it('started 只有 legacy query 时等 updated action 补齐，且只落一条 tool_use', () => {
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-late',
      query: 'placeholder query',
      action: null,
    });
    expect(coll.events).toHaveLength(0);

    feedItem('updated', {
      type: 'webSearch',
      id: 'ws-late',
      query: '',
      action: { type: 'search', query: 'late query', queries: null },
    });
    feedItem('completed', {
      type: 'webSearch',
      id: 'ws-late',
      query: '',
      action: { type: 'search', query: 'late query', queries: null },
    });

    expect(coll.events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result_full',
      'tool_result',
    ]);
    expect((coll.events[0].data as { input: unknown }).input).toEqual({
      query: 'late query',
      action: { type: 'search', query: 'late query', queries: null },
    });
  });

  it('completed 的权威 action 变化时用同一 id 补发 tool_use 更新', () => {
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-final-action',
      query: '',
      action: { type: 'search', query: 'early query', queries: null },
    });
    feedItem('completed', {
      type: 'webSearch',
      id: 'ws-final-action',
      query: '',
      action: { type: 'open_page', url: 'https://example.com/final' },
    });

    expect(coll.events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_use',
      'tool_result_full',
      'tool_result',
    ]);
    expect(coll.events.slice(0, 2).map((event) => event.data)).toEqual([
      {
        toolUseId: 'ws-final-action',
        toolName: 'web_search',
        input: {
          query: 'early query',
          action: { type: 'search', query: 'early query', queries: null },
        },
      },
      {
        toolUseId: 'ws-final-action',
        toolName: 'web_search',
        input: {
          query: 'https://example.com/final',
          action: { type: 'open_page', url: 'https://example.com/final' },
        },
      },
    ]);
  });

  it('completed 快照丢失字段时仍用 started 的 legacy query 补发调用记录', () => {
    feedItem('started', {
      type: 'webSearch',
      id: 'ws-legacy-only',
      query: 'legacy query',
      action: null,
    });
    expect(coll.events).toHaveLength(0);

    feedItem('completed', {
      type: 'webSearch',
      id: 'ws-legacy-only',
      query: '',
      action: null,
    });

    expect(coll.events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result_full',
      'tool_result',
    ]);
    expect((coll.events[0].data as { input: { query: string } }).input.query).toBe('legacy query');
  });

  it('缺失 started/updated 时 completed 仍先补 tool_use', () => {
    feedItem('completed', {
      type: 'webSearch',
      id: 'ws-completed-only',
      query: '',
      action: { type: 'search', query: 'completed query', queries: null },
    });

    expect(coll.events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result_full',
      'tool_result',
    ]);
    expect((coll.events[0].data as { input: { query: string } }).input.query).toBe('completed query');
  });

  it('completed 仍无有效参数时不生成空白调用记录', () => {
    feedItem('started', { type: 'webSearch', id: 'ws-empty', query: '', action: null });
    feedItem('updated', { type: 'webSearch', id: 'ws-empty', query: '', action: null });
    feedItem('completed', { type: 'webSearch', id: 'ws-empty', query: '', action: null });

    expect(coll.events).toHaveLength(0);
  });
});

// ── fileChange ──────────────────────────────────────────────────────────────

describe('fileChange', () => {
  it('completed 出 tool_use + tool_result_full + tool_result', () => {
    feedItem('completed', {
      type: 'fileChange',
      id: 'fc1',
      status: 'completed',
      changes: [
        { path: 'src/foo.ts', kind: { type: 'add' }, diff: '+ hello' },
        { path: 'src/bar.ts', kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@' },
      ],
    });
    expect(coll.events.map((e) => e.type)).toEqual(['tool_use', 'tool_result_full', 'tool_result']);
    expect((coll.events[0].data as { toolName: string }).toolName).toBe('file_change');
    expect((coll.events[2].data as { summary: string }).summary).toContain('2 file');
  });

  it('started 不 emit (只 completed 处理)', () => {
    feedItem('started', { type: 'fileChange', id: 'fc2', status: 'inProgress', changes: [] });
    expect(coll.events).toHaveLength(0);
  });
});

// ── error notification ──────────────────────────────────────────────────────

describe('error notification', () => {
  it('willRetry=false → emit error event', () => {
    translateErrorNotification(
      { threadId: 't1', turnId: 'turn-1', willRetry: false, error: { message: 'rate limit' } },
      coll.queue,
      { rt, log },
    );
    expect(coll.events).toHaveLength(1);
    expect(coll.events[0].type).toBe('error');
    expect((coll.events[0].data as { message: string }).message).toBe('rate limit');
  });

  it('willRetry=true → 不 emit (server 自己重试, 不打扰 UI)', () => {
    translateErrorNotification(
      { threadId: 't1', turnId: 'turn-1', willRetry: true, error: { message: 'transient' } },
      coll.queue,
      { rt, log },
    );
    expect(coll.events).toHaveLength(0);
  });
});

// ── 防御 ────────────────────────────────────────────────────────────────────

describe('defensive', () => {
  it('未知 item.type 不 throw, 静默 warn', () => {
    expect(() =>
      feedItem('completed', { type: 'unknownFutureItem', id: 'x', payload: {} }),
    ).not.toThrow();
    expect(coll.events).toHaveLength(0);
  });

  it('item 没 type 字段不 throw', () => {
    expect(() =>
      translateItemNotification(
        'completed',
        { threadId: 't', turnId: 'tu', item: { id: 'x' } as { id: string; type: string } },
        coll.queue,
        { rt, log },
      ),
    ).not.toThrow();
  });
});
