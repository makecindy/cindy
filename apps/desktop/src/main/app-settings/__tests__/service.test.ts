import { registerRuntimeSettingsSection, runtimeSettingsSections } from '../runtime';
import { registerAppSettingsTools } from '../../../../../../packages/lizi-mcps/src/xdt-helper/app_settings';
import { XdtHelperToolRegistry } from '../../../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAppSettingsService } from '../service';
import {
  createMemorySettingsSection,
  updateMakerMemorySettings,
} from '../memory';
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

// #8930, unit: production section -> runtime registry -> real Desktop service ->
// registered MCP handler. Old tests stubbed section.update/settings.call and missed
// the throwing guard and wrapped result. Minimal failure: all-off then all-on.
// In-memory persistence/restart ports; no Electron boot or user settings writes.
function memoryEntry() {
  let value = { maker: true, claudeCode: true, codex: true, pi: true };
  let enabled = true;
  const wire = () => ({ value: { ...value }, defaults: { maker: true, claudeCode: true, codex: true, pi: true },
    isCustomized: true, customizedKeys: Object.keys(value) as Array<keyof typeof value> });
  const write = vi.fn((key: keyof typeof value, next: boolean) => { value = { ...value, [key]: next }; return wire(); });
  const prepare = vi.fn(async () => {});
  const setAgentMemory = vi.fn(async () => {});
  const manager = { isEnabled: () => enabled, enable: async () => { enabled = true; return { effective: 'next-session' as const }; },
    disable: async () => { enabled = false; return { effective: 'next-session' as const }; }, syncNativeAgentsOff: async () => [] };
  const maker = { makerMemory: manager, setAgentMemory };
  const read = vi.fn(wire);
  registerRuntimeSettingsSection(createMemorySettingsSection({
    read, readState: wire, isMakerEnabled: () => enabled,
    updateMaker: (next, patch) => updateMakerMemorySettings(next as boolean, patch, {
      makerMemory: manager, maker, writeMemorySetting: write,
      applyChange: parts => runMemoryChangeWithCodexRestart({ prepare, finalize: async () => {}, cancel: () => {},
        clearDeferredRestart: () => {}, scheduleDeferredRestart: () => {} }, parts), invalidateBridge: async () => {},
    }),
    updateNative: () => { throw new Error('Unexpected native-only update'); },
    reset: () => { throw new Error('Unexpected reset'); },
  }));
  const section = runtimeSettingsSections().find(item => item.id === 'memory')!;
  const service = createAppSettingsService([section]);
  const guard = vi.fn(async () => {});
  const registry = new XdtHelperToolRegistry();
  registerAppSettingsTools(registry, { call: input => service(input, guard) },
    () => ({ agentKind: 'codex', sessionId: 'memory-entry-test', workingDir: '/fixture' }));
  const call = async (patch: Record<string, unknown>) => {
    const result = await registry.call('update_app_settings', { section: 'memory', patch });
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return { call, guard, write, prepare, setAgentMemory, wire, read };
}

describe('registered memory settings through Desktop service and MCP', () => {
  it('returns the real wrapped conflict without writes or restart, preserving maker/Pi', async () => {
    const entry = memoryEntry();
    expect(await entry.call({ maker: false, claudeCode: false, codex: false, pi: false })).toMatchObject({ ok: true });
    entry.write.mockClear(); entry.prepare.mockClear(); entry.setAgentMemory.mockClear();
    expect(await entry.call({ maker: true, claudeCode: true, codex: true, pi: true })).toMatchObject({
      ok: false, errorCode: 'MEMORY_SETTINGS_CONFLICT', data: {
        hint: expect.stringContaining('maker'), result: { conflictingFields: ['claudeCode', 'codex'], requires: { maker: false } },
      },
    });
    expect(entry.wire().value).toEqual({ maker: false, claudeCode: false, codex: false, pi: false });
    expect(entry.write).not.toHaveBeenCalled(); expect(entry.prepare).not.toHaveBeenCalled();
    expect(entry.setAgentMemory).not.toHaveBeenCalled();
    expect(await entry.call({ maker: true, pi: true })).toMatchObject({ ok: true,
      state: { value: { maker: true, pi: true, claudeCode: false, codex: false } } });
    for (const patch of [{ codex: true }, { claudeCode: false }]) {
      expect(await entry.call(patch)).toMatchObject({ ok: false, errorCode: 'MEMORY_SETTINGS_CONFLICT',
        data: { result: { conflictingFields: Object.keys(patch), requires: { maker: false } } } });
    }
    expect(await entry.call({ maker: true })).toMatchObject({ ok: true });
    expect(await entry.call({ unknown: true })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('keeps revoked, partial-write and readback failures generic without exposing thrown details', async () => {
    const revoked = memoryEntry();
    revoked.guard.mockRejectedValue(new Error('secret revoked detail'));
    expect(await revoked.call({ maker: true, codex: true })).toMatchObject({ ok: false, errorCode: 'SETTINGS_OPERATION_FAILED' });
    expect(revoked.write).not.toHaveBeenCalled();
    const partial = memoryEntry();
    const persist = partial.write.getMockImplementation()!;
    partial.write.mockImplementationOnce(persist).mockImplementationOnce(() => { throw new Error('secret persistence detail'); });
    const failed = await partial.call({ maker: false, codex: false });
    expect(failed).toMatchObject({ ok: false, errorCode: 'SETTINGS_OPERATION_FAILED' });
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(partial.wire().value).toMatchObject({ maker: true, codex: false });
    const readback = memoryEntry();
    readback.read.mockImplementation(() => { throw new Error('secret readback detail'); });
    expect(await readback.call({ maker: false })).toMatchObject({ ok: false, errorCode: 'SETTINGS_OPERATION_FAILED' });
    expect(readback.wire().value.maker).toBe(false);
    const late = memoryEntry();
    late.guard.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked after update'));
    expect(await late.call({ maker: false })).toMatchObject({ ok: false, errorCode: 'SETTINGS_OPERATION_FAILED' });
  });
});

// Unit: a settings save based on an earlier read is checked before memory is persisted.
describe('memory settings saved from an earlier read', () => {
  const stale = { assertUnchanged: () => { throw new Error('CONFLICT'); } };
  it('persists nothing for the Cindy memory switch once the read is out of date', async () => {
    const writeMemorySetting = vi.fn();
    const applyChange = vi.fn(async (parts: { persist: () => Promise<object> }) => ({ ...await parts.persist(), codexRestartDeferred: false }));
    await expect(updateMakerMemorySettings(false, {}, {
      makerMemory: { isEnabled: () => true, enable: vi.fn(), disable: vi.fn(), syncNativeAgentsOff: vi.fn() },
      maker: { setAgentMemory: vi.fn() }, writeMemorySetting, applyChange: applyChange as never, invalidateBridge: vi.fn(),
    }, stale)).rejects.toThrow('CONFLICT');
    expect(writeMemorySetting).not.toHaveBeenCalled();
  });
  it('checks only the first engine write, which the read covers', async () => {
    const value = { maker: false, claudeCode: true, codex: true, pi: true };
    const updateNative = vi.fn(async (kind: 'claude-code' | 'codex' | 'pi', next: unknown) => { value[kind === 'claude-code' ? 'claudeCode' : kind] = next as boolean; });
    const section = createMemorySettingsSection({ read: () => ({}), readState: () => ({ value }), isMakerEnabled: () => false,
      updateMaker: vi.fn(), updateNative, reset: vi.fn() });
    const guard = { assertUnchanged: vi.fn() };
    await section.update({ claudeCode: false, pi: false }, guard);
    expect(updateNative.mock.calls).toEqual([['claude-code', false, guard], ['pi', false, undefined]]);
  });
});
