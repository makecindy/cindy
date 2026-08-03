/**
 * schedule IPC 的 device-link JSON 边界翻译。
 *
 * Mobile 清空 intervalMs 只能用可序列化的 null 表达(device-link 经
 * JSON.stringify,值为 undefined 的 key 会被丢掉),而引擎契约是
 * 「带 key 的 undefined = 显式清空;省略 key = 不修改」。desktop IPC 入口的
 * normalizeNullableIntervalMs 负责这一步翻译:null → 带 key 的 undefined,
 * 数值与省略 key 两种形态原样透传。
 *
 * electron mock 头与 scheduleReadiness.test.ts 相同(import '../schedule'
 * 的模块链需要这三个 mock 才能 collect)。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    getPath: vi.fn(() => '/tmp/cindy-test-user-data'),
    getAppPath: vi.fn(() => '/tmp/cindy-test-app'),
    isPackaged: false,
  },
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => null,
}));

import { normalizeNullableIntervalMs } from '../schedule';

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

describe('normalizeNullableIntervalMs(device-link JSON 边界)', () => {
  it('null 翻译成带 key 的 undefined(引擎的显式清空表达)', () => {
    const out = normalizeNullableIntervalMs({ cronExpr: '0 9 * * *', intervalMs: null });
    expect(hasOwn(out, 'intervalMs')).toBe(true);
    expect(out.intervalMs).toBeUndefined();
    expect(out.cronExpr).toBe('0 9 * * *');
  });

  it('数值原样透传(同一对象,不额外拷贝)', () => {
    const patch = { intervalMs: 600_000 };
    expect(normalizeNullableIntervalMs(patch)).toBe(patch);
  });

  it('省略 key 原样透传,不会被伪造成清空', () => {
    const patch: { prompt: string; intervalMs?: number | null } = { prompt: 'p' };
    const out = normalizeNullableIntervalMs(patch);
    expect(out).toBe(patch);
    expect(hasOwn(out, 'intervalMs')).toBe(false);
  });

  it('mobile 清空 patch 走完 JSON round-trip 后仍能翻译成清空表达', () => {
    // 模拟 device-link 真实线上形态:mobile 发 null → JSON.stringify/parse →
    // desktop 归一化。这条链任何一环丢 key,清空间隔就静默失效。
    const wire = JSON.parse(
      JSON.stringify({ cronExpr: '*/10 * * * *', recurring: true, intervalMs: null }),
    ) as { cronExpr: string; recurring: boolean; intervalMs?: number | null };
    expect(hasOwn(wire, 'intervalMs')).toBe(true);

    const out = normalizeNullableIntervalMs(wire);
    expect(hasOwn(out, 'intervalMs')).toBe(true);
    expect(out.intervalMs).toBeUndefined();
  });
});
