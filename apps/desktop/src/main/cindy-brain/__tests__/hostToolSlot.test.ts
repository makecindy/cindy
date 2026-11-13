import { describe, expect, it, vi } from 'vitest';
import { handlePluginHostToolRequest, type PluginHostToolPorts } from '../hostToolSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { authorizePluginHostToolCall, createHostToolRuntime, disposePluginHostTools, getPluginHostToolCaller, setHostToolProviders } from '../../mcp-integrations/hostToolCaller.js';
import { createTaskToolCallAuthorizer } from '../../maker-ipc/taskToolCallAuthorizer.js';
import { captureTaskActionSyncGuard, captureTaskActionDeliveryGuard, hasTaskActionAuthorization, bindTaskActionInput, taskActionInputGuard } from '../../maker-ipc/taskActionAuthorization.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { createGhostPageBridge } from '../../../shared/ghostPageBridge.js';
import { createSchedulerMcpServer, type SchedulerMcpDeps } from '@cindy/mcps';
import { Scheduler, type Schedule } from '@cindy/maker-scheduler';
import { getDesktopMcpToolApprovalPolicy } from '../../maker-host/mcp-tool-approval-policy.js';
import { withPluginSchedulerApproval } from '../pluginSchedulerApproval.js';
import { GhostRuntime, type SandboxHandle } from '../runtime/GhostRuntime.js';
import { isValidPluginInstallRelId, pluginInstallStoragePart } from '../../../shared/pluginIdentity.js';

const uiPipe = createGhostProductionCallbacks<{
  send(event: { sender: { id: number; isDestroyed(): boolean } }, payload: unknown): Promise<unknown>;
}>({ variables: ['executionPipe'], callbacks: { send: ['ipcMain.handle', 'ghost-pipe:send'] } });

const lifecycle = createGhostProductionCallbacks<{ getGhostRuntime(): GhostRuntime }>({
  functions: ['getGhostRuntime', 'disposePluginRuntimeHostServices'], initialize: 'let runtimeSingleton = null;',
});
const hostLifecycle = createGhostProductionCallbacks<{ runtime: GhostRuntime }>({
  source: new URL('../../../../../host/src/plugins/runtime.ts', import.meta.url),
  variables: ['disposeRuntimeHostServices', 'runtime'],
});

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
  let pageLive = true;
  const owner = () => ({ dataOwnerId: 'owner', ownerGeneration: generation });
  const result = { content: [{ type: 'text' as const, text: '{"ok":true,"items":["task"]}' }], _meta: { unchanged: true } };
  const invoke = vi.fn(async (_name: string, _args: Record<string, unknown>) => result);
  const commonAuthorize = createTaskToolCallAuthorizer({
    getDb: () => ({} as never), isScopeCurrent: () => true, authorizePluginCall: authorizePluginHostToolCall,
  });
  const ports: PluginHostToolPorts = {
    owner, getGhost: () => ghost,
    createRuntime: (_server, caller) => ({
      describe: name => ({ name, category: name === 'list_sessions' ? 'history' : name === 'schedule_list' ? 'scheduler' : name === 'archive_sessions' || name === 'send_to_session' ? 'control' : 'auth' }),
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
  }, () => pageLive, ports);
  return { ports, invoke, result, call, closePage: () => { pageLive = false; }, get ghost() { return ghost!; }, remove: () => { ghost = null; }, changeOwner: () => { generation++; } };
}
const code = (value: Awaited<ReturnType<typeof handlePluginHostToolRequest>>) => JSON.parse(value.content[0].type === 'text' ? value.content[0].text : '{}').errorCode;

const desktopEntry = createGhostProductionCallbacks<{
  requestPluginHostToolCall(id: string, payload: unknown, current: () => boolean): Promise<unknown>;
}>({ functions: ['requestPluginHostToolCall'] });

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

  // Unit performance regression: the new service admission constructed a runtime
  // for undeclared groups, and Desktop created directories before approval. The
  // existing policy cases asserted only the final error, missing these side effects.
  // Include Node's shared browser/computer providers: an undeclared request must
  // not probe a provider, ask for approval or reach a confirmation before returning.
  it.each([
    ['cindy_docs', 'read_sheet'], ['cindy_browser', 'browser'], ['cindy_computer', 'status'],
  ])('rejects undeclared %s before constructing its runtime', async (server, tool) => {
    const f = fixture();
    const create = vi.spyOn(f.ports, 'createRuntime');
    expect(code(await handlePluginHostToolRequest('dashboard', {
      type: 'host-tool-request', server, tool, args: {},
    }, () => true, f.ports))).toBe('PERMISSION_DENIED');
    expect(create).not.toHaveBeenCalled();
    expect(f.ports.approveGroup).not.toHaveBeenCalled();
    expect(f.ports.confirm).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('creates a private output directory only for an approved Desktop service execution', async () => {
    const f = fixture(), mkdirSync = vi.fn(), mkdir = vi.fn(async () => {});
    f.ghost.manifest.agent!.hostTools = ['docs'];
    f.ghost.approvedHostToolGroups = [];
    const api = desktopEntry({ handlePluginHostToolRequest, findGhostForInstanceId: () => f.ghost,
      getActiveDataOwnerPushStamp: f.ports.owner, ghostInstallApprovalToken: () => 'r1',
      ownerScopedUserDataPath: () => '/fixture/private', fs: { mkdirSync, promises: { mkdir } },
      createHostToolRuntime: () => ({ describe: () => ({ name: 'read_sheet', category: 'read' }), call: f.invoke, close: async () => {} }),
      requestPluginTaskApproval: async () => f.ghost.approvedHostToolGroups!.includes('docs'),
      getDesktopMcpToolApprovalPolicy: () => 'auto-approve', log: { info: vi.fn() },
    });
    const request = () => api.requestPluginHostToolCall('dashboard', { type: 'host-tool-request', server: 'cindy_docs', tool: 'read_sheet', args: {} }, () => true);
    await request();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    f.ghost.approvedHostToolGroups = ['docs'];
    expect(await request()).toEqual(f.result);
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledExactlyOnceWith('/fixture/private', { recursive: true });
  });
  // Item 28, unit: the real sandbox lifecycle and production exit callback must
  // close the native service scope. Node stop coverage missed the logic-page
  // stop/crash/update path added for computer connections in item 26.
  // #9825 review: resident Node resources can predate the first logic page.
  // Prior stop/crash/update coverage opened connections only after starting.
  // Execute both production callbacks with the real GhostRuntime transitions.
  it.each([
    ['desktop', 'stop'], ['desktop', 'crash'], ['desktop', 'update'],
    ['host', 'stop'], ['host', 'crash'], ['host', 'update'],
  ] as const)('%s keeps an existing connection while starting, then releases it after logic-page %s', async (environment, action) => {
    const owner = { dataOwnerId: 'owner', ownerGeneration: 31 };
    const caller = { ...owner, kind: 'plugin' as const, pluginId: 'dashboard' };
    setHostToolProviders([{ name: 'cindy_computer', toClaudeSdkConfig: () => null, toHostTools: () => {
      let count = 0, open = true;
      return { list: () => [{ name: 'status', category: 'computer' }],
        describe: name => ({ name, category: 'computer' }),
        call: async () => { if (!open) throw new Error('CONNECTION_CLOSED'); return { content: [{ type: 'text', text: String(++count) }] }; },
        close: async () => { open = false; } };
    } }], owner);
    const handles: Array<SandboxHandle & { gone(): void }> = [];
    const noop = () => {};
    const deps = { GhostRuntime,
      electronSandboxAdapter: { create() {
        let onGone: ((details: { reason: string }) => void) | null = null;
        const handle = { load: async () => {}, destroy: noop, onGone: (fn: (details: { reason: string }) => void) => { onGone = fn; },
          crashForTest: () => onGone?.({ reason: 'crashed' }), gone: () => onGone?.({ reason: 'oom' }) };
        handles.push(handle); return handle;
      } },
      isValidPluginInstallRelId, pluginInstallStoragePart,
      log: { info: noop, warn: noop }, disconnectRoutineSource: noop,
      releasePluginUiRegions: noop, releasePluginAppearance: noop,
      pluginDeviceSync: { invalidate: noop }, pluginLiveScreenViews: { invalidate: noop }, getGhostPipeDispatcher: () => ({ onRuntimeState: noop }),
      networkSlotSingleton: null, fsSlotSingleton: null, getDesktopHostTerminalService: () => ({ disposePlugin: noop }),
      disposePluginHostTools, modelPickerSingleton: null, pluginInvocations: { invalidate: noop },
      invocationRuntimeGenerations: new Map(), broadcastGhostRuntimeStates: noop,
    };
    const runtime = environment === 'desktop' ? lifecycle(deps).getGhostRuntime() : hostLifecycle({
      GhostRuntime, sandbox: { adapter: deps.electronSandboxAdapter }, log: deps.log,
      network: { disposeGhost: noop }, fsSlot: { disposePlugin: noop },
      options: { publish: noop, onPluginStopped: disposePluginHostTools }, dispatcher: { onRuntimeState: noop },
    }).runtime;
    const ghost = fixture().ghost;
    try {
      const old = createHostToolRuntime('cindy_computer', caller)!;
      expect((await old.call('status')).content[0]).toMatchObject({ text: '1' });
      await runtime.spawn(ghost);
      expect((await old.call('status')).content[0]).toMatchObject({ text: '2' });
      if (action === 'stop') runtime.stop('dashboard');
      if (action === 'crash') handles.at(-1)!.gone();
      if (action === 'update') await runtime.spawn({ ...ghost, manifest: { ...ghost.manifest, version: '2.0.0' }, approval: { state: 'approved', revision: 'r2' } });
      await expect(old.call('status')).rejects.toThrow('CONNECTION_CLOSED');
      if (action !== 'update') await runtime.spawn(ghost);
      expect((await createHostToolRuntime('cindy_computer', caller)!.call('status')).content[0]).toMatchObject({ text: '1' });
    } finally { runtime.destroyAll(); setHostToolProviders([], { ...owner, ownerGeneration: 32 }); }
  });

  it('rejects malformed server identities before service lookup', async () => {
    const f = fixture();
    expect(code(await handlePluginHostToolRequest('dashboard', {
      type: 'host-tool-request', server: { toString: null }, tool: 'browser', args: {},
    }, () => true, f.ports))).toBe('INVALID_PARAMS');
    expect(f.ports.approveGroup).not.toHaveBeenCalled();
  });

  it('keeps computer observations per plugin until stop and honors live provider disable', async () => {
    const owner = { dataOwnerId: 'owner', ownerGeneration: 4 };
    const caller = { ...owner, kind: 'plugin' as const, pluginId: 'one' };
    let enabled = true;
    const close = vi.fn(async () => {});
    const create = vi.fn(() => { let count = 0; return {
      describe: (name: string) => ({ name, category: 'computer' }),
      call: async () => ({ content: [{ type: 'text' as const, text: String(++count) }] }), close,
    }; });
    setHostToolProviders([{ name: 'cindy_computer', isEnabled: () => enabled, toClaudeSdkConfig: () => null, toHostTools: create }], owner);
    // Catalog inspection closes its own detached descriptor before active calls.
    create.mockClear(); close.mockClear();
    try {
      const first = createHostToolRuntime('cindy_computer', caller)!;
      expect((await first.call('status')).content[0]).toMatchObject({ text: '1' });
      await first.close();
      const next = createHostToolRuntime('cindy_computer', caller)!;
      expect((await next.call('status')).content[0]).toMatchObject({ text: '2' });
      expect(create).toHaveBeenCalledTimes(1);
      expect((await createHostToolRuntime('cindy_computer', { ...caller, pluginId: 'two' })!.call('status')).content[0]).toMatchObject({ text: '1' });
      enabled = false;
      expect(createHostToolRuntime('cindy_computer', caller)).toBeNull();
      enabled = true;
      disposePluginHostTools('one');
      expect((await createHostToolRuntime('cindy_computer', caller)!.call('status')).content[0]).toMatchObject({ text: '1' });
      setHostToolProviders([], { ...owner, ownerGeneration: 5 });
      expect(createHostToolRuntime('cindy_computer', caller)).toBeNull();
      expect(close).toHaveBeenCalledTimes(3);
    } finally { setHostToolProviders([], { ...owner, ownerGeneration: 6 }); }
  });

  // Item 26: these existing services were inaccessible from the public plugin entry.
  // One approved plugin is enough to expose group/category confusion and risky calls.
  it.each([
    ['cindy_browser', 'browser', 'browser', { action: 'status' }, false],
    ['cindy_browser', 'browser', 'browser', { action: 'setBackend', backend: 'user-browser' }, true],
    ['cindy_computer', 'computer', 'status', {}, false],
    ['cindy_ssh', 'ssh', 'ssh_exec', { host: 'example', command: 'pwd' }, true],
    ['cindy_docs', 'docs', 'read_sheet', { path: 'own.csv' }, false],
    ['cindy_docs', 'docs', 'make_docx', { outPath: 'own.docx', markdown: 'Report' }, true],
  ] as const)('opens %s/%s through its existing risk policy', async (server, group, tool, args, confirmed) => {
    const f = fixture();
    f.ghost.manifest.agent!.hostTools = [group];
    f.ghost.approvedHostToolGroups = [group];
    f.ports.createRuntime = () => ({ describe: name => ({ name, category: group === 'docs' ? 'read' : group }),
      call: async () => f.result, close: async () => {} });
    f.ports.policy = (serverName, name, input) => getDesktopMcpToolApprovalPolicy(serverName === 'cindy_docs'
      ? { serverName, toolName: name, toolParams: input }
      : { serverName, toolName: 'call_tool', toolParams: { name, args: input } });
    const call = () => handlePluginHostToolRequest('dashboard', { type: 'host-tool-request', server, tool, args }, () => true, f.ports);
    expect(await call()).toEqual(f.result);
    expect(f.ports.confirm).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    f.ghost.approvedHostToolGroups = [];
    expect(code(await call())).toBe('PERMISSION_DENIED');
    f.ghost.approvedHostToolGroups = [group];
    f.ghost.manifest.agent!.hostTools = ['history'];
    expect(code(await call())).toBe('PERMISSION_DENIED');
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

  // Unit #9801/622jIH: real Host admission + existing queued-input guard.
  // Prior gateway tests kept the page alive; only normal page retirement changes here.
  it.each(['none', 'owner', 'disabled', 'removed', 'directory', 'revision', 'group', 'target', 'body', 'client'] as const)(
    'keeps accepted delivery after page close while rejecting real change: %s', async change => {
      const f = fixture();
      const item = { clientId: 'accepted', text: 'approved body' } as AgentInputQueuedMessage;
      let write!: () => void;
      f.invoke.mockImplementationOnce(async () => {
        write = captureTaskActionSyncGuard()!;
        bindTaskActionInput('target', item);
        return f.result;
      });
      expect(await f.call('send_to_session', { target_session_id: 'target', message: item.text })).toBe(f.result);
      f.closePage();
      expect(write).toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
      if (change === 'owner') f.changeOwner();
      if (change === 'disabled') f.ghost.enabled = false;
      if (change === 'removed') f.remove();
      if (change === 'directory') f.ghost.dir = '/fixture/replaced';
      if (change === 'revision') f.ghost.approval = { state: 'approved', revision: 'r2' };
      if (change === 'group') f.ghost.approvedHostToolGroups = [];
      if (change === 'body') item.text = 'changed';
      if (change === 'client') item.clientId = 'changed';
      const delivery = taskActionInputGuard(change === 'target' ? 'other-target' : 'target', item)!;
      if (change === 'none') await expect(delivery()).resolves.toBeUndefined();
      else await expect(delivery()).rejects.toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
      expect(code(await f.call())).toBe('PERMISSION_DENIED');
    },
  );

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
    let actualScheduler: Scheduler | undefined;
    let remote: SchedulerMcpDeps['remote'];
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
        createSchedulerMcpServer({ getScheduler: () => actualScheduler ?? ({ create, updateFromCurrent: update, runNow, resume, get }) as never,
          authorizeCall: authorizePluginHostToolCall,
          getApprovedScheduleGuard: () => getPluginHostToolCaller()?.scheduleGuard,
          remote,
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
      useScheduler: (scheduler: Scheduler) => { actualScheduler = scheduler; },
      useRemote: (value: NonNullable<SchedulerMcpDeps['remote']>) => { remote = value; },
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
    if (tool === 'schedule_run_now') expect(f.runNow).toHaveBeenCalledWith('automation', {
      expectedSchedule: expect.objectContaining({ id: 'automation', executionMode: 'agent' }),
    });
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

  // Unit, #9801 / Greptile 4535245940: a real engine must reject an ordinary
  // schedule changed to a script after schedule_get, before writes or runner fire.
  // Prior tests only rejected a definition already containing a command.
  it.each(['schedule_update', 'schedule_run_now', 'schedule_resume'] as const)('rejects a concurrent script change at the existing engine guard for %s', async tool => {
    const f = schedulerFixture(false, true, false);
    let stored: Schedule = { id: 'automation', name: 'Automation', prompt: 'run', kind: 'cron',
      cronExpr: '0 9 * * *', timezone: 'UTC', recurring: true, manual: false, agentKind: 'codex',
      workingDir: '/fixture/project', workspaceKind: 'project', useWorktree: false, executionMode: 'agent',
      notify: { desktop: false, feishu: false }, status: 'paused', createdAt: 1, updatedAt: 1 };
    let reads = 0;
    const get = vi.fn(async () => {
      const current = structuredClone(stored);
      if (++reads === 1) stored = { ...stored, executionMode: 'script', scriptConfig: { command, capabilities: [] } };
      return current;
    });
    const update = vi.fn(async (_id: string, patch: Partial<Schedule>) => stored = { ...stored, ...patch });
    const insertRun = vi.fn(), fire = vi.fn(async () => ({ sessionId: 'result' }));
    f.useScheduler(new Scheduler({ storage: { get, update, insertRun, updateRun: vi.fn() } as never, runner: { fire } }));
    const result = await f.call(tool, { id: 'automation', ...(tool === 'schedule_update' ? { recurring: true } : {}) }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).message).toContain('Schedule changed');
    expect(update).not.toHaveBeenCalled(); expect(insertRun).not.toHaveBeenCalled(); expect(fire).not.toHaveBeenCalled();
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  // Unit, same boundary on the existing remote wire: schedule_get adds view
  // metadata and qualified task IDs that must not enter the persisted comparison.
  it.each(['schedule_update', 'schedule_run_now', 'schedule_resume'] as const)('passes the original remote definition to the existing %s guard', async tool => {
    const f = schedulerFixture(false, true, false);
    const definition = { id: 'automation', name: 'Automation', executionMode: 'agent', targetSessionId: 'task', sessionId: 'bound' };
    const invoke = vi.fn(async (_device: string, op: string, _args: unknown[]) => ({ ok: true as const,
      data: op === 'get' ? { ...definition, webhookStatus: { configured: true } } : { id: 'automation' } }));
    f.useRemote({ listDevices: async () => [{ deviceId: 'computer', deviceName: 'Computer', local: false, available: true }], invoke });
    const result = await f.call(tool, { id: 'automation', device: 'computer', ...(tool === 'schedule_update' ? { recurring: true } : {}) }) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    const args = invoke.mock.calls.find(([, op]) => op !== 'get')![2];
    const expected = tool === 'schedule_update' ? args[2] : tool === 'schedule_resume' ? args[1]
      : (args[1] as { expectedSchedule: unknown }).expectedSchedule;
    expect(expected).toEqual(definition);
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
