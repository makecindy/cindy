/**
 * TerminalShellSection — Settings → 个性化 下的 RSB 默认终端 shell 选择。
 *
 * UI:
 *   ┌─ 默认终端 shell ──────────────────────────┐
 *   │ 新建终端 tab 时使用此 shell                │
 *   │ ┌─────────────────────────────────────┐  │
 *   │ │ 自动选择 (zsh)                  ▼   │  │
 *   │ └─────────────────────────────────────┘  │
 *   └─────────────────────────────────────────┘
 *
 * - mount 时并行读取偏好和 shell 列表,两者齐备后再渲染完整控件。
 * - `'auto'` 永远是第一项;后面是当前机器实际装了的 shell（zsh / bash / pwsh / cmd / ...)，
 *   未装的不展示。
 * - 用户选 `'auto'` 之外 = 已 customize（rule 20），右侧出现「恢复默认」按钮 → 一键回 auto。
 * - 改变默认只影响**新建**的 terminal tab,已有 tab 不动（要切就 Settings 改 + 新建 tab）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SelectParts as Select } from '@/components/ui/select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { AvailableShell, ShellId } from '../../../shared/terminal-bridge';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function TerminalShellSection() {
  const { t } = useTranslation();

  const [pref, setPref] = useState<ShellId | null>(null);
  const [shells, setShells] = useState<AvailableShell[] | null>(null);
  const [resetting, setResetting] = useState(false);

  // 原生 <select> 的弹层打开后再异步追加 <option>,Windows 上不会可靠地
  // 重算内容/高度。Electron 也记录过同类原生弹层渲染问题:
  // https://github.com/electron/electron/issues/29665
  // https://github.com/electron/electron/issues/33110
  // 因此这里并行预取全部数据,齐备后才一次性渲染 Radix Select;不要把加载
  // 重新挪回 pointer/focus 事件里。
  useEffect(() => {
    let cancelled = false;
    const prefRequest = window.electronAPI.terminal
      .getDefaultShellPref()
      .catch((): ShellId => 'auto');
    const shellsRequest = window.electronAPI.terminal
      .listAvailableShells()
      .catch((): AvailableShell[] => []);

    void Promise.all([prefRequest, shellsRequest]).then(([nextPref, nextShells]) => {
      if (cancelled) return;
      setPref(nextPref);
      setShells(nextShells);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const autoTargetLabel = useMemo(() => {
    return shells?.find((s) => s.isAutoDetectTarget)?.displayName ?? '';
  }, [shells]);

  const isCustomized = pref != null && pref !== 'auto';

  const onChange = useCallback(
    (value: ShellId) => {
      const prev = pref;
      setPref(value); // 乐观更新
      void window.electronAPI.terminal.setDefaultShellPref(value).catch((err) => {
        setPref(prev);
        toast.error(err instanceof Error ? err.message : String(err));
      });
    },
    [pref],
  );

  const onReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    const prev = pref;
    setPref('auto');
    try {
      await window.electronAPI.terminal.setDefaultShellPref('auto');
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      setPref(prev);
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setResetting(false);
    }
  }, [resetting, pref, t]);

  if (pref === null || shells === null) return null; // 数据齐备后再一次性显示,避免跳变

  const autoLabel = autoTargetLabel
    ? t('settings.terminalShell.autoWithTarget', { target: autoTargetLabel })
    : t('settings.terminalShell.auto');
  const unavailablePref =
    pref !== 'auto' && !shells.some((shell) => shell.id === pref) ? pref : null;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.terminalShell.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.terminalShell.description')}
        </p>
      </div>

      <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-14 font-medium leading-none text-[var(--text-primary)]">
            {t('settings.terminalShell.card.label')}
          </p>
          <DefaultOverrideControls
            isCustomized={isCustomized}
            disabled={resetting}
            onReset={() => void onReset()}
          />
        </div>

        <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.terminalShell.card.description')}
        </p>

        <Select.Root
          value={pref}
          onValueChange={(value) => onChange(value as ShellId)}
          disabled={resetting}
        >
          <Select.Trigger
            aria-label={t('settings.terminalShell.card.selectAria')}
            className={cn(
              'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-full border px-3 text-12 outline-none',
              'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
              'border-[var(--settings-input-border)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
              'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60',
            )}
          >
            <span className="min-w-0 truncate text-left">
              <Select.Value />
            </span>
            <Select.Icon asChild>
              <ChevronDown size={15} className="shrink-0 opacity-75" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              side="bottom"
              align="start"
              sideOffset={4}
              className={cn(
                'z-[10010] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border p-1.5',
                'max-h-[min(15rem,var(--radix-select-content-available-height))]',
                'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
              )}
            >
              <Select.ScrollUpButton className="flex h-5 items-center justify-center text-[var(--settings-section-desc)]">
                <ChevronUp size={14} />
              </Select.ScrollUpButton>
              <Select.Viewport>
                <ShellOption value="auto" label={autoLabel} />
                {shells.map((shell) => (
                  <ShellOption key={shell.id} value={shell.id} label={shell.displayName} />
                ))}
                {/* 用户上次选的 shell 当前不可用(卸了)时,仍要显示让用户可以切回 auto */}
                {unavailablePref ? (
                  <ShellOption
                    value={unavailablePref}
                    label={t('settings.terminalShell.unavailable', { shell: unavailablePref })}
                    unavailable
                  />
                ) : null}
              </Select.Viewport>
              <Select.ScrollDownButton className="flex h-5 items-center justify-center text-[var(--settings-section-desc)]">
                <ChevronDown size={14} />
              </Select.ScrollDownButton>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>
    </div>
  );
}

/** Radix shell option row;统一键盘高亮、选中指示、失效提示和主题 token。 */
function ShellOption({
  value,
  label,
  unavailable = false,
}: {
  value: ShellId;
  label: string;
  unavailable?: boolean;
}) {
  return (
    <Select.Item
      value={value}
      className={cn(
        'flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-12 outline-none',
        'text-[var(--settings-input-text)]',
        unavailable && 'text-[var(--settings-section-desc)]',
      )}
    >
      <Select.ItemText>{label}</Select.ItemText>
      <Select.ItemIndicator>
        <Check size={14} strokeWidth={2.25} />
      </Select.ItemIndicator>
    </Select.Item>
  );
}
