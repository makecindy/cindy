/**
 * search_chat_history 工具单测 —— schema 校验 + payload 整形(host 回调 mock 掉)。
 * 验证工具层契约: 默认值、ISO 转换、omit-when-null、向量诊断字段、游标往返、错误码映射。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerSearchChatHistoryTool } from '../xdt-helper/search_chat_history.js';
import type {
  XdtHelperHistoryDeps,
  SearchChatHistoryArgs,
  SearchChatHistoryResult,
} from '../xdt-helper/_history_types.js';

function makeResult(over: Partial<SearchChatHistoryResult> = {}): SearchChatHistoryResult {
  return {
    hits: [],
    sessions: {},
    vectorUsed: false,
    vectorSkipReason: null,
    nextOffset: null,
    hasMore: false,
    poolSize: 0,
    poolCapped: false,
    ...over,
  };
}

/** 构造 registry + mock deps; 返回 registry 和被捕获的 searchChatHistory mock。 */
function setup(result: SearchChatHistoryResult | { ok: false; errorCode: string; message: string }) {
  const searchChatHistory = vi.fn(async (_args: SearchChatHistoryArgs) => {
    if ('ok' in result && result.ok === false) return result as never;
    return { ok: true as const, result: result as SearchChatHistoryResult };
  });
  const history = {
    listWorkdirs: vi.fn(),
    listSessions: vi.fn(),
    getMessages: vi.fn(),
    searchChatHistory,
  } as unknown as XdtHelperHistoryDeps;
  const registry = new XdtHelperToolRegistry();
  registerSearchChatHistoryTool(registry, { history });
  return { registry, searchChatHistory };
}

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (!block || block.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

describe('search_chat_history tool', () => {
  it('超长 query → INVALID_ARGS (zod)', async () => {
    const { registry, searchChatHistory } = setup(makeResult());
    const res = await registry.call('search_chat_history', { query: '边'.repeat(257) });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(searchChatHistory).not.toHaveBeenCalled();
  });

  it('缺 query → INVALID_ARGS (zod)', async () => {
    const { registry, searchChatHistory } = setup(makeResult());
    const res = await registry.call('search_chat_history', {});
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(searchChatHistory).not.toHaveBeenCalled();
  });

  it('默认值: roles 缺省=问答四类, contextRadius=2, limit=10, offset=0', async () => {
    const { registry, searchChatHistory } = setup(makeResult());
    await registry.call('search_chat_history', { query: '  登录报错  ' });
    expect(searchChatHistory).toHaveBeenCalledTimes(1);
    const args = searchChatHistory.mock.calls[0][0];
    expect(args.query).toBe('登录报错'); // trim
    expect(args.roles).toEqual(['user', 'assistant', 'ask_user', 'plan_review']);
    expect(args.contextRadius).toBe(2);
    expect(args.limit).toBe(10);
    expect(args.offset).toBe(0);
    expect(args.sessionIds).toBeNull();
    expect(args.fromMs).toBeNull();
  });

  it('非法 from ISO → INVALID_ARGS, 不调 host', async () => {
    const { registry, searchChatHistory } = setup(makeResult());
    const res = await registry.call('search_chat_history', { query: 'x', from: 'not-a-date' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(searchChatHistory).not.toHaveBeenCalled();
  });

  it('payload 整形: createdAt→ISO, snippet/技术字段 omit-when-null, isHit, 诊断字段', async () => {
    const ts = Date.parse('2026-05-01T08:00:00.000Z');
    const result = makeResult({
      hits: [
        {
          messageId: 'm1',
          sessionId: 's1',
          role: 'assistant',
          createdAt: ts,
          snippet: null, // 纯向量命中 → 应被 omit
          score: 0.5,
          ftsRank: null, // omit
          vectorRank: 1,
          vectorDistance: 0.12,
          context: [
            {
              id: 'm0',
              sessionId: 's1',
              role: 'user',
              content: { text: 'hi' },
              toolUseId: null, // omit
              agentMeta: null, // omit
              createdAt: ts - 1000,
              rewindAt: null, // omit
              isHit: false,
            },
            {
              id: 'm1',
              sessionId: 's1',
              role: 'assistant',
              content: 'answer',
              toolUseId: 'tool-123',
              agentMeta: { foo: 1 },
              createdAt: ts,
              rewindAt: null,
              isHit: true,
            },
          ],
        },
      ],
      sessions: { s1: { workingDir: '/repo', agentKind: 'cc', title: 'T' } },
      vectorUsed: true,
      poolSize: 1,
    });
    const { registry } = setup(result);
    const out = parse(await registry.call('search_chat_history', { query: 'x' }));

    expect(out.ok).toBe(true);
    const hit = out.hits[0];
    expect(hit.createdAt).toBe('2026-05-01T08:00:00.000Z');
    expect('snippet' in hit).toBe(false); // null → omit
    expect('ftsRank' in hit).toBe(false); // null → omit
    expect(hit.vectorRank).toBe(1);
    expect(hit.vectorDistance).toBe(0.12);
    expect(hit.score).toBe(0.5);

    // context[0]: 技术字段全 null → 全 omit, 只剩核心字段
    const c0 = hit.context[0];
    expect(c0).toEqual({
      id: 'm0',
      sessionId: 's1',
      role: 'user',
      content: { text: 'hi' },
      createdAt: '2026-05-01T07:59:59.000Z',
      isHit: false,
    });
    // context[1]: 命中本身, 带 toolUseId / agentMeta
    const c1 = hit.context[1];
    expect(c1.isHit).toBe(true);
    expect(c1.toolUseId).toBe('tool-123');
    expect(c1.agentMeta).toEqual({ foo: 1 });

    expect(out.sessions).toEqual({ s1: { workingDir: '/repo', agentKind: 'cc', title: 'T' } });
    expect(out.vector_used).toBe(true);
    expect('vector_skip_reason' in out).toBe(false); // null → omit
    expect(out.pool_size).toBe(1);
    expect(out.pool_capped).toBe(false);
    expect(out.nextCursor).toBeNull();
    expect(out.hasMore).toBe(false);
  });

  it('vector_skip_reason 在退化时透传', async () => {
    const { registry } = setup(
      makeResult({ vectorUsed: false, vectorSkipReason: 'sqlite-vec 扩展未加载, 本次仅用 FTS 全文检索。' }),
    );
    const out = parse(await registry.call('search_chat_history', { query: 'x' }));
    expect(out.vector_used).toBe(false);
    expect(out.vector_skip_reason).toContain('FTS');
  });

  it('游标往返: 有 nextOffset → 返回 nextCursor; 回传该 cursor → host 收到对应 offset', async () => {
    const { registry, searchChatHistory } = setup(makeResult({ nextOffset: 10, hasMore: true }));
    const first = parse(await registry.call('search_chat_history', { query: 'x' }));
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe('string');

    await registry.call('search_chat_history', { query: 'x', cursor: first.nextCursor });
    const secondArgs = searchChatHistory.mock.calls[1][0];
    expect(secondArgs.offset).toBe(10);
  });

  it('坏 cursor → offset 回 0 + warning', async () => {
    const { registry, searchChatHistory } = setup(makeResult());
    const out = parse(await registry.call('search_chat_history', { query: 'x', cursor: '!!!garbage!!!' }));
    expect(searchChatHistory.mock.calls[0][0].offset).toBe(0);
    expect(out.warning).toBe('INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE');
  });

  it('host HOST_NOT_READY → 工具返 HOST_NOT_READY', async () => {
    const { registry } = setup({ ok: false, errorCode: 'HOST_NOT_READY', message: 'db not ready' });
    const res = await registry.call('search_chat_history', { query: 'x' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });

  it('host 其它错 → 归 INTERNAL', async () => {
    const { registry } = setup({ ok: false, errorCode: 'INTERNAL', message: 'boom' });
    const res = await registry.call('search_chat_history', { query: 'x' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });
});
