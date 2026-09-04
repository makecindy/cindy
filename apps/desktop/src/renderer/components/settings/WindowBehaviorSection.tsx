/**
 * WindowBehaviorSection — 「应用行为」section:本机相关的应用级开关。
 *
 * 三项设置:
 *  1. 「保持电脑唤醒」(keepAwake):main 用 powerSaveBlocker 防系统休眠、放行锁屏,
 *     让后台 agent / 定时任务持续运行。跨平台生效(mac/win/linux),故常驻显示。
 *  2. 「关闭主窗口时」:Windows 选择退出或收起到托盘,Linux 选择退出或最小化。
 *  3. 「后台窗口首次左键点击仅激活不透传」(swallowActivationClick,PR #446):仅
 *     macOS + Windows 有实际效果,Linux 上两条底层路径均 no-op,故该行在 Linux 隐藏。
 *
 * 卡片样式沿用 NotificationSection 的规格(rounded 12 / Card bg / 1px Board /
 * padding 20)以保持视觉一致。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useSwallowActivationClickSettings } from '@/hooks/useSwallowActivationClickSettings';
import { useKeepAwakeSetting } from '@/hooks/useKeepAwakeSetting';
import {
  isLinuxCloseBehavior,
  isWindowsCloseBehavior,
  type LinuxCloseBehavior,
  type WindowsCloseBehavior,
} from '../../../shared/windowBehavior';

type DesktopCloseBehavior = LinuxCloseBehavior | WindowsCloseBehavior;

/** 一张开关卡片:左侧标签 + 说明(+ 可选补充说明行),右侧开关。 */
function BehaviorCard({
  label,
  hint,
  note,
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  label: string;
  hint: string;
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p
          className="text-13 font-medium text-[var(--settings-section-sublabel)]"
          style={{ letterSpacing: '0.12px' }}
        >
          {label}
        </p>
        <p className="whitespace-pre-line text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
          {hint}
        </p>
        {note}
      </div>

      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={ariaLabel} />
    </div>
  );
}

export function WindowBehaviorSection() {
  const { enabled, setEnabled } = useSwallowActivationClickSettings();
  const { keepAwake, setKeepAwake } = useKeepAwakeSetting();
  const { t } = useTranslation();
  // macOS 上 acceptFirstMouse 是 Cocoa 级参数、只在 BrowserWindow 构造时读一次,
  // 用户切完开关下次启动才生效——单独渲染一行"需要重启应用"避免和主 hint 混在
  // 同一段落里被忽略。Windows 上是 renderer JS 即时生效,不加提示。
  const isMac = window.electronAPI?.platform === 'darwin';
  // swallowActivationClick 仅 mac/win 有效,Linux 上隐藏该行;keepAwake 跨平台常驻。
  const showsSwallowActivationClick = isMac || window.electronAPI?.platform === 'win32';
  const isWindows = window.electronAPI?.platform === 'win32';
  const isLinux = window.electronAPI?.platform === 'linux';
  const [closeBehavior, setCloseBehaviorState] = useState<DesktopCloseBehavior | null>(null);

  useEffect(() => {
    if (!isWindows && !isLinux) return;
    let active = true;
    const getCloseBehavior = isWindows
      ? window.electronAPI.windowBehavior.getWindowsCloseBehavior
      : window.electronAPI.windowBehavior.getLinuxCloseBehavior;
    void getCloseBehavior()
      .then((behavior) => {
        if (active) setCloseBehaviorState(behavior);
      })
      .catch(() => {
        // Keep the unselected first-close state if main is unavailable.
      });
    return () => {
      active = false;
    };
  }, [isLinux, isWindows]);

  const setCloseBehavior = (behavior: DesktopCloseBehavior): void => {
    const previous = closeBehavior;
    setCloseBehaviorState(behavior);
    const update =
      isLinux && isLinuxCloseBehavior(behavior)
        ? window.electronAPI.windowBehavior.setLinuxCloseBehavior(behavior)
        : isWindows && isWindowsCloseBehavior(behavior)
          ? window.electronAPI.windowBehavior.setWindowsCloseBehavior(behavior)
          : Promise.reject(new Error('Unsupported close behavior for this platform'));
    void update.catch(() => {
      setCloseBehaviorState(previous);
    });
  };

  const closeBehaviorOptions: readonly DesktopCloseBehavior[] = isLinux
    ? ['minimize', 'quit']
    : ['tray', 'quit'];

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.windowBehavior.title')}
      </h2>

      <BehaviorCard
        label={t('settings.devices.keepAwake')}
        hint={t('settings.devices.keepAwakeHint')}
        checked={keepAwake}
        onCheckedChange={(v) => void setKeepAwake(v)}
        ariaLabel={t('settings.devices.keepAwake')}
      />

      {(isWindows || isLinux) && (
        <div
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl p-5',
            'bg-[var(--settings-theme-card-bg)]',
            'border border-[var(--settings-theme-card-border)]',
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-13 font-medium text-[var(--settings-section-sublabel)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.windowBehavior.closeBehavior.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.windowBehavior.closeBehavior.hint')}
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label={t('settings.windowBehavior.closeBehavior.aria')}
            className="flex w-fit shrink-0 items-center gap-0.5 rounded-full border border-[var(--settings-theme-card-border)] p-0.5"
          >
            {closeBehaviorOptions.map((behavior) => {
              const active = closeBehavior === behavior;
              return (
                <button
                  key={behavior}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setCloseBehavior(behavior)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs transition-colors',
                    active
                      ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)]'
                      : 'text-[var(--settings-section-sublabel)] hover:bg-sidebar-item-hover',
                  )}
                >
                  {t(`settings.windowBehavior.closeBehavior.${behavior}`)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showsSwallowActivationClick && (
        <BehaviorCard
          label={t('settings.windowBehavior.swallowActivationClickLabel')}
          hint={t('settings.windowBehavior.swallowActivationClickHint')}
          note={
            isMac ? (
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.windowBehavior.macRestartNote')}
              </p>
            ) : undefined
          }
          checked={enabled}
          onCheckedChange={setEnabled}
          ariaLabel={t('settings.windowBehavior.swallowActivationClickAria')}
        />
      )}
    </div>
  );
}
