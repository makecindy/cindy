import { describe, expect, it } from 'vitest';

import { createOneShotTicketStore } from '../oneShotTickets';

describe('oneShotTickets(inspect→confirm 的 owner/事实绑定载体)', () => {
  it('原子消费:一张票只能用一次,重放拿不到值', () => {
    const store = createOneShotTicketStore<{ id: string }>({ ttlMs: 1000, maxEntries: 4 });
    const token = store.issue({ id: 'hello' });
    expect(store.consume(token)).toEqual({ id: 'hello' });
    // 重放:同一 token 第二次消费必须失败 —— 否则 confirm 可被重复落盘。
    expect(store.consume(token)).toBeNull();
    expect(store.consume('not-a-token')).toBeNull();
  });

  it('过期票拿不到值(确认卡长时间停留后必须重新 inspect)', () => {
    let clock = 0;
    const store = createOneShotTicketStore<number>({ ttlMs: 100, maxEntries: 4, now: () => clock });
    const token = store.issue(42);
    clock = 99;
    const fresh = store.issue(43);
    clock = 100; // 第一张到期,第二张(99+100)未到期
    expect(store.consume(token)).toBeNull();
    expect(store.consume(fresh)).toBe(43);
  });

  it('超容量先驱逐最早签发的票,不无界增长', () => {
    const store = createOneShotTicketStore<number>({ ttlMs: 10_000, maxEntries: 2 });
    const first = store.issue(1);
    const second = store.issue(2);
    const third = store.issue(3); // 容量 2:签发第三张时驱逐第一张
    expect(store.consume(first)).toBeNull();
    expect(store.consume(second)).toBe(2);
    expect(store.consume(third)).toBe(3);
  });
});
