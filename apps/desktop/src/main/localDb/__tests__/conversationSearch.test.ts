import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const conversationSearchSource = readFileSync(
  resolve(__dirname, '..', 'conversationSearch.ts'),
  'utf8',
);

describe('conversationSearch source invariants', () => {
  it('includes visible AskUser cards in content search roles', () => {
    expect(conversationSearchSource).toContain(
      "const SEARCH_ROLES = ['user', 'assistant', 'ask_user', 'plan_review'] as const;",
    );
  });

  // 标题匹配必须按**界面上显示的**标题算:未起名会话行上显示的是本地化兜底文案,
  // 拿原始哨兵匹配会让「搜得到的」与「看得到的」错位,命中下标也会错位。
  // renderer 渲染同一个 conversationSearchTitle,两端逐字一致(PR #1031)。
  it('matches session titles through the shared display projection', () => {
    expect(conversationSearchSource).toContain(
      'fuzzyTitleMatch(conversationSearchTitle(row.title, request.unnamedLabel), query)',
    );
  });

  // 返回给 renderer 的 summary 仍是原始存储值:投影只发生在匹配 / 渲染那一刻,
  // 不把某次请求时的 locale 固化进返回数据(本 PR 第 8 条不变量)。
  it('keeps the raw stored title in the session summary', () => {
    expect(conversationSearchSource).toContain('title: row.title,');
  });
});
