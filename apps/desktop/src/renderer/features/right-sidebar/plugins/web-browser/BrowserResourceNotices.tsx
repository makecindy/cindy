import { Gauge, RotateCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { forceKillBrowserTab } from '../../lib/rsbBrowserBridge';
import type { UseBrowserWebviewResult } from '../../hooks/useBrowserWebview';

interface BrowserResourceNoticesProps extends Pick<UseBrowserWebviewResult, 'crash' | 'resourceAlert' | 'dismissResourceAlert'> {
  tabId: string;
  tabVisible: boolean;
  onRecover: () => void;
}

export function BrowserResourceNotices({
  tabId, tabVisible, crash, resourceAlert, dismissResourceAlert, onRecover,
}: BrowserResourceNoticesProps) {
  const { t } = useTranslation();
  return (
    <>
      {crash && (
        <BrowserCrashBanner
          reason={crash.reason}
          cause={crash.cause}
          onRecover={onRecover}
          onForceKill={
            crash.reason === 'unresponsive'
              ? () => void forceKillBrowserTab(tabId)
              : undefined
          }
        />
      )}
      {/* 资源看门狗 cpu-alert 提示条:非阻断,固定在 slot 顶部居中。用户可
          「强制终止」失控页面,或「忽略」继续(可能是正经的重页面)。 */}
      {!crash && resourceAlert && (
        <div
          className={cn(
            'absolute left-1/2 top-2 z-10 flex w-max max-w-[calc(100%_-_1rem)] -translate-x-1/2 items-center gap-2',
            'rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            'py-1 pl-3 pr-1 text-11 text-[var(--text-secondary)] shadow-[shadow:var(--shadow-menu)]',
          )}
        >
          <Gauge size={12} strokeWidth={2} className="shrink-0 text-[var(--warning-fg)]" />
          <span>{t('rightSidebar.browser.resourceAlert.cpuHint')}</span>
          <Button
            variant="secondary"
            size="xxs"
            compact
            tone="danger"
            type="button"
            onClick={() => {
              dismissResourceAlert();
              void forceKillBrowserTab(tabId);
            }}
          >
            {t('rightSidebar.browser.resourceAlert.terminate')}
          </Button>
          <Tip text={t('rightSidebar.browser.resourceAlert.dismiss')} side="bottom" disabled={!tabVisible}>
            <button
              type="button"
              aria-label={t('rightSidebar.browser.resourceAlert.dismiss')}
              onClick={dismissResourceAlert}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </Tip>
        </div>
      )}
    </>
  );
}

/**
 * 崩溃 banner —— absolute 覆盖整个 webview slot,半透明黑底 + 中心一个卡片。
 * Codex 也对崩溃做 UI 反馈(`render-process-gone` 事件链),Chrome 在 tab 内显示
 * "Aw, Snap!" 页。我们做精简版:图标 + 原因 + 重载按钮。
 *
 * `cause === 'resource-memory'`:资源看门狗因内存超限主动终止(不是页面自己崩),
 * 换专属文案让用户明白"是保护机制在工作"。`onForceKill` 只在 unresponsive 时传:
 * 卡死的 guest 进程还在烧 CPU,「强制终止」给用户一个立即止损的出口(终止后
 * 走 render-process-gone → 本 banner 切到 crashed 文案 → 重新加载恢复)。
 */
function BrowserCrashBanner({
  reason,
  cause,
  onRecover,
  onForceKill,
}: {
  reason: string;
  cause?: 'resource-memory';
  onRecover: () => void;
  onForceKill?: () => void;
}) {
  const { t } = useTranslation();
  // 区分资源终止、导航熔断、unresponsive 与进程崩溃。沿用同一个克制的恢复
  // banner,不新增布局或视觉分支。
  const titleKey =
    cause === 'resource-memory'
      ? 'rightSidebar.browser.crash.resourceKilledTitle'
      : reason === 'navigation-loop'
        ? 'rightSidebar.browser.crash.navigationLoopTitle'
        : reason === 'unresponsive'
          ? 'rightSidebar.browser.crash.unresponsiveTitle'
          : 'rightSidebar.browser.crash.crashedTitle';
  const descKey =
    cause === 'resource-memory'
      ? 'rightSidebar.browser.crash.resourceKilledDesc'
      : reason === 'navigation-loop'
        ? 'rightSidebar.browser.crash.navigationLoopDesc'
        : reason === 'unresponsive'
          ? 'rightSidebar.browser.crash.unresponsiveDesc'
          : 'rightSidebar.browser.crash.crashedDesc';
  return (
    <div className="modal-scrim absolute inset-0 flex items-center justify-center">
      <ErrorNotice className="modal-panel max-w-xs" message={t(titleKey)} description={t(descKey)} actions={<>
          <Button size="sm" compact type="button" onClick={onRecover}>
            <RotateCw size={12} strokeWidth={2.5} />
            {t('rightSidebar.browser.crash.reload')}
          </Button>
          {onForceKill && (
            <Button variant="secondary" size="sm" compact tone="danger" type="button" onClick={onForceKill}>
              {t('rightSidebar.browser.crash.forceKill')}
            </Button>
          )}
        </>} />
    </div>
  );
}
