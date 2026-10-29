/**
 * WindowBehaviorSection — 「应用行为」section:本机相关的应用级开关。
 *
 * 应用设置:
 *  - 登录电脑后自动启动:Windows / macOS 的系统登录启动项,默认不注册。
 *  - 菜单栏余量:macOS 14+ 的原生菜单栏项,默认开启。
 *  1. 「保持电脑唤醒」(keepAwake):main 用 powerSaveBlocker 防系统休眠、放行锁屏,
 *     让后台 agent / 定时任务持续运行。跨平台生效(mac/win/linux),故常驻显示。
 *  2. 「关闭主窗口时」:Windows 选择退出或收起到托盘,Linux 选择退出或最小化。
 *  3. 「后台窗口首次左键点击仅激活不透传」(swallowActivationClick,PR #446):仅
 *     macOS + Windows 有实际效果,Linux 上两条底层路径均 no-op,故该行在 Linux 隐藏。
 *
 * 各项放在同一张卡片里、以分割线隔开,与「协同」「Agent 资源占用」同一套设置行样式
 * (settingsRowClasses)。平台不支持的行不渲染,分割线只出现在可见行之间。
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';
import { useSwallowActivationClickSettings } from '@/hooks/useSwallowActivationClickSettings';
import { useKeepAwakeSetting } from '@/hooks/useKeepAwakeSetting';
import { useLoginItemSetting } from '@/hooks/useLoginItemSetting';
import { useMenubarSetting } from '@/hooks/useMenubarSetting';
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
  label,
  hint,
  note,
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
}: {
  id?: string;
  label: string;
  hint: string;
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div id={id} className={SETTINGS_ROW_CLASS}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
          {label}
        </p>
        <p className={cn('whitespace-pre-line', SETTINGS_ROW_HINT_CLASS)}>
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

  const rows: { key: string; node: ReactNode }[] = [
    {
      key: 'keep-awake',
      node: (
        <BehaviorRow
          id="settings-search-settings-devices-keepAwake"
          label={t('settings.devices.keepAwake')}
          hint={t('settings.devices.keepAwakeHint')}
          checked={keepAwake}
          onCheckedChange={(v) => void setKeepAwake(v)}
          ariaLabel={t('settings.devices.keepAwake')}
        />
      ),
    },
  ];

  if (loginItem.supported) {
    rows.push({
      key: 'login-item',
      node: (
        <BehaviorRow
          id="settings-search-login-item"
          label={t('settings.windowBehavior.loginItem.label')}
          hint={t('settings.windowBehavior.loginItem.hint')}
          checked={Boolean(loginItem.state?.enabled || loginItem.state?.requiresApproval)}
          disabled={!loginItem.state?.available || loginItem.busy}
          onCheckedChange={(enabled) => void loginItem.setEnabled(enabled)}
          ariaLabel={t('settings.windowBehavior.loginItem.label')}
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
          id="settings-search-menubar"
          label={t('settings.windowBehavior.menubar.label')}
          hint={t('settings.windowBehavior.menubar.hint')}
          checked={menubar.state?.enabled === true}
          disabled={menubar.busy}
          onCheckedChange={(enabled) => void menubar.setEnabled(enabled)}
          ariaLabel={t('settings.windowBehavior.menubar.label')}
        />
      ),
    });
  }

  if (isWindows || isLinux) {
    rows.push({
      key: 'close-behavior',
      node: (
        <div className="cindy-segmented-row px-4 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p id="settings-search-settings-windowBehavior-closeBehavior-label"
              className={SETTINGS_ROW_LABEL_CLASS}
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.windowBehavior.closeBehavior.label')}
            </p>
            <p className={SETTINGS_ROW_HINT_CLASS}>
              {t('settings.windowBehavior.closeBehavior.hint')}
            </p>
          </div>

          <SegmentedControl
            aria-label={t('settings.windowBehavior.closeBehavior.aria')}
            value={closeBehavior}
            onValueChange={setCloseBehavior}
            options={closeBehaviorOptions.map((behavior) => ({
              value: behavior,
              label: t(`settings.windowBehavior.closeBehavior.${behavior}`),
            }))}
          />
        </div>
      ),
    });
  }

  if (showsSwallowActivationClick) {
    rows.push({
      key: 'activation-click',
      node: (
        <BehaviorRow
          id="settings-search-activation-click"
          label={t('settings.windowBehavior.swallowActivationClickLabel')}
          hint={t('settings.windowBehavior.swallowActivationClickHint')}
          note={
            isMac ? (
              <p className={SETTINGS_ROW_HINT_CLASS}>
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
    <div className="flex flex-col gap-[14px]">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>
        {t('settings.windowBehavior.title')}
      </h2>

      <div className={SETTINGS_CARD_CLASS}>
        {rows.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? <div className={SETTINGS_ROW_DIVIDER_CLASS} /> : null}
            {row.node}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
