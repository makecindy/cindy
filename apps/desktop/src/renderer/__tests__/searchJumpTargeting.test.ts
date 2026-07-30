/**
 * searchJumpTargeting.test.ts
 * ---------------------------------------------------------------------------
 * 回归:搜索 / 引用跳转的落点判定必须区分"目标在窗口里"与"窗口连续覆盖到目标"。
 *
 * 背景(#676 review):这个判定原先内联在 CCAgentSessionView 的 searchJump effect 里 ——
 * 调用方在 messages 里看到目标就直接 focus 并 return,store 侧新加的孤岛感知补齐根本没有
 * 机会运行。于是"补齐失败留下孤岛 → 重跳同一目标自愈"这条链在生产路径上是断的,而 store
 * 级回归绕过了这个入口、看不出问题。判定抽成纯函数后由本文件直接覆盖。
 */

import { describe, it, expect } from 'vitest';
import { canFocusWithoutJumpLoad } from '@/lib/searchJumpTargeting';

const windowWith = (ids: string[], hasIsland?: boolean) => ({
  messages: ids.map((clientId) => ({ clientId })),
  ...(hasIsland === undefined ? {} : { historyWindowHasIsland: hasIsland }),
});

describe('搜索跳转落点判定', () => {
  it('窗口连续且目标在窗口里 → 直接 focus,不必再走 store', () => {
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c']), 'b')).toBe(true);
    // historyWindowHasIsland 缺省(undefined)等于"无孤岛"。
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b'], false), 'b')).toBe(true);
  });

  it('目标不在窗口里 → 必须走 store 加载', () => {
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b']), 'zzz')).toBe(false);
  });

  it('窗口有孤岛时即便目标在窗口里也要走 store,让补齐自愈', () => {
    // 关键回归:目标"在 messages 里"可能只是先前失败的深跳留下的孤立片段。
    expect(canFocusWithoutJumpLoad(windowWith(['island-target'], true), 'island-target')).toBe(
      false,
    );
  });
});

describe('canFocusWithoutJumpLoad · 孤岛一律交回 store', () => {
  it('有孤岛时即便已翻到历史起点也不直接 focus(around 仍可能捞回缺的邻居)', () => {
    // review #676(codex P1):跳转不只走分页,它还发 around-client-id。远程权威重建可以同时
    // 留下"孤岛 + hasMore=false"(翻到历史起点却保留了一条被有损推送落下的脱离行),那时
    // around 恰好能把它周围缺的邻居捞回来。用 hasMore 短路会把这条修复通道永久关掉。
    const state = {
      messages: [{ clientId: 'a' }, { clientId: 'b' }],
      historyWindowHasIsland: true,
      hasMoreMessages: false,
    };
    expect(canFocusWithoutJumpLoad(state, 'b')).toBe(false);
  });

  it('有孤岛且还能继续翻页时同样交回 store 补齐', () => {
    const state = {
      messages: [{ clientId: 'a' }],
      historyWindowHasIsland: true,
      hasMoreMessages: true,
    };
    expect(canFocusWithoutJumpLoad(state, 'a')).toBe(false);
  });
});
