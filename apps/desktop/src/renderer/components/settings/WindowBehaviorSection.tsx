/**
 * WindowBehaviorSection — 「应用行为」section:本机相关的应用级开关。
 *
 * 五项设置:
 *  1. 「保持电脑唤醒」(keepAwake):main 用 powerSaveBlocker 防系统休眠、放行锁屏,
 *     让后台 agent / 定时任务持续运行。跨平台生效(mac/win/linux),故常驻显示。
 *  2. 「开机时启动 Cindy」(launchAtLogin):仅 Windows 显示。事实源是操作系统登录项,
 *     每次挂载都重新查询——用户可能在任务管理器「启动应用」里禁用过它。
 *  3. 「开机启动时收起到托盘」(startInTrayOnLogin):仅 Windows 显示,依赖第 2 项,
 *     关着时置灰。只影响登录项拉起的那次启动,手动双击图标仍正常显示窗口。
 *  4. 「关闭主窗口时」(windowsCloseBehavior):仅 Windows 显示,选择退出或收起到托盘。
 *  5. 「后台窗口首次左键点击仅激活不透传」(swallowActivationClick,PR #446):仅
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
import type { WindowsCloseBehavior } from '../../../shared/windowBehavior';

/** 一张开关卡片:左侧标签 + 说明(+ 可选补充说明行),右侧开关。 */
function BehaviorCard({
  label,
  hint,
  note,
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
}: {
  label: string;
  hint: string;
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
  /** 依赖项未满足时置灰(仍渲染,让用户看得到这个能力的存在与前置条件)。 */
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      {/* 只让文字区跟随禁用态变淡:Switch 自己有 --switch-disabled-* token
          表达不可用,外层再叠一层整体透明度会把它压成两级灰。 */}
      <div className={cn('flex min-w-0 flex-col gap-1', disabled && 'opacity-60')}>
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

      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        disabled={disabled}
      />
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
  const [windowsCloseBehavior, setWindowsCloseBehaviorState] =
    useState<WindowsCloseBehavior | null>(null);
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);
  const [startInTrayOnLogin, setStartInTrayOnLoginState] = useState(false);

  useEffect(() => {
    if (!isWindows) return;
    let active = true;
    void window.electronAPI.windowBehavior
      .getWindowsCloseBehavior()
      .then((behavior) => {
        if (active) setWindowsCloseBehaviorState(behavior);
      })
      .catch(() => {
        // Keep the unselected first-close state if main is unavailable.
      });
    return () => {
      active = false;
    };
  }, [isWindows]);

  // 登录项的事实源是操作系统:用户可能在任务管理器「启动应用」里禁用它,
  // 所以每次进设置页都重新查询,不缓存。
  useEffect(() => {
    if (!isWindows) return;
    let active = true;
    void window.electronAPI.windowBehavior
      .getLaunchAtLogin()
      .then((state) => {
        if (!active) return;
        setLaunchAtLoginState(state.launchAtLogin);
        setStartInTrayOnLoginState(state.startInTrayOnLogin);
      })
      .catch(() => {
        // Leave both switches off when main cannot report the login item state.
      });
    return () => {
      active = false;
    };
  }, [isWindows]);

  const setWindowsCloseBehavior = (behavior: WindowsCloseBehavior): void => {
    const previous = windowsCloseBehavior;
    setWindowsCloseBehaviorState(behavior);
    void window.electronAPI.windowBehavior.setWindowsCloseBehavior(behavior).catch(() => {
      setWindowsCloseBehaviorState(previous);
    });
  };

  const setLaunchAtLogin = (next: boolean): void => {
    const previous = launchAtLogin;
    setLaunchAtLoginState(next);
    void window.electronAPI.windowBehavior
      .setLaunchAtLogin(next)
      // main 回传写入后的事实状态:改登录项失败时它仍是旧值,UI 要跟着退回,
      // 不能停留在用户以为已生效的乐观态。
      .then((applied) => setLaunchAtLoginState(applied))
      .catch(() => setLaunchAtLoginState(previous));
  };

  const setStartInTrayOnLogin = (next: boolean): void => {
    const previous = startInTrayOnLogin;
    setStartInTrayOnLoginState(next);
    void window.electronAPI.windowBehavior
      .setStartInTrayOnLogin(next)
      .catch(() => setStartInTrayOnLoginState(previous));
  };

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

      {isWindows && (
        <>
          <BehaviorCard
            label={t('settings.windowBehavior.launchAtLogin.label')}
            hint={t('settings.windowBehavior.launchAtLogin.hint')}
            checked={launchAtLogin}
            onCheckedChange={setLaunchAtLogin}
            ariaLabel={t('settings.windowBehavior.launchAtLogin.label')}
          />

          <BehaviorCard
            label={t('settings.windowBehavior.startInTrayOnLogin.label')}
            hint={t('settings.windowBehavior.startInTrayOnLogin.hint')}
            checked={startInTrayOnLogin}
            onCheckedChange={setStartInTrayOnLogin}
            ariaLabel={t('settings.windowBehavior.startInTrayOnLogin.label')}
            // 只在开机自启时生效,自启动关着时这项没有意义——置灰而不是隐藏,
            // 让用户看到这个能力存在以及它的前置条件。
            disabled={!launchAtLogin}
          />

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
              {(['tray', 'quit'] as const).map((behavior) => {
                const active = windowsCloseBehavior === behavior;
                return (
                  <button
                    key={behavior}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setWindowsCloseBehavior(behavior)}
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
        </>
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
