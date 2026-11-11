/**
 * memory/errors.ts + _shared.ts 回归 — issue #2341:
 * manager 的 owner 作用域守卫抛的 memory:not-ready 必须翻译成
 * MAKER_MEMORY_NOT_READY, 与「真空库返回 ok+[]」在响应层面可区分;
 * withStore 在 store 操作完成后复核 scope (review #2388 Codex 4th P1)。
 */

import { MemoryError, type MakerMemoryManager } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import { classifyMemoryError } from '../memory/errors.js';
import { withStore } from '../memory/_shared.js';
import type { MemoryMcpDeps } from '../types.js';

const mockStore = {
  write: async () => ({ ok: true as const, filename: 'x.md' }),
  list: async () => [],
  delete: async () => ({ ok: true as const }),
};

function depsWithManager(manager: Partial<MakerMemoryManager>): MemoryMcpDeps {
  return {
    getManager: () => manager as MakerMemoryManager,
    workdir: '/work',
  };
}

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

describe('withStore · 操作后 scope 复核 (review #2388 Codex 4th P1)', () => {
  it('fn 执行期间 owner 切换 → 返回 MAKER_MEMORY_NOT_READY, 不按成功返回', async () => {
    let scope = 'cloud:old:1';
    const manager: Partial<MakerMemoryManager> = {
      isEnabled: () => true,
      getStore: async () => mockStore as never,
      currentOwnerScopeKey: () => scope,
    };
    const deps = depsWithManager(manager);
    // fn 执行中模拟登出/切账号: scope 前进
    const result = await withStore(deps, async () => {
      scope = 'cloud:new:2';
      return mockStore.list();
    });
    expect((result.content[0] as { text?: string }).text ?? "").toContain('MAKER_MEMORY_NOT_READY');
    expect(result.isError).toBe(true);
  });

  it('scope 未变 → 正常返回 ok+data (回归)', async () => {
    const manager: Partial<MakerMemoryManager> = {
      isEnabled: () => true,
      getStore: async () => mockStore as never,
      currentOwnerScopeKey: () => 'cloud:abc:1',
    };
    const result = await withStore(depsWithManager(manager), async (s) => s.list());
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text?: string }).text ?? "").toContain('"ok": true');
  });

  it('manager 未提供 currentOwnerScopeKey (旧 host) → 不复核, 兼容', async () => {
    const manager: Partial<MakerMemoryManager> = {
      isEnabled: () => true,
      getStore: async () => mockStore as never,
    };
    const result = await withStore(depsWithManager(manager), async (s) => s.list());
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text?: string }).text ?? "").toContain('"ok": true');
  });
});
