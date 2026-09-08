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
import type { Schedule, CreateScheduleInput, UpdateScheduleInput } from '@cindy/maker-scheduler';
import { BUILTIN_TEMPLATES } from '@cindy/maker-scheduler';
import { applyTemplateToMobileScheduleDraft, buildMobileScheduleInput, createMobileScheduleDraft } from '@cindy/maker-shared/schedule-form';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((name, handler) => handlers.set(name, handler)) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    getPath: vi.fn(() => '/tmp/cindy-test-user-data'),
    getAppPath: vi.fn(() => '/tmp/cindy-test-app'),
    isPackaged: false,
  },
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('../../device-link/invoke-context.js', () => ({ isDeviceLinkInvoke: () => true }));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => null,
}));

import {
  normalizeLegacyDeviceLinkIntervalClear,
  normalizeLegacyDeviceLinkModelSelection,
  registerScheduleHandlers,
  setSchedulerReady,
  normalizeNullableIntervalMs,
} from '../schedule';

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

describe('normalizeLegacyDeviceLinkIntervalClear(旧版 mobile 的清空兼容)', () => {
  // 旧版 mobile 全量表单的 wire 形态:带 cronExpr / manual / notify,清空间隔时
  // 不带 intervalMs key(经 JSON 序列化被丢),靠旧引擎隐式清空表达语义。
  const legacyForm = {
    name: '巡检',
    cronExpr: '0 9 * * *',
    recurring: true,
    manual: false,
    notify: { desktop: true, feishu: false },
  };

  it('device-link 来源 + 旧全量表单缺 intervalMs key → 翻译成显式清空', () => {
    const out = normalizeLegacyDeviceLinkIntervalClear({ ...legacyForm }, true);
    expect(hasOwn(out, 'intervalMs')).toBe(true);
    expect(out.intervalMs).toBeUndefined();
  });

  it('非 device-link 来源的同形态 patch 原样透传(MCP / renderer 的真 partial 不受影响)', () => {
    const patch = { ...legacyForm };
    expect(normalizeLegacyDeviceLinkIntervalClear(patch, false)).toBe(patch);
  });

  it('新版 mobile 恒带 intervalMs key(数值或 null 归一化后的 undefined),不会命中兼容分支', () => {
    const withNumber = { ...legacyForm, intervalMs: 600_000 };
    expect(normalizeLegacyDeviceLinkIntervalClear(withNumber, true)).toBe(withNumber);

    const clearedByNull = normalizeLegacyDeviceLinkIntervalClear(
      normalizeNullableIntervalMs({ ...legacyForm, intervalMs: null }),
      true,
    );
    expect(hasOwn(clearedByNull, 'intervalMs')).toBe(true);
    expect(clearedByNull.intervalMs).toBeUndefined();
  });

  it('device-link 的非全量 partial(缺 manual/notify 标记)不被伪造成清空', () => {
    const partial = { cronExpr: '0 9 * * *' };
    expect(normalizeLegacyDeviceLinkIntervalClear(partial, true)).toBe(partial);
  });
});


describe('scheduled model selection IPC compatibility', () => {
  const existing = { id: 'bound-schedule', targetSessionId: 'bound', agentKind: 'codex',
    modelAgentKind: 'pi', model: 'pi-model', providerId: 'pi-source', effort: 'high', fastMode: true } as Schedule;
  const fullForm = { cronExpr: '0 9 * * *', manual: false, notify: { desktop: true, feishu: false },
    targetSessionId: 'bound', agentKind: 'codex', model: 'pi-model' } as UpdateScheduleInput;

  it('normalizes an old Mobile full form inside the update handler before partial merge', async () => {
    const updateFromCurrent = vi.fn(async (_id, update) => ({ ...existing, ...await update(existing) }));
    setSchedulerReady({ updateFromCurrent } as never, {} as never);
    registerScheduleHandlers();
    const wire = JSON.parse(JSON.stringify({ ...fullForm, model: 'codex-model' }));
    const result = await handlers.get('maker:schedule:update')!(null, existing.id, wire);
    expect(result).toMatchObject({ agentKind: 'codex', modelAgentKind: 'codex', model: 'codex-model', fastMode: false });
    expect(result).toHaveProperty('providerId', undefined);
    expect(result).toHaveProperty('effort', undefined);
    expect(updateFromCurrent).toHaveBeenCalledTimes(1);
    expect(existing).toMatchObject({ modelAgentKind: 'pi', providerId: 'pi-source', fastMode: true });
  });

  it('preserves an untouched old full form and genuine local/remote partial updates', () => {
    expect(normalizeLegacyDeviceLinkModelSelection(existing, fullForm, true)).toBe(fullForm);
    const partial = { model: 'other' };
    expect(normalizeLegacyDeviceLinkModelSelection(existing, partial, true)).toBe(partial);
    const local = { ...fullForm, model: 'other' };
    expect(normalizeLegacyDeviceLinkModelSelection(existing, local, false)).toBe(local);
    const modern = { ...fullForm, model: 'other', modelAgentKind: 'pi' as const };
    expect(normalizeLegacyDeviceLinkModelSelection(existing, modern, true)).toBe(modern);
  });

  it('clears the old explicit route when the old full form clears its model', () => {
    const wire = JSON.parse(JSON.stringify({ ...fullForm, model: undefined }));
    expect(normalizeLegacyDeviceLinkModelSelection(existing, wire, true)).toMatchObject({
      modelAgentKind: undefined, model: undefined, providerId: undefined, effort: undefined, fastMode: false,
    });
  });

  it.each([true, false])('passes a Mobile template choice and Fast=%s through the real creation handler', async (fastMode) => {
    const template = BUILTIN_TEMPLATES[0]!;
    const draft = applyTemplateToMobileScheduleDraft(createMobileScheduleDraft(), {
      ...template, agentKind: 'pi', model: 'pi-model', providerId: 'pi-source', fastMode: true,
      useWorktree: false,
    });
    const input = buildMobileScheduleInput({ ...draft, targetSessionId: 'bound', effort: 'high', fastMode });
    const create = vi.fn(async (input: CreateScheduleInput) => input);
    setSchedulerReady({ create } as never, {} as never);
    registerScheduleHandlers();
    const wire = JSON.parse(JSON.stringify({ templateId: template.id, overrides: input }));
    await handlers.get('maker:schedule:create-from-template')!(null, wire);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'bound', agentKind: 'pi', modelAgentKind: 'pi', model: 'pi-model',
      providerId: 'pi-source', effort: 'high', fastMode,
    }));
  });
});
