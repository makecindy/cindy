// @vitest-environment jsdom
// The local IM cards' API for a cloud instance: settings over the private channel, binding
// starts on authorization tickets, provider links open on this computer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_HOOK_PROVIDER_ACTION_URL,
  CLOUD_IM_SETTINGS_CHANNEL,
} from '../../../../shared/cloudImSettings';
import { createCloudImTarget, type CloudImAuthorization } from '../cloudImTarget';

const DEVICE = 'cloud-device-1';
let replies: Array<{ call: string; result: unknown; generation?: number }>;
const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]) => {
  const request = args[0] as { call: string; args: unknown[] };
  const reply = replies.find((entry) => entry.call === request.call);
  return { ownerGeneration: reply?.generation ?? 1, result: reply?.result ?? null };
});
const openExternal = vi.fn(async () => ({ success: true }));
// Status subscriptions follow the document; each test ends its own so none outlives it.
const subscriptions: Array<() => void> = [];

function target(overrides: Partial<CloudImAuthorization> = {}) {
  const authorization: CloudImAuthorization = {
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => false),
    ...overrides,
  };
  const pickDirectory = vi.fn(async () => '/home/cindy/work');
  return {
    authorization,
    pickDirectory,
    target: createCloudImTarget(DEVICE, { authorization, pickDirectory }),
  };
}
const requests = () =>
  invoke.mock.calls.map(([device, channel, args]) => {
    expect(device).toBe(DEVICE);
    expect(channel).toBe(CLOUD_IM_SETTINGS_CHANNEL);
    return args[0] as { call: string; args: unknown[] };
  });

beforeEach(() => {
  replies = [{ call: 'maker:hook-control:get', result: { hook: { enabled: true } } }];
  Object.assign(window, { electronAPI: { deviceLink: { invoke }, openExternal } });
});
afterEach(() => {
  for (const stop of subscriptions.splice(0)) stop();
  document.documentElement.removeAttribute('data-app-hidden');
  Reflect.deleteProperty(document, 'visibilityState');
  vi.useRealTimers();
  vi.restoreAllMocks();
  invoke.mockClear();
  openExternal.mockClear();
});

describe('cloud IM target', () => {
  it('sends the same payloads the local preload sends', async () => {
    const { target: t } = target();
    await t.api.hookControl.addProject('/home/cindy/repo');
    await t.api.hookControl.setSharedProjectPrefs('repo', { model: 'm' });
    await t.api.hookControl.setTelegramGroupActivation('b1', '-100', 'always');
    await t.api.telegramBot.setPersona({ botName: 'Cindy', soul: 's', syncProfile: true });
    await t.api.imDefaultSettingsGet('slack');
    expect(requests()).toEqual([
      { call: 'maker:hook-control:add-project', args: [{ directory: '/home/cindy/repo' }] },
      { call: 'maker:hook-control:shared-prefs-set', args: [{ workspace: 'repo', patch: { model: 'm' } }] },
      {
        call: 'maker:hook-control:telegram-group-activation-set',
        args: [{ bindingId: 'b1', chatId: '-100', mode: 'always' }],
      },
      { call: 'telegramBot:set-persona', args: [{ botName: 'Cindy', soul: 's', syncProfile: true }] },
      { call: 'maker:im-default-settings:get', args: ['slack'] },
    ]);
  });

  it('starts bindings on the authorization ticket and ends them over the channel', async () => {
    const { target: t, authorization } = target();
    await expect(t.api.hookControl.setEnabled(true)).resolves.toEqual({ hook: { enabled: true } });
    await t.api.hookControl.addBinding();
    await t.api.hookControl.rebindTeam('T9');
    await t.api.hookControl.providerBindStart('x');
    await t.api.hookControl.providerBindStart('feishu');
    expect(vi.mocked(authorization.start).mock.calls.map(([request]) => request)).toEqual([
      { kind: 'slack' },
      { kind: 'slack' },
      { kind: 'slack-rebind', teamId: 'T9' },
      { kind: 'provider', provider: 'x' },
      { kind: 'provider', provider: 'feishu' },
    ]);
    expect(requests().every((request) => request.call === 'maker:hook-control:get')).toBe(true);
    invoke.mockClear();
    await t.api.hookControl.setEnabled(false);
    await t.api.hookControl.providerBindRevoke('telegram');
    expect(requests()).toEqual([
      { call: 'maker:hook-control:set-enabled', args: [{ enabled: false }] },
      { call: 'maker:hook-control:provider-bind-revoke', args: [{ provider: 'telegram' }] },
    ]);
  });

  it.each(['telegram', 'x', 'feishu'] as const)('cancels only the running %s ticket', async (provider) => {
    const running = target({ cancel: vi.fn(async () => true) });
    await running.target.api.hookControl.providerBindCancel(provider);
    expect(requests()).toEqual([{ call: 'maker:hook-control:get', args: [] }]);
    invoke.mockClear();
    const idle = target();
    await idle.target.api.hookControl.providerBindCancel(provider);
    expect(requests()).toEqual([
      { call: 'maker:hook-control:provider-bind-cancel', args: [{ provider }] },
    ]);
  });

  it('enables Slack communications through its own ticket while disabling stays a native write', async () => {
    const { target: t, authorization } = target();
    await t.api.hookControl.setSlackCommunications('team-a', true);
    expect(authorization.start).toHaveBeenCalledWith({ kind: 'slack-communications', teamId: 'team-a' });
    expect(requests()).toEqual([{ call: 'maker:hook-control:get', args: [] }]);
    invoke.mockClear();
    await t.api.hookControl.setSlackCommunications('team-a', false);
    expect(requests()).toEqual([{ call: 'maker:hook-control:set-slack-communications', args: [{ teamId: 'team-a', enabled: false }] }]);
  });

  it('opens provider links on this computer', async () => {
    replies.push({ call: CLOUD_HOOK_PROVIDER_ACTION_URL, result: { url: 'https://t.me/cindy' } });
    const { target: t } = target();
    await t.api.hookControl.openProviderAction('telegram', 'provider');
    expect(requests()).toEqual([
      { call: CLOUD_HOOK_PROVIDER_ACTION_URL, args: [{ provider: 'telegram', action: 'provider' }] },
    ]);
    expect(openExternal).toHaveBeenCalledWith('https://t.me/cindy');
  });

  // Unit/jsdom: the remote adapter must not swallow a browser rejection or disable native
  // Feishu actions.
  it('reports a rejected browser opening instead of a successful action', async () => {
    replies.push({ call: CLOUD_HOOK_PROVIDER_ACTION_URL, result: { url: 'https://t.me/cindy' } });
    openExternal.mockResolvedValueOnce({ success: false });
    await expect(target().target.api.hookControl.openProviderAction('telegram', 'provider'))
      .rejects.toThrow('OPEN_FAILED');
  });

  it('selects the working computer through its native handler and awaits the result', async () => {
    const result = { hook: { feishu: { binding: { state: 'confirmed' } } } };
    replies.push({ call: 'maker:hook-control:provider-bind-select', result });
    await expect(target().target.api.hookControl.providerBindSelect('feishu')).resolves.toEqual(result);
    expect(requests()).toEqual([
      { call: 'maker:hook-control:provider-bind-select', args: [{ provider: 'feishu' }] },
    ]);
  });

  it('starts an unbound provider switch on a ticket and preserves retained bindings', async () => {
    const { target: t, authorization } = target();
    replies[0]!.result = { hook: { feishu: { enabled: false, binding: null } } };
    await t.api.hookControl.setProviderEnabled('feishu', true);
    expect(authorization.start).toHaveBeenCalledWith({ kind: 'provider', provider: 'feishu' });
    expect(requests().every((r) => r.call === 'maker:hook-control:get')).toBe(true);
    vi.mocked(authorization.start).mockClear();
    invoke.mockClear();
    replies[0]!.result = { hook: { feishu: { enabled: false, binding: { state: 'confirmed' } } } };
    await t.api.hookControl.setProviderEnabled('feishu', true);
    expect(authorization.start).not.toHaveBeenCalled();
    expect(requests()).toContainEqual({ call: 'maker:hook-control:set-provider-enabled', args: [{ provider: 'feishu', enabled: true }] });
  });

  it('keeps the existing switch path on an older Host without a provider ticket', async () => {
    const { target: t, authorization } = target({ canAuthorizeProvider: () => false });
    await t.api.hookControl.setProviderEnabled('feishu', true);
    expect(authorization.start).not.toHaveBeenCalled();
    expect(requests()).toEqual([
      { call: 'maker:hook-control:set-provider-enabled', args: [{ provider: 'feishu', enabled: true }] },
    ]);
  });

  it('picks directories in the instance browser', async () => {
    const { target: t, pickDirectory } = target();
    await expect(t.api.showOpenDirectoryDialog()).resolves.toEqual({
      canceled: false,
      path: '/home/cindy/work',
    });
    pickDirectory.mockResolvedValueOnce(null as unknown as string);
    await expect(t.api.showOpenDirectoryDialog()).resolves.toEqual({ canceled: true });
  });

  it('refuses replies from another account generation', async () => {
    const { target: t } = target();
    await t.api.hookControl.get();
    replies[0]!.generation = 2;
    await expect(t.api.hookControl.get()).rejects.toThrow('[OWNER_CHANGED]');
  });

  it('polls the connection snapshot only while a card listens', async () => {
    vi.useFakeTimers();
    const { target: t } = target();
    const listener = vi.fn();
    const stop = t.api.hookControl.onStatusChanged(listener);
    await vi.advanceTimersByTimeAsync(5100);
    expect(listener).toHaveBeenCalledWith({ enabled: true });
    replies[0]!.result = { hook: { enabled: true } };
    await vi.advanceTimersByTimeAsync(5100);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stops polling while the IM page is hidden and refreshes once it returns', async () => {
    vi.useFakeTimers();
    const { target: t } = target();
    const listener = vi.fn();
    subscriptions.push(t.api.hookControl.onStatusChanged(listener));
    await vi.advanceTimersByTimeAsync(5100);
    expect(listener).toHaveBeenCalledTimes(1);
    t.setActive(false);
    invoke.mockClear();
    replies[0]!.result = { hook: { enabled: false } };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoke).not.toHaveBeenCalled();
    t.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ enabled: false });
    await vi.advanceTimersByTimeAsync(5100);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  // §8.3: a window the host hid or minimised keeps visibilityState visible when background
  // throttling is off, so the hidden-animation gate's attribute must stop the poll as well.
  // Before: the interval kept issuing instance calls behind a hidden window.
  it.each([
    [
      'the host hides the window',
      () => document.documentElement.setAttribute('data-app-hidden', 'true'),
      () => document.documentElement.removeAttribute('data-app-hidden'),
    ],
    ['the document is hidden', () => setVisibility('hidden'), () => setVisibility('visible')],
  ])('stops polling while %s and reads once when it is back', async (_case, hide, show) => {
    vi.useFakeTimers();
    const { target: t } = target();
    const listener = vi.fn();
    subscriptions.push(t.api.hookControl.onStatusChanged(listener));
    hide();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(invoke).not.toHaveBeenCalled();
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ enabled: true });
    await vi.advanceTimersByTimeAsync(5100);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  // Each read is a call in the instance's one-at-a-time queue; a slow reply must not stack
  // further reads behind it. Before: every tick issued another call while one was out.
  it('skips ticks while a read is still out', async () => {
    vi.useFakeTimers();
    let answer!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ ownerGeneration: 1, result: { hook: { enabled: true } } });
        }),
    );
    const { target: t } = target();
    const listener = vi.fn();
    subscriptions.push(t.api.hookControl.onStatusChanged(listener));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    answer();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}
