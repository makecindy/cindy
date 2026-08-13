import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import type { TFunction } from 'i18next';

import { createLogger } from '@/lib/logger';

const log = createLogger('right-sidebar.tab-error-boundary');

interface Props {
  children: ReactNode;
  tabId: string;
  tabKind: string;
  t: TFunction;
}

interface State {
  error: Error | null;
  retryKey: number;
}

/** Isolate one sidebar plugin from the rest of the detached window. */
export class TabBodyErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('sidebar tab render crashed', {
      tabId: this.props.tabId,
      tabKind: this.props.tabKind,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  componentDidUpdate(previousProps: Props): void {
    if (previousProps.tabId !== this.props.tabId || previousProps.tabKind !== this.props.tabKind) {
      if (this.state.error !== null) {
        this.setState({ error: null, retryKey: this.state.retryKey + 1 });
      }
    }
  }

  private retry = (): void => {
    this.setState((state) => ({ error: null, retryKey: state.retryKey + 1 }));
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      const { t } = this.props;
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-content-area px-4">
          <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-5 py-6 text-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
              <TriangleAlert size={16} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-13 font-medium text-[var(--text-primary)]">
                {t('rightSidebar.panelError.title')}
              </h2>
              <p className="mt-1 text-12 leading-relaxed text-[var(--text-secondary)]">
                {t('rightSidebar.panelError.description')}
              </p>
            </div>
            <button
              type="button"
              onClick={this.retry}
              className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-opacity hover:opacity-90"
              style={{
                backgroundColor: 'var(--accent-cta-bg)',
                color: 'var(--accent-pure-cta-fg)',
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              {t('rightSidebar.panelError.reload')}
            </button>
          </div>
        </div>
      );
    }

    return <div key={this.state.retryKey} className="flex min-h-0 flex-1 flex-col">{this.props.children}</div>;
  }
}
