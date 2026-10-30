/**
 * searchJumpTargeting.test.ts
 * ---------------------------------------------------------------------------
 * 回归:搜索 / 引用跳转的落点判定必须区分"目标在窗口里"与"窗口连续覆盖到目标"。
 *
 * 背景(#676):这个判定原先内联在 CCAgentSessionView 的 searchJump effect 里 ——
 * 调用方在 messages 里看到目标就直接 focus 并 return,store 侧新加的孤岛感知补齐根本没有
 * 机会运行。于是"补齐失败留下孤岛 → 重跳同一目标自愈"这条链在生产路径上是断的,而 store
 * 级回归绕过了这个入口、看不出问题。判定抽成纯函数后由本文件直接覆盖。
 *
 * feat B:窗口模型从 boolean(historyWindowHasIsland)升级为显式孤岛区间
 * (historyWindowIslands,每座孤岛 {oldestClientId, newestClientId})。"能否零成本
 * focus"只看目标是否落在**主连续段**(最后一个孤岛最新边界行之后的所有行)里:
 * 孤岛行与主段之间隔着没加载的历史,必须先交给 store 补齐。
 */

import { describe, it, expect } from 'vitest';
import {
  canFocusWithoutJumpLoad,
  mainContiguousRunStartIndex,
  isInsideMainContiguousRun,
  type LoadedWindowIsland,
} from '@/lib/searchJumpTargeting';

const windowWith = (ids: string[], islands?: LoadedWindowIsland[]) => ({
  messages: ids.map((clientId) => ({ clientId })),
  ...(islands === undefined ? {} : { historyWindowIslands: islands }),
});

describe('搜索跳转落点判定 — 主连续段', () => {
  it('无孤岛且目标在窗口里 → 直接 focus,不必再走 store', () => {
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c']), 'b')).toBe(true);
    // 显式空孤岛列表与缺省同义。
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b'], []), 'b')).toBe(true);
  });

  it('目标不在窗口里 → 必须走 store 加载', () => {
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b']), 'zzz')).toBe(false);
  });

  it('目标在孤岛上 → 即便在窗口里也要走 store,让补齐自愈', () => {
    // 关键回归:目标"在 messages 里"可能只是先前失败的深跳留下的孤立片段。
    expect(
      canFocusWithoutJumpLoad(
        windowWith(
          ['island-target'],
          [{ oldestClientId: 'island-target', newestClientId: 'island-target' }],
        ),
        'island-target',
      ),
    ).toBe(false);
  });

  it('目标在主段内(最后一座孤岛 newest 边界之后)→ 直接 focus', () => {
    const islands: LoadedWindowIsland[] = [{ oldestClientId: 'a', newestClientId: 'b' }];
    // 主段 = b 之后的所有行。
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c', 'd'], islands), 'c')).toBe(true);
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c', 'd'], islands), 'd')).toBe(true);
    // 孤岛上的行仍不直接 focus。
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c', 'd'], islands), 'a')).toBe(false);
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c', 'd'], islands), 'b')).toBe(false);
  });

  it('多孤岛时,目标落在两座孤岛之间 → 走 store;落在主段 → 直接 focus', () => {
    const islands: LoadedWindowIsland[] = [
      { oldestClientId: 'a', newestClientId: 'b' },
      { oldestClientId: 'd', newestClientId: 'e' },
    ];
    const window = windowWith(['a', 'b', 'c', 'd', 'e', 'f', 'g'], islands);
    // c 在 b 与 d 之间:是"b → 最新"这段历史里的洞,不得直接 focus。
    expect(canFocusWithoutJumpLoad(window, 'c')).toBe(false);
    expect(canFocusWithoutJumpLoad(window, 'd')).toBe(false);
    expect(canFocusWithoutJumpLoad(window, 'e')).toBe(false);
    // 主段 = e 之后。
    expect(canFocusWithoutJumpLoad(window, 'f')).toBe(true);
    expect(canFocusWithoutJumpLoad(window, 'g')).toBe(true);
  });

  it('孤岛边界行不在窗口里(模型被破坏)→ 保守整窗不连续,一律走 store', () => {
    // newest 边界行缺失:主段起点按"找不到边界"保守推到窗口末尾。
    expect(
      canFocusWithoutJumpLoad(
        windowWith(['x', 'y'], [{ oldestClientId: 'ghost', newestClientId: 'y' }]),
        'y',
      ),
    ).toBe(false);
    // oldest 边界行缺失同样保守。
    expect(
      canFocusWithoutJumpLoad(
        windowWith(['x', 'y'], [{ oldestClientId: 'x', newestClientId: 'ghost' }]),
        'x',
      ),
    ).toBe(false);
  });
});

describe('mainContiguousRunStartIndex', () => {
  it('无孤岛时整窗都是主段', () => {
    expect(mainContiguousRunStartIndex([{ clientId: 'a' }, { clientId: 'b' }], [])).toBe(0);
  });

  it('主段起点 = 最后一个孤岛 newest 边界行之后', () => {
    const messages = [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }];
    const islands: LoadedWindowIsland[] = [{ oldestClientId: 'a', newestClientId: 'b' }];
    expect(mainContiguousRunStartIndex(messages, islands)).toBe(2);
  });

  it('边界行缺失 → 主段为空(返回 messages.length)', () => {
    const messages = [{ clientId: 'a' }, { clientId: 'b' }];
    const islands: LoadedWindowIsland[] = [{ oldestClientId: 'a', newestClientId: 'nope' }];
    expect(mainContiguousRunStartIndex(messages, islands)).toBe(messages.length);
  });
});

describe('isInsideMainContiguousRun(与 canFocusWithoutJumpLoad 共用同一把尺子)', () => {
  it('目标在窗口外或下标早于主段起点 → false', () => {
    const islands: LoadedWindowIsland[] = [{ oldestClientId: 'a', newestClientId: 'b' }];
    expect(
      isInsideMainContiguousRun(
        [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }],
        islands,
        'c',
      ),
    ).toBe(true);
    expect(
      isInsideMainContiguousRun(
        [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }],
        islands,
        'b',
      ),
    ).toBe(false);
    expect(
      isInsideMainContiguousRun(
        [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }],
        islands,
        'zzz',
      ),
    ).toBe(false);
  });
});
