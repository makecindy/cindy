import { Component, Fragment, type ReactNode } from 'react';
import { launchSettled, recordJsError } from '@/debug/jsErrorGuard';

type Props = {
  children: ReactNode;
  /** 错误页；`retry` 丢弃出错的子树并重新挂载。 */
  fallback: (retry: () => void) => ReactNode;
};
type State = { failed: boolean; error: unknown; attempt: number };

/**
 * 页面树的渲染兜底：包在导航树外面、登录与设备连接 Provider 里面（见根布局），树里任何一处渲染报错
 * 都落到这里，显示可重新加载的错误页，而不是让 App 退出。重新加载只重挂这棵页面树。
 *
 * 启动窗口内不接：此时把报错原样抛回去，它仍是 React 的未捕获错误、照旧致命，
 * expo-updates 的错误恢复才能回滚坏掉的热更（窗口定义见 `jsErrorGuard`）。
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, error: undefined, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown): void {
    recordJsError('render', error);
  }

  private retry = (): void => {
    this.setState((state) => ({ failed: false, error: undefined, attempt: state.attempt + 1 }));
  };

  render(): ReactNode {
    if (this.state.failed) {
      if (!launchSettled()) throw this.state.error;
      return this.props.fallback(this.retry);
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
