// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent';
import { GhostInstallConsentHost } from '../GhostInstallConsentHost';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

type Push = (payload: GhostInstallConsentRequest, ownerStamp?: unknown) => void;

const HOST = {
  key: 'network:host:upload.weather.test',
  kind: 'network' as const,
  labelKey: 'networkHost',
  labelArgs: { host: 'upload.weather.test' },
};

describe('GhostInstallConsentHost', () => {
  let push: Push | undefined;
  let dismiss: ((payload: { requestId: string }) => void) | undefined;
  const resolveInstallConsent = vi.fn();

  beforeEach(() => {
    mocks.confirm.mockReset().mockResolvedValue(true);
    resolveInstallConsent.mockReset().mockResolvedValue({ handled: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghosts: {
        onInstallConsentRequest: (callback: Push) => {
          push = callback;
          return () => {};
        },
        onInstallConsentDismissed: (callback: typeof dismiss) => {
          dismiss = callback;
          return () => {};
        },
        resolveInstallConsent,
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('shows the added permissions of an update and returns the answer to Main', async () => {
    render(<GhostInstallConsentHost />);
    await act(async () => {
      push?.({
        requestId: 'consent-1',
        initiator: 'user',
        origin: 'custom-market',
        originLabel: 'Team market',
        facts: {
          kind: 'update', ghostId: 'weather-chip', name: 'Weather', version: '2.0.0',
          previousVersion: '1.0.0', added: [HOST], removed: [], unchangedCount: 1,
          builtinOauthClientChanged: false,
        },
      });
    });

    await waitFor(() => expect(resolveInstallConsent).toHaveBeenCalledWith('consent-1', true));
    const options = mocks.confirm.mock.calls[0][0] as {
      title: string;
      description: string;
      confirmText: string;
      content: ReactNode;
    };
    expect(options.title).toBe('settings.ghosts.installConsent.updateTitle:{"name":"Weather"}');
    expect(options.description).toContain('"from":"1.0.0"');
    expect(options.description).toContain('originCustomMarket');
    expect(options.confirmText).toBe('settings.ghosts.installConsent.confirmUpdate');
    render(<>{options.content}</>);
    expect(screen.getByText('settings.ghosts.perm.networkHost:{"host":"upload.weather.test"}')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.installConsent.addedBadge')).toBeTruthy();
  });

  it('answers cancel when Main dismisses the pending dialog', async () => {
    let seenSignal: AbortSignal | undefined;
    mocks.confirm.mockImplementation(
      (_options: unknown, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => resolve(false));
        }),
    );
    render(<GhostInstallConsentHost />);
    await act(async () => {
      push?.({
        requestId: 'consent-2',
        initiator: 'user',
        origin: 'local-file',
        facts: { kind: 'install', ghostId: 'weather-chip', name: 'Weather', version: '1.0.0', permissions: [] },
      });
    });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await act(async () => {
      dismiss?.({ requestId: 'consent-2' });
    });
    expect(seenSignal?.aborted).toBe(true);
    await waitFor(() => expect(resolveInstallConsent).toHaveBeenCalledWith('consent-2', false));
  });
});
