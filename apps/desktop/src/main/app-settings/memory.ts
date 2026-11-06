import type { MakerMemoryManager } from '@cindy/maker-core';
import type { MemorySettings, writeMemorySetting } from '../maker-host/memory-settings-store.js';
import type { MemoryChangeParts } from '../maker-ipc/deferredCodexRestart.js';

export type NativeMemoryPatch = Partial<Omit<MemorySettings, 'maker'>>;
interface Deps {
  makerMemory: Pick<MakerMemoryManager, 'isEnabled' | 'enable' | 'disable' | 'syncNativeAgentsOff'>;
  maker: { setAgentMemory(kind: 'claude-code' | 'codex' | 'pi', enabled: boolean): Promise<unknown> };
  writeMemorySetting: typeof writeMemorySetting;
  applyChange<T extends object>(parts: MemoryChangeParts<T>): Promise<T & { codexRestartDeferred: boolean }>;
  invalidateBridge(reason: string): Promise<void>;
}

/** One persisted native-memory intent and one Codex idle-boundary callback. */
export async function updateMakerMemorySettings(enabled: boolean, nativePatch: NativeMemoryPatch, deps: Deps) {
  const { makerMemory, maker, writeMemorySetting } = deps;
  const wasEnabled = makerMemory.isEnabled();
  let persistedSettings: MemorySettings | null = null;
  return deps.applyChange({
    persist: async () => {
      // Save the native fields from this same request before capturing the
      // maker toggle's runtime callback. Never push Codex mid-turn here.
      for (const key of ['claudeCode', 'codex', 'pi'] as const) {
        if (nativePatch[key] !== undefined) writeMemorySetting(key, nativePatch[key]);
      }
      // Persist before changing the manager. A failed maker:false write must reject the toggle
      // instead of presenting an opt-out that silently disappears after restart.
      const settingsState = writeMemorySetting('maker', enabled, { preserveDefault: enabled });
      persistedSettings = settingsState.value;
      const result = enabled
        ? await makerMemory.enable({ skipAgentSync: true })
        : await makerMemory.disable();
      // Claude 的原生覆盖立即应用(纯内存,不碰 busy 的 Codex host)——
      // 延迟路径下新建 Claude 会话也要立刻符合最新设置(review P1 2026-07-23)。
      if (enabled) {
        await makerMemory.syncNativeAgentsOff(['claude-code']);
      } else if (!settingsState.value.maker) {
        await maker.setAgentMemory('claude-code', settingsState.value.claudeCode);
      }
      if (nativePatch.pi !== undefined) {
        await maker.setAgentMemory('pi', settingsState.value.pi);
      }
      return {
        ...result,
        isCustomized: settingsState.isCustomized,
        customizedKeys: settingsState.customizedKeys,
        defaults: settingsState.defaults,
      };
    },
    applyRuntime: async () => {
      if (enabled) {
        await makerMemory.syncNativeAgentsOff(['codex']);
      } else if (persistedSettings && !persistedSettings.maker) {
        await maker.setAgentMemory('codex', persistedSettings.codex);
      }
      // 开关翻转 ⇒ 重建 codex bridge, 理由与约束见
      // shutdownAgentMcpEnvironmentsBestEffort 文档 (review R1 P2)。
      if (wasEnabled !== enabled) {
        await deps.invalidateBridge('maker-memory toggle');
      }
    },
  });
}
