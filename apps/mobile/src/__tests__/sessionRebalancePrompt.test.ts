/**
 * 手机发送前问换号(provider-groups.md §6.2「任务进行中换号」，2026-10-21 用户裁决「和电脑一样」)：系统弹窗的三个按钮
 * 分别是换过去、换过去并让这个任务以后自动换、取消；选过以后自动换的不再弹窗。提议在任务空闲时预先问好，点发送时
 * 没有问好的提议(问不到、回包不对、还没问完)就立即照常发送，不多等一次往返。
 * 从发送前调用的入口验证用户看到什么、任务所在电脑收到什么。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const alert = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ Alert: { alert } }));

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import { i18n } from '@/i18n';
import {
  askMobileSessionRebalance,
  applyMobileSessionRebalancePreferencePatch,
  offerMobileSessionRebalance,
  prefetchMobileSessionRebalance,
  SESSION_REBALANCE_QUERY_TIMEOUT_MS,
} from '@/session/sessionRebalancePrompt';

const MINI = 'device:mini:anthropic';
const reply = (kind: 'ask' | 'auto') => ({
  kind,
  memberKey: MINI,
  label: 'Mini',
  quota: { usedPercent: 20, resetAtMs: Date.now() + 86_400_000, windowMs: 7 * 86_400_000 },
});

function invoker(suggestion: unknown) {
  return vi.fn((_deviceId: string, _channel: string, args?: unknown[]): Promise<unknown> => {
    const request = args?.[0] as { action: string };
    if (request.action !== 'rebalance-suggestion') return Promise.resolve({ ok: true });
    if (suggestion === 'pending') return new Promise(() => undefined);
    return suggestion instanceof Error ? Promise.reject(suggestion) : Promise.resolve(suggestion);
  });
}

type Button = { text: string; onPress(): void };

function press(button: 'confirm' | 'remember' | 'disable' | 'cancel') {
  if (button === 'remember' || button === 'disable') {
    alert.mockImplementationOnce((_title: string, _body: string, buttons: Button[]) => {
      buttons.find((b) => b.text === i18n.t('session.providerGroupRebalance.moreOptions'))!.onPress();
    });
  }
  alert.mockImplementationOnce((_title: string, _body: string, buttons: Button[]) => {
    buttons.find((b) => b.text === i18n.t(`session.providerGroupRebalance.${button}`))!.onPress();
  });
}

const decisions = (invoke: ReturnType<typeof invoker>) =>
  invoke.mock.calls.map(([, , args]) => args?.[0] as { action: string }).filter((r) => r.action === 'rebalance-decision');

async function offer(invoke: ReturnType<typeof invoker>, sessionId = 's1') {
  await offerMobileSessionRebalance({ invoke, hostDeviceId: 'pc', sessionId, clientId: 'message-a', ask: askMobileSessionRebalance });
}

beforeEach(() => {
  alert.mockReset();
});

describe('offerMobileSessionRebalance', () => {
  // Unit/远程写超时合同：手机 5 秒后照常发送，但继续收敛迟到的保存成功/失败。
  it.each([true, false])('reconciles a late preference result instead of claiming a UI timeout failed (ok=%s)', async (ok) => {
    vi.useFakeTimers();
    try {
      press('disable');
      const invoke = invoker(reply('ask'));
      const sessionId = `late-write-${ok}`;
      await prefetchMobileSessionRebalance(invoke, 'pc', sessionId);
      let resolve!: (value: unknown) => void;
      const pending = new Promise<unknown>((done) => { resolve = done; });
      invoke.mockImplementation(async (_device, _channel, args) =>
        (args?.[0] as { action: string }).action === 'rebalance-preference' ? pending : reply('ask'));
      const sending = offer(invoke, sessionId);
      await vi.advanceTimersByTimeAsync(SESSION_REBALANCE_QUERY_TIMEOUT_MS);
      await sending;
      expect(alert).toHaveBeenCalledTimes(2);
      await prefetchMobileSessionRebalance(invoke, 'pc', sessionId);
      resolve({ ok });
      await vi.advanceTimersByTimeAsync(0);
      expect(alert).toHaveBeenCalledTimes(ok ? 2 : 3);
      if (ok) await offer(invoke, sessionId);
      expect(alert).toHaveBeenCalledTimes(ok ? 2 : 3);
    } finally { vi.useRealTimers(); }
  });
  // Unit/§6.2：收到电脑上关闭的推送后，手机不能继续使用已缓存或在途的旧提议；按任务所属电脑隔离。
  it('retires cached and pending proposals from another controller preference push', async () => {
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'remote-disabled');
    await prefetchMobileSessionRebalance(invoke, 'other', 'remote-disabled');
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((done) => { resolve = done; });
    invoke.mockImplementation(async () => response);
    const pending = prefetchMobileSessionRebalance(invoke, 'pc', 'remote-disabled');
    applyMobileSessionRebalancePreferencePatch('pc', 'remote-disabled', { providerGroupRebalanceEnabled: false });
    const ask = vi.fn(async () => 'cancel' as const);
    const input = { invoke, hostDeviceId: 'pc', sessionId: 'remote-disabled', clientId: 'm', ask };
    await offerMobileSessionRebalance(input);
    expect(ask).not.toHaveBeenCalled();
    resolve(reply('ask'));
    await pending;
    await offerMobileSessionRebalance(input);
    expect(ask).not.toHaveBeenCalled();
    await offerMobileSessionRebalance({ ...input, hostDeviceId: 'other' });
    expect(ask).toHaveBeenCalledTimes(1);
  });
  // Unit/时序，§6.2：手机也丢弃关闭操作之前发出的、之后才到达的提议。
  it('discards a late suggestion after opting out', async () => {
    press('disable');
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'late-disable');
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((done) => { resolve = done; });
    invoke.mockImplementation(async (_device, _channel, args) =>
      (args?.[0] as { action: string }).action === 'rebalance-suggestion' ? response : { ok: true });
    const pending = prefetchMobileSessionRebalance(invoke, 'pc', 'late-disable');
    await offer(invoke, 'late-disable');
    resolve(reply('ask'));
    await pending;
    await offer(invoke, 'late-disable');
    expect(alert).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['confirm', false],
    ['remember', true],
    ['cancel', null],
  ] as const)('passes the choice to the task’s computer: %s', async (button, remember) => {
    press(button);
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 's1');
    await offer(invoke);

    expect(invoke).toHaveBeenCalledWith('pc', PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'rebalance-suggestion', sessionId: 's1' }]);
    expect(alert).toHaveBeenCalledTimes(button === 'remember' ? 2 : 1);
    expect(alert.mock.calls[0][0]).toContain('Mini');
    expect(alert.mock.calls[0][2]).toHaveLength(3);
    expect(alert.mock.calls[0][3]).toEqual({ cancelable: false });
    expect(decisions(invoke)).toEqual(remember === null
      ? []
      : [{ action: 'rebalance-decision', sessionId: 's1', clientId: 'message-a', memberKey: MINI, remember }]);
    // 一次提议只管一条消息。
    await offer(invoke);
    expect(alert).toHaveBeenCalledTimes(button === 'remember' ? 2 : 1);
  });

  // Unit, §6.2：Android 不能追加第四个按钮；通过更多选项关闭，并由任务所在电脑保存。
  it('offers a persistent opt-out without sending a switch decision', async () => {
    press('disable');
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'disable');
    await offer(invoke, 'disable');
    expect(alert.mock.calls.slice(0, 2).map((call) => call[2].length)).toEqual([3, 3]);
    expect(invoke).toHaveBeenLastCalledWith('pc', PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'rebalance-preference', sessionId: 'disable', enabled: false }]);
    expect(decisions(invoke)).toEqual([]);
  });

  // Unit/兼容：旧电脑明确拒绝新动作、或保存失败时，不能静默当成已经关闭。
  it.each([false, 'unsupported'])('reports failure to save the opt-out (%s)', async (failure) => {
    press('disable');
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'failed-disable');
    invoke.mockImplementation(async () => {
      if (failure === 'unsupported') throw new Error('[INVALID_PARAMS] unknown action');
      return { ok: false };
    });
    await offer(invoke, 'failed-disable');
    expect(alert).toHaveBeenLastCalledWith(i18n.t('session.providerGroupRebalance.disable'), i18n.t('session.providerGroupRebalance.disableFailed'));
    expect(decisions(invoke)).toEqual([]);
  });

  it('switches without asking for a task set to switch automatically', async () => {
    const invoke = invoker(reply('auto'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 's1');
    await offer(invoke);
    expect(alert).not.toHaveBeenCalled();
    expect(decisions(invoke)).toEqual([{ action: 'rebalance-decision', sessionId: 's1', clientId: 'message-a', memberKey: MINI, remember: false }]);
  });

  // Unit/protocol: combining two valid names used to silently discard the complete suggestion.
  it('offers a combined computer and account name at the protocol limit', async () => {
    const label = `${'D'.repeat(128)} · ${'A'.repeat(128)}`;
    const invoke = invoker({ ...reply('ask'), label });
    press('confirm');
    await prefetchMobileSessionRebalance(invoke, 'pc', 'long-name');
    await offer(invoke, 'long-name');
    expect(alert.mock.calls[0][0]).toContain(label);
    expect(decisions(invoke)).toHaveLength(1);
  });

  it.each([
    ['an older computer that does not know the request', new Error('[INVALID_PARAMS] unknown action')],
    ['no suggestion', null],
    ['a malformed reply', { ...reply('ask'), label: '' }],
    ['a question still on its way', 'pending'],
  ])('sends at once without asking for %s', async (name, suggestion) => {
    const invoke = invoker(suggestion);
    const fetched = prefetchMobileSessionRebalance(invoke, 'pc', name);
    if (suggestion !== 'pending') await fetched;
    await offer(invoke, name);
    expect(alert).not.toHaveBeenCalled();
    expect(decisions(invoke)).toEqual([]);
  });
});
