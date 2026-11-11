import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAppSettingsService } from '../service';
import { updateMakerMemorySettings } from '../memory';
import { runMemoryChangeWithCodexRestart } from '../../maker-ipc/deferredCodexRestart';
import { CodexCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';

// Unit: settings tools must retain unspecified overrides, reject unknown fields,
// and recheck caller authority before committing. The previous UI-only surface
// had no reusable domain contract to exercise these conditions.
describe('app settings service', () => {
  it('discovers fields, preserves unrelated settings and reads committed state after reset', async () => {
    let value = { font: 14, animation: true };
    const update = vi.fn((patch: Record<string, unknown>) => { value = { ...value, ...patch }; return { effective: 'next-session' }; });
    const service = createAppSettingsService([{ id: 'test', title: '外观', description: '字体', effective: 'immediate',
      schema: z.strictObject({ font: z.number().min(10).optional(), animation: z.boolean().optional() }),
      read: () => value, update, reset: () => { value = { font: 14, animation: true }; } }]);
    const guard = vi.fn(async () => {});
    expect(await service({ operation: 'list', query: '字体' }, guard)).toMatchObject({ sections: [{ id: 'test', operations: ['get', 'update', 'reset'] }] });
    expect(await service({ operation: 'update', section: 'test', patch: { font: 18 } }, guard)).toMatchObject({ state: { font: 18, animation: true }, result: { effective: 'next-session' } });
    for (const patch of [{}, { typo: true }, { font: 2 }]) expect(await service({ operation: 'update', section: 'test', patch }, guard)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(await service({ operation: 'reset', section: 'test' }, guard)).toMatchObject({ state: { font: 14, animation: true } });
  });
  it('rejects revoked calls before writes and does not claim success after a persistence failure', async () => {
    const update = vi.fn(() => { throw new Error('disk unavailable'); });
    const service = createAppSettingsService([{ id: 'test', title: 'test', description: '', effective: 'immediate',
      schema: z.strictObject({ enabled: z.boolean() }), read: () => ({}), update }]);
    const guard = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked'));
    await expect(service({ operation: 'update', section: 'test', patch: { enabled: true } }, guard)).rejects.toThrow('revoked');
    expect(update).not.toHaveBeenCalled();
    await expect(service({ operation: 'update', section: 'test', patch: { enabled: true } }, async () => {})).rejects.toThrow('disk unavailable');
    expect(await service({ operation: 'reset', section: 'test' }, async () => {})).toMatchObject({ ok: false, errorCode: 'RESET_NOT_SUPPORTED' });
  });
});

// R1 P1: a combined maker:false/codex:false patch must not hot-update a busy
// host or later restore its previous codex:true snapshot. The generic service
// tests above cannot exercise the native persistence/idle-boundary callback.
// Unit: production memory updater + real restart executor, in-memory settings.
describe('combined memory settings', () => {
  it.each([false, true])('keeps the final native flags when Codex busy=%s', async busy => {
    let value = { maker: true, claudeCode: true, codex: true, pi: true };
    let enabled = true;
    const live = { claudeCode: true, codex: true, pi: true };
    let pending: (() => Promise<void>) | undefined;
    const setAgentMemory = vi.fn(async (kind: 'claude-code' | 'codex' | 'pi', next: boolean) => {
      live[kind === 'claude-code' ? 'claudeCode' : kind] = next;
    });
    const defaults = { ...value };
    const result = await updateMakerMemorySettings(false, { codex: false, claudeCode: false, pi: false }, {
      makerMemory: {
        isEnabled: () => enabled,
        enable: async () => { enabled = true; return { effective: 'next-session' }; },
        disable: async () => { enabled = false; return { effective: 'next-session' }; },
        syncNativeAgentsOff: async () => [],
      },
      maker: { setAgentMemory },
      writeMemorySetting: (key, next) => {
        value = { ...value, [key]: next };
        return { value: { ...value }, defaults, isCustomized: true, customizedKeys: Object.keys(value) as Array<keyof typeof value> };
      },
      applyChange: parts => runMemoryChangeWithCodexRestart({
        prepare: async () => { if (busy) throw new CodexCredentialModeSwitchBusyError(['running']); },
        finalize: async () => {}, cancel: () => {}, clearDeferredRestart: () => {},
        scheduleDeferredRestart: (_reason, applyRuntime) => { pending = applyRuntime; },
      }, parts),
      invalidateBridge: async () => {},
    });
    expect(result.codexRestartDeferred).toBe(busy);
    expect(value).toEqual({ maker: false, claudeCode: false, codex: false, pi: false });
    expect(live.claudeCode).toBe(false);
    expect(live.pi).toBe(false);
    if (busy) {
      expect(setAgentMemory.mock.calls.some(([kind]) => kind === 'codex')).toBe(false);
      expect(pending).toBeTypeOf('function');
      await pending!();
    }
    expect(live).toEqual({ claudeCode: false, codex: false, pi: false });
    expect(setAgentMemory.mock.calls.filter(([kind]) => kind === 'codex')).toEqual([['codex', false]]);
  });
});
