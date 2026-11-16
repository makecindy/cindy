// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

import { DiscordChannelAccessUnsupportedError, useDiscordChannelAccess } from '../useDiscordChannelAccess';
import { setChannelSelected, setGuildEnabled } from '@/lib/discordChannelAccess';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const api = {
  listChannels: vi.fn(),
  getChannelAccess: vi.fn(),
  setChannelAccess: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const entry = (channelId: string) => ({ guildId: '11', channelId });

beforeEach(() => {
  vi.resetAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  api.listChannels.mockResolvedValue({ status: { kind: 'connected', appId: 'bot' }, guilds: [] });
  api.getChannelAccess.mockResolvedValue({ channels: [] });
  (window as unknown as { electronAPI: unknown }).electronAPI = { discordBot: api };
});

/** Two quick toggles: the first write is in flight, the second is still queued behind it. */
async function queueTwoWrites(
  hook: ReturnType<
    typeof renderHook<ReturnType<typeof useDiscordChannelAccess>, { active: boolean }>
  >,
) {
  await waitFor(() => expect(hook.result.current.access).not.toBeNull());
  const first = deferred<{ channels: Array<{ guildId: string; channelId: string }> }>();
  api.setChannelAccess.mockImplementationOnce(() => first.promise);
  api.setChannelAccess.mockImplementation(async (access: unknown) => access);
  act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '21', true)));
  act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '22', true)));
  await waitFor(() => expect(api.setChannelAccess).toHaveBeenCalledTimes(1));
  return first;
}

describe('useDiscordChannelAccess queued saves', () => {
  it('does not send a queued save after the bot disconnects, and does not repaint the next session', async () => {
    const hook = renderHook(({ active }) => useDiscordChannelAccess(active), {
      initialProps: { active: true },
    });
    const first = await queueTwoWrites(hook);

    hook.rerender({ active: false });
    await act(async () => first.resolve({ channels: [entry('21')] }));

    expect(api.setChannelAccess).toHaveBeenCalledTimes(1);
    expect(hook.result.current.access).toBeNull();

    // 重新连上后以主进程真实保存的白名单为准。
    api.getChannelAccess.mockResolvedValue({ channels: [entry('21')] });
    hook.rerender({ active: true });
    await waitFor(() => expect(hook.result.current.access).toEqual({ channels: [entry('21')] }));
  });

  it('does not send a queued save after unmount', async () => {
    const hook = renderHook(({ active }) => useDiscordChannelAccess(active), {
      initialProps: { active: true },
    });
    const first = await queueTwoWrites(hook);

    hook.unmount();
    await act(async () => first.resolve({ channels: [entry('21')] }));

    expect(api.setChannelAccess).toHaveBeenCalledTimes(1);
  });

  it('does not send a queued save after the data owner changed', async () => {
    const hook = renderHook(({ active }) => useDiscordChannelAccess(active), {
      initialProps: { active: true },
    });
    const first = await queueTwoWrites(hook);

    setDataOwnerGeneration('owner-b', 2);
    await act(async () => first.resolve({ channels: [entry('21')] }));

    expect(api.setChannelAccess).toHaveBeenCalledTimes(1);
  });

  it('sends both queued saves in order when nothing changed', async () => {
    const hook = renderHook(({ active }) => useDiscordChannelAccess(active), {
      initialProps: { active: true },
    });
    const first = await queueTwoWrites(hook);

    await act(async () => first.resolve({ channels: [entry('21')] }));

    await waitFor(() => expect(api.setChannelAccess).toHaveBeenCalledTimes(2));
    expect(api.setChannelAccess.mock.calls[1][0]).toEqual({
      channels: [entry('21'), entry('22')],
      guilds: [{ guildId: '11', enabled: true, mode: 'selected' }],
    });
  });

  it.each([false, true])('invalidates editing after an unsupported reload (queued writes: %s)', async (queued) => {
    const hook = renderHook(({ active }) => useDiscordChannelAccess(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(hook.result.current.access).not.toBeNull());
    const first = queued ? await queueTwoWrites(hook) : null;
    api.getChannelAccess.mockRejectedValueOnce(new DiscordChannelAccessUnsupportedError());

    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.error).toBe('unsupported'));
    act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '23', true)));
    if (first) await act(async () => first.resolve({ channels: [entry('21')] }));

    expect(hook.result.current.access).toBeNull();
    expect(hook.result.current.guilds).toBeNull();
    expect(api.setChannelAccess).toHaveBeenCalledTimes(queued ? 1 : 0);
  });

  // Retry can overlap a completed save: an older snapshot must not restore a revoked guild
  // or become the base of the next write. Existing tests only kept saves in flight. Tier: unit.
  it('keeps a completed revocation when an earlier retry snapshot arrives later', async () => {
    const initial = {
      channels: [entry('21')],
      guilds: [{ guildId: '11', enabled: true, mode: 'selected' as const }],
    };
    const revokedGuild = {
      guildId: '11', enabled: false, mode: 'selected', savedChannels: [{ channelId: '21' }],
    };
    api.getChannelAccess.mockResolvedValue(initial);
    api.setChannelAccess.mockRejectedValueOnce(new Error('save failed'));
    api.setChannelAccess.mockImplementation(async (access: unknown) => access);
    const hook = renderHook(() => useDiscordChannelAccess(true));
    await waitFor(() => expect(hook.result.current.access).toEqual(initial));
    act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '22', true)));
    await waitFor(() => expect(hook.result.current.error).toBe('save'));

    const retry = deferred<typeof initial>();
    api.getChannelAccess.mockImplementationOnce(() => retry.promise);
    act(() => hook.result.current.reload());
    await waitFor(() => expect(api.getChannelAccess).toHaveBeenCalledTimes(3));
    await act(async () => hook.result.current.update((a) => setGuildEnabled(a, '11', false)));
    expect(api.setChannelAccess).toHaveBeenCalledTimes(2);

    await act(async () => retry.resolve(initial));
    expect(hook.result.current.access).toEqual({ channels: [], guilds: [revokedGuild] });
    await act(async () => hook.result.current.update((a) => setGuildEnabled(a, '12', true)));
    expect(api.setChannelAccess.mock.calls[2][0].guilds).toContainEqual(revokedGuild);
    expect(hook.result.current.loading).toBe(false);
  });

  it.each([false, true])('invalidates editing after unsupported save recovery (queued during recovery: %s)', async (queued) => {
    const hook = renderHook(({ active }) => useDiscordChannelAccess(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(hook.result.current.access).not.toBeNull());
    const recovery = deferred<{ channels: Array<{ guildId: string; channelId: string }> }>();
    api.getChannelAccess.mockImplementationOnce(() => recovery.promise);
    api.setChannelAccess.mockImplementation(async (access: unknown) => access);
    api.setChannelAccess.mockRejectedValueOnce(new Error('save failed'));

    act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '21', true)));
    await waitFor(() => expect(api.getChannelAccess).toHaveBeenCalledTimes(2));
    if (queued) act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '22', true)));
    await act(async () => recovery.reject(new DiscordChannelAccessUnsupportedError()));
    act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '23', true)));

    expect(hook.result.current.error).toBe('unsupported');
    expect(hook.result.current.access).toBeNull();
    expect(hook.result.current.guilds).toBeNull();
    expect(api.setChannelAccess).toHaveBeenCalledTimes(1);
  });

  it('never writes a queued save to a different connection after switching', async () => {
    const first = deferred<{ channels: Array<{ guildId: string; channelId: string }> }>();
    const sourceA = {
      load: vi.fn(async () => ({ guilds: [], access: { channels: [] } })),
      save: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementation(async (a: unknown) => a),
    };
    const sourceB = {
      load: vi.fn(async () => ({ guilds: [], access: { channels: [entry('99')] } })),
      save: vi.fn(async (a: unknown) => a),
    };
    const hook = renderHook(
      ({ source, key }) => useDiscordChannelAccess(true, source as never, key),
      {
        initialProps: { source: sourceA, key: 'conn-a' },
      },
    );
    await waitFor(() => expect(hook.result.current.access).not.toBeNull());
    act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '21', true)));
    act(() => hook.result.current.update((a) => setChannelSelected(a, '11', '22', true)));
    await waitFor(() => expect(sourceA.save).toHaveBeenCalledTimes(1));

    hook.rerender({ source: sourceB, key: 'conn-b' });
    await act(async () => first.resolve({ channels: [entry('21')] }));

    expect(sourceA.save).toHaveBeenCalledTimes(1);
    expect(sourceB.save).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.access).toEqual({ channels: [entry('99')] }));
  });
});
