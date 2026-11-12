/**
 * 远程 Agent 草稿:切到别的模型再切回来时,还原本机为那台电脑记的该模型档位 / Fast,
 * 而不是落回目录默认。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
}

beforeEach(() => {
  const storage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
});

async function loadModules() {
  const draftMemory = await import('../agentDeviceDraftMemory');
  const modelMemory = await import('@/state/agentDeviceModelMemory');
  const { resolveDeviceLinkDraftDefaults } = await import('../deviceLinkDraftDefaults');
  return { ...draftMemory, ...modelMemory, resolveDeviceLinkDraftDefaults };
}

function caps(): AgentCapabilities {
  return {
    availableModels: [
      {
        id: 'claude-opus-5',
        displayName: 'Opus 5',
        contextWindow: 1_000_000,
        efforts: ['high', 'xhigh'],
        defaultEffort: 'high',
        supportsFastMode: true,
      },
      {
        id: 'claude-sonnet-5',
        displayName: 'Sonnet 5',
        contextWindow: 1_000_000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        supportsFastMode: false,
      },
    ],
    hasFastMode: true,
    effortLevels: [
      { id: 'low', displayName: 'Low' },
      { id: 'high', displayName: 'High' },
      { id: 'xhigh', displayName: 'X-High' },
    ],
    permissionModes: [{ id: 'acceptEdits', displayName: 'Accept edits' }],
  };
}

describe('agentDeviceDraftMemory', () => {
  it('还没选过这台电脑 → null(由目录默认播种)', async () => {
    const m = await loadModules();
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    expect(m.recallAgentDeviceSelection('dev-a', 'claude-code')).toBeNull();
  });

  it('取回上一次选择时带上这台电脑的每模型档位', async () => {
    const m = await loadModules();
    m.setAgentDeviceModelEffort('dev-a', 'claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    m.rememberAgentDeviceSelection('dev-a', 'claude-code', {
      model: 'claude-sonnet-5',
      effort: 'low',
      fastMode: false,
      providerId: 'anthropic',
    });
    const recalled = m.recallAgentDeviceSelection('dev-a', 'claude-code');
    expect(recalled?.model).toBe('claude-sonnet-5');
    expect(recalled?.providerModelMemory?.['claude-code:anthropic']?.effortByModel).toEqual({
      'claude-opus-5': 'xhigh',
    });
    // 别的电脑不带这份记忆。
    m.rememberAgentDeviceSelection('dev-b', 'claude-code', {
      model: 'claude-sonnet-5',
      effort: 'low',
      fastMode: false,
      providerId: 'anthropic',
    });
    expect(m.recallAgentDeviceSelection('dev-b', 'claude-code')?.providerModelMemory).toBeUndefined();
  });

  it('A 设 xhigh+Fast → 切到 B → 切回 A:还原 xhigh 与 Fast,而不是默认 high', async () => {
    const m = await loadModules();
    // 在 A 上调档(ChatInput 经读写器写进这台电脑的记忆)。
    const memory = m.agentDeviceModelMemoryAccessors('dev-a');
    memory.setChoice?.('claude-code', 'anthropic', 'claude-opus-5', 'xhigh');
    memory.setFast('claude-code', 'anthropic', 'claude-opus-5', true);
    // 切到 B 后,「上一次选择」只剩 B。
    m.rememberAgentDeviceSelection('dev-a', 'claude-code', {
      model: 'claude-sonnet-5',
      effort: 'low',
      fastMode: false,
      providerId: 'anthropic',
    });

    const back = m.resolveDeviceLinkDraftDefaults(
      caps(),
      m.recallAgentDeviceSelection('dev-a', 'claude-code'),
      'claude-opus-5',
      'claude-code',
    );
    expect(back.model).toBe('claude-opus-5');
    expect(back.effort).toBe('xhigh');
    expect(back.fastMode).toBe(true);
  });

  it('切回从没调过档的模型 → 仍是目录默认', async () => {
    const m = await loadModules();
    m.rememberAgentDeviceSelection('dev-a', 'claude-code', {
      model: 'claude-sonnet-5',
      effort: 'low',
      fastMode: false,
      providerId: 'anthropic',
    });
    const back = m.resolveDeviceLinkDraftDefaults(
      caps(),
      m.recallAgentDeviceSelection('dev-a', 'claude-code'),
      'claude-opus-5',
      'claude-code',
    );
    expect(back.effort).toBe('high');
    expect(back.fastMode).toBe(false);
  });
});
