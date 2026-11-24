import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSettingsManagement,
  type ManagementCaller,
  type ManagementExecution,
} from '../management.js';
import { connectInstanceMaintenance, type InstanceMaintenanceGate } from '../../instance-runtime/maintenance.js';
import {
  callCloudManagement,
  isCloudManagementInvocation,
  registerPrivateCloudManagementCall,
} from '../managementCalls.js';

// The call table fills only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));

const caller: ManagementCaller = { key: 'instance-a:browser-a', assertCurrent() {} };
const field = {
  name: 'secret',
  kind: 'password' as const,
  label: 'Secret',
  required: true,
  maxLength: 128,
};
function setup(run = vi.fn<(values: Record<string, string>, execution: ManagementExecution) => Promise<void>>(async () => {})) {
  let time = 1_000;
  const manager = createSettingsManagement(
    {
      async list() {
        return [
          {
            id: 'bot',
            label: 'Bot',
            status: 'disconnected',
            actions: [
              { label: 'Connect', intent: 'connect', resource: 'bot', fields: [field], run },
            ],
          },
        ];
      },
    },
    () => time,
  );
  const ticket = async (who = caller) => {
    const page = await manager.execute(who, { operation: 'list', section: 'bots' });
    if (page.kind !== 'page') throw new Error('page');
    return page.items[0]!.actions[0]!.id;
  };
  const start = (
    actionId: string,
    operationId = randomUUID(),
    who = caller,
    values = { secret: 'PRIVATE-CREDENTIAL' },
  ) => manager.execute(who, { operation: 'run', operationId, actionId, values });
  return {
    manager,
    run,
    ticket,
    start,
    advance: (ms: number) => {
      time += ms;
      manager.prune();
    },
  };
}
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
/** A maintenance gate that refuses new work once maintenance begins and counts what it runs. */
function maintenanceGate() {
  const state = { preparing: false, inFlight: 0 };
  const gate: InstanceMaintenanceGate = {
    admit() { if (state.preparing) throw Object.assign(new Error('CLOUD_MAINTENANCE_RETRY'), { code: 'CLOUD_MAINTENANCE_RETRY' }); },
    run(kind, work) { gate.admit(kind); state.inFlight++; return work().finally(() => { state.inFlight--; }); },
  };
  connectInstanceMaintenance(gate);
  return state;
}
const noMaintenance: InstanceMaintenanceGate = { admit() {}, run: (_kind, work) => work() };
afterEach(() => { vi.restoreAllMocks(); connectInstanceMaintenance(noMaintenance); });
describe('cloud management action isolation and results', () => {
  // Unit: an action counts as in flight until it settles; once maintenance has begun a new one is
  // refused with its ticket unused, so it can start after maintenance.
  it('keeps a started action in flight until it settles and refuses new ones during maintenance', async () => {
    const gate = maintenanceGate();
    let finish!: () => void;
    const s = setup(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    const first = randomUUID();
    await s.start(await s.ticket(), first);
    await settle();
    expect(gate.inFlight).toBe(1);
    // Maintenance begins: the running action keeps its place until it settles.
    gate.preparing = true;
    await settle();
    expect(gate.inFlight).toBe(1);
    finish();
    await settle();
    expect(gate.inFlight).toBe(0);
    await expect(s.manager.execute(caller, { operation: 'status', operationId: first })).resolves.toMatchObject({ phase: 'succeeded' });
    const action = await s.ticket();
    await expect(s.start(action)).rejects.toMatchObject({ code: 'CLOUD_MAINTENANCE_RETRY' });
    gate.preparing = false;
    await expect(s.start(action)).resolves.toMatchObject({ phase: 'running' });
  });
  it('binds tickets and operation results to the browser session', async () => {
    const s = setup(),
      action = await s.ticket(),
      id = randomUUID();
    await expect(s.start(action, id, { ...caller, key: 'instance-b:browser-b' })).rejects.toThrow(
      'EXPIRED',
    );
    await s.start(action, id);
    await settle();
    await expect(
      s.manager.execute(
        { ...caller, key: 'instance-a:browser-b' },
        { operation: 'status', operationId: id },
      ),
    ).rejects.toThrow('NOT_FOUND');
    expect(s.run).toHaveBeenCalledTimes(1);
    s.manager.stop();
  });
  it('does not replay a lost response or reuse an action with a new operation', async () => {
    const s = setup(),
      action = await s.ticket(),
      id = randomUUID();
    await s.start(action, id);
    await settle();
    expect(await s.start(action, id)).toMatchObject({ phase: 'succeeded' });
    await expect(s.start(action)).rejects.toThrow('EXPIRED');
    await expect(s.start(action, id, caller, { secret: 'different' })).rejects.toThrow('REUSED');
    expect(s.run).toHaveBeenCalledTimes(1);
    s.manager.stop();
  });
  it('rejects unrecognized fields, invalid required values and expired tickets before dispatch', async () => {
    const s = setup(),
      action = await s.ticket();
    for (const values of [
      { secret: '' },
      { secret: 'x'.repeat(129) },
      { secret: 'ok', channel: 'arbitrary' },
    ])
      await expect(s.start(action, randomUUID(), caller, values)).rejects.toThrow('INVALID_INPUT');
    s.advance(300_001);
    await expect(s.start(action)).rejects.toThrow('EXPIRED');
    expect(s.run).not.toHaveBeenCalled();
    s.manager.stop();
  });
  it('locks one resource across browser sessions while allowing status polling', async () => {
    let finish!: () => void;
    const s = setup(
        vi.fn(
          async () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        ),
      ),
      a = await s.ticket();
    const other = { ...caller, key: 'instance-a:browser-b' },
      b = await s.ticket(other);
    const result = await s.start(a);
    await settle();
    await expect(s.start(b, randomUUID(), other)).rejects.toThrow('BUSY');
    if (result.kind !== 'operation') throw new Error('operation');
    expect(
      await s.manager.execute(caller, { operation: 'status', operationId: result.operationId }),
    ).toMatchObject({ phase: 'running' });
    finish();
    await settle();
    s.manager.stop();
  });
  it('never projects submitted passwords or raw service errors', async () => {
    const s = setup(
        vi.fn(async () => {
          throw new Error('PRIVATE-CREDENTIAL');
        }),
      ),
      action = await s.ticket(),
      id = randomUUID();
    await s.start(action, id);
    await settle();
    const result = await s.manager.execute(caller, { operation: 'status', operationId: id });
    expect(result).toMatchObject({ phase: 'failed', code: 'MANAGEMENT_OPERATION_FAILED' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    s.manager.stop();
  });
  it('cancels only this job on owner loss and keeps uncertain writes unknown', async () => {
    let active = true,
      finish!: () => void;
    const cancel = vi.fn();
    const who = {
      key: 'instance-a:browser-a',
      assertCurrent() {
        if (!active) throw new Error('owner changed');
      },
    };
    const s = setup(
      vi.fn(async (_v, e) => {
        e.onCancel(cancel);
        await new Promise<void>((r) => {
          finish = r;
        });
      }),
    );
    const action = await s.ticket(who),
      id = randomUUID();
    await s.start(action, id, who);
    await settle();
    active = false;
    s.advance(1);
    expect(cancel).toHaveBeenCalledOnce();
    finish();
    await settle();
    expect(await s.manager.execute(caller, { operation: 'status', operationId: id })).toMatchObject(
      { phase: 'unknown' },
    );
    s.manager.stop();
  });
  it('does not interpret restart or missing operation as success', async () => {
    const s = setup();
    expect(
      await s.manager.execute(caller, { operation: 'status', operationId: randomUUID() }),
    ).toMatchObject({ phase: 'unknown' });
    s.manager.stop();
  });
  it('consumes callbacks while in flight, permits correction after validation failure', async () => {
    let finish!: () => void, respondFinish!: () => void;
    const respond = vi.fn(async (value: string) => {
      if (value === 'bad') throw new Error('bad');
      await new Promise<void>((r) => {
        respondFinish = r;
      });
    });
    const s = setup(
      vi.fn(async (_v, e) => {
        e.prompt(
          {
            kind: 'callback',
            url: 'https://auth.example/authorize',
            expiresAt: Date.now() + 60_000,
          },
          respond,
        );
        await new Promise<void>((r) => {
          finish = r;
        });
      }),
    );
    const id = randomUUID();
    await s.start(await s.ticket(), id);
    await settle();
    await expect(
      s.manager.execute(caller, { operation: 'respond', operationId: id, value: 'bad' }),
    ).rejects.toThrow();
    const response = s.manager.execute(caller, {
      operation: 'respond',
      operationId: id,
      value: 'good',
    });
    await settle();
    await expect(
      s.manager.execute(caller, { operation: 'respond', operationId: id, value: 'duplicate' }),
    ).rejects.toThrow('UNAVAILABLE');
    respondFinish();
    await response;
    finish();
    await settle();
    expect(respond).toHaveBeenCalledTimes(2);
    s.manager.stop();
  });
});
describe('private native service adapter', () => {
  it('requires an unforgeable current invocation and never exposes arbitrary IPC', async () => {
    expect(isCloudManagementInvocation({})).toBe(false);
    let captured: unknown;
    registerPrivateCloudManagementCall('cloud:provider:key-replace', async (event) => {
      captured = event;
      expect(isCloudManagementInvocation(event)).toBe(true);
      return { ok: true };
    });
    const execution: ManagementExecution = {
      signal: new AbortController().signal,
      assertCurrent() {},
      prompt() {},
      onCancel() {},
    };
    expect(await callCloudManagement('cloud:provider:key-replace', [], execution)).toEqual({
      ok: true,
    });
    expect(isCloudManagementInvocation(captured)).toBe(false);
    await expect(callCloudManagement('safe-storage-read', ['secret'], execution)).rejects.toThrow(
      'UNAVAILABLE',
    );
  });
});
