// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
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
let sampleListener: ((sample: import('../../../../../../shared/processMonitor').ProcessMonitorSample) => void) | null = null;
const onSample = vi.fn((listener: typeof sampleListener) => {
  sampleListener = listener;
  return offSample;
});

function makeContext({
  remoteHostId = null,
  deviceLinkDeviceId,
}: {
  remoteHostId?: string | null;
  deviceLinkDeviceId: string | null | undefined;
}): TabKindHostContext {
  return {
    tabId: 'resource-usage-tab',
    sessionId: 'session-1',
    workdir: remoteHostId || deviceLinkDeviceId ? '/remote/project' : 'C:\\project',
    remoteHostId,
    deviceLinkDeviceId,
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
  sampleListener = null;
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

describe('ResourceUsageBody local-only gate', () => {
  it('shows a local-only unavailable state without subscribing to local samples', () => {
    render(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ remoteHostId: 'ssh-host-1', deviceLinkDeviceId: null })}
        active
        shellVisible
      />,
    );

    expect(screen.getByText('rightSidebar.resourceUsage.remoteUnavailableTitle')).toBeTruthy();
    expect(
      screen.getByText('rightSidebar.resourceUsage.remoteUnavailableDescription'),
    ).toBeTruthy();
    expect(onSample).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('reports readiness only after the first local sample is committed', () => {
    const onFirstSample = vi.fn();
    render(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId: null })}
        active
        shellVisible
        onFirstSample={onFirstSample}
      />,
    );

    expect(onFirstSample).not.toHaveBeenCalled();
    act(() => {
      sampleListener?.({ capturedAtMs: 1, entries: [] });
    });
    expect(onFirstSample).toHaveBeenCalledOnce();

    act(() => {
      sampleListener?.({ capturedAtMs: 2, entries: [] });
    });
    expect(onFirstSample).toHaveBeenCalledOnce();
  });

  it('releases the local subscription when the tab switches to an SSH task', () => {
    const view = render(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId: null })}
        active
        shellVisible
      />,
    );

    expect(onSample).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    view.rerender(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ remoteHostId: 'ssh-host-1', deviceLinkDeviceId: null })}
        active
        shellVisible
      />,
    );

    expect(offSample).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ['a device-link session', 'device-1' as string | undefined],
    ['an unresolved device-link owner', undefined],
  ])('fails closed for %s without subscribing to local samples', (_label, deviceLinkDeviceId) => {
    render(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId })}
        active
        shellVisible
      />,
    );

    expect(screen.getByText('rightSidebar.resourceUsage.remoteUnavailableTitle')).toBeTruthy();
    expect(onSample).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('releases the local subscription when the tab switches to a device-link task', () => {
    const view = render(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId: null })}
        active
        shellVisible
      />,
    );

    expect(onSample).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    view.rerender(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId: 'device-1' })}
        active
        shellVisible
      />,
    );

    expect(offSample).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('subscribes after an unresolved device-link owner is confirmed local', () => {
    const view = render(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId: undefined })}
        active
        shellVisible
      />,
    );

    expect(onSample).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    view.rerender(
      <ResourceUsageBody
        state={{}}
        ctx={makeContext({ deviceLinkDeviceId: null })}
        active
        shellVisible
      />,
    );

    expect(onSample).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
