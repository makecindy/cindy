// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedModelEntry } from '@cindy/model-providers';
import { useUnifiedRowActions, type UnifiedRowActionsOptions } from '@/components/new-chat/useUnifiedRowActions';
import { resolveUnifiedRowConfig } from '@/components/new-chat/unifiedModelSelection';
import * as engines from '@/state/modelEnginePrefs';
import * as memory from '@/state/providerModelMemory';

const raw = (id: string): UnifiedModelEntry => ({ providerId: 'fixture', modelId: id, displayName: id,
  candidates: ['codex'], recommended: 'codex', nativeAgent: null, capabilities: {
    codex: { agent: 'codex', wireModelId: id, efforts: ['low', 'high'], defaultEffort: 'high',
      defaultEffortSource: 'catalog', supportsFastMode: true, contextWindow: 100_000, contextWindowVerified: false },
  } });
const entry = { ...raw('flash'), aliasEntries: [raw('flash'), raw('flash-old')] };
const config = resolveUnifiedRowConfig({ entry });
const anchor = { kind: 'model' as const, providerId: 'fixture', modelId: 'flash' };
const options = (over: Partial<UnifiedRowActionsOptions> = {}): UnifiedRowActionsOptions => ({
  interactionDisabled: false, isLiveRow: () => false, onSelect: vi.fn(),
  modelMemory: { getEffort: memory.getProviderModelEffort, setEffort: memory.setProviderModelEffort,
    getFast: memory.getProviderModelFast, setFast: memory.setProviderModelFast,
    clearEffort: memory.clearProviderModelEffort, clearFast: memory.clearProviderModelFast,
    editMany: memory.editProviderModelMemoryBatch },
  onFavoriteFlash: vi.fn(), onBeforeRemoveFavorite: vi.fn(), ...over,
});
beforeEach(() => { localStorage.clear(); engines.__resetForTest(); memory.__resetForTest(); });
afterEach(cleanup);

describe('alias edits through the actual row action hook', () => {
  it('writes engine, effort and explicit Fast=false to both real IDs', async () => {
    const { result } = renderHook(() => useUnifiedRowActions(options()));
    await act(async () => {
      await result.current.applyEngine(anchor, entry, config, 'codex');
      await result.current.applyEffort(anchor, entry, config, 'low');
      await result.current.applyFast(anchor, entry, config, false);
    });
    for (const id of ['flash', 'flash-old']) {
      expect(engines.getModelEngineOverride('fixture', id)).toBe('codex');
      expect(memory.getProviderModelEffort('codex', 'fixture', id)).toBe('low');
      expect(memory.getProviderModelFast('codex', 'fixture', id)).toBe(false);
    }
  });
  it('does not write other alias memories if the live operation fails', async () => {
    const live = vi.fn(async () => false);
    const { result } = renderHook(() => useUnifiedRowActions(options({ isLiveRow: () => true, onEffortChangeLive: live })));
    await act(async () => { expect(await result.current.applyEffort(anchor, entry, config, 'low')).toBe(false); });
    expect(live).toHaveBeenCalledOnce();
    expect(memory.getProviderModelEffort('codex', 'fixture', 'flash-old')).toBeUndefined();
  });
  it('checks the owner again after awaiting a live write', async () => {
    let finish!: (value: boolean) => void;
    const live = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useUnifiedRowActions(options({ isLiveRow: () => true, onFastModeChangeLive: live })));
    let action: ReturnType<typeof result.current.applyFast>;
    act(() => { action = result.current.applyFast(anchor, entry, config, true); });
    memory.setProviderModelMemoryOwner('another-owner');
    await act(async () => { finish(true); expect(await action).toBe(false); });
    expect(memory.getProviderModelFast('codex', 'fixture', 'flash-old')).toBeUndefined();
  });
  it('resets all aliases without clearing a different engine or model', async () => {
    const { result } = renderHook(() => useUnifiedRowActions(options()));
    engines.setModelEngineOverride('fixture', 'flash-old', 'codex');
    for (const id of ['flash', 'flash-old']) {
      memory.setProviderModelEffort('codex', 'fixture', id, 'low');
      memory.setProviderModelFast('codex', 'fixture', id, false);
    }
    memory.setProviderModelEffort('pi', 'fixture', 'flash-old', 'low');
    memory.setProviderModelEffort('codex', 'fixture', 'unrelated', 'low');
    await act(async () => { await result.current.resetToRecommended(anchor, entry, config); });
    for (const id of ['flash', 'flash-old']) {
      expect(engines.getModelEngineOverride('fixture', id)).toBeUndefined();
      expect(memory.getProviderModelEffort('codex', 'fixture', id)).toBeUndefined();
      expect(memory.getProviderModelFast('codex', 'fixture', id)).toBeUndefined();
    }
    expect(memory.getProviderModelEffort('pi', 'fixture', 'flash-old')).toBe('low');
    expect(memory.getProviderModelEffort('codex', 'fixture', 'unrelated')).toBe('low');
  });
});
