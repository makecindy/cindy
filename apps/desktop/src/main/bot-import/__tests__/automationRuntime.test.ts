import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import type { Routine } from '@cindy/maker-scheduler';
import { createCompanionEnvironmentStore } from '../environment.js';
import { discoverImportSources, inspectImportSource } from '../sources.js';
import { validateImportSelection } from '../transfer.js';

const shared = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof createCompanionEnvironmentStore>, message: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: { read: (...args: Parameters<typeof shared.store.read>) => shared.store.read(...args), update: (...args: Parameters<typeof shared.store.update>) => shared.store.update(...args) } }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: shared.message }));
import { assertImportedAutomationReady, prepareImportedAutomation, finishImportedAutomation } from '../automationRuntime.js';
let root: string;
let secretValues: Map<string, string>;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-runtime-test-'));
  const values = secretValues = new Map<string, string>();
  shared.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); return true; }, remove: key => { values.delete(key); return true; } });
  shared.message.mockReset().mockResolvedValue({});
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('executes the default imported script and monitor subtrees after removing the source', async () => {
  const sourceRoot = path.join(root, '.hermes');
  const files = {
    'config.yaml': 'name: Ada\n',
    'cron/jobs.json': JSON.stringify([{ id: 'report', script: 'reports/report.sh', monitor_script: 'monitor/check.sh', no_agent: true, schedule: { kind: 'interval', minutes: 5 } }]),
    'scripts/reports/report.sh': '. ./helper.sh\nreport\n',
    'scripts/reports/helper.sh': 'report() { cat data/report.txt; }\n',
    'scripts/reports/data/report.txt': 'copied report resource',
    'scripts/monitor/check.sh': '. ./helper.sh\nmonitor\n',
    'scripts/monitor/helper.sh': 'monitor() { cat data/state.txt; }\n',
    'scripts/monitor/data/state.txt': 'copied monitor resource',
    'scripts/unrelated/unused.sh': 'exit 99',
  };
  for (const [name, text] of Object.entries(files)) { const file = path.join(sourceRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  const reader = { home: root, env: {}, readCronDatabase: vi.fn(async () => []) };
  const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const selected = validateImportSelection({ requestId: 'script-subtree-fixture', previewId: 'preview', name: 'Ada', takeover: true, entryIds: snapshot.items.filter(item => item.view.selected).map(item => item.view.id) }, snapshot);
  const task = selected.find(item => item.automation)!;
  const assets = Object.fromEntries(selected.flatMap(item => item.asset ? [[item.asset.name, item.asset.bytes.toString('base64')]] : []));
  expect(Object.keys(assets)).toHaveLength(6);
  expect(assets['scripts/unrelated/unused.sh']).toBeUndefined();
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], files: assets, automations: {
    routine: { kind: 'hermes', handover: 'ready', original: task.automation!.original, sourceRoot, deliveries: [] },
  } }, () => {});
  await fs.rm(sourceRoot, { recursive: true, force: true });
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Report', prompt: 'Run report', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  const result = await prepareImportedAutomation(root, routine, 'copied-run', new AbortController().signal, () => {});
  expect(result?.direct).toBe('copied report resource');
  expect(result?.prompt).toContain('copied monitor resource');
  expect(await fs.readdir(path.join(root, 'bots/bot/import-executions'))).toEqual([]);
});

it('uses the original monitor URL but masks echoed path/query credentials, previous output and legacy retry caches', async () => {
  const requests: string[] = [];
  const endpoint = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(`Count: 7\n${req.url}\nfake-path-secret\nfake/query+secret`);
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/fake-path-secret?token=fake%2Fquery%2Bsecret`;
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Monitor', prompt: `Monitor ${url}`, enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  const signal = new AbortController().signal;
  try {
    await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
      routine: { kind: 'hermes', handover: 'ready', original: { monitor_url: url }, sourceRoot: root, monitorOutput: `Old ${url} fake/query+secret` },
    } }, () => {});
    const prepared = (await prepareImportedAutomation(root, routine, 'run', signal, () => {}))!;
    expect(requests).toEqual(['/fake-path-secret?token=fake%2Fquery%2Bsecret']);
    expect(prepared.prompt).toContain('Count: 7');
    const stored = (await shared.store.read(root, 'bot', () => {}))!;
    expect(stored.automations!.routine!.original.monitor_url).toBe(url);
    for (const value of [url, 'fake-path-secret', 'fake/query+secret', 'fake%2Fquery%2Bsecret']) {
      expect(JSON.stringify(prepared)).not.toContain(value);
      expect(JSON.stringify(stored.automations!.routine!.prepared)).not.toContain(value);
    }
    await finishImportedAutomation(root, routine, 'chat', 'run', prepared.prompt, true, signal, () => {});
    expect(shared.message.mock.calls[0]![1].content).toBe(prepared.prompt);
    expect((await prepareImportedAutomation(root, routine, 'next-run', signal, () => {}))?.skipped).toBe(true);
    // A persisted result written by an older build is sanitized even on the fast retry path.
    await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.prepared = { runId: 'legacy', prompt: url, direct: 'fake/query+secret', monitorOutput: 'fake-path-secret' }; });
    const calls = requests.length;
    const retry = await prepareImportedAutomation(root, routine, 'legacy', signal, () => {});
    for (const value of [url, 'fake-path-secret', 'fake/query+secret']) expect(JSON.stringify(retry)).not.toContain(value);
    expect(requests).toHaveLength(calls);
    await finishImportedAutomation(root, routine, 'chat', 'legacy', 'fake/query+secret', true, signal, () => {});
    expect(JSON.stringify(shared.message.mock.calls)).not.toContain('fake/query+secret');
  } finally { endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); }
});
it.skipIf(process.platform === 'win32')('runs a copied script after the source is gone, with private env, once per durable run', async () => {
  vi.stubEnv('CINDY_UNRELATED_TEST_SECRET', 'fixture-launch-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://fixture-user:fixture-password@example.invalid');
  const script = 'test "$DATA_TOKEN" = "fixture-token" || exit 1\ntest -z "$CINDY_UNRELATED_TEST_SECRET" || exit 2\ntest -z "$HTTPS_PROXY" || exit 3\nprintf "data read succeeded"\n';
  await shared.store.write(root, 'bot', { version: 1, env: { DATA_TOKEN: 'fixture-token' }, mcp: [], credentials: [], files: { 'scripts/report.sh': Buffer.from(script).toString('base64') }, automations: {
    routine: { kind: 'hermes', handover: 'ready', original: { id: 'original', script: 'report.sh', no_agent: true, repeat: { times: 1, completed: 0 } }, sourceRoot: path.join(root, 'source-does-not-exist'), deliveries: [] },
  } }, () => {});
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Report', prompt: 'Run report', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'run-1', signal, () => {});
  expect(result?.direct).toBe('data read succeeded');
  expect(await prepareImportedAutomation(root, routine, 'run-1', signal, () => {})).toEqual(result);
  await expect(finishImportedAutomation(root, routine, 'main-chat', 'run-1', result!.direct!, true, signal, () => {})).resolves.toBe(true);
  expect(shared.message).toHaveBeenCalledWith('main-chat', expect.objectContaining({ clientId: 'imported-routine:run-1', content: 'data read succeeded' }));
  expect(await prepareImportedAutomation(root, routine, 'run-2', signal, () => {})).toMatchObject({ skipped: true, exhausted: true });
  expect(await prepareImportedAutomation(root, routine, 'run-1', signal, () => {})).toMatchObject({ exhausted: true });
  await expect(finishImportedAutomation(root, routine, 'main-chat', 'run-1', result!.direct!, true, signal, () => {})).resolves.toBe(true);
  expect((await shared.store.read(root, 'bot', () => {}))!.automations!.routine!.completed).toBe(1);
  expect(await fs.readdir(path.join(root, 'bots/bot/import-executions'))).toEqual([]);
});

it('counts only successful completion toward the source repeat limit', async () => {
  const routine = { id: 'routine', botId: 'bot' } as Routine;
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'hermes', handover: 'ready', original: { repeat: { times: 2, completed: 1 } }, sourceRoot: root },
  } }, () => {});
  shared.message.mockRejectedValueOnce(new Error('fixture delivery failure'));
  const finish = () => finishImportedAutomation(root, routine, 'chat', 'last-run', 'report', true, new AbortController().signal, () => {});
  await expect(finish()).rejects.toThrow('fixture delivery failure');
  expect((await shared.store.read(root, 'bot', () => {}))!.automations!.routine!.completed).toBeUndefined();
  await expect(finish()).resolves.toBe(true);
  await expect(finish()).resolves.toBe(true);
  expect((await shared.store.read(root, 'bot', () => {}))!.automations!.routine!.completed).toBe(2);
});

it.each(['pending', undefined] as const)('blocks management and defers execution until the persisted %s handover completes', async handover => {
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Report', prompt: 'Read data', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'hermes', handover, original: { enabled: true }, sourceRoot: root, prepared: { runId: 'run', prompt: 'cached' } },
  } }, () => {});
  await expect(assertImportedAutomationReady(root, 'bot', 'routine', () => {})).rejects.toThrow('AUTOMATION_HANDOVER_REQUIRED');
  const signal = new AbortController().signal;
  expect(await prepareImportedAutomation(root, routine, 'run', signal, () => {})).toMatchObject({ deferred: true });
  expect(shared.message).not.toHaveBeenCalled();
  await expect(fs.access(path.join(root, 'bots/bot/import-executions'))).rejects.toThrow();
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.handover = 'ready'; });
  await expect(assertImportedAutomationReady(root, 'bot', 'routine', () => {})).resolves.toBeUndefined();
  expect(await prepareImportedAutomation(root, routine, 'run', signal, () => {})).toEqual({ runId: 'run', prompt: 'cached' });
  // Static adapter/dependency failures remain blocked even after a ready marker.
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.issues = ['AUTOMATION_DEPENDENCY_NOT_SELECTED']; });
  await expect(assertImportedAutomationReady(root, 'bot', 'routine', () => {})).rejects.toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
});


it.each([2, 4])('resumes confirmed Telegram target/chunk progress after failure on send %s and restart', async failAt => {
  const routine = { id: 'routine', botId: 'bot', prompt: 'Must not rerun the model' } as Routine;
  const signal = new AbortController().signal;
  const deliveries = [{ connectionId: 'telegram', chatId: 'first' }, { connectionId: 'telegram', chatId: 'second', threadId: 7 }];
  const text = 'a'.repeat(1750) + 'remaining';
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [
    { id: 'telegram', format: 'telegram', value: { token: '123:fixture_token' } },
  ], automations: { routine: { kind: 'hermes', handover: 'ready', original: { repeat: { times: 1 } }, sourceRoot: root, deliveries,
    prepared: { runId: 'first-run', prompt: 'Report', monitorHash: 'captured-monitor', monitorOutput: 'captured-state' },
  } } }, () => {});
  const sent: Array<{ chat_id: string; text: string; message_thread_id?: number }> = [];
  let attempts = 0;
  const fetcher = vi.fn(async (_url: unknown, input: RequestInit) => {
    if (++attempts === failAt) return new Response(JSON.stringify({ ok: false }), { status: 500 });
    sent.push(JSON.parse(String(input.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: attempts } }));
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(finishImportedAutomation(root, routine, 'chat', 'first-run', text, false, signal, () => {})).rejects.toThrow('DELIVERY_FAILED');
  const unfinished = (await shared.store.read(root, 'bot', () => {}))!.automations!.routine!;
  expect(unfinished.deliveryProgress?.next).toBe(failAt - 1);
  expect(unfinished.completed).toBeUndefined();
  // Reopen the durable encrypted store with no in-process environment cache.
  shared.store = createCompanionEnvironmentStore({ read: key => secretValues.get(key) ?? null,
    write: (key, value) => { secretValues.set(key, value); return true; }, remove: key => { secretValues.delete(key); return true; } });
  const retryId = failAt === 2 ? 'first-run' : 'next-occurrence';
  expect(await prepareImportedAutomation(root, routine, retryId, signal, () => {})).toMatchObject({ direct: text });
  await expect(finishImportedAutomation(root, routine, 'chat', retryId, 'changed output must not replace pending chunks', true, signal, () => {})).resolves.toBe(true);
  expect(sent).toEqual([
    { chat_id: 'first', text: 'a'.repeat(1750) }, { chat_id: 'first', text: 'remaining' },
    { chat_id: 'second', text: 'a'.repeat(1750), message_thread_id: 7 }, { chat_id: 'second', text: 'remaining', message_thread_id: 7 },
  ]);
  expect(shared.message).not.toHaveBeenCalled(); // Model output was already recorded by its original run.
  const completed = (await shared.store.read(root, 'bot', () => {}))!.automations!.routine!;
  expect(completed).toMatchObject({ completed: 1, lastRun: retryId, monitorHash: 'captured-monitor', monitorOutput: 'captured-state' });
  expect(completed.deliveryProgress).toBeUndefined();
  const calls = fetcher.mock.calls.length;
  await finishImportedAutomation(root, routine, 'chat', retryId, text, true, signal, () => {});
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
