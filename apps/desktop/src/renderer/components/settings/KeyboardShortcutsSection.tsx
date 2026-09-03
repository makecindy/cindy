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
 *
 * 已检测或已启用的硬件设备出现在快捷键这一级，方便直接打开。
 * 「配件」始终列出全部可见设备，不因为某台已经出现在外面就从列表里拿掉。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, Package, Pencil, RotateCcw, Trash2 } from 'lucide-react';

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
import { useWorkLouderCodex } from '@/hooks/useWorkLouderCodex';
import { useXboxGamepad } from '@/hooks/useXboxGamepad';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import { WorkLouderCodexEntry, WorkLouderCodexSettings } from './WorkLouderCodexSettings';
import {
  isWorkLouderModel,
  VISIBLE_WORKLOUDER_MODELS,
  type WorkLouderModel,
} from '../../../shared/workLouderCodex';
import {
  GAMEPAD_FAMILIES,
  VISIBLE_GAMEPAD_FAMILIES,
  type GamepadFamily,
} from '../../../shared/xboxGamepad';
import { XboxGamepadEntry, XboxGamepadSettings } from './XboxGamepadSettings';

const log = createLogger('settings:keyboard-shortcuts');

function shouldShowHardwareOutside(device: {
  present: boolean | null | undefined;
  enabled: boolean | undefined;
}): boolean {
  return device.present === true || device.enabled === true;
}

type HardwarePane = 'list' | 'accessories' | WorkLouderModel | GamepadFamily;

function AccessoriesEntry({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="settings-shortcuts-accessories"
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-4 text-left outline-none transition-colors',
        'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
        'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
      )}
      aria-label={t('settings.shortcuts.accessories.openAria')}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <Package size={18} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-13 font-medium text-[var(--text-primary)]">
          {t('settings.shortcuts.accessories.title')}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">
          {t('settings.shortcuts.accessories.description')}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
    </button>
  );
}

interface RecordingError {
  id: AppShortcutId;
  message: string;
}

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
  const [hardwarePane, setHardwarePane] = useState<HardwarePane>('list');
  const [hardwareReturnTo, setHardwareReturnTo] = useState<'list' | 'accessories'>('list');
  const workLouderCodex = useWorkLouderCodex({ model: 'codex-micro', watchConnection: true });
  const workLouderCreator = useWorkLouderCodex({
    model: 'creator-micro-2',
    watchConnection: true,
  });
  const workLouderBoards = {
    'codex-micro': workLouderCodex,
    'creator-micro-2': workLouderCreator,
  };
  const xboxGamepad = useXboxGamepad({ family: 'xbox', watchConnection: true });
  const playstationGamepad = useXboxGamepad({ family: 'playstation', watchConnection: true });
  const nintendoGamepad = useXboxGamepad({ family: 'nintendo', watchConnection: true });
  const genericGamepad = useXboxGamepad({ family: 'generic', watchConnection: true });
  const gamepads = {
    xbox: xboxGamepad,
    playstation: playstationGamepad,
    nintendo: nintendoGamepad,
    generic: genericGamepad,
  };
  const workLouderConnected = Object.fromEntries(
    VISIBLE_WORKLOUDER_MODELS.map((model) => [
      model,
      shouldShowHardwareOutside({
        present: workLouderBoards[model].state?.devicePresent,
        enabled: workLouderBoards[model].state?.settings.deviceEnabled,
      }),
    ]),
  ) as Record<WorkLouderModel, boolean>;
  const gamepadConnected = Object.fromEntries(
    GAMEPAD_FAMILIES.map((family) => [
      family,
      shouldShowHardwareOutside({
        present: gamepads[family].state?.devicePresent,
        enabled: gamepads[family].state?.settings.deviceEnabled,
      }),
    ]),
  ) as Record<GamepadFamily, boolean>;
  const [error, setError] = useState<RecordingError | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const mutationRequestIdRef = useRef(0);
  const workLouderOpenRequested =
    new URLSearchParams(window.location.search).get('workLouderCodex') === '1';

  useEffect(() => {
    if (workLouderOpenRequested) {
      setHardwareReturnTo('list');
      setHardwarePane('codex-micro');
    }
  }, [workLouderOpenRequested]);

  const openWorkLouder = (model: WorkLouderModel, from: 'list' | 'accessories') => {
    setHardwareReturnTo(from);
    setHardwarePane(model);
  };
  const openGamepad = (family: GamepadFamily, from: 'list' | 'accessories') => {
    setHardwareReturnTo(from);
    setHardwarePane(family);
  };

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
      window.electronAPI.appShortcuts.setOverride(recordingId, combo).catch((err: unknown) => {
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

  const handleResetOne = useCallback(
    (id: AppShortcutId) => {
      const requestId = beginShortcutAction();
      void window.electronAPI.appShortcuts.clearOverride(id).catch((err: unknown) => {
        reportMutationError(requestId, err, id);
      });
    },
    [beginShortcutAction, reportMutationError],
  );

  /** 删除绑定 = override 置 null, 该快捷键禁用 (显示"未设置")。 */
  const handleDeleteOne = useCallback(
    (id: AppShortcutId) => {
      const requestId = beginShortcutAction();
      setRecordingId(null);
      void window.electronAPI.appShortcuts.setOverride(id, null).catch((err: unknown) => {
        reportMutationError(requestId, err, id);
      });
    },
    [beginShortcutAction, reportMutationError],
  );

  const iconButtonClass =
    'inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-chip)] transition-colors';

  if (isWorkLouderModel(hardwarePane)) {
    return (
      <WorkLouderCodexSettings
        model={hardwarePane}
        onBack={() => setHardwarePane(hardwareReturnTo)}
      />
    );
  }
  if ((GAMEPAD_FAMILIES as readonly string[]).includes(hardwarePane)) {
    return (
      <XboxGamepadSettings
        family={hardwarePane as GamepadFamily}
        onBack={() => setHardwarePane(hardwareReturnTo)}
      />
    );
  }
  if (hardwarePane === 'accessories') {
    return (
      <div className="flex flex-col gap-[14px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHardwarePane('list')}
            className="flex size-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            aria-label={t('settings.shortcuts.accessories.back')}
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.shortcuts.accessories.title')}
          </h2>
        </div>
        <div
          className={cn(
            'flex flex-col overflow-hidden rounded-xl',
            'bg-[var(--settings-theme-card-bg)]',
            'border border-[var(--settings-theme-card-border)]',
            '[&>*+*]:border-t [&>*+*]:border-[var(--settings-theme-card-border)]',
          )}
        >
          {VISIBLE_WORKLOUDER_MODELS.map((model) => (
            <WorkLouderCodexEntry
              key={model}
              model={model}
              state={workLouderBoards[model].state}
              loading={workLouderBoards[model].loading}
              grouped
              onOpen={() => openWorkLouder(model, 'accessories')}
            />
          ))}
          {VISIBLE_GAMEPAD_FAMILIES.map((family) => (
            <XboxGamepadEntry
              key={family}
              family={family}
              state={gamepads[family].state}
              loading={gamepads[family].loading}
              grouped
              onOpen={() => openGamepad(family, 'accessories')}
            />
          ))}
        </div>
      </div>
    );
  }

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

      {VISIBLE_WORKLOUDER_MODELS.filter((model) => workLouderConnected[model]).map((model) => (
        <WorkLouderCodexEntry
          key={model}
          model={model}
          state={workLouderBoards[model].state}
          loading={workLouderBoards[model].loading}
          onOpen={() => openWorkLouder(model, 'list')}
        />
      ))}
      {VISIBLE_GAMEPAD_FAMILIES.filter((family) => gamepadConnected[family]).map((family) => (
        <XboxGamepadEntry
          key={family}
          family={family}
          state={gamepads[family].state}
          loading={gamepads[family].loading}
          onOpen={() => openGamepad(family, 'list')}
        />
      ))}
      <AccessoriesEntry onOpen={() => setHardwarePane('accessories')} />

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
                    className={cn(
                      iconButtonClass,
                      !def.rebindable && 'opacity-50 pointer-events-none',
                    )}
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
                      className={cn(
                        iconButtonClass,
                        !def.rebindable && 'opacity-50 pointer-events-none',
                      )}
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
    </div>
  );
}
