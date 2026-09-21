import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    query: dbMocks.query,
  }),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

import { searchSessionsFn } from '../session-search';

describe('searchSessionsFn', () => {
  beforeEach(() => {
    dbMocks.query.mockReset();
    dbMocks.query.mockResolvedValue([]);
  });

  it('CJK 短词收成相邻 phrase，多词 AND', async () => {
    await searchSessionsFn('登录 报错');
    expect(dbMocks.query).toHaveBeenCalledTimes(1);
    expect(dbMocks.query.mock.calls[0][1][0]).toBe(16_384);
    expect(dbMocks.query.mock.calls[0][1][1]).toBe('"登 录" AND "报 错"');
  });

  it('英文多词保持 AND，不退化成 OR', async () => {
    await searchSessionsFn('login bug');
    expect(dbMocks.query.mock.calls[0][1][1]).toBe('"login" AND "bug"');
  });

  it('纯标点返回空且不查库', async () => {
    await expect(searchSessionsFn('***')).resolves.toEqual([]);
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it('snippet 从原文重建并透传过滤参数（不用索引侧文本）', async () => {
    dbMocks.query.mockResolvedValue([
      {
        messageId: 'm1',
        sessionId: 's1',
        role: 'user',
        ts: 1,
        content: '登录 报错了',
        score: 0.1,
      },
    ]);
    const hits = await searchSessionsFn('登录', { sessionId: 's1', role: 'user', limit: 3 });
    // 原文真实空格保留、只高亮命中词；不再走 SQLite snippet()。
    expect(hits).toEqual([
      {
        messageId: 'm1',
        sessionId: 's1',
        role: 'user',
        ts: 1,
        snippet: '<mark>登录</mark> 报错了',
        score: 0.1,
      },
    ]);
    const [sql, params] = dbMocks.query.mock.calls[0];
    expect(sql).toContain('MATCH ?');
    expect(sql).toContain('substr(m.content, 1, ?)');
    expect(sql).not.toContain('snippet(');
    expect(sql).not.toContain('offsets(');
    expect(sql).toContain('m.session_id = ?');
    expect(sql).toContain('m.role = ?');
    expect(params).toEqual([16_384, '"登 录"', 's1', 'user', 3]);
  });

  it('中英相邻与多命中区间在 snippet 中不产生假空格且高亮正确', async () => {
    dbMocks.query.mockResolvedValue([
      {
        messageId: 'm2',
        sessionId: 's1',
        role: 'user',
        ts: 2,
        content: 'foo登录bar后 login 失败',
        score: 0.2,
      },
    ]);
    const hits = await searchSessionsFn('foo登录bar login');
    // 原文无空格处不得出现假空格；原文真实空格原样保留。
    expect(hits[0]!.snippet).toBe('<mark>foo登录bar</mark>后 <mark>login</mark> 失败');
  });
});
