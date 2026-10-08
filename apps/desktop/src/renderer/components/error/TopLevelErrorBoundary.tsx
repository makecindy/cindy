/**
 * TopLevelErrorBoundary — 整个 React 树最外层的渲染崩溃兜底(挂在 index.tsx,
 * 包裹 <App />)。
 *
 * 背景:router.tsx 的 errorElement(RouteErrorFallback)只覆盖 RouterProvider
 * **之内**的路由子树;App.tsx 里 RouterProvider 之上还有一整条 provider 链
 * (Theme / Locale / EnvCheck / Auth / SplashScreen / MakerBootstrap …),这一段
 * 同步渲染抛错时没有任何 boundary,#root 直接被 React 卸载成白屏,且 release
 * 日志无痕。本组件把这个缺口补上:兜底页 + 统一 logger 上报。
 *
 * 注意:兜底 UI(AppCrashScreen)刻意不依赖任何 Provider/Context——崩溃源可能
 * 正是链上的某个 Provider,详见 AppCrashScreen 头注释的依赖约束。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { createLogger } from '@/lib/logger';
import { AppCrashScreen } from './AppCrashScreen';

const log = createLogger('top-level-error-boundary');

interface NormalizedError {
  message: string;
  stack?: string;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

interface TopLevelErrorBoundaryState {
  error: NormalizedError | null;
}

interface RenderEntryContext {
  entry: string;
  windowKind: string;
  appVersion?: string;
}

/**
 * Keep the crash record attributable when several renderer windows share the
 * same main log. Do not include the raw query string: boot session/device IDs
 * in it are user data and are not needed to identify the entry point.
 */
function getRenderEntryContext(): RenderEntryContext {
  try {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const ghostPanel = params.get('ghostPanelWindow');

    if (params.get('sidebarWindow') === '1') {
      return {
        entry: 'sidebar-window',
        windowKind: 'sidebar',
        appVersion: window.electronAPI?.appVersion,
      };
    }
    if (ghostPanel) {
      return {
        entry: 'ghost-panel',
        windowKind: 'ghost-panel',
        appVersion: window.electronAPI?.appVersion,
      };
    }
    if (params.get('secondaryWindow') === '1') {
      return {
        entry: 'secondary-window',
        windowKind: 'secondary',
        appVersion: window.electronAPI?.appVersion,
      };
    }
    if (view) {
      return {
        entry: `view:${view}`,
        windowKind: 'utility',
        appVersion: window.electronAPI?.appVersion,
      };
    }
  } catch {
    // A malformed/early window URL must not interfere with the crash fallback.
  }

  return {
    entry: 'main',
    windowKind: 'main',
    appVersion: window.electronAPI?.appVersion,
  };
}

export class TopLevelErrorBoundary extends Component<
  { children: ReactNode },
  TopLevelErrorBoundaryState
> {
  state: TopLevelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): TopLevelErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const { message, stack } = normalizeError(error);
    const renderEntry = getRenderEntryContext();
    log.error('top-level render crashed (above RouterProvider)', {
      message,
      stack,
      componentStack: info.componentStack ?? undefined,
      ...renderEntry,
    });
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <AppCrashScreen
          variant="fullscreen"
          message={this.state.error.message}
          stack={this.state.error.stack}
        />
      );
    }
    return this.props.children;
  }
}
