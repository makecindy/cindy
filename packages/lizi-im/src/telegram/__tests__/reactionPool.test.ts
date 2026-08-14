import { describe, expect, it } from 'vitest';

import {
  EXPRESSIVE_DONE_POOL,
  EXPRESSIVE_ERROR_POOL,
  pickExpressiveReaction,
} from '../reactionPool.js';

describe('expressive reaction pools', () => {
  it('池规模为 35(正) + 10(负)', () => {
    expect(EXPRESSIVE_DONE_POOL).toHaveLength(35);
    expect(EXPRESSIVE_ERROR_POOL).toHaveLength(10);
  });

  it('正/负池不相交(成功不会随机出负向表情)', () => {
    const neg = new Set<string>(EXPRESSIVE_ERROR_POOL);
    for (const e of EXPRESSIVE_DONE_POOL) expect(neg.has(e)).toBe(false);
  });

  it('基础款仍在各自池首位(回落安全)', () => {
    expect(EXPRESSIVE_DONE_POOL[0]).toBe('👍');
    expect(EXPRESSIVE_ERROR_POOL[0]).toBe('👎');
  });

  it('pickExpressiveReaction 按注入 random 确定取值', () => {
    expect(pickExpressiveReaction(EXPRESSIVE_DONE_POOL, () => 0)).toBe('👍');
    expect(pickExpressiveReaction(EXPRESSIVE_ERROR_POOL, () => 0)).toBe('👎');
    // random 接近 1 时取末位
    expect(pickExpressiveReaction(EXPRESSIVE_DONE_POOL, () => 0.999)).toBe(
      EXPRESSIVE_DONE_POOL[EXPRESSIVE_DONE_POOL.length - 1],
    );
  });
});
