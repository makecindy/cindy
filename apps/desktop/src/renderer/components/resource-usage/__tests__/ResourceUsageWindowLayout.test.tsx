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
  WindowControls: () => <button data-testid="window-controls" />,
}));

vi.mock('@/hooks/useTheme', () => ({ ThemeProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/hooks/useFontSettings', () => ({ FontSettingsProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/hooks/useLocale', () => ({ LocaleProvider: ({ children }: React.PropsWithChildren) => children }));
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
  let samplingListener: ((active: boolean) => void) | null = null;

  beforeEach(() => {
    resourceBodyProps = null;
    samplingListener = null;
    rendererReady.mockClear();
    presentationReady.mockClear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        resourceUsageWindow: {
          close: vi.fn(() => Promise.resolve()),
          rendererReady,
          presentationReady,
          onSamplingActiveChanged: (cb: (active: boolean) => void) => {
            samplingListener = cb;
            return vi.fn();
          },
        },
      },
    });
  });

  it('mounts hidden prewarm sampling, reports renderer readiness, then follows main visibility', async () => {
    render(<ResourceUsageWindowRoot />);

    expect(rendererReady).toHaveBeenCalledOnce();
    expect(resourceBodyProps).toMatchObject({ active: true, shellVisible: true });

    await act(async () => samplingListener?.(false));
    expect(resourceBodyProps).toMatchObject({ active: false, shellVisible: false });

    await act(async () => samplingListener?.(true));
    expect(resourceBodyProps).toMatchObject({ active: true, shellVisible: true });
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
