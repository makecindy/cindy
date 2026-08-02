// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { BrowserBackendSubsection } from '../BrowserBackendSubsection';

afterEach(cleanup);

describe('BrowserBackendSubsection', () => {
  it('shows a one-click recovery action with an explicit error state', () => {
    const onRecover = vi.fn();
    render(
      <BrowserBackendSubsection
        active="rsb-webview"
        pending={false}
        recovering={false}
        health={{
          active: 'rsb-webview',
          status: 'error',
          canRecover: true,
          reason: 'disposing',
        }}
        onSelect={vi.fn()}
        onRecover={onRecover}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'settings.computerUse.browserBackend.health.error',
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.computerUse.browserBackend.health.recover',
      }),
    );
    expect(onRecover).toHaveBeenCalledOnce();
  });

  it('keeps reconnect available after the replacement is healthy', () => {
    render(
      <BrowserBackendSubsection
        active="rsb-webview"
        pending={false}
        recovering={false}
        health={{ active: 'rsb-webview', status: 'ready', canRecover: true }}
        onSelect={vi.fn()}
        onRecover={vi.fn()}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'settings.computerUse.browserBackend.health.ready',
    );
    expect(
      screen.getByRole('button', {
        name: 'settings.computerUse.browserBackend.health.reconnect',
      }),
    ).toBeTruthy();
  });

  it('uses the semantic spinner motion and stays static under reduced motion', () => {
    render(
      <BrowserBackendSubsection
        active="rsb-webview"
        pending={false}
        recovering
        health={{ active: 'rsb-webview', status: 'ready', canRecover: true }}
        onSelect={vi.fn()}
        onRecover={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'settings.computerUse.browserBackend.health.recovering',
    });
    const spinner = button.querySelector('span');
    expect(spinner?.classList.contains('animate-spinner')).toBe(true);
    expect(spinner?.classList.contains('motion-reduce:animate-none')).toBe(true);
    expect(spinner?.classList.contains('animate-spin')).toBe(false);
  });

  it('does not show embedded recovery controls for the external backend', () => {
    render(
      <BrowserBackendSubsection
        active="external"
        pending={false}
        recovering={false}
        health={{ active: 'external', status: 'ready', canRecover: false }}
        onSelect={vi.fn()}
        onRecover={vi.fn()}
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
