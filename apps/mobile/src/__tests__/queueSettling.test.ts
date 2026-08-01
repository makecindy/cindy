/**
 * 落定中判定的纯函数测试。
 *
 * 这份判定原来内联在会话页的 layout effect 里,只能事后 setState 补气泡——那要多走一次
 * render 才落地,队列减少的同一帧屏幕上就没有气泡了(实测 trace:queue=0 settling=0 先
 * 亮一帧,新建会话必然命中)。抽成纯函数后 render 阶段与 effect 共用同一份判据,这里锁住
 * 判据本身,防止两边漂移。
 */
import { describe, expect, it } from 'vitest';
import { computeVanishedQueueItems, mergeSettlingItems } from '@/session/queueSettling';

const NO_IDS: ReadonlySet<string> = new Set();

function item(clientId: string) {
  return { clientId };
}

function build(overrides: Partial<Parameters<typeof computeVanishedQueueItems>[0]> = {}) {
  return {
    previous: [],
    current: [],
    previousSteeringClientIds: NO_IDS,
    currentSteeringClientIds: NO_IDS,
    hiddenClientIds: NO_IDS,
    locallyRemovedClientIds: NO_IDS,
    ...overrides,
  };
}

describe('computeVanishedQueueItems', () => {
  it('treats the vanished head prefix as settling (drain 恒从队首连续消费)', () => {
    const vanished = computeVanishedQueueItems(build({
      previous: [item('a'), item('b'), item('c')],
      current: [item('c')],
    }));
    expect(vanished.map((entry) => entry.clientId)).toEqual(['a', 'b']);
  });

  it('ignores mid-queue removals (远端取消,不渲染转圈幽灵)', () => {
    const vanished = computeVanishedQueueItems(build({
      previous: [item('a'), item('b'), item('c')],
      current: [item('a'), item('c')],
    }));
    expect(vanished).toEqual([]);
  });

  it('keeps steered items even when they are not the head prefix', () => {
    const vanished = computeVanishedQueueItems(build({
      previous: [item('a'), item('b'), item('c')],
      current: [item('a'), item('c')],
      previousSteeringClientIds: new Set(['b']),
    }));
    expect(vanished.map((entry) => entry.clientId)).toEqual(['b']);
  });

  it('excludes items whose real message already landed, and locally removed ones', () => {
    expect(computeVanishedQueueItems(build({
      previous: [item('a')],
      current: [],
      hiddenClientIds: new Set(['a']),
    }))).toEqual([]);
    expect(computeVanishedQueueItems(build({
      previous: [item('a')],
      current: [],
      locallyRemovedClientIds: new Set(['a']),
    }))).toEqual([]);
  });

  it('covers the new-session case: the only queued message gets drained', () => {
    const vanished = computeVanishedQueueItems(build({
      previous: [item('first')],
      current: [],
    }));
    expect(vanished.map((entry) => entry.clientId)).toEqual(['first']);
  });
});

describe('mergeSettlingItems', () => {
  it('returns the settled list untouched when nothing was derived', () => {
    const settled = [item('a')];
    expect(mergeSettlingItems(settled, [])).toBe(settled);
  });

  it('appends only clientIds the settled list does not already carry', () => {
    const settled = [item('a')];
    expect(mergeSettlingItems(settled, [item('a')])).toBe(settled);
    expect(mergeSettlingItems(settled, [item('b')]).map((entry) => entry.clientId))
      .toEqual(['a', 'b']);
  });
});
