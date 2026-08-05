// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

beforeEach(() => {
  vi.resetModules();
});

function setElectronApi(value: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value,
  });
}

function capabilities(label: string) {
  return {
    availableModels: [
      {
        id: `${label}-model`,
        displayName: label,
        contextWindow: 1,
        efforts: [],
        defaultEffort: null,
      },
    ],
    hasFastMode: false,
    effortLevels: [],
    permissionModes: [],
  };
}

function provider(id: string): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'none' },
    routing: {
      'claude-code': { upstream: 'https://example.invalid', authStrategy: 'none' },
    },
    models: { 'claude-code': [] },
    connected: true,
  };
}

describe('remote model hook device ownership', () => {
  it('never renders the previous device capabilities under a newly selected device', async () => {
    const invoke = vi.fn((deviceId: string) => {
      if (deviceId === 'dev-a') return Promise.resolve(capabilities('Mac A'));
      return new Promise(() => {});
    });
    setElectronApi({ deviceLink: { invoke } });
    const mod = await import('@/hooks/useAgentCapabilities');
    await mod.prefetchDeviceCapabilities('dev-a');

    const frames: Array<{ deviceId: string; label: string | null; loading: boolean }> = [];
    function Probe({ deviceId }: { deviceId: string }) {
      const state = mod.useAgentCapabilities('codex', deviceId);
      frames.push({
        deviceId,
        label: state.capabilities?.availableModels[0]?.displayName ?? null,
        loading: state.loading,
      });
      return null;
    }

    const view = render(<Probe deviceId="dev-a" />);
    await waitFor(() =>
      expect(frames.at(-1)).toEqual({
        deviceId: 'dev-a',
        label: 'Mac A',
        loading: false,
      }),
    );

    frames.length = 0;
    view.rerender(<Probe deviceId="dev-b" />);
    expect(frames[0]).toEqual({ deviceId: 'dev-b', label: null, loading: true });
  });

  it('never renders the previous device providers under a newly selected device', async () => {
    const invoke = vi.fn((deviceId: string) => {
      if (deviceId === 'dev-a') {
        return Promise.resolve({ providers: [provider('provider-a')] });
      }
      return new Promise(() => {});
    });
    setElectronApi({ deviceLink: { invoke } });
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-a');

    const frames: Array<{ deviceId: string; providerIds: string[]; loading: boolean }> = [];
    function Probe({ deviceId }: { deviceId: string }) {
      const state = mod.useDeviceProviders(deviceId);
      frames.push({
        deviceId,
        providerIds: state.providers.map((provider) => provider.id),
        loading: state.loading,
      });
      return null;
    }

    const view = render(<Probe deviceId="dev-a" />);
    await waitFor(() =>
      expect(frames.at(-1)).toEqual({
        deviceId: 'dev-a',
        providerIds: ['provider-a'],
        loading: false,
      }),
    );

    frames.length = 0;
    view.rerender(<Probe deviceId="dev-b" />);
    expect(frames[0]).toEqual({ deviceId: 'dev-b', providerIds: [], loading: true });
  });

  it('clears a stale provider catalog when an upgraded controller reaches an old unsupported device', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ providers: [provider('stale-provider')] })
      .mockRejectedValueOnce(
        new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed remotely'),
      );
    setElectronApi({ deviceLink: { invoke } });
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-old');

    const frames: Array<ReturnType<typeof mod.useDeviceProviders>> = [];
    function Probe() {
      const state = mod.useDeviceProviders('dev-old');
      frames.push(state);
      return null;
    }

    render(<Probe />);
    await waitFor(() => expect(frames.at(-1)?.providers).toHaveLength(1));
    await act(async () => {
      mod.evictDeviceProviders('dev-old');
      await mod.prefetchDeviceProviders('dev-old');
    });

    await waitFor(() => expect(frames.at(-1)?.unsupported).toBe(true));
    expect(frames.at(-1)?.providers).toEqual([]);
    expect(frames.at(-1)?.error).toContain('CHANNEL_NOT_ALLOWED');
  });
});
