import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComputerMcpServer } from './server.js';
import { WindowSnapshotTracker } from './snapshot-tracker.js';
import type { ComputerMcpDeps, LiziMcpLogger } from '../types.js';

function textPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first?.text) throw new Error('missing text payload');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function makeLogger(): LiziMcpLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function makeHarness(deps: ComputerMcpDeps, options?: Parameters<typeof createComputerMcpServer>[1]) {
  const server = createComputerMcpServer(
    {
      ...deps,
      resolveProcessIdentity:
        deps.resolveProcessIdentity ?? (async (pid) => ({ pid, name: 'Code' })),
    },
    options,
  );
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'snapshot-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    textPayload(await client.callTool({ name: 'call_tool', arguments: { name, args } }));
  return {
    call,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('WindowSnapshotTracker', () => {
  it('treats only the latest recorded snapshot per window as fresh', () => {
    const tracker = new WindowSnapshotTracker();
    const first = tracker.record('s1', 100, 1);
    expect(tracker.validate('s1', first, 100, 1)).toEqual({ ok: true });

    const second = tracker.record('s1', 100, 1);
    expect(tracker.validate('s1', second, 100, 1)).toEqual({ ok: true });
    expect(tracker.validate('s1', first, 100, 1)).toEqual({
      ok: false,
      reason: 'superseded',
      latestSnapshotId: second,
    });
  });

  it('isolates snapshots per session and per window', () => {
    const tracker = new WindowSnapshotTracker();
    const id = tracker.record('s1', 100, 1);
    expect(tracker.validate('s2', id, 100, 1)).toEqual({ ok: false, reason: 'unknown_snapshot' });
    expect(tracker.validate('s1', 'ws-made-up', 100, 1)).toEqual({
      ok: false,
      reason: 'unknown_snapshot',
    });
    expect(tracker.validate('s1', id, 100, 2)).toMatchObject({ ok: false, reason: 'window_mismatch' });
    expect(tracker.validate('s1', id, 200, 1)).toMatchObject({ ok: false, reason: 'window_mismatch' });
    // window_id omitted by the action → only pid is checked.
    expect(tracker.validate('s1', id, 100)).toEqual({ ok: true });
  });

  it('accepts registered driver snapshot aliases without weakening freshness checks', () => {
    const tracker = new WindowSnapshotTracker();
    const first = tracker.record('s1', 100, 1);
    tracker.registerAlias(first, 's000c');

    expect(tracker.validate('s1', 's000c', 100, 1)).toEqual({ ok: true });

    const second = tracker.record('s1', 100, 1);
    tracker.registerAlias(second, 's000d');
    expect(tracker.validate('s1', 's000c', 100, 1)).toEqual({
      ok: false,
      reason: 'superseded',
      latestSnapshotId: second,
    });
    expect(tracker.validate('s1', 's000d', 100, 1)).toEqual({ ok: true });
  });

  it('keeps driver snapshot aliases isolated per session', () => {
    const tracker = new WindowSnapshotTracker();
    const first = tracker.record('s1', 100, 1);
    const second = tracker.record('s2', 100, 1);
    tracker.registerAlias(first, 's000c');
    tracker.registerAlias(second, 's000c');

    expect(tracker.validate('s1', 's000c', 100, 1)).toEqual({ ok: true });
    expect(tracker.validate('s2', 's000c', 100, 1)).toEqual({ ok: true });
  });

  it('does not overwrite a repeated driver alias with a newer observation', () => {
    const tracker = new WindowSnapshotTracker();
    const first = tracker.record('s1', 100, 1);
    tracker.registerAlias(first, 'stable-window-alias');

    const second = tracker.record('s1', 100, 1);
    tracker.registerAlias(second, 'stable-window-alias');

    expect(tracker.validate('s1', 'stable-window-alias', 100, 1)).toEqual({
      ok: false,
      reason: 'superseded',
      latestSnapshotId: second,
    });
    expect(tracker.validate('s1', second, 100, 1)).toEqual({ ok: true });
  });
});

describe('computer snapshot guard', () => {
  const windowState = { ok: true, elements: [{ index: 0 }, { index: 1 }] };

  function makeDeps(logger = makeLogger()) {
    const callTool = vi.fn(
      async (_name: string, _args: Record<string, unknown>) => windowState as unknown,
    );
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool,
      logger,
    };
    return { deps, callTool, logger };
  }

  it('stamps a snapshot_id on successful get_window_state and strips it from driver args', async () => {
    const { deps, callTool } = makeDeps();
    const h = await makeHarness(deps, { sessionId: 'sess-1' });

    const observed = await h.call('get_window_state', { pid: 100, window_id: 1 });
    expect(observed.ok).toBe(true);
    const snapshotId = observed.snapshot_id as string;
    expect(typeof snapshotId).toBe('string');
    expect(snapshotId.length).toBeGreaterThan(0);

    const clicked = await h.call('click', {
      pid: 100,
      window_id: 1,
      element_index: 1,
      snapshot_id: snapshotId,
    });
    expect(clicked.ok).toBe(true);
    const clickArgs = callTool.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(clickArgs).not.toHaveProperty('snapshot_id');
    expect(clickArgs.element_index).toBe(1);
    await h.cleanup();
  });

  it('accepts an element_token prefix as a snapshot_id alias', async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === 'get_window_state') {
        return {
          ok: true,
          elements: [
            { element_index: 0, element_token: 's000c:0' },
            { element_index: 1, element_token: 's000c:1' },
          ],
        };
      }
      return { ok: true };
    });
    const h = await makeHarness({ getStatus: vi.fn(), callTool }, { sessionId: 'sess-1' });

    const observed = await h.call('get_window_state', { pid: 100, window_id: 1 });
    expect(observed.ok).toBe(true);
    expect(observed.snapshot_id).toMatch(/^ws-/);

    const clicked = await h.call('click', {
      pid: 100,
      window_id: 1,
      element_index: 1,
      snapshot_id: 's000c',
    });
    expect(clicked.ok).toBe(true);
    expect(callTool).toHaveBeenLastCalledWith('click', {
      pid: 100,
      window_id: 1,
      element_index: 1,
      session: 'sess-1',
    }, { sessionId: 'sess-1' });
    await h.cleanup();
  });

  it('accepts a driver data.snapshot_id as a snapshot_id alias', async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === 'get_window_state') {
        return { ok: true, snapshot_id: 's000c', elements: [] };
      }
      return { ok: true };
    });
    const h = await makeHarness({ getStatus: vi.fn(), callTool }, { sessionId: 'sess-1' });

    const observed = await h.call('get_window_state', { pid: 100, window_id: 1 });
    expect(observed.ok).toBe(true);
    expect(observed.snapshot_id).toMatch(/^ws-/);

    const clicked = await h.call('click', {
      pid: 100,
      window_id: 1,
      element_index: 1,
      snapshot_id: 's000c',
    });
    expect(clicked.ok).toBe(true);
    expect(callTool).toHaveBeenLastCalledWith('click', {
      pid: 100,
      window_id: 1,
      element_index: 1,
      session: 'sess-1',
    }, { sessionId: 'sess-1' });
    await h.cleanup();
  });

  it('rejects an action whose snapshot has been superseded, without dispatching to the driver', async () => {
    const { deps, callTool } = makeDeps();
    const h = await makeHarness(deps, { sessionId: 'sess-1' });

    const first = await h.call('get_window_state', { pid: 100, window_id: 1 });
    await h.call('get_window_state', { pid: 100, window_id: 1 });
    const dispatchesBefore = callTool.mock.calls.length;

    const rejected = await h.call('click', {
      pid: 100,
      window_id: 1,
      element_index: 0,
      snapshot_id: first.snapshot_id,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errorCode).toBe('STALE_SNAPSHOT');
    const data = rejected.data as Record<string, unknown>;
    expect(data.reason).toBe('superseded');
    expect(String(data.hint)).toContain('get_window_state');
    expect(callTool.mock.calls.length).toBe(dispatchesBefore);
    await h.cleanup();
  });

  it('rejects unknown snapshot ids and snapshots from another window', async () => {
    const { deps } = makeDeps();
    const h = await makeHarness(deps, { sessionId: 'sess-1' });

    const unknown = await h.call('set_value', {
      pid: 100,
      window_id: 1,
      element_index: 0,
      value: 'x',
      snapshot_id: 'ws-nope',
    });
    expect(unknown.errorCode).toBe('STALE_SNAPSHOT');
    expect((unknown.data as Record<string, unknown>).reason).toBe('unknown_snapshot');

    const observed = await h.call('get_window_state', { pid: 100, window_id: 1 });
    const mismatched = await h.call('click', {
      pid: 100,
      window_id: 2,
      element_index: 0,
      snapshot_id: observed.snapshot_id,
    });
    expect(mismatched.errorCode).toBe('STALE_SNAPSHOT');
    expect((mismatched.data as Record<string, unknown>).reason).toBe('window_mismatch');
    await h.cleanup();
  });

  it('lets element_index actions without snapshot_id through but logs telemetry', async () => {
    const { deps, callTool, logger } = makeDeps();
    const h = await makeHarness(deps, { sessionId: 'sess-1' });

    const clicked = await h.call('click', { pid: 100, window_id: 1, element_index: 0 });
    expect(clicked.ok).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('element_index action without snapshot_id', {
      server: 'cindy_computer',
      tool: 'click',
      sessionId: 'sess-1',
    });
    await h.cleanup();
  });

  it('does not validate or log for coordinate-based actions', async () => {
    const { deps, logger } = makeDeps();
    const h = await makeHarness(deps, { sessionId: 'sess-1' });

    const clicked = await h.call('click', { pid: 100, window_id: 1, x: 10, y: 20 });
    expect(clicked.ok).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('does not stamp a snapshot_id when the driver reports a failed observation', async () => {
    const logger = makeLogger();
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: false, error: 'window gone' })),
      logger,
    };
    const h = await makeHarness(deps, { sessionId: 'sess-1' });

    const observed = await h.call('get_window_state', { pid: 100, window_id: 1 });
    expect(observed.ok).toBe(true);
    expect(observed).not.toHaveProperty('snapshot_id');
    await h.cleanup();
  });
});
