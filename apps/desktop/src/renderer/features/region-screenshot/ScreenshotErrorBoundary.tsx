import { Component, type ReactNode } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('screenshot-error-boundary');

/** 系统浮层不能用主应用崩溃页挡住桌面；渲染失败立即交还屏幕。 */
export class ScreenshotErrorBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    log.warn('screenshot render failed', { error });
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
