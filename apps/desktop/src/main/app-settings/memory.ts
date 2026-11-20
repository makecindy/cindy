import type { MakerMemoryManager } from '@cindy/maker-core';
import { z } from 'zod';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { AppSettingsSection } from './service.js';
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

interface MemorySectionDeps {
  read(): object;
  readState(): { value: MemorySettings };
  isMakerEnabled(): boolean | null;
  updateMaker(enabled: unknown, patch: NativeMemoryPatch): Promise<unknown>;
  updateNative(kind: 'claude-code' | 'codex' | 'pi', enabled: unknown): Promise<unknown>;
  reset(): Promise<unknown>;
}

/** The production settings entry; adapters inject the existing initialized runtime. */
export function createMemorySettingsSection(deps: MemorySectionDeps): AppSettingsSection {
  return {
    id: 'memory', title: '记忆开关', description: 'Cindy 记忆和各引擎记忆的开关。恢复默认只恢复开关，不删除已有记忆。',
    effective: 'immediate-or-when-idle',
    schema: z.strictObject({ maker: z.boolean().optional(), claudeCode: z.boolean().optional(),
      codex: z.boolean().optional(), pi: z.boolean().optional() }),
    read: () => ({ ...deps.read(), runtime: { maker: deps.isMakerEnabled() } }),
    update: async patch => {
      const next = { ...deps.readState().value, ...patch };
      // Preserve the Settings policy even for explicit false values: while
      // Cindy memory owns native memory, those fields cannot be changed here.
      const conflictingFields = (['claudeCode', 'codex'] as const).filter(key => patch[key] !== undefined);
      if (next.maker && conflictingFields.length) return {
        ok: false,
        errorCode: 'MEMORY_SETTINGS_CONFLICT',
        message: 'Cindy 记忆开启时不能修改 Claude Code 或 Codex 原生记忆。请先将 maker 设为 false，再修改这些字段；本次未应用任何字段。',
        conflictingFields,
        requires: { maker: false },
      };
      let result: unknown;
      if (patch.maker !== undefined) {
        const nativePatch: NativeMemoryPatch = {};
        for (const key of ['claudeCode', 'codex', 'pi'] as const) {
          if (typeof patch[key] === 'boolean') nativePatch[key] = patch[key];
        }
        return deps.updateMaker(patch.maker, nativePatch);
      }
      for (const key of ['claudeCode', 'codex', 'pi'] as const) {
        if (patch[key] !== undefined) {
          await deps.updateNative(key === 'claudeCode' ? 'claude-code' : key, patch[key]);
          if (deps.readState().value[key] !== patch[key]) throwIpcError('INTERNAL', 'memory setting was not persisted');
        }
      }
      return result;
    }, reset: deps.reset,
  };
}
