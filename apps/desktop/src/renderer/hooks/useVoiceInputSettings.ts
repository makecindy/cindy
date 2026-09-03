import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DictationDictionaryLearningAction } from '@cindy/voice-input-core';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  DEFAULT_VOICE_INPUT_REFINEMENT_INSTRUCTIONS,
  MAX_VOICE_INPUT_DICTIONARY_CSV_BYTES,
  MAX_VOICE_INPUT_DICTIONARY_ALIASES,
  MAX_VOICE_INPUT_DICTIONARY_CANDIDATES,
  MAX_VOICE_INPUT_DICTIONARY_ENTRIES,
  MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS,
  MAX_VOICE_INPUT_REFINEMENT_INSTRUCTIONS_CHARS,
  buildVoiceInputDictionaryAliasHints,
  createManualVoiceInputDictionaryEntry,
  formatVoiceInputDictionary,
  getDefaultVoiceInputSettings,
  getNewAutomaticDictionaryEntries,
  getNewAutomaticDictionaryEntryTexts,
  mergeVoiceInputDictionaryCsvTerms,
  normalizeVoiceInputDictionaryEntryText,
  parseVoiceInputDictionaryCsv,
  type VoiceInputDataSnapshot,
  type VoiceInputDictionaryEntry,
  type VoiceInputDictionaryEntrySource,
  type VoiceInputDictionaryLearningEvidence,
  type VoiceInputLanguage,
  type VoiceInputSettings,
} from '../../shared/voiceInputData';
import type { VoiceInputShortcut } from '@/voice-input/shortcut';
import { findComposerVoiceInputConflict } from '@/voice-input/composerVoiceInputConflict';
import { getComposerSendShortcutPreference } from './useComposerSendShortcutPreference';

export {
  DEFAULT_VOICE_INPUT_REFINEMENT_INSTRUCTIONS,
  MAX_VOICE_INPUT_DICTIONARY_CSV_BYTES,
  MAX_VOICE_INPUT_DICTIONARY_ALIASES,
  MAX_VOICE_INPUT_DICTIONARY_CANDIDATES,
  MAX_VOICE_INPUT_DICTIONARY_ENTRIES,
  MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS,
  MAX_VOICE_INPUT_REFINEMENT_INSTRUCTIONS_CHARS,
  buildVoiceInputDictionaryAliasHints,
  createManualVoiceInputDictionaryEntry,
  formatVoiceInputDictionary,
  getNewAutomaticDictionaryEntries,
  getNewAutomaticDictionaryEntryTexts,
  mergeVoiceInputDictionaryCsvTerms,
  normalizeVoiceInputDictionaryEntryText,
  parseVoiceInputDictionaryCsv,
};
export type {
  VoiceInputDictionaryEntry,
  VoiceInputDictionaryEntrySource,
  VoiceInputDictionaryLearningEvidence,
  VoiceInputLanguage,
  VoiceInputSettings,
};

const LEGACY_SETTINGS_STORAGE_KEY = 'voiceInput.settings.v1';
const LEGACY_HISTORY_STORAGE_KEY = 'voiceInput.history.v1';
const log = createLogger('voice-input-settings');

export function migrateLegacyVoiceInputRendererStorage(): void {
  try {
    const settingsRaw = localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
    const historyRaw = localStorage.getItem(LEGACY_HISTORY_STORAGE_KEY);
    if (!settingsRaw && !historyRaw) return;
    window.electronAPI.voiceInput.migrateLegacyRendererData({ settingsRaw, historyRaw });
    localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_HISTORY_STORAGE_KEY);
  } catch (error) {
    log.warn('legacy renderer voice-input data migration failed:', error instanceof Error ? error.message : String(error));
  }
}

export function getVoiceInputSettings(): VoiceInputSettings {
  try {
    return window.electronAPI.voiceInput.getDataSnapshot().settings;
  } catch {
    return getDefaultVoiceInputSettings(window.electronAPI?.platform);
  }
}

export async function recordVoiceInputDictionaryLearningActions(
  actions: DictationDictionaryLearningAction[],
): Promise<void> {
  if (actions.length === 0) return;
  try {
    await window.electronAPI.voiceInput.recordDictionaryLearningActions(actions);
  } catch (error) {
    log.warn('dictionary learning actions failed:', error instanceof Error ? error.message : String(error));
  }
}

export function deleteVoiceInputDictionaryEntries(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  void window.electronAPI.voiceInput.deleteDictionaryEntries(entryIds).catch((error) => {
    log.warn('voice input dictionary delete failed:', error instanceof Error ? error.message : String(error));
  });
}

export async function adviseAndRecordVoiceInputDictionaryLearning(
  evidence: VoiceInputDictionaryLearningEvidence,
): Promise<void> {
  const current = getVoiceInputSettings();
  if (!current.refinementEnabled || !current.autoDictionaryEnabled) return;
  try {
    const result = await window.electronAPI.voiceInput.adviseDictionaryLearning({
      ...evidence,
      debug: import.meta.env.DEV,
    });
    if (!result.ok) {
      log.warn('dictionary learning advisor failed:', result.error);
      return;
    }
    if (result.actions.length > 0) {
      log.debug('dictionary learning actions applied:', result.actions.length);
    }
  } catch (error) {
    log.warn('dictionary learning advisor failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Subscribe to the main-owned voice-input data store. The global overlay window
 * is cached across hide/show, so imperative refs must refresh from main events
 * instead of holding the initial snapshot forever.
 */
export function subscribeVoiceInputSettings(
  callback: (settings: VoiceInputSettings) => void,
): () => void {
  return window.electronAPI.voiceInput.onDataChanged((snapshot: VoiceInputDataSnapshot) => {
    callback(snapshot.settings);
  });
}

export type VoiceInputShortcutUpdateResult =
  | {
    ok: true;
    settings: VoiceInputSettings;
    /**
     * 快捷键已存盘，但 macOS 监听权限还没拿到，所以按键暂时不会有反应。设置页据此
     * 请求授权并标注「待授权」，而不是当成注册失败报错。
     */
    pendingInputMonitoring?: boolean;
  }
  // 用 IPC 契约的固定联合而不是裸 string，避免误传/误判不存在的 code。
  | {
    ok: false;
    error: string;
    errorCode?: VoiceInputGlobalErrorCode;
    conflict?: 'composer-voice-input';
  };

/**
 * 录制期挂起全局快捷键。
 *
 * 与「同步」分开是必要的：main 侧会丢掉与存盘不一致的同步请求（那是过时的广播回声），而挂起
 * 传的 null 恰恰**故意**与存盘不同。不把意图讲明，就只能在 main 侧放行所有 null —— 于是
 * 「清空快捷键」那次提交广播出的 null 回声也能迟到落地，把更晚一次提交刚注册好的快捷键关掉。
 */
export async function suspendVoiceInputGlobalShortcut(): Promise<{ ok: boolean; error?: string }> {
  return syncVoiceInputGlobalShortcut(null, { suspend: true });
}

/**
 * 返回类型带上 `errorCode`：调用方要靠它区分「还是缺权限」「helper 真起不来」「被更晚一轮
 * 顶掉」，只有 ok/error 的话就只能去匹配 main 侧那句英文（而那句已经被统一消毒成固定文案，
 * 压根区分不出原因）。
 */
export async function syncVoiceInputGlobalShortcut(
  shortcut: VoiceInputShortcut | null,
  options?: { suspend?: true },
): Promise<{ ok: boolean; error?: string; errorCode?: VoiceInputGlobalErrorCode }> {
  try {
    const result = await window.electronAPI.voiceInput.setGlobalShortcut(shortcut, options);
    if (!result.ok) {
      log.warn('global voice input shortcut sync failed:', result.error);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('global voice input shortcut sync failed:', message);
    return { ok: false, error: message };
  }
}

export function useVoiceInputSettings(): {
  settings: VoiceInputSettings;
  setLanguage: (language: VoiceInputLanguage) => void;
  setMicrophoneDeviceId: (deviceId: string | null) => void;
  setMuteSystemAudio: (enabled: boolean) => void;
  setPlayInteractionSound: (enabled: boolean) => void;
  setFastActivationEnabled: (enabled: boolean) => void;
  setRefinementEnabled: (enabled: boolean) => void;
  setRefinementInstructions: (instructions: string) => void;
  setAutoDictionaryEnabled: (enabled: boolean) => void;
  setDictionarySyncEnabled: (enabled: boolean) => void;
  /** 这几个返回持久化结果:成功才收口 UI(关对话框、清草稿、提示成功)。 */
  addDictionaryEntry: (text: string) => Promise<boolean>;
  importDictionaryEntries: (texts: string[]) => Promise<boolean>;
  renameDictionaryEntry: (entryId: string, text: string) => Promise<boolean>;
  editDictionaryEntry: (entryId: string, text: string, aliases: string[]) => Promise<boolean>;
  deleteDictionaryEntry: (entryId: string) => Promise<boolean>;
  recordDictionaryLearningActions: (actions: DictationDictionaryLearningAction[]) => void;
  setShortcut: (shortcut: VoiceInputShortcut | null) => Promise<VoiceInputShortcutUpdateResult>;
} {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<VoiceInputSettings>(getVoiceInputSettings);

  const updateSettings = useCallback((patch: Partial<VoiceInputSettings>) => {
    const previousShortcut = getVoiceInputSettings().shortcut;
    void window.electronAPI.voiceInput
      .updateSettings(patch)
      .then((next) => {
        setSettings(next);
        if (!areVoiceInputShortcutsEqual(previousShortcut, next.shortcut)) {
          void syncVoiceInputGlobalShortcut(next.shortcut);
        }
      })
      .catch((error) => {
        log.warn('voice input settings update failed:', error instanceof Error ? error.message : String(error));
        toast.error(formatVoiceInputPersistenceError(t, error));
      });
  }, [t]);

  const setLanguage = useCallback(
    (language: VoiceInputLanguage) => updateSettings({ language }),
    [updateSettings],
  );

  const setMicrophoneDeviceId = useCallback(
    (microphoneDeviceId: string | null) => updateSettings({ microphoneDeviceId }),
    [updateSettings],
  );

  const setMuteSystemAudio = useCallback(
    (muteSystemAudio: boolean) => updateSettings({ muteSystemAudio }),
    [updateSettings],
  );

  const setPlayInteractionSound = useCallback(
    (playInteractionSound: boolean) => updateSettings({ playInteractionSound }),
    [updateSettings],
  );

  const setFastActivationEnabled = useCallback(
    (fastActivationEnabled: boolean) => updateSettings({ fastActivationEnabled }),
    [updateSettings],
  );

  const setRefinementEnabled = useCallback(
    (refinementEnabled: boolean) => updateSettings({ refinementEnabled }),
    [updateSettings],
  );

  const setRefinementInstructions = useCallback(
    (refinementInstructions: string) => updateSettings({ refinementInstructions }),
    [updateSettings],
  );

  const setAutoDictionaryEnabled = useCallback(
    (autoDictionaryEnabled: boolean) => updateSettings({ autoDictionaryEnabled }),
    [updateSettings],
  );

  const setDictionarySyncEnabled = useCallback(
    (dictionarySyncEnabled: boolean) => updateSettings({ dictionarySyncEnabled }),
    [updateSettings],
  );

  // 词典的增改删都是语义化操作:主进程按「用户做了什么」更新同步状态,再把物化
  // 结果回投影成 settings。整份覆盖词条数组表达不了用户意图,也会被下一次物化冲掉。
  /**
   * 返回 Promise 而不是 fire-and-forget:调用方要等持久化真的成功再关对话框、清
   * 草稿、弹成功提示。主进程会在投影文件写不下去、或同步状态来自更新客户端时
   * 拒绝写入 —— 那时 UI 却已经宣告成功,用户以为加上了,重启后发现没有。
   */
  const runDictionaryMutation = useCallback(
    (mutate: () => Promise<unknown>): Promise<boolean> =>
      mutate()
        .then((next) => {
          setSettings(next as VoiceInputSettings);
          return true;
        })
        .catch((error) => {
          log.warn('voice input dictionary update failed:', error instanceof Error ? error.message : String(error));
          toast.error(formatVoiceInputPersistenceError(t, error));
          return false;
        }),
    [t],
  );

  const addDictionaryEntry = useCallback(
    (text: string) => runDictionaryMutation(() => window.electronAPI.voiceInput.addDictionaryEntry(text)),
    [runDictionaryMutation],
  );

  const importDictionaryEntries = useCallback(
    (texts: string[]) =>
      runDictionaryMutation(() => window.electronAPI.voiceInput.importDictionaryEntries(texts)),
    [runDictionaryMutation],
  );

  const renameDictionaryEntry = useCallback(
    (entryId: string, text: string) =>
      runDictionaryMutation(() => window.electronAPI.voiceInput.renameDictionaryEntry(entryId, text)),
    [runDictionaryMutation],
  );

  const editDictionaryEntry = useCallback(
    (entryId: string, text: string, aliases: string[]) =>
      runDictionaryMutation(() =>
        window.electronAPI.voiceInput.editDictionaryEntry(entryId, text, aliases),
      ),
    [runDictionaryMutation],
  );

  const deleteDictionaryEntry = useCallback(
    (entryId: string) =>
      runDictionaryMutation(() => window.electronAPI.voiceInput.deleteDictionaryEntries([entryId])),
    [runDictionaryMutation],
  );

  const recordDictionaryLearningActions = useCallback((actions: DictationDictionaryLearningAction[]) => {
    void recordVoiceInputDictionaryLearningActions(actions);
  }, []);

  const setShortcut = useCallback(
    async (shortcut: VoiceInputShortcut | null): Promise<VoiceInputShortcutUpdateResult> => {
      if (
        findComposerVoiceInputConflict(
          getComposerSendShortcutPreference(),
          shortcut,
          window.electronAPI?.platform,
        )
      ) {
        return {
          ok: false,
          conflict: 'composer-voice-input',
          error: 'Voice Input shortcut conflicts with the Composer send shortcut',
        };
      }

      try {
        const result = await window.electronAPI.voiceInput.updateShortcutSetting(shortcut);
        if (!result.ok) log.warn('voice input shortcut setting update failed:', result.error);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('voice input shortcut setting update failed:', message);
        return { ok: false, error: message };
      }
    },
    [],
  );

  // Every main-side data-changed broadcast (history appends after each
  // dictation included) delivers a freshly cloned settings object, so keying
  // this effect on `settings.shortcut` re-syncs after every recording — and
  // re-logs a registration failure each time when the accelerator is held by
  // another process. Key on the shortcut's value instead.
  const shortcutKey = serializeVoiceInputShortcut(settings.shortcut);
  const shortcutRef = useRef(settings.shortcut);
  shortcutRef.current = settings.shortcut;
  useEffect(() => {
    void syncVoiceInputGlobalShortcut(shortcutRef.current);
  }, [shortcutKey]);

  useEffect(() => subscribeVoiceInputSettings(setSettings), []);

  return {
    settings,
    setLanguage,
    setMicrophoneDeviceId,
    setMuteSystemAudio,
    setPlayInteractionSound,
    setFastActivationEnabled,
    setRefinementEnabled,
    setRefinementInstructions,
    setAutoDictionaryEnabled,
    setDictionarySyncEnabled,
    addDictionaryEntry,
    importDictionaryEntries,
    renameDictionaryEntry,
    editDictionaryEntry,
    deleteDictionaryEntry,
    recordDictionaryLearningActions,
    setShortcut,
  };
}

function formatVoiceInputPersistenceError(
  t: (key: string, options?: Record<string, unknown>) => string,
  error: unknown,
): string {
  const message =
    extractIpcError(error)?.message ?? (error instanceof Error ? error.message : String(error));
  return t('settings.voiceInput.saveFailed', { message });
}

function serializeVoiceInputShortcut(shortcut: VoiceInputShortcut | null): string {
  if (!shortcut) return '';
  const { modifiers } = shortcut;
  return [
    shortcut.trigger ?? '',
    shortcut.code,
    shortcut.key,
    modifiers.meta ? '1' : '0',
    modifiers.ctrl ? '1' : '0',
    modifiers.alt ? '1' : '0',
    modifiers.shift ? '1' : '0',
    modifiers.fn ? '1' : '0',
  ].join('|');
}

function areVoiceInputShortcutsEqual(
  lhs: VoiceInputShortcut | null,
  rhs: VoiceInputShortcut | null,
): boolean {
  return serializeVoiceInputShortcut(lhs) === serializeVoiceInputShortcut(rhs);
}
