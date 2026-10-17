import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CINDY_SUBAGENT_EXTENSION_SOURCE } from '../cindy-subagent-source.js';

// Execute the exact staged extension, including its filesystem mailbox and
// lifecycle handlers. Export helpers only in this test's in-memory module.
const compiled = ts.transpileModule(CINDY_SUBAGENT_EXTENSION_SOURCE + '\nexport { parentContextSnapshot, createResultDelivery };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const nativeRequire = createRequire(import.meta.url);
function loadExtension(fsOverrides: Record<string, unknown> = {}) {
  const loaded: any = {};
  new Function('require', 'exports', compiled)((name: string) => name === 'node:fs'
    ? { ...nativeRequire(name), ...fsOverrides } : nativeRequire(name), loaded);
  return loaded;
}
const extension = loadExtension();
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(fsOverrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-delegation-'));
  roots.push(root);
  vi.stubEnv('CINDY_PI_SUBAGENT_RUN_ROOT', root);
  vi.stubEnv('CINDY_PI_SUBAGENT_OWNER_ID', 'owner');
  vi.stubEnv('CINDY_PI_SUBAGENT_BINARY', '/fixture/pi');
  vi.stubEnv('CINDY_PI_SUBAGENT_RUNTIME_FILE', path.join(root, 'runtime.json'));
  await writeFile(path.join(root, 'runtime.json'), JSON.stringify({ modelRoutes: { 'available-model': [] } }));
  const runId = randomUUID();
  const dir = path.join(root, runId);
  await mkdir(dir);
  const status = { version: 1, runId, taskId: 'tool-call', runtimeOwnerId: 'owner', state: 'running',
    tasks: [1, 2].map(n => ({ childId: 'child-' + n, agent: 'worker', status: 'running', output: 'interim text' })) };
  const publish = () => writeFile(path.join(dir, 'status.json'), JSON.stringify(status));
  await publish();
  const hooks: Record<string, (...args: any[]) => any> = {};
  let tool: any;
  const pi = { on: (event: string, handler: any) => { hooks[event] = handler; }, appendEntry: vi.fn(),
    registerTool: (value: any) => { tool = value; } };
  await loadExtension(fsOverrides).default(pi);
  const ctx = { ui: { input: vi.fn(async (_title: string, _payload: string) => JSON.stringify({ ok: true })) },
    sessionManager: { getBranch: () => [] }, hasPendingMessages: () => false };
  const execute = (params: any, signal = new AbortController().signal) => tool.execute('control-id', params, signal, undefined, ctx);
  return { root, runId, dir, status, publish, hooks, pi, ctx, execute };
}
const boundary = { outcome: 'completed', context: { pendingMessages: [] } };
function restorePending(f: Awaited<ReturnType<typeof fixture>>) {
  f.hooks.session_start!({}, { sessionManager: { getBranch: () => [{
    type: 'custom', customType: 'cindy-subagent-delivery',
    data: { runId: f.runId, state: 'pending', deadlineAt: Date.now() + 86400000 },
  }] } });
}

describe('Pi delegation behavior', () => {
  it('forks the native projected context, prioritizing the latest correction and compaction summary', () => {
    const snapshot = extension.parentContextSnapshot({ sessionManager: {
      getBranch: () => { throw new Error('Raw branch resurrects discarded content'); },
      buildSessionProjection: () => ({ messages: [
        { role: 'system', content: 'SYSTEM_NOT_COPIED' },
        { role: 'user', content: 'OLD_CONTEXT ' + 'x'.repeat(40000) },
        { role: 'compactionSummary', summary: 'DECISIONS_RETAINED' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }] },
        { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'LATEST_FILE_EVIDENCE' }] },
        { role: 'user', content: 'LATEST_REQUEST ' + 'a'.repeat(20000) + ' FINAL_CORRECTION' },
      ] }),
    } });
    expect(snapshot).toContain('LATEST_REQUEST');
    expect(snapshot).toContain('FINAL_CORRECTION');
    expect(snapshot).toContain('DECISIONS_RETAINED');
    expect(snapshot).toContain('LATEST_FILE_EVIDENCE');
    expect(snapshot).not.toContain('SYSTEM_NOT_COPIED');
    expect(snapshot).not.toContain('PRIVATE_THINKING');
    expect(snapshot.length).toBeLessThanOrEqual(32000);
  });

  it('refuses to silently fork an unprojectable raw session', () => {
    expect(() => extension.parentContextSnapshot({ sessionManager: { getBranch: () => [] } })).toThrow('context:fresh');
  });

  it('wait times out without stopping children and rejects a foreign child id', async () => {
    const f = await fixture();
    const result = await f.execute({ action: 'wait', taskId: f.runId, childId: 'child-1', waitSeconds: 0 });
    expect(result.content[0].text).toContain('child-1');
    expect(result.content[0].text).not.toContain('child-2');
    expect(await readdir(f.dir)).toEqual(['status.json']);
    await expect(f.execute({ action: 'stop', taskId: f.runId, childId: 'foreign' })).rejects.toThrow('does not belong');
    await expect(f.execute({ action: 'stop', taskId: f.runId, childId: '  ' })).rejects.toThrow('non-empty');
  });

  it('does not expose another runtime owner through list or controls', async () => {
    const f = await fixture();
    f.status.runtimeOwnerId = 'other-instance';
    await f.publish();
    expect((await f.execute({ action: 'list' })).content[0].text).toContain('No durable');
    await expect(f.execute({ action: 'stop', taskId: f.runId })).rejects.toThrow('not found');
  });

  it.each([true, false])('reports the actual runner receipt (accepted=%s), preserving child targeting', async accepted => {
    const f = await fixture();
    const operation = f.execute({ action: 'steer', taskId: f.runId, childId: 'child-1', message: 'LATEST_CORRECTION' });
    // Attach rejection handling before publishing the receipt.
    const outcome = operation.then((value: any) => ({ value }), (error: Error) => ({ error }));
    const files = await readdir(path.join(f.dir, 'controls'));
    const request = JSON.parse(await readFile(path.join(f.dir, 'controls', files[0]!), 'utf8'));
    expect(request).toMatchObject({ acknowledge: true, childId: 'child-1', message: 'LATEST_CORRECTION' });
    await mkdir(path.join(f.dir, 'control-receipts'));
    await writeFile(path.join(f.dir, 'control-receipts', request.requestId + '.json'), JSON.stringify({ requestId: request.requestId, accepted, reason: 'target-terminal' }));
    const result = await outcome;
    if (accepted) expect(result.value.content[0].text).toContain('accepted by the runner');
    else expect(result.error.message).toContain('rejected: target-terminal');
  });

  it('cancellation after mailbox delivery reports uncertainty without replaying the command', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const operation = f.execute({ action: 'follow_up', taskId: f.runId, message: 'check again' }, controller.signal);
    const outcome = expect(operation).rejects.toThrow('delivery is uncertain');
    controller.abort();
    await outcome;
    expect(await readdir(path.join(f.dir, 'controls'))).toHaveLength(1);
  });

  it('resumes one retained child through the host and returns its new generation id', async () => {
    const f = await fixture();
    f.status.state = 'completed';
    f.status.tasks.forEach(task => { task.status = 'completed'; });
    await f.publish();
    const newId = randomUUID();
    f.ctx.ui.input.mockResolvedValue(JSON.stringify({ ok: true, runId: newId }));
    const result = await f.execute({ action: 'resume', taskId: f.runId, childId: 'child-2', message: 'recheck' });
    const payload = JSON.parse(f.ctx.ui.input.mock.calls[0]![1] as string);
    expect(payload).toMatchObject({ action: 'resume', runId: f.runId, childId: 'child-2', message: 'recheck' });
    expect(result.content[0].text).toContain(newId);
    expect(f.pi.appendEntry).toHaveBeenCalledWith('cindy-subagent-delivery', expect.objectContaining({ runId: newId, state: 'pending' }));
  });

  it('commits one bounded result before settlement and deduplicates after reload', async () => {
    const f = await fixture();
    const delivery = extension.createResultDelivery(f.pi);
    delivery.track(f.runId, Date.now() + 10000, true);
    f.status.state = 'completed';
    f.status.tasks.forEach(task => { task.status = 'completed'; task.output = 'x'.repeat(40000); });
    await f.publish();
    const result = await f.hooks.agent_before_settle!(boundary, f.ctx);
    expect(result.continue).toBe(true);
    expect(result.entries[0].details.runIds).toEqual([f.runId]);
    expect(result.entries[0].content.length).toBeLessThanOrEqual(32000);
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    const entries = [ { type: 'custom', customType: 'cindy-subagent-delivery', data: f.pi.appendEntry.mock.calls[0]![1] }, ...result.entries ];
    f.hooks.session_start!({}, { sessionManager: { getBranch: () => entries } });
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
  });

  it('stopping the parent revokes the continuation without stopping its detached children', async () => {
    const f = await fixture();
    extension.createResultDelivery(f.pi).track(f.runId, Date.now() + 10000, true);
    f.ctx.ui.input.mockResolvedValue(JSON.stringify({ ok: false }));
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    expect(f.pi.appendEntry).toHaveBeenLastCalledWith('cindy-subagent-delivery', { runId: f.runId, state: 'consumed' });
    expect(await readdir(f.dir)).toEqual(['status.json']);
  });

  it('explicit get consumes a terminal result and notify:false never holds settlement', async () => {
    const f = await fixture();
    // Replay a pending native entry into the production tool's own tracker.
    f.hooks.session_start!({}, { sessionManager: { getBranch: () => [{ type: 'custom', customType: 'cindy-subagent-delivery', data: { runId: f.runId, state: 'pending', deadlineAt: Date.now() + 10000 } }] } });
    f.status.state = 'completed';
    f.status.tasks.forEach(task => { task.status = 'completed'; });
    await f.publish();
    await f.execute({ action: 'get', taskId: f.runId });
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    extension.createResultDelivery(f.pi).track(f.runId, Date.now() + 10000, false);
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    expect(f.ctx.ui.input).not.toHaveBeenCalled();
  });

  it('clears notification intent when an aborted turn settles without a collection hook', async () => {
    const f = await fixture();
    extension.createResultDelivery(f.pi).track(f.runId, Date.now() + 10000, true);
    f.hooks.agent_settled!();
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    expect(f.ctx.ui.input).not.toHaveBeenCalled();
  });

  it('returns runner exit diagnostics without waiting for the whole task timeout', async () => {
    const f = await fixture();
    extension.createResultDelivery(f.pi).track(f.runId, Date.now() + 10000, true);
    f.ctx.ui.input.mockImplementation(async (_title, payload) => JSON.stringify(JSON.parse(payload).action === 'status'
      ? { ok: false, exited: true, error: 'Runner crashed' } : { ok: true }));
    const result = await f.hooks.agent_before_settle!(boundary, f.ctx);
    expect(result.entries[0].content).toContain('Runner crashed');
  });

  it('polls only pending runs without listing or reading historical statuses', async () => {
    const fs = nativeRequire('node:fs');
    const readStatus = vi.fn(fs.readFileSync);
    const scanHistory = vi.fn(fs.readdirSync);
    const f = await fixture({ readFileSync: readStatus, readdirSync: scanHistory });
    const historicalId = randomUUID();
    await mkdir(path.join(f.root, historicalId));
    await writeFile(path.join(f.root, historicalId, 'status.json'), JSON.stringify({
      ...f.status, runId: historicalId, state: 'completed',
    }));
    restorePending(f);
    // Keep the run active for several poll ticks, then simulate user input.
    let polls = 0;
    f.ctx.hasPendingMessages = () => ++polls > 3;
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    expect(scanHistory).not.toHaveBeenCalled();
    const files = readStatus.mock.calls.map(args => String(args[0]));
    expect(files.filter(file => file === path.join(f.dir, 'status.json'))).toHaveLength(3);
    expect(files.some(file => file.includes(historicalId))).toBe(false);
  });

  it.each(['running', 'completed'])('settles a restored %s run owned by the previous runtime without exposing its output', async state => {
    const f = await fixture();
    f.status.state = state;
    f.status.runtimeOwnerId = 'previous-runtime';
    f.status.tasks.forEach(task => { task.status = state; task.output = 'FOREIGN_OUTPUT'; });
    await f.publish();
    restorePending(f);
    const result = await f.hooks.agent_before_settle!(boundary, f.ctx);
    expect(result.continue).toBe(true);
    expect(result.entries[0].content).toContain('another runtime owner');
    expect(result.entries[0].content).not.toContain('FOREIGN_OUTPUT');
    expect(result.entries[0].details.runIds).toEqual([f.runId]);
    expect(f.ctx.ui.input.mock.calls.every(([, payload]) => JSON.parse(payload).action === 'delivery')).toBe(true);
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    f.hooks.session_start!({}, { sessionManager: { getBranch: () => [{
      type: 'custom', customType: 'cindy-subagent-delivery',
      data: { runId: f.runId, state: 'pending', deadlineAt: Date.now() + 86400000 },
    }, ...result.entries] } });
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
    expect(await readdir(f.dir)).toEqual(['status.json']);
  });

  it('settles a restored missing run when the host rejects status access', async () => {
    const f = await fixture();
    await rm(path.join(f.dir, 'status.json'));
    restorePending(f);
    f.ctx.ui.input.mockImplementation(async (_title, payload) => JSON.stringify(JSON.parse(payload).action === 'status'
      ? { ok: false, error: 'PI Subagent runner control failed' } : { ok: true }));
    const result = await f.hooks.agent_before_settle!(boundary, f.ctx);
    expect(result.entries[0].content).toContain('host rejected status access');
    expect(result.entries[0].content).toContain('does not confirm the child stopped');
    expect(await f.hooks.agent_before_settle!(boundary, f.ctx)).toBeUndefined();
  });

  it('does not deliver legacy output when both the runtime and status lack an owner', async () => {
    const f = await fixture();
    vi.stubEnv('CINDY_PI_SUBAGENT_OWNER_ID', undefined);
    f.status.state = 'completed';
    f.status.tasks.forEach(task => { task.status = 'completed'; task.output = 'LEGACY_OUTPUT'; });
    await writeFile(path.join(f.dir, 'status.json'), JSON.stringify({ ...f.status, runtimeOwnerId: undefined }));
    restorePending(f);
    const result = await f.hooks.agent_before_settle!(boundary, f.ctx);
    expect(result.entries[0].content).toContain('another runtime owner');
    expect(result.entries[0].content).not.toContain('LEGACY_OUTPUT');
  });

  it('keeps a transiently unreadable status pending when the host still confirms the run', async () => {
    const f = await fixture();
    await rm(path.join(f.dir, 'status.json'));
    restorePending(f);
    f.ctx.ui.input.mockImplementation(async (_title, payload) => {
      if (JSON.parse(payload).action === 'status') {
        f.status.state = 'completed';
        f.status.tasks.forEach(task => { task.status = 'completed'; task.output = 'RECOVERED_RESULT'; });
        await f.publish();
      }
      return JSON.stringify({ ok: true });
    });
    const result = await f.hooks.agent_before_settle!(boundary, f.ctx);
    expect(result.entries[0].content).toContain('RECOVERED_RESULT');
    expect(result.entries[0].content).not.toContain('rejected');
  });

  it('retains the failure reason alongside intermediate output', async () => {
    const f = await fixture();
    Object.assign(f.status.tasks[0]!, { status: 'failed', error: 'Provider disconnected' });
    const result = await f.publish().then(() => f.execute({ action: 'get', taskId: f.runId }));
    expect(result.content[0].text).toContain('interim text');
    expect(result.content[0].text).toContain('Provider disconnected');
  });

  it('waits for asynchronous completion, but yields to pending user input and never continues an error', async () => {
    const f = await fixture();
    extension.createResultDelivery(f.pi).track(f.runId, Date.now() + 10000, true);
    expect(await f.hooks.agent_before_settle!({ ...boundary, outcome: 'error' }, f.ctx)).toBeUndefined();
    expect(await f.hooks.agent_before_settle!({ ...boundary, context: { pendingMessages: [{}] } }, f.ctx)).toBeUndefined();
    const operation = f.hooks.agent_before_settle!(boundary, f.ctx);
    f.status.state = 'completed';
    f.status.tasks.forEach(task => { task.status = 'completed'; task.output = 'CHILD_RESULT'; });
    await f.publish();
    expect((await operation).entries[0].content).toContain('CHILD_RESULT');
  });
});
