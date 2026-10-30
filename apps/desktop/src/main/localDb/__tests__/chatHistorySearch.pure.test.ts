/**
 * chatHistorySearch.pure 单测 —— RRF 融合 + FTS query 构造的纯逻辑。
 * 不碰 sqlite / embedding / electron, 直接 import 纯模块。
 */

import { describe, expect, it } from 'vitest';

import {
  fuseRRF,
  buildFtsMatch,
  buildMessagesFtsMatch,
  visibleTextMatchesMessagesFtsQuery,
  RRF_K,
} from '../chatHistorySearch.pure';

describe('fuseRRF', () => {
  it('空输入返回空数组', () => {
    expect(fuseRRF([], [])).toEqual([]);
  });

  it('仅 FTS arm: 保序, ftsRank 1-based, vectorRank 为 null', () => {
    const out = fuseRRF(['a', 'b', 'c'], []);
    expect(out.map((e) => e.messageId)).toEqual(['a', 'b', 'c']);
    expect(out[0].ftsRank).toBe(1);
    expect(out[1].ftsRank).toBe(2);
    expect(out[0].vectorRank).toBeNull();
    // 分数严格递减(排名越靠前分越高)
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });

  it('仅向量 arm: vectorRank 1-based, ftsRank 为 null', () => {
    const out = fuseRRF([], ['x', 'y']);
    expect(out.map((e) => e.messageId)).toEqual(['x', 'y']);
    expect(out[0].vectorRank).toBe(1);
    expect(out[0].ftsRank).toBeNull();
  });

  it('两路都命中同一 doc: 分数相加, 双 rank 都填', () => {
    // 'shared' 在 FTS rank1 + 向量 rank1 → 共识, 应排第一
    const out = fuseRRF(['shared', 'fOnly'], ['shared', 'vOnly']);
    const shared = out.find((e) => e.messageId === 'shared')!;
    expect(shared.ftsRank).toBe(1);
    expect(shared.vectorRank).toBe(1);
    // shared 分 = 2 * 1/(k+1); 单路 doc 分 = 1/(k+1) 或 1/(k+2)
    expect(shared.score).toBeCloseTo(2 / (RRF_K + 1), 10);
    expect(out[0].messageId).toBe('shared'); // 共识命中排首位
  });

  it('同分按 messageId 字典序兜底(确定性)', () => {
    // 'b' 和 'a' 都只在 FTS rank1(分别独立两次调用不现实, 用相同 rank 模拟):
    // 构造两个 doc 同分: fts=['z'], vec=['a'] → 都是各自 arm rank1 → 同分
    const out = fuseRRF(['z'], ['a']);
    expect(out[0].score).toBeCloseTo(out[1].score, 10);
    expect(out.map((e) => e.messageId)).toEqual(['a', 'z']); // 'a' < 'z'
  });

  it('k 越大, 头部分数越低(平滑)', () => {
    const small = fuseRRF(['a'], [], 1)[0].score;
    const large = fuseRRF(['a'], [], 1000)[0].score;
    expect(small).toBeGreaterThan(large);
  });
});

describe('buildFtsMatch', () => {
  it('英文多词 → OR 连接的引号 token', () => {
    expect(buildFtsMatch('login bug')).toBe('"login" OR "bug"');
  });

  it('去重 token', () => {
    expect(buildFtsMatch('bug bug fix')).toBe('"bug" OR "fix"');
  });

  it('剥离 FTS 操作符 / 标点(防注入与语法错)', () => {
    // -, (), :, * 等都不是 \p{L}\p{N}, 被切掉
    expect(buildFtsMatch('foo-bar (baz):*')).toBe('"foo" OR "bar" OR "baz"');
  });

  it('纯标点 / 空串 → null(跳过 FTS arm)', () => {
    expect(buildFtsMatch('')).toBeNull();
    expect(buildFtsMatch('   ')).toBeNull();
    expect(buildFtsMatch('-*:()')).toBeNull();
  });

  it('CJK 连续串作为整体 token(unicode61 分词特性)', () => {
    expect(buildFtsMatch('登录报错')).toBe('"登录报错"');
  });

  it('messages_fts 把 CJK run 收成相邻 phrase；默认多词 OR，session_search 显式 AND', () => {
    expect(buildMessagesFtsMatch('登录报错')).toBe('"登 录 报 错"');
    expect(buildMessagesFtsMatch('边界')).toBe('"边 界"');
    expect(buildMessagesFtsMatch('login crash')).toBe('"login" OR "crash"');
    expect(buildMessagesFtsMatch('修复 login 问题')).toBe('"修 复" OR "login" OR "问 题"');
    expect(buildMessagesFtsMatch('login crash', 'AND')).toBe('"login" AND "crash"');
    expect(buildMessagesFtsMatch('修复 login 问题', 'AND')).toBe(
      '"修 复" AND "login" AND "问 题"',
    );
  });

  it('中英混合: 各自成 token', () => {
    expect(buildFtsMatch('修复 login 问题')).toBe('"修复" OR "login" OR "问题"');
  });

  it('token 数封顶 32, 防超长 MATCH', () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(' ');
    const out = buildFtsMatch(many)!;
    expect(out.split(' OR ')).toHaveLength(32);
  });

  it('combining mark / 变体选择符跟着所属 token，不拆成两半', () => {
    expect(buildMessagesFtsMatch('甲́乙')).toBe('"甲́ 乙"');
    expect(buildMessagesFtsMatch('禰\u{E0100}豆子')).toBe('"禰\u{E0100} 豆 子"');
  });

  it('超长连续汉字截成有限 MATCH，不把整段扩进去', () => {
    const out = buildMessagesFtsMatch('边'.repeat(400))!;
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out.startsWith('"边 ')).toBe(true);
  });

  it('65~256 字连续汉字整段保留，不截成 64 字前缀', () => {
    const query = '边'.repeat(200) + '界';
    // messages_fts：cjk_seg 后 201 个单字相邻 phrase，整段精确召回。
    expect(buildMessagesFtsMatch(query)).toBe(`"${'边 '.repeat(200)}界"`);
    // 群历史整段 token：完整段 quoted 精确匹配，前缀假阳性不再出现。
    expect(buildFtsMatch(query)).toBe(`"${query}"`);
  });

  it('超过 256 字的汉字 run 截到上限，只防御绕过 schema 的输入', () => {
    expect(buildMessagesFtsMatch('边'.repeat(300))).toBe(`"${'边 '.repeat(255)}边"`);
  });

  it('超长 Latin / 数字 token 不截断，quoted MATCH 仍是精确命中', () => {
    const hex = 'a'.repeat(128);
    expect(buildMessagesFtsMatch(hex)).toBe(`"${hex}"`);
    expect(buildFtsMatch(hex)).toBe(`"${hex}"`);
  });
});

describe('visibleTextMatchesMessagesFtsQuery', () => {
  it('跨标点的按字 phrase 仍算可见命中', () => {
    expect(visibleTextMatchesMessagesFtsQuery('边，界', '边界')).toBe(true);
    expect(visibleTextMatchesMessagesFtsQuery('登录报错了', '登录')).toBe(true);
  });

  it('可见正文不含 query 时不算命中，即使隐藏字段会 MATCH', () => {
    expect(visibleTextMatchesMessagesFtsQuery('please inspect the billing flow', 'secret')).toBe(
      false,
    );
    expect(visibleTextMatchesMessagesFtsQuery('结论。', 'turn17search1')).toBe(false);
  });
});
