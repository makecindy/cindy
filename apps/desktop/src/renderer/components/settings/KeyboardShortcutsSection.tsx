/**
 * KeyboardShortcutsSection — Settings「键盘快捷键」tab 的主区块。
 *
 * 扁平列出 shared/appShortcuts registry 里当前平台可用的全部应用级快捷键
 * (scope 仅用于冲突检测域, 不做展示分组)。每行: 标题 + 说明 | 组合键展示 |
 * 编辑 / 删除按钮; 编辑 (录制) 中组合键位变为"按下新快捷键…", 旁边显示
 * 「取消」按钮。删除 = override 置 null (该快捷键禁用, 显示"未设置");
 * 已自定义 (改绑或删除) 的行显示单项恢复默认, 头部提供"恢复全部默认"。
 *
 * 改绑校验: 系统保留键 / registry 内冲突 (scope 重叠域) / 与语音输入快捷键
 * 冲突 / 裸键限制 —— 全部阻断 + 行内提示。
 *
 * 存储语义: 只写用户 override (main 侧 AppShortcutStore), 恢复默认 = 清除
 * override; 生效值与显示通过 appShortcutStore 单例热更新。
 * 录制期间设置 body.dataset.appShortcutRecording 旗标, useAppShortcut 全体
 * 让路, 避免录制 ⌘B 时误触发侧边栏切换。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  APP_SHORTCUT_DEFINITIONS,
  appShortcutCombosEqual,
  comboToElectronAccelerator,
  createAppShortcutComboFromEvent,
  findAppShortcutConflict,
  formatAppShortcutCombo,
  getAppShortcutDefinition,
  isAppShortcutAvailableOnPlatform,
  isAppShortcutComboBindable,
  type AppShortcutCombo,
  type AppShortcutDefinition,
  type AppShortcutId,
} from '../../../shared/appShortcuts';
import { isSystemReservedShortcut } from '../../../shared/keyboardReserved';
import {
  getAppShortcutCombos,
  getAppShortcutOverrides,
  getAppShortcutPlatform,
  subscribeAppShortcuts,
} from '@/lib/appShortcutStore';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  DEFAULT_APPSHOT_SHORTCUT_PREFERENCES,
  formatAppshotShortcut,
  type AppshotShortcut,
  type AppshotShortcutPreferences,
} from '../../../shared/appshots';

const log = createLogger('settings:keyboard-shortcuts');

interface RecordingError {
  id: AppShortcutId;
  message: string;
}

type AppshotRecordingTarget = 'preferred' | 'fallback' | null;
type AppshotPermissionTarget = 'screen-recording' | 'accessibility' | 'input-monitoring';

const APPSHOT_PERMISSION_SETTINGS_URLS: Record<AppshotPermissionTarget, string> = {
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

export function KeyboardShortcutsSection() {
  const { t } = useTranslation();
  const platform = getAppShortcutPlatform();
  // overrides 快照订阅: 改绑 / reset 后 main 广播 → appShortcutStore 通知 →
  // 这里重渲染。快照序列化做 useSyncExternalStore 的相等性判定。
  const overridesJson = useSyncExternalStore(subscribeAppShortcuts, () =>
    JSON.stringify(getAppShortcutOverrides()),
  );
  const overrides = JSON.parse(overridesJson) as Partial<
    Record<AppShortcutId, AppShortcutCombo | null>
  >;
  const [recordingId, setRecordingId] = useState<AppShortcutId | null>(null);
  const [error, setError] = useState<RecordingError | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const mutationRequestIdRef = useRef(0);
  const [appshotState, setAppshotState] = useState<{
    preferences: AppshotShortcutPreferences;
    configured: AppshotShortcut;
    active: AppshotShortcut | null;
    fallbackReason?: string;
  } | null>(null);
  const [appshotRecording, setAppshotRecording] = useState<AppshotRecordingTarget>(null);
  const [appshotError, setAppshotError] = useState<string | null>(null);
  const appshotsApi = window.electronAPI?.appshots;

  useEffect(() => {
    if (!appshotsApi) return;
    void appshotsApi.getShortcutState().then((state) => {
      setAppshotState(state);
    }).catch(() => {
      setAppshotError(t('settings.shortcuts.appshots.loadFailed'));
    });
    return appshotsApi.onShortcutStateChanged((state) => {
      setAppshotState(state);
    });
  }, [appshotsApi, t]);

  useEffect(() => {
    if (!appshotRecording) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setAppshotRecording(null);
        return;
      }
      const combo = createAppShortcutComboFromEvent(event);
      if (!combo) return;
      const current = appshotState?.preferences ?? DEFAULT_APPSHOT_SHORTCUT_PREFERENCES;
      const next: AppshotShortcutPreferences = {
        ...current,
        [appshotRecording]: { kind: 'accelerator', combo },
      };
      setAppshotRecording(null);
      setAppshotError(null);
      if (!appshotsApi) return;
      void appshotsApi.setShortcutPreferences(next)
        .then(setAppshotState)
        .catch(() => setAppshotError(t('settings.shortcuts.appshots.saveFailed')));
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [appshotRecording, appshotState?.preferences, appshotsApi, t]);

  const setAppshotDualModifier = useCallback((modifier: 'command' | 'option' | 'shift') => {
    const current = appshotState?.preferences ?? DEFAULT_APPSHOT_SHORTCUT_PREFERENCES;
    const next = { ...current, preferred: { kind: 'dual-modifier' as const, modifier } };
    setAppshotError(null);
    if (!appshotsApi) return;
    void appshotsApi.setShortcutPreferences(next)
      .then(setAppshotState)
      .catch(() => setAppshotError(t('settings.shortcuts.appshots.saveFailed')));
  }, [appshotState?.preferences, appshotsApi, t]);

  const resetAppshotShortcuts = useCallback(() => {
    setAppshotError(null);
    if (!appshotsApi) return;
    void appshotsApi.resetShortcutPreferences()
      .then(setAppshotState)
      .catch(() => setAppshotError(t('settings.shortcuts.appshots.saveFailed')));
  }, [appshotsApi, t]);

  const openAppshotPermissionSettings = useCallback(async (target: AppshotPermissionTarget) => {
    try {
      const result = await window.electronAPI.openExternal(APPSHOT_PERMISSION_SETTINGS_URLS[target]);
      if (!result.success) throw new Error('open failed');
    } catch {
      toast.error(t('settings.shortcuts.appshots.openPermissionSettingsFailed'));
    }
  }, [t]);

  const mutationErrorMessage = useCallback(
    (err: unknown) => {
      // Decode the IPC envelope so persistence failures never look successful.
      const ipcError = extractIpcError(err);
      return t(
        ipcError?.code === 'INVALID_PARAMS'
          ? 'settings.shortcuts.errors.notBindable'
          : 'settings.shortcuts.errors.saveFailed',
      );
    },
    [t],
  );

  const beginShortcutAction = useCallback(() => {
    const requestId = ++mutationRequestIdRef.current;
    setError(null);
    setGlobalError(null);
    return requestId;
  }, []);

  const reportMutationError = useCallback(
    (requestId: number, err: unknown, id?: AppShortcutId) => {
      if (requestId !== mutationRequestIdRef.current) return;
      const message = mutationErrorMessage(err);
      if (id) {
        setError({ id, message });
      } else {
        setGlobalError(message);
      }
    },
    [mutationErrorMessage],
  );

  const visibleDefs = APP_SHORTCUT_DEFINITIONS.filter(
    (def) => !def.hiddenInSettings && isAppShortcutAvailableOnPlatform(def.id, platform),
  );

  const hasAnyOverride = Object.keys(overrides).length > 0;

  const itemLabel = useCallback(
    (def: AppShortcutDefinition) => t(def.labelKey, { defaultValue: def.id }),
    [t],
  );

  /** 录制到合法按键后的校验; 返回错误文案, null = 通过。 */
  const validateCombo = useCallback(
    (id: AppShortcutId, combo: AppShortcutCombo): string | null => {
      if (!isAppShortcutComboBindable(combo)) {
        return t('settings.shortcuts.errors.notBindable');
      }
      const family = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'other';
      if (isSystemReservedShortcut(combo, family)) {
        return t('settings.shortcuts.errors.systemReserved');
      }
      const selfDef = APP_SHORTCUT_DEFINITIONS.find((d) => d.id === id)!;
      // darwin 上菜单专属 id (如 新对话) 只能绑可表达为菜单 accelerator 的
      // 组合, 否则绑定后按键永不生效 (与 main store 校验一致)。
      if (
        selfDef.menuBacked &&
        platform === 'darwin' &&
        comboToElectronAccelerator(combo, 'darwin') === null
      ) {
        return t('settings.shortcuts.errors.menuAccelerator');
      }
      // 跨 id 冲突: 与 main store 写入兜底共用 shared 的 findAppShortcutConflict。
      const conflictId = findAppShortcutConflict(id, combo, getAppShortcutOverrides(), platform);
      if (conflictId) {
        return t('settings.shortcuts.errors.conflict', {
          name: itemLabel(getAppShortcutDefinition(conflictId)),
        });
      }
      // 语音输入全局快捷键是独立体系, 这里只做占用提示级别的冲突阻断。
      const voice = getVoiceInputSettings().shortcut;
      if (
        voice &&
        voice.trigger !== 'modifier' &&
        voice.code === combo.code &&
        voice.modifiers.meta === combo.meta &&
        voice.modifiers.ctrl === combo.ctrl &&
        voice.modifiers.alt === combo.alt &&
        voice.modifiers.shift === combo.shift
      ) {
        return t('settings.shortcuts.errors.voiceConflict');
      }
      return null;
    },
    [itemLabel, platform, t],
  );

  // 录制态: window capture 全量吞键, 合法组合 → 校验 → 写 override。
  // 取消走行内「取消」按钮 (Escape 保留为静默兜底, 不作为宣传的交互)。
  // 互斥双通道: body dataset 让 renderer 的 useAppShortcut 让路;
  // setRecording IPC 让 main 暂停菜单 accelerator 注册与 before-input 消费
  // (macOS 菜单 accelerator 在 renderer 收到按键前由系统分发, dataset 拦不住)。
  useEffect(() => {
    if (!recordingId) return;
    document.body.dataset.appShortcutRecording = '1';
    window.electronAPI.appShortcuts.setRecording(true);
    const cancel = () => setRecordingId(null);
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        cancel();
        return;
      }
      const combo = createAppShortcutComboFromEvent(e);
      if (!combo) return; // 纯修饰键, 等主键
      // 与当前生效组合相同 → 视为无变化, 直接退出录制
      if (getAppShortcutCombos(recordingId).some((c) => appShortcutCombosEqual(c, combo))) {
        cancel();
        return;
      }
      const message = validateCombo(recordingId, combo);
      if (message) {
        beginShortcutAction();
        setError({ id: recordingId, message });
        cancel();
        return;
      }
      const requestId = beginShortcutAction();
      window.electronAPI.appShortcuts
        .setOverride(recordingId, combo)
        .catch((err: unknown) => {
          // main 侧校验兜底失败 (理论上 renderer 已前置校验)
          log.warn('setOverride failed', err);
          reportMutationError(requestId, err, recordingId);
        });
      cancel();
    };
    window.addEventListener('keydown', handler, true);
    window.addEventListener('blur', cancel);
    return () => {
      delete document.body.dataset.appShortcutRecording;
      window.electronAPI.appShortcuts.setRecording(false);
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('blur', cancel);
    };
  }, [beginShortcutAction, recordingId, reportMutationError, t, validateCombo]);

  const handleResetAll = useCallback(() => {
    const requestId = beginShortcutAction();
    setRecordingId(null);
    void window.electronAPI.appShortcuts.resetAll().catch((err: unknown) => {
      reportMutationError(requestId, err);
    });
  }, [beginShortcutAction, reportMutationError]);

  const handleResetOne = useCallback((id: AppShortcutId) => {
    const requestId = beginShortcutAction();
    void window.electronAPI.appShortcuts.clearOverride(id).catch((err: unknown) => {
      reportMutationError(requestId, err, id);
    });
  }, [beginShortcutAction, reportMutationError]);

  /** 删除绑定 = override 置 null, 该快捷键禁用 (显示"未设置")。 */
  const handleDeleteOne = useCallback((id: AppShortcutId) => {
    const requestId = beginShortcutAction();
    setRecordingId(null);
    void window.electronAPI.appShortcuts.setOverride(id, null).catch((err: unknown) => {
      reportMutationError(requestId, err, id);
    });
  }, [beginShortcutAction, reportMutationError]);

  const iconButtonClass =
    'inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-chip)] transition-colors';

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.shortcuts.title')}
        </h2>
        {hasAnyOverride && (
          <button
            type="button"
            onClick={handleResetAll}
            className="shrink-0 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {t('settings.shortcuts.resetAll')}
          </button>
        )}
      </div>
      {globalError && <span className="text-12 text-[var(--error-fg)]">{globalError}</span>}

      <div
        className={cn(
          'flex flex-col rounded-xl p-5 gap-1',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        {visibleDefs.map((def) => {
          const isRecording = recordingId === def.id;
          const customized = def.id in overrides;
          const combos = getAppShortcutCombos(def.id);
          const rowError = error?.id === def.id ? error.message : null;
          return (
            <div key={def.id} className="flex items-center gap-2 py-2">
              {/* 条目标题 + 说明双行: 标题主文字色 + 说明次级色,
                  对齐 LinkOpenSection 卡片条目的用色规范 */}
              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                  {itemLabel(def)}
                </p>
                <p className="truncate text-12 leading-[1.4] text-[var(--text-secondary)]">
                  {t(def.descriptionKey, { defaultValue: '' })}
                </p>
              </div>
              {rowError && !isRecording && (
                <span className="text-12 text-[var(--error-fg)]">{rowError}</span>
              )}

              {/* 组合键展示位: 录制中显示提示, 无绑定显示"未设置" */}
              <span
                className={cn(
                  'inline-flex min-w-[72px] items-center justify-center rounded-md px-2 py-1',
                  // 不用 font-mono: 项目的 mono 映射到 --app-font-code (代码字体),
                  // 普遍缺 ⌘⇧⌥⌃ 字形, 会 fallback 渲染得又小又不协调。系统 UI
                  // 字体自带这些符号的正确字形 (与 VoiceInputSection 显示一致)。
                  'border text-12 font-medium',
                  isRecording
                    ? 'border-[var(--focus-ring)] text-[var(--text-primary)] bg-[var(--surface-chip)]'
                    : 'border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)]',
                  !isRecording && combos.length === 0
                    ? 'text-[var(--text-tertiary)]'
                    : 'text-[var(--text-secondary)]',
                )}
              >
                {isRecording
                  ? t('settings.shortcuts.recording')
                  : combos.length === 0
                    ? t('settings.shortcuts.none')
                    : combos.map((c) => formatAppShortcutCombo(c, platform)).join(' / ')}
              </span>

              {isRecording ? (
                <button
                  type="button"
                  onClick={() => setRecordingId(null)}
                  className="shrink-0 rounded-md px-2 py-1 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-chip)] transition-colors"
                >
                  {t('settings.shortcuts.cancel')}
                </button>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={!def.rebindable}
                    onClick={() => {
                      beginShortcutAction();
                      setRecordingId(def.id);
                    }}
                    className={cn(iconButtonClass, !def.rebindable && 'opacity-50 pointer-events-none')}
                    aria-label={t('settings.shortcuts.editAria', { name: itemLabel(def) })}
                    title={t('settings.shortcuts.edit')}
                  >
                    <Pencil size={13} />
                  </button>
                  {combos.length > 0 && (
                    <button
                      type="button"
                      disabled={!def.rebindable}
                      onClick={() => handleDeleteOne(def.id)}
                      className={cn(iconButtonClass, !def.rebindable && 'opacity-50 pointer-events-none')}
                      aria-label={t('settings.shortcuts.deleteAria', { name: itemLabel(def) })}
                      title={t('settings.shortcuts.delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  {customized && (
                    <button
                      type="button"
                      onClick={() => handleResetOne(def.id)}
                      className={iconButtonClass}
                      aria-label={t('settings.shortcuts.reset')}
                      title={t('settings.shortcuts.reset')}
                    >
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {platform === 'darwin' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
              {t('settings.shortcuts.appshots.title')}
            </h2>
            <button type="button" onClick={resetAppshotShortcuts} className="shrink-0 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              {t('settings.shortcuts.appshots.reset')}
            </button>
          </div>
          <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
            <div className="flex items-start gap-3">
              <Camera size={17} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
              <div className="min-w-0 flex-1">
                <p className="text-13 font-medium text-[var(--text-primary)]">{t('settings.shortcuts.appshots.description')}</p>
                <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">{t('settings.shortcuts.appshots.codexOnly')}</p>
              </div>
            </div>
            {appshotState && (
              <div className="mt-4 flex flex-col gap-2 text-12">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--text-secondary)]">{t('settings.shortcuts.appshots.preferred')}</span>
                  <span className="rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-2 py-1 text-[var(--text-primary)]">
                    {formatAppshotShortcut(appshotState.preferences.preferred, platform)}
                  </span>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {(['command', 'option', 'shift'] as const).map((modifier) => (
                    <button key={modifier} type="button" onClick={() => setAppshotDualModifier(modifier)} className="rounded-md border border-[var(--settings-theme-card-border)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]">
                      {t(`settings.shortcuts.appshots.modifiers.${modifier}`)}
                    </button>
                  ))}
                  <button type="button" onClick={() => setAppshotRecording('preferred')} className="rounded-md border border-[var(--settings-theme-card-border)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]">
                    {appshotRecording === 'preferred' ? t('settings.shortcuts.recording') : t('settings.shortcuts.appshots.customize')}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--text-secondary)]">{t('settings.shortcuts.appshots.fallback')}</span>
                  <span className="rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-2 py-1 text-[var(--text-primary)]">
                    {formatAppshotShortcut(appshotState.preferences.fallback, platform)}
                  </span>
                </div>
                <div className="flex justify-end">
                  <button type="button" onClick={() => setAppshotRecording('fallback')} className="rounded-md border border-[var(--settings-theme-card-border)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]">
                    {appshotRecording === 'fallback' ? t('settings.shortcuts.recording') : t('settings.shortcuts.appshots.customize')}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] pt-2">
                  <span className="text-[var(--text-secondary)]">{t('settings.shortcuts.appshots.active')}</span>
                  <span className={cn('text-right', appshotState.active ? 'text-[var(--text-primary)]' : 'text-[var(--error-fg)]')}>
                    {appshotState.active ? formatAppshotShortcut(appshotState.active, platform) : t('settings.shortcuts.appshots.unavailable')}
                  </span>
                </div>
                {appshotState.fallbackReason && <p className="text-12 text-[var(--text-secondary)]">{t(`settings.shortcuts.appshots.reasons.${appshotState.fallbackReason}`)}</p>}
                {appshotError && <p className="text-12 text-[var(--error-fg)]">{appshotError}</p>}
              </div>
            )}
            <div className="mt-4 border-t border-[var(--settings-theme-card-border)] pt-3 text-12 leading-[1.5] text-[var(--text-secondary)]">
              <p className="font-medium text-[var(--text-primary)]">{t('settings.shortcuts.appshots.permissionsTitle')}</p>
              <p className="mt-1">{t('settings.shortcuts.appshots.permissions')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(['screen-recording', 'accessibility', 'input-monitoring'] as const).map((target) => (
                  <button
                    key={target}
                    type="button"
                    onClick={() => void openAppshotPermissionSettings(target)}
                    className="rounded-md border border-[var(--settings-theme-card-border)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]"
                  >
                    {t(`settings.shortcuts.appshots.permissionsActions.${target}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
