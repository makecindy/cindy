// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapGitSafetySettingsFromMain,
  getGitSafetyAutoSnapshotEnabled,
  setGitSafetyAutoSnapshotEnabled,
  subscribeGitSafetyAutoSnapshotEnabled,
} from '@/lib/gitSafetySettingsStore';
import {
  useGitSafetyAutoSnapshotEnabled,
  useGitSafetyAutoSnapshotEnabledForDevice,
  useGitSafetySettings,
} from '@/hooks/useGitSafetySettings';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

type GitSafetyWire = {
  autoSnapshotEnabled: boolean;
  isCustomized: boolean;
  defaultAutoSnapshotEnabled: boolean;
};

function installGitSafetyApi(overrides: {
  gitSafetyGet?: () => Promise<GitSafetyWire>;
  gitSafetySet?: (enabled: boolean) => Promise<GitSafetyWire>;
  gitSafetyReset?: () => Promise<GitSafetyWire>;
  deviceLinkInvoke?: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}) {
  const api = {
    gitSafetyGet: vi.fn(overrides.gitSafetyGet),
    gitSafetySet: vi.fn(overrides.gitSafetySet),
    gitSafetyReset: vi.fn(overrides.gitSafetyReset),
  };
  const deviceLinkInvoke = vi.fn(overrides.deviceLinkInvoke);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: api,
      deviceLink: { invoke: deviceLinkInvoke },
    } as unknown as Window['electronAPI'],
  });
  return { ...api, deviceLinkInvoke };
}

describe('Git safety settings wiring', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as Partial<Window>).electronAPI;
  });

  it('mirrors the main-process Git safety setting into the renderer store on boot', async () => {
    const api = installGitSafetyApi({
      gitSafetyGet: async () => ({
        autoSnapshotEnabled: true,
        isCustomized: true,
        defaultAutoSnapshotEnabled: false,
      }),
    });
    const observed: boolean[] = [];
    const unsubscribe = subscribeGitSafetyAutoSnapshotEnabled((next) => observed.push(next));

    await bootstrapGitSafetySettingsFromMain();

    expect(api.gitSafetyGet).toHaveBeenCalledTimes(1);
    expect(getGitSafetyAutoSnapshotEnabled()).toBe(true);
    expect(observed).toEqual([true]);
    unsubscribe();
  });

  it('updates main state and the synchronous renderer mirror from the settings hook', async () => {
    const api = installGitSafetyApi({
      gitSafetyGet: async () => ({
        autoSnapshotEnabled: false,
        isCustomized: false,
        defaultAutoSnapshotEnabled: false,
      }),
      gitSafetySet: async (enabled) => ({
        autoSnapshotEnabled: enabled,
        isCustomized: true,
        defaultAutoSnapshotEnabled: false,
      }),
    });

    const { result } = renderHook(() => useGitSafetySettings());
    await waitFor(() => expect(api.gitSafetyGet).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.setAutoSnapshotEnabled(true);
    });

    expect(api.gitSafetySet).toHaveBeenCalledWith(true);
    expect(result.current.autoSnapshotEnabled).toBe(true);
    expect(result.current.isCustomized).toBe(true);
    expect(getGitSafetyAutoSnapshotEnabled()).toBe(true);
  });

  it('lets render-time consumers follow the synchronous Git safety mirror', () => {
    setGitSafetyAutoSnapshotEnabled(false);
    const { result } = renderHook(() => useGitSafetyAutoSnapshotEnabled());

    expect(result.current).toBe(false);

    act(() => {
      setGitSafetyAutoSnapshotEnabled(true);
    });

    expect(result.current).toBe(true);
  });

  it('uses the local renderer mirror when no remote device is provided', () => {
    const api = installGitSafetyApi({});
    setGitSafetyAutoSnapshotEnabled(false);
    const { result } = renderHook(() => useGitSafetyAutoSnapshotEnabledForDevice());

    expect(result.current).toBe(false);

    act(() => {
      setGitSafetyAutoSnapshotEnabled(true);
    });

    expect(result.current).toBe(true);
    expect(api.deviceLinkInvoke).not.toHaveBeenCalled();
  });

  it('reads remote Git safety from the controlled device', async () => {
    const api = installGitSafetyApi({
      deviceLinkInvoke: async () => ({
        autoSnapshotEnabled: true,
        isCustomized: true,
        defaultAutoSnapshotEnabled: false,
      }),
    });

    const { result } = renderHook(() => useGitSafetyAutoSnapshotEnabledForDevice('remote-git-safety-on'));

    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(api.deviceLinkInvoke).toHaveBeenCalledWith('remote-git-safety-on', IPC_CHANNELS.MAKER_INVOKE.GIT_SAFETY_GET, []);
    expect(api.gitSafetyGet).not.toHaveBeenCalled();
  });

  it('revalidates cached remote Git safety when the controller window is focused', async () => {
    let remoteEnabled = true;
    const api = installGitSafetyApi({
      deviceLinkInvoke: async () => ({
        autoSnapshotEnabled: remoteEnabled,
        isCustomized: true,
        defaultAutoSnapshotEnabled: false,
      }),
    });

    const { result } = renderHook(() => useGitSafetyAutoSnapshotEnabledForDevice('remote-git-safety-focus'));

    await waitFor(() => expect(result.current).toBe(true));
    expect(api.deviceLinkInvoke).toHaveBeenCalledTimes(1);

    remoteEnabled = false;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(api.deviceLinkInvoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('does not let the controller local setting enable remote Codex rewind', async () => {
    setGitSafetyAutoSnapshotEnabled(true);
    const api = installGitSafetyApi({
      deviceLinkInvoke: async () => ({
        autoSnapshotEnabled: false,
        isCustomized: true,
        defaultAutoSnapshotEnabled: true,
      }),
    });

    const { result } = renderHook(() => useGitSafetyAutoSnapshotEnabledForDevice('remote-git-safety-off'));

    await waitFor(() => expect(api.deviceLinkInvoke).toHaveBeenCalledTimes(1));
    expect(api.deviceLinkInvoke).toHaveBeenCalledWith('remote-git-safety-off', IPC_CHANNELS.MAKER_INVOKE.GIT_SAFETY_GET, []);
    expect(result.current).toBe(false);
  });
});
