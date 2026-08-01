import {
  getEffectiveAppShortcuts,
  normalizeAppShortcutOverrides,
  type AppShortcutCombo,
  type AppShortcutId,
  type AppShortcutOverrides,
} from '../../shared/appShortcuts';
import { voiceInputShortcutToAppShortcutCombo } from '../voice-input/appShortcutConflict';

/**
 * renderer 侧应用级快捷键状态单例。
 *
 * 启动时同步拉一次 main 的 overrides + platform (sendSync, 数据极小),
 * 用 shared/appShortcuts 的 getEffectiveAppShortcuts 在本端合并出生效表 ——
 * 与 main 消费端跑同一份 registry 代码, 判定不漂移。之后订阅
 * app-shortcuts:changed 广播热更新, 设置页改绑立即对所有监听生效。
 *
 * 语音输入的键盘快捷键是 registry 之外的用户键位: 历史设置可能占着
 * mod+1..9 等隐藏槽位默认组合, 这里把它作为 yieldToCombos 传入合并
 * (隐藏槽位让位, 语音快捷键获胜), 并订阅语音设置变更热更新。registry
 * 消费端全部走本 store, 让位对 useAppShortcut 监听与序号徽标同时生效。
 *
 * 非 Electron 环境 (单测 jsdom) 下退化为纯默认值。
 */

let platform = 'darwin';
let effective = new Map<AppShortcutId, AppShortcutCombo[]>();
let overridesSnapshot: AppShortcutOverrides = {};
let voiceYieldCombos: AppShortcutCombo[] = [];
const listeners = new Set<() => void>();
let initialized = false;

function recomputeEffective(): void {
  effective = getEffectiveAppShortcuts(overridesSnapshot, platform, voiceYieldCombos);
}

function readVoiceYieldCombos(): AppShortcutCombo[] {
  try {
    const shortcut = window.electronAPI?.voiceInput?.getDataSnapshot()?.settings?.shortcut;
    if (!shortcut) return [];
    const combo = voiceInputShortcutToAppShortcutCombo(shortcut);
    return combo ? [combo] : [];
  } catch {
    return [];
  }
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const api = window.electronAPI?.appShortcuts;
  if (api) {
    try {
      const state = api.getState();
      platform = state.platform;
      overridesSnapshot = normalizeAppShortcutOverrides(state.overrides, platform);
    } catch {
      overridesSnapshot = {};
    }
    api.onChanged((payload) => {
      overridesSnapshot = normalizeAppShortcutOverrides(payload?.overrides, platform);
      recomputeEffective();
      listeners.forEach((cb) => cb());
    });
    voiceYieldCombos = readVoiceYieldCombos();
    try {
      window.electronAPI?.voiceInput?.onDataChanged(() => {
        voiceYieldCombos = readVoiceYieldCombos();
        recomputeEffective();
        listeners.forEach((cb) => cb());
      });
    } catch {
      // 语音订阅不可用时保持启动快照, 不影响其余快捷键。
    }
  } else if (typeof navigator !== 'undefined' && !/Mac|iPhone|iPad/.test(navigator.platform)) {
    platform = 'win32';
  }
  recomputeEffective();
}

/** 某 id 当前生效的组合列表; 平台不可用返回空数组 (消费端据此不挂监听)。 */
export function getAppShortcutCombos(id: AppShortcutId): AppShortcutCombo[] {
  ensureInitialized();
  return effective.get(id) ?? [];
}

export function getAppShortcutOverrides(): AppShortcutOverrides {
  ensureInitialized();
  return { ...overridesSnapshot };
}

export function getAppShortcutPlatform(): string {
  ensureInitialized();
  return platform;
}

/** 订阅生效表变化 (改绑 / reset 后触发); 返回取消订阅函数。 */
export function subscribeAppShortcuts(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
