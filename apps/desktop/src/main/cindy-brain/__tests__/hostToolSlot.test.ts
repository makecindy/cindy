import { describe, expect, it, vi } from 'vitest';
import { handlePluginHostToolRequest, type PluginHostToolPorts } from '../hostToolSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { authorizePluginHostToolCall, getPluginHostToolCaller } from '../../mcp-integrations/hostToolCaller.js';
import { createTaskToolCallAuthorizer } from '../../maker-ipc/taskToolCallAuthorizer.js';
import { captureTaskActionSyncGuard, captureTaskActionDeliveryGuard, hasTaskActionAuthorization } from '../../maker-ipc/taskActionAuthorization.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { createGhostPageBridge } from '../../../shared/ghostPageBridge.js';
import { createSchedulerMcpServer } from '@cindy/mcps';
import { getDesktopMcpToolApprovalPolicy } from '../../maker-host/mcp-tool-approval-policy.js';
import { withPluginSchedulerApproval } from '../pluginSchedulerApproval.js';

const uiPipe = createGhostProductionCallbacks<{
  send(event: { sender: { id: number; isDestroyed(): boolean } }, payload: unknown): Promise<unknown>;
}>({ variables: ['executionPipe'], callbacks: { send: ['ipcMain.handle', 'ghost-pipe:send'] } });

// Test value: the production gateway must preserve raw tool results and enforce §1.2/§3
// approval and owner/install fences for a caller without a Session. Existing taskSlot tests
// cover plugin-owned tasks, not arbitrary Host tools. Unit; minimal single approved plugin.
function fixture() {
  let ghost: InstalledGhost | null = {
    enabled: true, dir: '/fixture/dashboard', approval: { state: 'approved', revision: 'r1' },
    manifest: { schemaVersion: 3, id: 'dashboard', name: 'Dashboard', version: '1.0.0', kind: 'chip', entry: 'main.js',
      agent: { hostTools: ['history', 'control', 'scheduler'] } },
    approvedHostToolGroups: ['history', 'control', 'scheduler'],
  };
  let generation = 1;
  const owner = () => ({ dataOwnerId: 'owner', ownerGeneration: generation });
  const result = { content: [{ type: 'text' as const, text: '{"ok":true,"items":["task"]}' }], _meta: { unchanged: true } };
  const invoke = vi.fn(async (_name: string, _args: Record<string, unknown>) => result);
  const commonAuthorize = createTaskToolCallAuthorizer({
    getDb: () => ({} as never), isScopeCurrent: () => true, authorizePluginCall: authorizePluginHostToolCall,
  });
  const ports: PluginHostToolPorts = {
    owner, getGhost: () => ghost,
    createRuntime: (_server, caller) => ({
      describe: name => ({ name, category: name === 'list_sessions' ? 'history' : name === 'schedule_list' ? 'scheduler' : name === 'archive_sessions' ? 'control' : 'auth' }),
      call: async (tool, args) => {
        const authorization = await commonAuthorize({ caller, sessionId: undefined, server: _server as 'cindy_helper', tool, args });
        if (!authorization.ok) throw new Error(authorization.errorCode);
        return authorization.run!(() => invoke(tool, args ?? {}));
      },
      close: vi.fn(async () => {}),
    }),
    approveGroup: vi.fn(async (_id, group, current) => current() && ghost?.approvedHostToolGroups?.includes(group) === true),
    policy: (_server, tool) => tool === 'archive_sessions' ? 'prompt-each-time' : 'auto-approve',
    confirm: vi.fn(async () => true), recordCall: vi.fn(),
  };
  const call = (tool = 'list_sessions', args: Record<string, unknown> = {}) => handlePluginHostToolRequest('dashboard', {
    type: 'host-tool-request', server: tool === 'schedule_list' ? 'cindy_scheduler' : 'cindy_helper', tool, args,
  }, () => true, ports);
  return { ports, invoke, result, call, get ghost() { return ghost!; }, remove: () => { ghost = null; }, changeOwner: () => { generation++; } };
}
const code = (value: Awaited<ReturnType<typeof handlePluginHostToolRequest>>) => JSON.parse(value.content[0].type === 'text' ? value.content[0].text : '{}').errorCode;

describe('plugin Host tool entry', () => {
  // Unit, §1.2: runtime.close is asynchronous too. The old last check ran
  // before cleanup, so an owner switch during close could return old data.
  it.each(['owner', 'approval'] as const)('rechecks %s after asynchronous runtime cleanup before returning tool data', async change => {
    const f = fixture(), create = f.ports.createRuntime;
    const close = vi.fn(async () => {
      await Promise.resolve();
      if (change === 'owner') f.changeOwner(); else f.ghost.approvedHostToolGroups = [];
    });
    f.ports.createRuntime = (server, caller) => ({ ...create(server, caller)!, close });
    expect(code(await f.call())).toBe('PERMISSION_DENIED');
    expect(close).toHaveBeenCalledOnce();
  });

  it('routes the public UI API through the real IPC dispatcher using the sender identity', async () => {
    const f = fixture();
    const sender = { id: 7, isDestroyed: () => false };
    const ipc = uiPipe({
      ghostIdForLogicWebContents: (id: number) => id === sender.id ? 'dashboard' : null,
      requireGhostAvailableForActiveSession() {},
      requestPluginHostToolCall: (id: string, payload: unknown, current: () => boolean) => handlePluginHostToolRequest(id, payload, current, f.ports),
    });
    const page = createGhostPageBridge({ ping: async () => ({ ok: true, id: 'dashboard' }), send: payload => ipc.send({ sender }, payload) });
    expect(await page.api.host.call('cindy_helper', 'list_sessions')).toEqual(f.result);
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('list_sessions', {});
  });

  it('rejects a self-reported plugin identity outside the gateway scope', async () => {
    expect(await authorizePluginHostToolCall({ sessionId: undefined, caller: { kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 },
      server: 'cindy_helper', tool: 'archive_sessions', args: {} })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('binds existing write and queued-delivery guards to the plugin approval without a task identity', async () => {
    const f = fixture();
    let beforeWrite: (() => void) | undefined;
    let beforeDelivery: (() => Promise<void>) | undefined;
    f.invoke.mockImplementationOnce(async () => {
      expect(hasTaskActionAuthorization()).toBe(true);
      expect(hasTaskActionAuthorization('unrelated-task')).toBe(false);
      beforeWrite = captureTaskActionSyncGuard();
      beforeDelivery = captureTaskActionDeliveryGuard();
      beforeWrite!();
      await beforeDelivery!();
      return f.result;
    });
    expect(await f.call('archive_sessions')).toBe(f.result);
    // Captured write/delivery fences outlive the temporary caller context.
    expect(beforeWrite).not.toThrow();
    await expect(beforeDelivery!()).resolves.toBeUndefined();
    f.changeOwner();
    expect(beforeWrite).toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
    await expect(beforeDelivery!()).rejects.toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
  });

  it.each(['list_sessions', 'schedule_list', 'archive_sessions'])('dispatches %s through the shared authorizer and preserves the complete tool result', async tool => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => {
      expect(getPluginHostToolCaller()?.caller).toEqual({ kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 });
      return f.result;
    });
    expect(await f.call(tool)).toBe(f.result);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.ports.confirm).toHaveBeenCalledTimes(tool === 'archive_sessions' ? 1 : 0);
  });

  it.each(['missing-approval', 'group-removed', 'owner', 'update', 'uninstall', 'window', 'deny'] as const)('rejects %s before the handler executes', async scenario => {
    const f = fixture();
    if (scenario === 'missing-approval') f.ghost.approvedHostToolGroups = [];
    if (scenario === 'group-removed') f.ghost.manifest.agent!.hostTools = ['history'];
    f.ports.confirm = vi.fn(async () => {
      if (scenario === 'owner') f.changeOwner();
      if (scenario === 'update') f.ghost.approval = { state: 'approved', revision: 'r2' };
      if (scenario === 'uninstall') f.remove();
      return scenario !== 'deny' && scenario !== 'window';
    });
    expect(code(await f.call('archive_sessions', { session_ids: ['target'] }))).toBe('PERMISSION_DENIED');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('denies group-external tools and plugin-management servers without prompting', async () => {
    const f = fixture();
    expect(code(await f.call('request_input_handoff'))).toBe('PERMISSION_DENIED');
    expect(code(await handlePluginHostToolRequest('dashboard', { type: 'host-tool-request', server: 'cindy', tool: 'ghost_call', args: {} }, () => true, f.ports))).toBe('PERMISSION_DENIED');
    expect(f.ports.confirm).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('confirms every risky invocation and executes the exact parameter snapshot shown', async () => {
    const f = fixture(), args = { session_ids: ['original'] };
    f.ports.confirm = vi.fn(async input => { expect(input.args).toEqual({ session_ids: ['original'] }); args.session_ids = ['changed']; return true; });
    await f.call('archive_sessions', args);
    await f.call('archive_sessions', { session_ids: ['original'] });
    expect(f.ports.confirm).toHaveBeenCalledTimes(2);
    expect(f.invoke.mock.calls.every(([, input]) => JSON.stringify(input) === '{"session_ids":["original"]}')).toBe(true);
    expect(f.ports.recordCall).toHaveBeenCalledWith('dashboard', 'cindy_helper', 'archive_sessions');
  });

  it('suppresses a late result after the account changes during execution', async () => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => { f.changeOwner(); return f.result; });
    expect(code(await f.call())).toBe('PERMISSION_DENIED');
  });
});

// Unit, #9801 security: use the production UI/Node gateway and real scheduler
// registry. Earlier tests covered group approval but never shell-bearing inputs.
describe('plugin scheduler command boundary', () => {
  const command = "printf 'complete command'";
  const production = createGhostProductionCallbacks<{
    requestPluginHostToolCall(id: string, payload: unknown, current: () => boolean): Promise<unknown>;
  }>({ functions: ['requestPluginHostToolCall'] });
  function schedulerFixture(node = false, allow = true, script = true) {
    const f = fixture();
    if (node) f.ghost.manifest.node = { entry: 'node.cjs', protocol: 'json-rpc-stdio' };
    let schedule = { id: 'automation', name: 'Automation', workingDir: '/fixture/project',
      executionMode: script ? 'script' : 'agent', scriptConfig: script ? { command, capabilities: [] } : undefined };
    const create = vi.fn(async () => schedule);
    const update = vi.fn(async (_id: string, patch: (current: typeof schedule) => Promise<unknown>) =>
      ({ ...schedule, ...await patch(structuredClone(schedule)) as object }));
    const runNow = vi.fn(async () => 'run'), resume = vi.fn(async () => schedule);
    const get = vi.fn(async () => structuredClone(schedule));
    const installed = vi.fn();
    const install = vi.fn(async () => {
      const prepared = { command: 'node /fixture/project/precheck.mjs', filePath: '/fixture/project/precheck.mjs', content: 'process.exit(0)' };
      installed();
      return { ...prepared, test: { decision: 'run' as const, status: 'passed' as const, exitCode: 0, durationMs: 0,
        stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false } };
    });
    const dialog = { showMessageBox: vi.fn(async (_parent: unknown, _options: Record<string, unknown>) => ({ response: allow ? 0 : 1 })) };
    const entry = production({
      handlePluginHostToolRequest, withPluginSchedulerApproval, getDesktopMcpToolApprovalPolicy,
      findGhostForInstanceId: () => f.ghost, getActiveDataOwnerPushStamp: f.ports.owner,
      createHostToolRuntime: (_server: string, caller: NonNullable<Parameters<typeof createSchedulerMcpServer>[1]>['hostCaller']) =>
        createSchedulerMcpServer({ getScheduler: () => ({ create, updateFromCurrent: update, runNow, resume, get }) as never,
          authorizeCall: authorizePluginHostToolCall,
          hookScript: { install } },
        { agentKind: 'codex', workingDir: '', hostCaller: caller }).hostTools,
      requestPluginTaskApproval: (id: string, active: () => boolean, _confirm: unknown, _explicit: boolean, capability: string) =>
        f.ports.approveGroup(id, capability.split(':')[1] as 'scheduler', active),
      getDeepLinkMainWindow: () => ({ isDestroyed: () => false }), isTrustedAppRendererWindow: () => true,
      createWindowGhostInstallConsentPrompt: vi.fn(), dialog, t: (key: string) => key, log: { info: vi.fn() },
      getPluginHostToolCaller,
    });
    const call = (tool: string, args: Record<string, unknown>) => entry.requestPluginHostToolCall('dashboard',
      { type: 'host-tool-request', server: 'cindy_scheduler', tool, args }, () => true);
    return { ...f, call, dialog, create, update, runNow, resume, get, installed,
      setHook: () => { Object.assign(schedule, { preRunHook: { command } }); } };
  }

  // Unit, #9801: group revocation must still stop ordinary non-shell schedules.
  it('rechecks revocation between separate calls', async () => {
    const f = schedulerFixture(false, true, false);
    await f.call('schedule_run_now', { id: 'automation' });
    expect(f.runNow).toHaveBeenCalledOnce();
    f.ghost.approvedHostToolGroups = [];
    expect(code(await f.call('schedule_run_now', { id: 'automation' }) as never)).toBe('PERMISSION_DENIED');
    expect(f.runNow).toHaveBeenCalledOnce();
  });

  it.each(['schedule_create', 'schedule_update', 'schedule_run_now', 'schedule_resume'] as const)('rejects browser plugin %s of a script without executing or prompting', async tool => {
    const f = schedulerFixture();
    const args = tool === 'schedule_create' ? { name: 'Automation', executionMode: 'script', workingDir: '/fixture/project',
      cronExpr: '0 9 * * *', timezone: 'UTC', recurring: true, agentKind: 'codex', notify: { desktop: false, feishu: false }, scriptConfig: { command } }
      : tool === 'schedule_update' ? { id: 'automation', scriptConfig: { command } } : { id: 'automation' };
    expect(code(await f.call(tool, args) as never)).toBe('UNSUPPORTED_CAPABILITY');
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
    expect({ schedule_create: f.create, schedule_update: f.update, schedule_run_now: f.runNow, schedule_resume: f.resume }[tool]!)
      .not.toHaveBeenCalled();
  });

  it.each(['schedule_create', 'schedule_run_now'] as const)('preserves approved node plugin %s without extra confirmation', async tool => {
    const f = schedulerFixture(true);
    await f.call(tool, tool === 'schedule_create' ? { name: 'Automation', executionMode: 'script', workingDir: '/fixture/project',
      cronExpr: '0 9 * * *', timezone: 'UTC', recurring: true, agentKind: 'codex', notify: { desktop: false, feishu: false }, scriptConfig: { command } } : { id: 'automation' });
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(tool === 'schedule_create' ? f.create : f.runNow).toHaveBeenCalledOnce();
  });

  it.each(['schedule_update', 'schedule_run_now', 'schedule_resume'] as const)('keeps non-shell browser %s on the original scheduler handler', async tool => {
    const f = schedulerFixture(false, true, false);
    await f.call(tool, { id: 'automation', ...(tool === 'schedule_update' ? { recurring: true } : {}) });
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
    expect({ schedule_update: f.update, schedule_run_now: f.runNow, schedule_resume: f.resume }[tool]).toHaveBeenCalledOnce();
    if (tool === 'schedule_run_now') expect(f.runNow).toHaveBeenCalledWith('automation', undefined);
  });

  it.each(['schedule_update', 'schedule_run_now', 'schedule_resume'] as const)('rejects a stored pre-run command during browser %s', async tool => {
    const f = schedulerFixture(false, true, false);
    f.setHook();
    expect(code(await f.call(tool, { id: 'automation', ...(tool === 'schedule_update' ? { name: 'Renamed' } : {}) }) as never))
      .toBe('UNSUPPORTED_CAPABILITY');
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.update).not.toHaveBeenCalled(); expect(f.runNow).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it.each(['schedule_create', 'schedule_update'] as const)('rejects a submitted pre-run command during browser %s', async tool => {
    const f = schedulerFixture(false, true, false);
    expect(code(await f.call(tool, { id: 'automation', preRunHook: { command } }) as never)).toBe('UNSUPPORTED_CAPABILITY');
    expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('rejects a recurring update that reactivates a stored script even without a command in the input', async () => {
    const f = schedulerFixture();
    expect(code(await f.call('schedule_update', { id: 'automation', recurring: true }) as never)).toBe('UNSUPPORTED_CAPABILITY');
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('rejects hook preparation before generating, installing or prompting', async () => {
    const f = schedulerFixture();
    expect(code(await f.call('schedule_set_pre_run_hook', { script: 'process.exit(0)', workingDir: '/fixture/project' }) as never)).toBe('UNSUPPORTED_CAPABILITY');
    expect(f.installed).not.toHaveBeenCalled();
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
