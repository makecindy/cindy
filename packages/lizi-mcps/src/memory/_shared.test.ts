import { describe, expect, it } from 'vitest';

import { shardNameSchema } from './_shared.js';

describe('shardNameSchema', () => {
  it('裸 slug 受 storage 上限约束，索引文件名可带 type 前缀与 .md', () => {
    expect(shardNameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(shardNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(shardNameSchema.safeParse(`project_${'a'.repeat(64)}.md`).success).toBe(true);
    expect(shardNameSchema.safeParse(`project_${'a'.repeat(65)}`).success).toBe(false);
  });
});
