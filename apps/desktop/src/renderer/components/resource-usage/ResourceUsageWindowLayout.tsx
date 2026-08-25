/**
 * ResourceUsageWindowLayout —— 资源用量独立子窗口的根组件
 * (路由 `/resource-usage-window`)。
 *
 * 窗口由 main/resource-usage-window/window.ts 打开
 * (`?resourceUsageWindow=1`),本组件:
 * - 画 46px 自绘 chrome:整条 drag region;mac 左端红绿灯让位、
 *   win 右端 WindowControls(close 按 sender 解析 = 只关本窗)
 * - 内容区直接用 ResourceUsageBody(永远以本机身份渲染)
 * - ⌘W / Ctrl+W:关本窗
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';

import { ResourceUsageBody } from '@/features/right-sidebar/plugins/resource-usage/ResourceUsageBody';
import type { ResourceUsageState } from '@/features/right-sidebar/plugins/resource-usage';
import type { TabKindHostContext } from '@/features/right-sidebar/types';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ThemeProvider } from '@/hooks/useTheme';
import { FontSettingsProvider } from '@/hooks/useFontSettings';
import { LocaleProvider, useLocale } from '@/hooks/useLocale';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { ToastContainer } from '@/components/ui/toast';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { createLogger } from '@/lib/logger';

const log = createLogger('ResourceUsageWindowLayout');

const STUB_CTX: TabKindHostContext = {
  tabId: 'resource-usage-window',
  sessionId: '',
  workdir: '',
  remoteHostId: null,
  deviceLinkDeviceId: null,
  patchState: () => {},
  onVisibilityChange: () => {},
  setCloseInterceptor: () => () => {},
};

const EMPTY_STATE: ResourceUsageState = {};

export function ResourceUsageWindowLayout() {
  const { t } = useTranslation();
  const { effectiveLocale, setLocale } = useLocale();
  const isMac = window.electronAPI?.platform === 'darwin';
  const presentationReadySentRef = useRef(false);
  const presentationReadyInFlightRef = useRef(false);
  const presentationReadyAttemptRef = useRef(0);
  const presentationReadyRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentationReadyDisposedRef = useRef(false);
  // Windows 隐藏预热只挂载 renderer，不触发 OS 进程扫描；用户显式打开后由 Main
  // 发送 true。其他平台保留现有首份快照预热行为。
  const [samplingActive, setSamplingActive] = useState(
    window.electronAPI.platform !== 'win32',
  );
  // BrowserWindow hide 后 Chromium 不会继续更新鼠标命中，复用窗口时自绘按钮可能保留
  // 上一次点击留下的 focus / :hover。隐藏时重建一次 chrome，确保下次 show 从干净状态开始。
  const [windowChromeRevision, setWindowChromeRevision] = useState(0);

  useEffect(() => {
    presentationReadyDisposedRef.current = false;
    const offSamplingActive = window.electronAPI.resourceUsageWindow.onSamplingActiveChanged(
      (active) => {
        setSamplingActive(active);
        if (active) return;
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setWindowChromeRevision((revision) => revision + 1);
      },
    );
    const offLocaleChanged = window.electronAPI.resourceUsageWindow.onLocaleChanged((locale) => {
      // Main 广播来自任一 renderer 的语言设置；忽略同值回广播，避免资源窗口
      // 收到通知后再次 invoke app-menu:set-locale 形成 IPC 回环。
      if (locale !== effectiveLocale) setLocale(locale);
    });
    void window.electronAPI.resourceUsageWindow.rendererReady().catch((err) => {
      log.warn('report renderer ready failed', err);
    });
    return () => {
      presentationReadyDisposedRef.current = true;
      offSamplingActive();
      offLocaleChanged();
      if (presentationReadyRetryRef.current) {
        clearTimeout(presentationReadyRetryRef.current);
        presentationReadyRetryRef.current = null;
      }
    };
  }, [effectiveLocale, setLocale]);

  const handleFirstSample = useCallback(() => {
    if (
      presentationReadySentRef.current ||
      presentationReadyInFlightRef.current ||
      presentationReadyRetryRef.current
    )
      return;

    const report = (): void => {
      presentationReadyInFlightRef.current = true;
      presentationReadyAttemptRef.current += 1;
      void window.electronAPI.resourceUsageWindow
        .presentationReady()
        .then(() => {
          presentationReadyInFlightRef.current = false;
          presentationReadySentRef.current = true;
        })
        .catch((err) => {
          presentationReadyInFlightRef.current = false;
          log.warn('report presentation ready failed', err);
          if (
            presentationReadyDisposedRef.current ||
            presentationReadyAttemptRef.current >= 3
          )
            return;
          presentationReadyRetryRef.current = setTimeout(() => {
            presentationReadyRetryRef.current = null;
            report();
          }, 500);
        });
    };

    report();
  }, []);

  const closeWindow = useCallback(() => {
    // 走资源窗口专用关闭通道(controller.close → hideWindow + 焦点回归主窗口),
    // 与快捷键一致;不用通用 windowClose() —— 后者在某些子窗口状态下可能落入主窗口
    // 关闭流程。#3183:之前鼠标点标题栏 X 与快捷键走两条路径,关闭后焦点回不到主窗口,
    // 用户感知为"打开用量后无法回去"。
    void window.electronAPI.resourceUsageWindow.close().catch((err) => {
      log.warn('close window failed', err);
    });
  }, []);

  useAppShortcut('close-tab-or-window', () => {
    closeWindow();
    return true;
  });

  return (
    <div className="flex h-screen flex-col bg-content-area text-foreground">
      {/* 46px 自绘 chrome */}
      <div
        className="relative flex h-[46px] shrink-0 items-center border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={isMac ? 'w-20 shrink-0' : 'w-3 shrink-0'} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Activity size={14} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate text-13 text-[var(--text-secondary)]">
            {t('titleBar.menuItems.resourceUsage')}
          </span>
        </div>
        {!isMac && (
          <div
            className="flex h-full shrink-0 items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls key={windowChromeRevision} onClose={closeWindow} />
          </div>
        )}
      </div>

      {/* 内容区:ResourceUsageBody(始终本机,不依赖 session) */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
        <ResourceUsageBody
          state={EMPTY_STATE}
          ctx={STUB_CTX}
          active={samplingActive}
          shellVisible={samplingActive}
          onFirstSample={handleFirstSample}
        />
      </div>
    </div>
  );
}

export function ResourceUsageWindowRoot() {
  return (
    <ThemeProvider>
      <FontSettingsProvider>
        <LocaleProvider>
          <ConfirmDialogProvider>
            <ResourceUsageWindowLayout />
            <ToastContainer />
          </ConfirmDialogProvider>
        </LocaleProvider>
      </FontSettingsProvider>
    </ThemeProvider>
  );
}
