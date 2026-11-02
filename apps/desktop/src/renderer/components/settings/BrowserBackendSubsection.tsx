/**
 * BrowserBackendSubsection —「自动操作浏览器」卡片里的一行,segmented 切换
 * "侧边栏内置浏览器 / 独立外置浏览器"。
 *
 * 纯 UI(dumb component):active kind / pending / onSelect 都从父组件
 * (ComputerUseSection) 拿。父组件根据 `active` 决定整张卡片其它 cell 是否
 * 渲染(外部 backend 才显示 Chrome 探测 + 打开登录入口)。
 *
 * 使用统一的 SegmentedControl 呈现设置单选状态。
 */

import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Download, Puzzle, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Button } from '@/components/ui/button';
import type {
  BrowserBackendHealth,
  BrowserBackendHealthReason,
} from '../../../shared/browserBackend';

type BackendKind = 'external' | 'rsb-webview' | 'user-browser';

interface BrowserBackendSubsectionProps {
  active: BackendKind;
  pending: boolean;
  recovering: boolean;
  health: BrowserBackendHealth | null;
  onSelect: (kind: BackendKind) => void;
  onRecover: () => void;
  /**
   * 推荐的页面控制插件在本机的状态,决定第 1 步写「安装」「启用」还是「更新」:
   * 已启用却仍报缺插件,说明装的版本还不支持「我的浏览器」。
   */
  userBrowserPluginState?: 'not-installed' | 'disabled' | 'enabled';
  /** 第 1 步就地安装或启用推荐插件;第 2 步打开插件详情,里面有装浏览器扩展的入口。 */
  onSetUpUserBrowser?: () => void;
  /** 正在就地安装或启用插件。 */
  userBrowserSetupBusy?: boolean;
}

const BACKEND_DESCRIPTION_KEYS: Record<BackendKind, string> = {
  'rsb-webview': 'settings.computerUse.browserBackend.rsbWebview.description',
  external: 'settings.computerUse.browserBackend.external.description',
  'user-browser': 'settings.computerUse.browserBackend.userBrowser.description',
};

const SETUP_KEY = 'settings.computerUse.browserBackend.userBrowserSetup';
const PLUGIN_STEP_KEYS = {
  'not-installed': {
    title: `${SETUP_KEY}.installPluginTitle`,
    body: `${SETUP_KEY}.pluginBody`,
    action: `${SETUP_KEY}.installPlugin`,
  },
  disabled: {
    title: `${SETUP_KEY}.enablePluginTitle`,
    body: `${SETUP_KEY}.pluginBody`,
    action: `${SETUP_KEY}.enablePlugin`,
  },
  enabled: {
    title: `${SETUP_KEY}.updatePluginTitle`,
    body: `${SETUP_KEY}.updatePluginBody`,
    action: `${SETUP_KEY}.updatePlugin`,
  },
} as const;

function healthReasonKey(reason: BrowserBackendHealthReason | undefined): string {
  switch (reason) {
    case 'disposing':
      return 'settings.computerUse.browserBackend.health.reasons.disposing';
    case 'host-unavailable':
      return 'settings.computerUse.browserBackend.health.reasons.hostUnavailable';
    case 'start-failed':
      return 'settings.computerUse.browserBackend.health.reasons.startFailed';
    case 'recovery-failed':
      return 'settings.computerUse.browserBackend.health.reasons.recoveryFailed';
    case 'extension-disconnected':
      return 'settings.computerUse.browserBackend.health.reasons.extensionDisconnected';
    case 'plugin-missing':
      return 'settings.computerUse.browserBackend.health.reasons.pluginMissing';
    case 'status-failed':
    default:
      return 'settings.computerUse.browserBackend.health.reasons.statusFailed';
  }
}

export function BrowserBackendSubsection({
  active,
  pending,
  recovering,
  health,
  onSelect,
  onRecover,
  userBrowserPluginState = 'not-installed',
  onSetUpUserBrowser,
  userBrowserSetupBusy = false,
}: BrowserBackendSubsectionProps) {
  const { t } = useTranslation();
  const embeddedHealth =
    active === 'rsb-webview' && health?.active === 'rsb-webview' ? health : null;
  // 「我的浏览器」只有连接状态可报,没有可恢复的宿主侧控制连接。
  const userBrowserHealth =
    active === 'user-browser' && health?.active === 'user-browser' ? health : null;
  return (
    <div className="border-t border-[var(--settings-theme-card-border)]">
      <div className="cindy-segmented-row px-4 py-[14px]">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-12 font-medium leading-[1.4] text-[var(--settings-section-title)]">
            {t('settings.computerUse.browserBackend.title')}
          </p>
          {/* 选中哪个就介绍哪个,切换时一起变。 */}
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]" aria-live="polite">
            {t(BACKEND_DESCRIPTION_KEYS[active])}
          </p>
        </div>
        <SegmentedControl<BackendKind>
          value={active}
          disabled={pending}
          onValueChange={onSelect}
          aria-label={t('settings.computerUse.browserBackend.title')}
          options={[
            {
              value: 'rsb-webview',
              label: t('settings.computerUse.browserBackend.rsbWebview.title'),
            },
            { value: 'external', label: t('settings.computerUse.browserBackend.external.title') },
            {
              value: 'user-browser',
              label: t('settings.computerUse.browserBackend.userBrowser.title'),
            },
          ]}
        />
      </div>
      {embeddedHealth ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div
            className={cn(
              'flex min-w-0 flex-1 items-start gap-2 text-12 leading-[1.5]',
              embeddedHealth.status === 'error'
                ? 'text-[var(--error-fg)]'
                : 'text-[var(--settings-section-desc)]',
            )}
            role={embeddedHealth.status === 'error' ? 'alert' : 'status'}
          >
            {embeddedHealth.status === 'error' ? (
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            )}
            <span>
              {embeddedHealth.status === 'error'
                ? t('settings.computerUse.browserBackend.health.error', {
                    reason: t(healthReasonKey(embeddedHealth.reason)),
                  })
                : t('settings.computerUse.browserBackend.health.ready')}
            </span>
          </div>
          <Button
            variant="secondary"
            loading={recovering}
            type="button"
            onClick={onRecover}
            disabled={pending || !embeddedHealth.canRecover}
          >
            <RefreshCw size={12} />
            {embeddedHealth.status === 'error'
              ? t('settings.computerUse.browserBackend.health.recover')
              : t('settings.computerUse.browserBackend.health.reconnect')}
          </Button>
        </div>
      ) : null}
      {userBrowserHealth &&
      userBrowserHealth.status === 'error' &&
      (userBrowserHealth.reason === 'plugin-missing' ||
        userBrowserHealth.reason === 'extension-disconnected') ? (
        // 「我的浏览器」还差一步:说清缺的是哪一步,并给出直接去做的按钮;连上后父组件轮询会自动变绿。
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div
            className="flex min-w-0 flex-1 basis-[280px] items-start gap-2 text-12 leading-[1.5]"
            role="status"
          >
            {userBrowserHealth.reason === 'plugin-missing' ? (
              <Puzzle size={14} className="mt-0.5 shrink-0 text-[var(--settings-section-desc)]" />
            ) : (
              <Download size={14} className="mt-0.5 shrink-0 text-[var(--settings-section-desc)]" />
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-[var(--settings-section-title)]">
                {t(
                  userBrowserHealth.reason === 'plugin-missing'
                    ? PLUGIN_STEP_KEYS[userBrowserPluginState].title
                    : 'settings.computerUse.browserBackend.userBrowserSetup.installExtensionTitle',
                )}
              </span>
              <span className="text-[var(--settings-section-desc)]">
                {t(
                  userBrowserHealth.reason === 'plugin-missing'
                    ? PLUGIN_STEP_KEYS[userBrowserPluginState].body
                    : 'settings.computerUse.browserBackend.userBrowserSetup.extensionBody',
                )}
              </span>
            </div>
          </div>
          {onSetUpUserBrowser ? (
            <Button
              variant="secondary"
              type="button"
              loading={userBrowserSetupBusy}
              onClick={onSetUpUserBrowser}
              disabled={pending || userBrowserSetupBusy}
            >
              {t(
                userBrowserHealth.reason === 'plugin-missing'
                  ? PLUGIN_STEP_KEYS[userBrowserPluginState].action
                  : 'settings.computerUse.browserBackend.userBrowserSetup.installExtension',
              )}
            </Button>
          ) : null}
        </div>
      ) : userBrowserHealth ? (
        <div
          className={cn(
            'flex items-start gap-2 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px] text-12 leading-[1.5]',
            userBrowserHealth.status === 'error'
              ? 'text-[var(--error-fg)]'
              : 'text-[var(--settings-section-desc)]',
          )}
          role={userBrowserHealth.status === 'error' ? 'alert' : 'status'}
        >
          {userBrowserHealth.status === 'error' ? (
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          )}
          <span>
            {userBrowserHealth.status === 'error'
              ? t('settings.computerUse.browserBackend.health.userBrowserError', {
                  reason: t(healthReasonKey(userBrowserHealth.reason)),
                })
              : t('settings.computerUse.browserBackend.health.userBrowserReady')}
          </span>
        </div>
      ) : null}
    </div>
  );
}
