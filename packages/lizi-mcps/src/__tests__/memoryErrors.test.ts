/**
 * memory/errors.ts 回归 — issue #2341:
 * manager 的 owner 作用域守卫抛的 memory:not-ready 必须翻译成
 * MAKER_MEMORY_NOT_READY, 与「真空库返回 ok+[]」在响应层面可区分。
 */

import { MemoryError } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import { classifyMemoryError } from '../memory/errors.js';

describe('classifyMemoryError · owner not-ready (#2341)', () => {
  it('MemoryError("not-ready") → MAKER_MEMORY_NOT_READY', () => {
    const result = classifyMemoryError(
      new MemoryError('not-ready', 'owner scope unavailable; refusing ephemeral fallback'),
    );
    expect(result.code).toBe('MAKER_MEMORY_NOT_READY');
    expect(result.message).toMatch(/memory:not-ready/);
  });

  it('裸 Error 带 memory:not-ready 前缀 → MAKER_MEMORY_NOT_READY', () => {
    const result = classifyMemoryError(
      new Error('memory:not-ready owner scope unavailable (signed-out or auth not settled)'),
    );
    expect(result.code).toBe('MAKER_MEMORY_NOT_READY');
  });

  it('旧的 manager 状态错文案仍映射 NOT_READY (回归)', () => {
    expect(classifyMemoryError(new Error('manager not ready: ...')).code).toBe(
      'MAKER_MEMORY_NOT_READY',
    );
    expect(classifyMemoryError(new Error('maker memory disabled (mode != "maker")')).code).toBe(
      'MAKER_MEMORY_NOT_READY',
    );
  });

  it('其他 memory 错误码不受影响 (回归)', () => {
    expect(classifyMemoryError(new MemoryError('not-found', 'x')).code).toBe('NOT_FOUND');
    expect(classifyMemoryError(new MemoryError('already-exists', 'x')).code).toBe(
      'ALREADY_EXISTS',
    );
    expect(classifyMemoryError(new MemoryError('shard-too-large', 'x')).code).toBe(
      'INVALID_PARAMS',
    );
    expect(classifyMemoryError(new Error('boom')).code).toBe('INTERNAL');
  });
});
