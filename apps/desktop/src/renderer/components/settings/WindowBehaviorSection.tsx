import { windowBehaviorSettings } from './WindowBehaviorSection.settings-search';
/**
 * WindowBehaviorSection — 「应用行为」section:本机相关的应用级开关。
 *
 * 应用设置:
 *  - 登录电脑后自动启动:Windows / macOS 的系统登录启动项,默认不注册。
 *  - 菜单栏余量:macOS 14+ 的原生菜单栏项,默认开启。
 *  「保持电脑唤醒」与「用隐私屏代替锁屏」已移到「离开电脑时」分组(AwayFromComputerSection,
 *  见 docs/product-rules/privacy-screen.md)。
 *  2. 「关闭主窗口时」:Windows 选择退出或收起到托盘,Linux 选择退出或最小化。
 *  3. 「后台窗口首次左键点击仅激活不透传」(swallowActivationClick,PR #446):仅
 *     macOS + Windows 有实际效果,Linux 上两条底层路径均 no-op,故该行在 Linux 隐藏。
 *
 * 各项放在同一张 SettingsCard 里、以分割线隔开,与「协同」「Agent 资源占用」同一套设置行
 * (settings-rows)。平台不支持的行不渲染,分割线只出现在可见行之间。
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';

import { SETTINGS_HINT, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useSwallowActivationClickSettings } from '@/hooks/useSwallowActivationClickSettings';
import { BehaviorRow } from './BehaviorRow';
import { useLoginItemSetting } from '@/hooks/useLoginItemSetting';
import { useMenubarSetting } from '@/hooks/useMenubarSetting';
import {
  isLinuxCloseBehavior,
  isWindowsCloseBehavior,
  type LinuxCloseBehavior,
  type WindowsCloseBehavior,
} from '../../../shared/windowBehavior';

type DesktopCloseBehavior = LinuxCloseBehavior | WindowsCloseBehavior;

export function WindowBehaviorSection() {
  const { enabled, setEnabled } = useSwallowActivationClickSettings();
  const loginItem = useLoginItemSetting();
  const menubar = useMenubarSetting();
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

  const rows: { key: string; node: ReactNode }[] = [];

  if (loginItem.supported) {
    rows.push({
      key: 'login-item',
      node: (
        <BehaviorRow
          id={windowBehaviorSettings.loginItemLabel.targetId}
          data-setting-id={windowBehaviorSettings.loginItemLabel.id}
          label={t(windowBehaviorSettings.loginItemLabel.titleKey)}
          hint={t(windowBehaviorSettings.loginItemLabel.descriptionKey)}
          checked={Boolean(loginItem.state?.enabled || loginItem.state?.requiresApproval)}
          disabled={!loginItem.state?.available || loginItem.busy}
          onCheckedChange={(enabled) => void loginItem.setEnabled(enabled)}
          ariaLabel={t(windowBehaviorSettings.loginItemLabel.titleKey)}
          note={
            <div
              className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)]"
              aria-live="polite"
            >
              {loginItem.error ? (
                <p role="alert">{t(`settings.windowBehavior.loginItem.${loginItem.error}`)}</p>
              ) : loginItem.state?.requiresApproval ? (
                <p>{t('settings.windowBehavior.loginItem.requiresApproval')}</p>
              ) : loginItem.busy ? (
                <p>{t('settings.windowBehavior.loginItem.loading')}</p>
              ) : null}
            </div>
          }
        />
      ),
    });
  }

  if (menubar.available) {
    rows.push({
      key: 'menubar',
      node: (
        <BehaviorRow
          id={windowBehaviorSettings.menubarLabel.targetId}
          data-setting-id={windowBehaviorSettings.menubarLabel.id}
          label={t(windowBehaviorSettings.menubarLabel.titleKey)}
          hint={t(windowBehaviorSettings.menubarLabel.descriptionKey)}
          checked={menubar.state?.enabled === true}
          disabled={menubar.busy}
          onCheckedChange={(enabled) => void menubar.setEnabled(enabled)}
          ariaLabel={t(windowBehaviorSettings.menubarLabel.titleKey)}
        />
      ),
    });
  }

  if (isWindows || isLinux) {
    rows.push({
      key: 'close-behavior',
      node: (
        <SettingsRow
          className="cindy-segmented-row"
          title={
            <span id={windowBehaviorSettings.closeBehaviorLabel.targetId}>
              {t(windowBehaviorSettings.closeBehaviorLabel.titleKey)}
            </span>
          }
          hint={t(windowBehaviorSettings.closeBehaviorLabel.descriptionKey)}
          trailing={
            <SegmentedControl data-setting-id={windowBehaviorSettings.closeBehaviorLabel.id}
              aria-label={t('settings.windowBehavior.closeBehavior.aria')}
              value={closeBehavior}
              onValueChange={setCloseBehavior}
              options={closeBehaviorOptions.map((behavior) => ({
                value: behavior,
                label: t(`settings.windowBehavior.closeBehavior.${behavior}`),
              }))}
            />
          }
        />
      ),
    });
  }

  if (showsSwallowActivationClick) {
    rows.push({
      key: 'activation-click',
      node: (
        <BehaviorRow
          id={windowBehaviorSettings.swallowActivationClickLabel.targetId}
          data-setting-id={windowBehaviorSettings.swallowActivationClickLabel.id}
          label={t(windowBehaviorSettings.swallowActivationClickLabel.titleKey)}
          hint={t(windowBehaviorSettings.swallowActivationClickLabel.descriptionKey)}
          note={
            isMac ? (
              <p className={SETTINGS_HINT}>
                {t('settings.windowBehavior.macRestartNote')}
              </p>
            ) : undefined
          }
          checked={enabled}
          onCheckedChange={setEnabled}
          ariaLabel={t('settings.windowBehavior.swallowActivationClickAria')}
        />
      ),
    });
  }

  return (
    <SettingsSection title={t('settings.windowBehavior.title')}>
      <SettingsCard>
        {rows.map((row) => (
          <Fragment key={row.key}>{row.node}</Fragment>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
