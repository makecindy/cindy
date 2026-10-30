// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSshCodexProviders } from '@/hooks/useSshCodexProviders';
import { loadSshSessionModelSelection } from '@/features/cc-agent/sshSessionModelSelection';
import { sshNativeCodexProvider, sshModel } from '@/features/cc-agent/__tests__/sshModelFixtures';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const list = vi.fn();
let statusChanged: (snapshot: RemoteHostSnapshot) => void;
beforeEach(() => {
  setDataOwnerGeneration('owner', 1);
  list.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { remoteSsh: {
    listCodexModels: list,
    onStatusChanged: (callback: typeof statusChanged) => { statusChanged = callback; return vi.fn(); },
  } } });
});
afterEach(cleanup);
const providers = (model: string) => [sshNativeCodexProvider([sshModel(model)])];

describe('SSH Codex model discovery', () => {
  it.each([false, true])('retries initial discovery on first ready even when rejection is late (%s)', async (late) => {
    let reject!: (error: Error) => void;
    list.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue(providers('connected-model'));
    const view = renderHook(() => useSshCodexProviders('a'));
    if (!late) await act(async () => reject(new Error('connecting')));
    act(() => {
      statusChanged({ config: { id: 'a' }, status: 'ready' } as RemoteHostSnapshot);
      statusChanged({ config: { id: 'a' }, status: 'ready' } as RemoteHostSnapshot);
    });
    if (late) await act(async () => reject(new Error('connecting')));
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.providers[0]?.models.codex?.[0].id).toBe('connected-model');
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('keeps the catalog on repeated ready snapshots and reloads once on reconnect', async () => {
    list.mockResolvedValue(providers('remote-model'));
    const view = renderHook(() => useSshCodexProviders('a'));
    const status = (value: string) => statusChanged({ config: { id: 'a' }, status: value } as RemoteHostSnapshot);
    act(() => { status('ready'); status('ready'); });
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const catalog = view.result.current.providers;
    act(() => { status('ready'); status('ready'); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(view.result.current.providers).toBe(catalog);
    expect(view.result.current.status).toBe('ready');
    act(() => { status('disconnected'); status('connecting'); status('ready'); status('ready'); });
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(list).toHaveBeenCalledTimes(2);
    act(() => view.result.current.refresh());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });
  it('ignores late results from a previous host and invalidates on disconnect', async () => {
    let finish!: (value: ReturnType<typeof providers>) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue(providers('host-b'));
    const view = renderHook(({ hostId }) => useSshCodexProviders(hostId), { initialProps: { hostId: 'a' } });
    view.rerender({ hostId: 'b' });
    await waitFor(() => expect(view.result.current.providers[0]?.models.codex?.[0].id).toBe('host-b'));
    await act(async () => { finish(providers('host-a')); });
    expect(view.result.current.providers[0].models.codex?.[0].id).toBe('host-b');
    act(() => statusChanged({ config: { id: 'b' }, status: 'disconnected' } as RemoteHostSnapshot));
    expect(view.result.current.status).toBe('error');
    expect(view.result.current.providers).toEqual([]);
    act(() => statusChanged({ config: { id: 'b' }, status: 'ready' } as RemoteHostSnapshot));
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
  });
  it('drops a previous account response and allows explicit retry after a read failure', async () => {
    let finish!: (value: ReturnType<typeof providers>) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(providers('new'));
    const view = renderHook(() => useSshCodexProviders('a'));
    setDataOwnerGeneration('other', 2);
    view.rerender();
    await waitFor(() => expect(view.result.current.status).toBe('error'));
    await act(async () => finish(providers('old')));
    expect(view.result.current.providers).toEqual([]);
    act(() => view.result.current.refresh());
    await waitFor(() => expect(view.result.current.providers[0]?.models.codex?.[0].id).toBe('new'));
  });
  it('creates with the host default even if the controller has only a gateway or a failed catalog', async () => {
    list.mockResolvedValue(providers('remote-native'));
    const selection = await loadSshSessionModelSelection('builder', {
      providers: [], loading: false, loadFailed: true, agentKind: 'codex',
      preferred: { model: 'codex/local-model', providerId: 'xd', effort: 'medium', fastMode: true },
    });
    expect(list).toHaveBeenCalledWith('builder');
    expect(selection).toEqual({ ok: true, model: 'remote-native', providerId: 'openai', effort: 'high', fastMode: false });
  });
  it.each([
    [null, 'remote-default'], [null, 'also-available'],
    ['openai', 'remote-default'], ['openai', 'also-available'],
  ] as const)('ignores controller preferences for native source %s and model %s', async (providerId, model) => {
    list.mockResolvedValue([sshNativeCodexProvider([
      sshModel('remote-default', { supportsFastMode: true }),
      sshModel('also-available', { supportsFastMode: true }),
    ])]);
    const getPresetEffort = vi.fn(() => 'low' as const);
    const getPresetFast = vi.fn(() => true);
    const selection = await loadSshSessionModelSelection('builder', {
      providers: [], loading: false, loadFailed: false, agentKind: 'codex',
      preferred: { model, providerId, effort: 'low', fastMode: true },
      getPresetEffort, getPresetFast,
    });
    expect(selection).toEqual({
      ok: true, model: 'remote-default', providerId: 'openai', effort: 'high', fastMode: false,
    });
    expect(getPresetEffort).not.toHaveBeenCalled();
    expect(getPresetFast).not.toHaveBeenCalled();
  });
  it('fails creation without falling back to local models', async () => {
    list.mockRejectedValue(new Error('remote unavailable'));
    expect(await loadSshSessionModelSelection('builder', {
      providers: providers('controller-native'), loading: false, loadFailed: false, agentKind: 'codex',
      preferred: { model: 'controller-native', effort: 'low', fastMode: false },
    })).toEqual({ ok: false, reason: 'catalog-error' });
  });
});
