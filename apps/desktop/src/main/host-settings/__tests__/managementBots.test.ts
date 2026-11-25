import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookControlManager } from '../../hook-control/manager.js';
import type { ManagementExecution } from '../management.js';
import { configureCloudHookManagement, listOfficialBotManagement } from '../managementBots.js';
const caller = { key: 'isolated-cloud-owner', assertCurrent() {} };
afterEach(() => vi.useRealTimers());
function setup() {
  // A partial Slack hook view the manager double hands to the real handlers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view: any = {
    url: 'https://hook.example.invalid',
    enabled: true,
    serverMultiTeam: true,
    bindings: [
      { teamId: 'team-a', slackUserId: 'user-a', teamName: 'Workspace A', displaced: true },
    ],
    pendingBind: null,
    binding: null,
    telegram: {},
    x: {},
    feishu: {},
  };
  const manager = {
    snapshot: () => structuredClone(view),
    rebindTeam: vi.fn((teamId: string) => {
      view.pendingBind = {
        teamId,
        intent: 'rebind',
        state: 'pending',
        authorizeUrl: 'https://auth.example.invalid/slack?state=fixture',
      };
      return true;
    }),
    cancelPendingBind: vi.fn(() => {
      view.pendingBind = null;
      return true;
    }),
    bindRevoke: vi.fn(() => {
      view.binding = null;
      return true;
    }),
  };
  configureCloudHookManagement(() => manager as unknown as HookControlManager);
  let cancel = () => {};
  const execution: ManagementExecution = {
    signal: new AbortController().signal,
    assertCurrent() {},
    prompt: vi.fn(),
    onCancel(fn) {
      cancel = fn;
    },
  };
  const action = () =>
    listOfficialBotManagement(caller)
      .find((e) => e.id.endsWith(':team-a'))!
      .actions.find((a) => a.intent === 'authorize')!;
  return { view, manager, execution, action, cancel: () => cancel() };
}
describe('official cloud bot native binding branches', () => {
  // Unit regression: a retained multi-workspace connection restores the same team,
  // so waiting exclusively for a new team leaves the remote authorization running forever.
  it('finishes when enabling a retained Slack connection without another authorization', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.view.enabled = false;
    s.view.status = 'disabled';
    s.view.bindings[0].displaced = false;
    const addBinding = vi.fn();
    Object.assign(s.manager, { armAutoBind: vi.fn(), addBinding, setProviderEnabled: () => { s.view.enabled = true; s.view.status = 'connected'; } });
    const action = listOfficialBotManagement(caller)[0]!.actions.find(a => a.intent === 'authorize')!;
    let settled = false;
    const run = action.run({}, s.execution).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await run;
    expect(addBinding).not.toHaveBeenCalled();
    expect(s.execution.prompt).not.toHaveBeenCalled();
  });

  // Restoring Slack communications may need OAuth but must not take over the workspace bot.
  it('projects and completes communications authorization for only the chosen Slack team', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.view.serverSlackCommunications = true;
    s.view.bindings[0].communicationsEnabled = false;
    const communications = vi.fn(async () => {
      s.view.pendingBind = { state: 'pending', purpose: 'communications', teamId: 'team-a', intent: 'rebind', authorizeUrl: 'https://auth.example.invalid/slack?state=communications' };
      return { ok: true, result: { authorizing: true } };
    });
    Object.assign(s.manager, { setSlackCommunications: communications });
    const action = listOfficialBotManagement(caller).find(e => e.id.endsWith(':team-a'))!.actions.find(a => a.intent === 'connect');
    expect(action).toBeDefined();
    const run = action!.run({}, s.execution);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.execution.prompt).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser', url: s.view.pendingBind.authorizeUrl }));
    expect(communications).toHaveBeenCalledWith('team-a', true);
    expect(s.manager.rebindTeam).not.toHaveBeenCalled();
    s.view.bindings[0].communicationsEnabled = true;
    s.view.pendingBind = null;
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(s.view.bindings[0].displaced).toBe(true);
  });

  it('does not cancel another Slack authorization that replaces a communications attempt', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.view.serverSlackCommunications = true;
    Object.assign(s.manager, { setSlackCommunications: async () => {
      s.view.pendingBind = { state: 'pending', purpose: 'communications', teamId: 'team-a', authorizeUrl: 'https://auth.example.invalid/slack?state=first' };
      return { ok: true, result: {} };
    } });
    const action = listOfficialBotManagement(caller).find(e => e.id.endsWith(':team-a'))!.actions.find(a => a.intent === 'connect');
    expect(action).toBeDefined();
    const run = action!.run({}, s.execution);
    const rejected = expect(run).rejects.toThrow('CHANGED');
    await vi.advanceTimersByTimeAsync(0);
    s.view.pendingBind = { state: 'pending', purpose: 'communications', teamId: 'team-a', authorizeUrl: 'https://auth.example.invalid/slack?state=second' };
    s.cancel();
    expect(s.manager.cancelPendingBind).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });

  it('rebinds only the selected displaced workspace and waits for its active result', async () => {
    vi.useFakeTimers();
    const s = setup();
    const run = s.action().run({}, s.execution);
    await Promise.resolve();
    expect(s.manager.rebindTeam).toHaveBeenCalledWith('team-a');
    expect(s.execution.prompt).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser' }));
    s.view.bindings.push({ teamId: 'untouched', displaced: false });
    s.view.bindings[0].displaced = false;
    s.view.pendingBind = null;
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(s.view.bindings[1]).toEqual({ teamId: 'untouched', displaced: false });
  });
  it('does not report cleared authorization as a successful rebind', async () => {
    vi.useFakeTimers();
    const s = setup();
    const run = s.action().run({}, s.execution);
    const rejected = expect(run).rejects.toThrow('AUTH_FAILED');
    await Promise.resolve();
    s.view.pendingBind = null;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(s.view.bindings[0].displaced).toBe(true);
  });
  it('does not cancel a different native authorization that took over', async () => {
    vi.useFakeTimers();
    const s = setup();
    const run = s.action().run({}, s.execution);
    const rejected = expect(run).rejects.toThrow('CHANGED');
    await Promise.resolve();
    s.view.pendingBind.authorizeUrl = 'https://auth.example.invalid/slack?state=another';
    s.cancel();
    expect(s.manager.cancelPendingBind).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });
  it('supports the native disconnect action for a legacy single binding', async () => {
    const s = setup();
    s.view.serverMultiTeam = false;
    s.view.bindings = [];
    s.view.binding = { state: 'confirmed', slackUserId: 'user-a' };
    const action = listOfficialBotManagement(caller)[0]!.actions.find(
      (a) => a.intent === 'disconnect',
    )!;
    await action.run({}, s.execution);
    expect(s.manager.bindRevoke).toHaveBeenCalledTimes(1);
  });
});

// Unit: remote official authorization omitted Feishu, and enabling an unbound provider
// already starts a native attempt. The ticket must follow that attempt, not replace its URL.
// Prior coverage only exercised Slack; a disabled Feishu lane is the minimal missing case.
describe('official provider authorization tickets', () => {
  function providerSetup(provider: 'telegram' | 'x' | 'feishu') {
    vi.useFakeTimers();
    const s = setup();
    const url = 'https://auth.example.invalid/authorize?state=fixture';
    const pending = () => ({ state: 'pending', attemptId: 'attempt-a', connectUrl: url, bindCode: provider === 'feishu' ? 'TEST-CODE' : null, expiresAt: Date.now() + 300_000 });
    s.view[provider] = { url: 'https://hook.example.invalid', enabled: false, available: true, status: 'connected', binding: null };
    const enable = vi.fn((_provider, enabled) => { s.view[provider].enabled = enabled; s.view[provider].binding = pending(); });
    const start = vi.fn(() => { s.view[provider].binding = { ...pending(), attemptId: 'duplicate-attempt' }; return true; });
    const cancel = vi.fn(() => true);
    Object.assign(s.manager, { setProviderEnabled: enable, providerBindStart: start, providerBindCancel: cancel });
    const action = () => listOfficialBotManagement(caller).find(e => e.id === `bot:official:${provider}`)?.actions.find(a => a.intent === 'authorize');
    return { ...s, action, enable, start, cancelProvider: cancel, url };
  }

  it.each(['telegram', 'x', 'feishu'] as const)('follows one %s attempt through confirmation', async provider => {
    const s = providerSetup(provider);
    expect(s.action()).toBeDefined();
    const run = s.action()!.run({}, s.execution);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.start).not.toHaveBeenCalled();
    expect(s.execution.prompt).toHaveBeenCalledWith(expect.objectContaining({
      url: s.url, ...(provider === 'feishu' ? { userCode: 'TEST-CODE', kind: 'device' } : { kind: 'browser' }),
    }));
    s.view[provider].binding = { ...s.view[provider].binding, state: 'confirmed', connectUrl: null, bindCode: null };
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(s.cancelProvider).not.toHaveBeenCalled();
  });

  it('does not cancel a newer Feishu attempt or accept its result', async () => {
    const s = providerSetup('feishu');
    expect(s.action()).toBeDefined();
    const run = s.action()!.run({}, s.execution);
    const rejected = expect(run).rejects.toThrow('CHANGED');
    await vi.advanceTimersByTimeAsync(0);
    s.view.feishu.binding = { ...s.view.feishu.binding, attemptId: 'attempt-b' };
    s.cancel();
    expect(s.cancelProvider).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });

  it('cancels the Feishu attempt owned by its ticket', async () => {
    const s = providerSetup('feishu');
    expect(s.action()).toBeDefined();
    const run = s.action()!.run({}, s.execution);
    const rejected = expect(run).rejects.toThrow('AUTH_FAILED');
    await vi.advanceTimersByTimeAsync(0);
    s.cancel();
    expect(s.cancelProvider).toHaveBeenCalledWith('feishu');
    s.view.feishu.binding.state = 'failed';
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });
});
