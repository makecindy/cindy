import { describe, expect, it, vi } from 'vitest';
import { XdtHelperToolRegistry } from '../../../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry.js';
import { registerSetSessionProjectPinTool } from '../../../../../../packages/lizi-mcps/src/xdt-helper/set_session_project_pin.js';
import { createSessionProjectPinSetter } from '../sessionProjectPin.js';
import { admitTaskAction } from '../../maker-ipc/taskActionAuthorization.js';

// #7402 / agent-user-parity: actual registry -> host boundary; archive tests do
// not cover this new metadata field or an older host. Minimal inputs below
// distinguish routing, unsupported writes, unknown receipts and expired input.
// Unit tier: injected transport/storage; persistence is covered by sessionsUpdate.
function setup(remote?: Parameters<typeof createSessionProjectPinSetter>[0]['remote']) {
  const patch = vi.fn(async (_id: string, value: { projectPinnedAt: string | null }) => value);
  const setter = createSessionProjectPinSetter({ patch, remote });
  const registry = new XdtHelperToolRegistry();
  registerSetSessionProjectPinTool(registry, {
    getSessionContext: () => ({ sessionId: 'caller', agentKind: 'codex', workingDir: '/test/project' }),
    setSessionProjectPin: setter,
  });
  const call = async (id: string, pinned = true) => {
    const result = await registry.call('set_session_project_pin', { session_id: id, pinned });
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('Expected text');
    return JSON.parse(first.text);
  };
  return { patch, setter, call };
}

describe('project pin tool', () => {
  it('persists a local pin and unpins without changing global metadata', async () => {
    const s = setup();
    expect(await s.call('local::task')).toMatchObject({ ok: true, project_pinned_at: expect.any(String) });
    expect(s.patch).toHaveBeenCalledWith('task', { projectPinnedAt: expect.any(String) }, expect.any(Object));
    expect(await s.call('task', false)).toMatchObject({ ok: true, project_pinned_at: null });
    expect(s.patch).toHaveBeenLastCalledWith('task', { projectPinnedAt: null }, expect.any(Object));
  });

  it.each(['::task', 'pc::', 'local::pc::task'])('rejects malformed target %s before any write', async id => {
    const s = setup();
    expect(await s.call(id)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(s.patch).not.toHaveBeenCalled();
  });

  it('rejects an old remote host before sending patch-meta', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { id: 'task' } }));
    const s = setup({ captureAccess: () => () => {}, invoke });
    expect(await s.call('pc::task')).toMatchObject({ ok: false, errorCode: 'REMOTE_UNSUPPORTED' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(s.patch).not.toHaveBeenCalled();
  });

  it('checks the remote receipt and returns the qualified target', async () => {
    const invoke = vi.fn(async (_device, channel, args, options) => {
      options?.preSend?.();
      return { ok: true as const, result: { id: args[0], projectPinnedAt: channel.endsWith(':get') ? null : args[1].projectPinnedAt } };
    });
    const s = setup({ captureAccess: () => () => {}, invoke });
    expect(await s.call('pc::task')).toMatchObject({ ok: true, session_id: 'pc::task', project_pinned_at: expect.any(String) });
    expect(invoke.mock.calls.map(c => c[1])).toEqual(['local-db:sessions:get', 'local-db:sessions:patch-meta']);
    expect(s.patch).not.toHaveBeenCalled();
  });

  it('reports a lost remote write receipt as uncertain without retrying', async () => {
    const invoke = vi.fn(async (_device, channel, _args, options) => {
      options?.preSend?.();
      if (channel.endsWith(':get')) return { ok: true as const, result: { id: 'task', projectPinnedAt: null } };
      throw new Error('timeout');
    });
    const s = setup({ captureAccess: () => () => {}, invoke });
    expect(await s.call('pc::task')).toMatchObject({ ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rechecks task authorization at the final remote send', async () => {
    let current = true;
    const check = () => { if (!current) throw new Error('expired'); };
    const decision = await admitTaskAction(
      { server: 'cindy_helper', tool: 'set_session_project_pin', sessionId: 'caller', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => check(), assertCurrentSync: check },
    );
    if (!decision.ok || !decision.run) throw new Error('Expected authorization');
    const writes = vi.fn();
    const s = setup({
      captureAccess: () => () => {},
      invoke: async (_device, channel, _args, options) => {
        if (channel.endsWith('patch-meta')) current = false;
        options?.preSend?.();
        if (channel.endsWith('patch-meta')) writes();
        return { ok: true, result: { id: 'task', projectPinnedAt: null } };
      },
    });
    expect(await decision.run(() => s.setter({ sessionId: 'task', deviceId: 'pc', pinned: true }))).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });
});
