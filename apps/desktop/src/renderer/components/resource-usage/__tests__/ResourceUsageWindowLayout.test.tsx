// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let resourceBodyProps: {
  active?: boolean;
  shellVisible?: boolean;
  onFirstSample?: () => void;
} | null = null;

vi.mock('@/features/right-sidebar/plugins/resource-usage/ResourceUsageBody', () => ({
  ResourceUsageBody: (props: typeof resourceBodyProps) => {
    resourceBodyProps = props;
    return <div data-testid="resource-body" />;
  },
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  // #3183: 暴露 onClose 触发,验证标题栏 X 走资源窗口专用关闭通道
  WindowControls: ({ onClose }: { onClose?: () => void }) => (
    <button data-testid="window-controls" onClick={onClose} />
  ),
}));

vi.mock('@/hooks/useTheme', () => ({ ThemeProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/hooks/useFontSettings', () => ({ FontSettingsProvider: ({ children }: React.PropsWithChildren) => children }));
const { setLocale } = vi.hoisted(() => ({ setLocale: vi.fn() }));
vi.mock('@/hooks/useLocale', () => ({
  LocaleProvider: ({ children }: React.PropsWithChildren) => children,
  useLocale: () => ({ effectiveLocale: 'en', setLocale }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ ConfirmDialogProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/ui/toast', () => ({ ToastContainer: () => null }));
vi.mock('@/hooks/useAppShortcut', () => ({ useAppShortcut: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ResourceUsageWindowRoot } from '../ResourceUsageWindowLayout';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ResourceUsageWindowRoot prewarm lifecycle', () => {
  const rendererReady = vi.fn(() => Promise.resolve());
  const presentationReady = vi.fn(() => Promise.resolve());
  const resourceClose = vi.fn(() => Promise.resolve());
  let samplingListener: ((active: boolean) => void) | null = null;
  let localeListener: ((locale: 'zh-CN' | 'en') => void) | null = null;

  beforeEach(() => {
    resourceBodyProps = null;
    samplingListener = null;
    localeListener = null;
    setLocale.mockClear();
    rendererReady.mockClear();
    presentationReady.mockClear();
    resourceClose.mockClear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        resourceUsageWindow: {
          close: resourceClose,
          rendererReady,
          presentationReady,
          onSamplingActiveChanged: (cb: (active: boolean) => void) => {
            samplingListener = cb;
            return vi.fn();
          },
          onLocaleChanged: (cb: (locale: 'zh-CN' | 'en') => void) => {
            localeListener = cb;
            return vi.fn();
          },
        },
      },
    });
  });

  it('renders the process-usage window title from the standing menu item copy', () => {
    render(<ResourceUsageWindowRoot />);

    expect(screen.getByText('titleBar.menuItems.resourceUsage')).toBeTruthy();
  });

  it('keeps Windows hidden prewarm idle, then samples only after Main activates it', async () => {
    render(<ResourceUsageWindowRoot />);

    expect(rendererReady).toHaveBeenCalledOnce();
    expect(resourceBodyProps).toMatchObject({ active: false, shellVisible: false });
    expect(presentationReady).not.toHaveBeenCalled();

    await act(async () => samplingListener?.(true));
    expect(resourceBodyProps).toMatchObject({ active: true, shellVisible: true });

    await act(async () => samplingListener?.(false));
    expect(resourceBodyProps).toMatchObject({ active: false, shellVisible: false });
  });

  it('applies locale changes received while the window is prewarmed', async () => {
    render(<ResourceUsageWindowRoot />);

    await act(async () => localeListener?.('zh-CN'));

    expect(setLocale).toHaveBeenCalledWith('zh-CN');
  });

  it('ignores a same-locale broadcast to avoid an IPC feedback loop', async () => {
    render(<ResourceUsageWindowRoot />);

    await act(async () => localeListener?.('en'));

    expect(setLocale).not.toHaveBeenCalled();
  });

  it('clears and remounts window controls when the reusable window is hidden', async () => {
    render(<ResourceUsageWindowRoot />);
    const controlsBeforeHide = screen.getByTestId('window-controls');
    controlsBeforeHide.focus();
    expect(document.activeElement).toBe(controlsBeforeHide);

    await act(async () => samplingListener?.(false));

    const controlsAfterHide = screen.getByTestId('window-controls');
    expect(controlsAfterHide).not.toBe(controlsBeforeHide);
    expect(document.activeElement).not.toBe(controlsAfterHide);
  });

  it('reports the prepared presentation only once after the first sample', async () => {
    render(<ResourceUsageWindowRoot />);

    await act(async () => {
      resourceBodyProps?.onFirstSample?.();
      resourceBodyProps?.onFirstSample?.();
    });

    expect(presentationReady).toHaveBeenCalledOnce();
  });

  it('closes the resource window via the dedicated close channel when the title-bar X is clicked (#3183)', () => {
    render(<ResourceUsageWindowRoot />);

    act(() => {
      screen.getByTestId('window-controls').click();
    });

    // 必须走 resourceUsageWindow.close(controller 隐藏窗口 + 焦点回归主窗口),
    // 而不是通用 windowClose,否则用户点 X 后看起来"回不去"。
    expect(resourceClose).toHaveBeenCalledOnce();
  });

  it('retries a transient presentation-ready IPC failure', async () => {
    vi.useFakeTimers();
    presentationReady.mockRejectedValueOnce(new Error('temporary IPC failure'));
    render(<ResourceUsageWindowRoot />);

    await act(async () => {
      resourceBodyProps?.onFirstSample?.();
      await Promise.resolve();
    });
    expect(presentationReady).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(presentationReady).toHaveBeenCalledTimes(2);
  });
});
