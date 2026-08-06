// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ResourceUsageBody } from '../ResourceUsageBody';

const subscribe = vi.fn(async () => undefined);
const unsubscribe = vi.fn(async () => undefined);
const offSample = vi.fn();
const onSample = vi.fn(() => offSample);

function makeContext(remoteHostId: string | null): TabKindHostContext {
  return {
    tabId: 'resource-usage-tab',
    sessionId: 'session-1',
    workdir: remoteHostId ? '/remote/project' : 'C:\\project',
    remoteHostId,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
  };
}

beforeEach(() => {
  subscribe.mockClear();
  unsubscribe.mockClear();
  offSample.mockClear();
  onSample.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      processMonitor: {
        onSample,
        subscribe,
        unsubscribe,
        terminate: vi.fn(async () => undefined),
      },
    },
  });
});

afterEach(() => cleanup());

describe('ResourceUsageBody SSH remote gate', () => {
  it('shows a local-only unavailable state without subscribing to local samples', () => {
    render(<ResourceUsageBody state={{}} ctx={makeContext('ssh-host-1')} active shellVisible />);

    expect(screen.getByText('rightSidebar.resourceUsage.remoteUnavailableTitle')).toBeTruthy();
    expect(
      screen.getByText('rightSidebar.resourceUsage.remoteUnavailableDescription'),
    ).toBeTruthy();
    expect(onSample).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('releases the local subscription when the tab switches to an SSH task', () => {
    const view = render(
      <ResourceUsageBody state={{}} ctx={makeContext(null)} active shellVisible />,
    );

    expect(onSample).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    view.rerender(
      <ResourceUsageBody state={{}} ctx={makeContext('ssh-host-1')} active shellVisible />,
    );

    expect(offSample).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
