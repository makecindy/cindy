import { windowBehaviorSettings } from './WindowBehaviorSection.settings-search';
/**
 * WindowBehaviorSection — 「应用行为」section:本机相关的应用级开关。
 *
 * 应用设置:
 *  - 登录电脑后自动启动:Windows / macOS 的系统登录启动项,默认不注册。
 *  - 菜单栏余量:macOS 14+ 的原生菜单栏项,默认开启。
 *  1. 「保持电脑唤醒」(keepAwake):main 用 powerSaveBlocker 防系统休眠、放行锁屏,
 *     让后台 agent / 定时任务持续运行。跨平台生效(mac/win/linux),故常驻显示。
 *  - 离开时继续工作(awayGuard,macOS 14+):任务进行中不熄屏，主人离开后由防窥遮罩
 *    覆盖，本机一有输入即系统锁屏。见 main/remote-desktop/awayGuard.ts。
 *  2. 「关闭主窗口时」:Windows 选择退出或收起到托盘,Linux 选择退出或最小化。
 *  3. 「后台窗口首次左键点击仅激活不透传」(swallowActivationClick,PR #446):仅
 *     macOS + Windows 有实际效果,Linux 上两条底层路径均 no-op,故该行在 Linux 隐藏。
 *
 * 各项放在同一张 SettingsCard 里、以分割线隔开,与「协同」「Agent 资源占用」同一套设置行
 * (settings-rows)。平台不支持的行不渲染,分割线只出现在可见行之间。
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';

import { Switch } from '@/components/ui/switch';
import { SETTINGS_HINT, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useSwallowActivationClickSettings } from '@/hooks/useSwallowActivationClickSettings';
import { useKeepAwakeSetting } from '@/hooks/useKeepAwakeSetting';
import { useAwayGuardSetting } from '@/hooks/useAwayGuardSetting';
import { useLoginItemSetting } from '@/hooks/useLoginItemSetting';
import { useMenubarSetting } from '@/hooks/useMenubarSetting';
import { isAwayGuardDelaySeconds } from '../../../shared/awayGuard';
import {
  isLinuxCloseBehavior,
  isWindowsCloseBehavior,
  type LinuxCloseBehavior,
  type WindowsCloseBehavior,
} from '../../../shared/windowBehavior';

type DesktopCloseBehavior = LinuxCloseBehavior | WindowsCloseBehavior;

/** 一行开关:左侧标签 + 说明(+ 可选补充说明行),右侧开关。 */
function BehaviorRow({
  id,
  'data-setting-id': settingId,
  label,
  hint,
  note,
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
}: {
  id?: string;
  'data-setting-id': string;
  label: string;
  hint: string;
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      id={id}
      title={label}
      hint={
        <span className="flex flex-col gap-1">
          <span className="whitespace-pre-line">{hint}</span>
          {note}
        </span>
      }
      trailing={
        <Switch data-setting-id={settingId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={ariaLabel}
          disabled={disabled}
        />
      }
    />
  );
}

export function WindowBehaviorSection() {
  const { enabled, setEnabled } = useSwallowActivationClickSettings();
  const { keepAwake, setKeepAwake } = useKeepAwakeSetting();
  const loginItem = useLoginItemSetting();
  const menubar = useMenubarSetting();
  const awayGuard = useAwayGuardSetting();
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

  const rows: { key: string; node: ReactNode }[] = [
    {
      key: 'keep-awake',
      node: (
        <BehaviorRow
          id={windowBehaviorSettings.devicesKeepAwake.targetId}
          data-setting-id={windowBehaviorSettings.devicesKeepAwake.id}
          label={t(windowBehaviorSettings.devicesKeepAwake.titleKey)}
          hint={t(windowBehaviorSettings.devicesKeepAwake.descriptionKey)}
          checked={keepAwake}
          onCheckedChange={(v) => void setKeepAwake(v)}
          ariaLabel={t(windowBehaviorSettings.devicesKeepAwake.titleKey)}
        />
      ),
    },
  ];

  if (awayGuard.available) {
    rows.push({
      key: 'away-guard',
      node: (
        <BehaviorRow
          id={windowBehaviorSettings.awayGuard.targetId}
          data-setting-id={windowBehaviorSettings.awayGuard.id}
          label={t(windowBehaviorSettings.awayGuard.titleKey)}
          hint={t(windowBehaviorSettings.awayGuard.descriptionKey)}
          checked={awayGuard.state?.enabled === true}
          disabled={awayGuard.busy}
          onCheckedChange={(enabled) => void awayGuard.setEnabled(enabled)}
          ariaLabel={t(windowBehaviorSettings.awayGuard.titleKey)}
          note={
            <div className="flex flex-col items-start gap-2 pt-1">
              {awayGuard.preview === 'permission' ||
              (awayGuard.state?.enabled && awayGuard.state.permission === 'missing') ? (
                <p className={SETTINGS_HINT} role="status">
                  {t('settings.windowBehavior.awayGuard.permission')}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                <Button
                  data-settings-search-action="Shows the away cover now so the owner can check locking and unlocking"
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={awayGuard.preview === 'starting'}
                  onClick={() => void awayGuard.startPreview()}
                >
                  {t('settings.windowBehavior.awayGuard.preview')}
                </Button>
                {awayGuard.preview === 'starting' ? (
                  <p className={SETTINGS_HINT}>
                    {t('settings.windowBehavior.awayGuard.previewStarting')}
                  </p>
                ) : awayGuard.preview === 'unavailable' ? (
                  <p className={SETTINGS_HINT} role="alert">
                    {t('settings.windowBehavior.awayGuard.previewUnavailable')}
                  </p>
                ) : null}
              </div>
            </div>
          }
        />
      ),
    });
  }

  if (awayGuard.available && awayGuard.state?.enabled) {
    rows.push({
      key: 'away-guard-delay',
      node: (
        <SettingsRow
          className="cindy-segmented-row"
          title={
            <span id={windowBehaviorSettings.awayGuardDelay.targetId}>
              {t(windowBehaviorSettings.awayGuardDelay.titleKey)}
            </span>
          }
          hint={t(windowBehaviorSettings.awayGuardDelay.descriptionKey)}
          trailing={
            <SegmentedControl data-setting-id={windowBehaviorSettings.awayGuardDelay.id}
              aria-label={t(windowBehaviorSettings.awayGuardDelay.titleKey)}
              value={String(awayGuard.state.delaySeconds ?? 'system')}
              onValueChange={(value) => {
                const seconds = Number(value);
                void awayGuard.setDelay(isAwayGuardDelaySeconds(seconds) ? seconds : null);
              }}
              options={windowBehaviorSettings.awayGuardDelay.options.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            />
          }
        />
      ),
    });
  }

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
