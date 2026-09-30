import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import type { Routine } from '@cindy/maker-scheduler';
import { createCompanionEnvironmentStore, type CompanionEnvironment } from '../environment.js';
import { discoverImportSources, inspectImportSource } from '../sources.js';
import { validateImportSelection } from '../transfer.js';
import * as importedProcess from '../process.js';

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
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('executes the default imported script and monitor subtrees after removing the source', async () => {
  const sourceRoot = path.join(root, '.hermes');
  const files = {
    'config.yaml': 'name: Ada\n',
    'cron/jobs.json': JSON.stringify([{ id: 'report', script: 'reports/report.sh', monitor_script: 'monitor/check.sh', no_agent: true, schedule: { kind: 'interval', minutes: 5 } }]),
    'scripts/reports/report.sh': 'test ! -x data/report.txt || exit 90\ntest ! -e "$HERMES_HOME/memory/image.png" || exit 91\ntest -f "$HERMES_HOME/scripts/unrelated/unused.sh" || exit 92\n./helper.sh\n',
    'scripts/reports/helper.sh': '#!/bin/sh\ncat data/report.txt\n',
    'scripts/reports/data/report.txt': 'copied report resource',
    'scripts/monitor/check.sh': './helper.sh\n',
    'scripts/monitor/helper.sh': '#!/bin/sh\ncat data/state.txt\n',
    'scripts/monitor/data/state.txt': 'copied monitor resource',
    'scripts/unrelated/unused.sh': 'exit 99',
  };
  for (const [name, text] of Object.entries(files)) { const file = path.join(sourceRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  for (const name of ['reports/helper.sh', 'monitor/helper.sh']) await fs.chmod(path.join(sourceRoot, 'scripts', name), 0o700);
  const reader = { home: root, env: {}, readCronDatabase: vi.fn(async () => []) };
  const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const selected = validateImportSelection({ requestId: 'script-subtree-fixture', previewId: 'preview', name: 'Ada', takeover: true, entryIds: snapshot.items.filter(item => item.view.selected).map(item => item.view.id) }, snapshot);
  const task = selected.find(item => item.automation)!;
  const assets = Object.fromEntries(selected.flatMap(item => item.asset ? [[item.asset.name, item.asset.bytes.toString('base64')]] : []));
  const fileExecutables = Object.fromEntries(selected.flatMap(item => item.asset ? [[item.asset.name, item.asset.executable === true]] : []));
  expect(fileExecutables['scripts/reports/helper.sh']).toBe(true);
  expect(fileExecutables['scripts/monitor/helper.sh']).toBe(true);
  expect(fileExecutables['scripts/reports/data/report.txt']).toBe(false);
  expect(Object.keys(assets)).toHaveLength(7);
  expect(assets['scripts/unrelated/unused.sh']).toBe(Buffer.from('exit 99').toString('base64'));
  expect(task.view.dependsOn).not.toContain(snapshot.items.find(item => item.asset?.name === 'scripts/unrelated/unused.sh')!.view.id);
  assets['memory/image.png'] = Buffer.from('legacy-private-image').toString('base64');
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], files: assets, fileExecutables, automations: {
    routine: { kind: 'hermes', handover: 'ready', original: task.automation!.original, sourceRoot, deliveries: [] },
  } }, () => {});
  await fs.rm(sourceRoot, { recursive: true, force: true });
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Report', prompt: 'Run report', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  const result = await prepareImportedAutomation(root, routine, 'copied-run', new AbortController().signal, () => {});
  expect(result?.direct).toBe('copied report resource');
  expect(result?.prompt).toContain('copied monitor resource');
  expect(await fs.readdir(path.join(root, 'bots/bot/import-executions'))).toEqual([]);
});

it('does not materialize legacy media or archived memory for a native command', async () => {
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture command' } as Routine;
  const directory = path.join(root, 'bots', 'bot', 'import-executions');
  const code = 'const fs=require("node:fs"),path=require("node:path");const dirs=fs.readdirSync(process.argv[1]);console.log(dirs.every(name=>!fs.existsSync(path.join(process.argv[1],name,"memory"))&&fs.existsSync(path.join(process.argv[1],name,"scripts/unused.py"))&&(process.platform==="win32"||(fs.statSync(path.join(process.argv[1],name,"scripts/unused.py")).mode&0o111)===0))?"clean":"incorrect assets");';
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code, directory], cwd: root } };
  const legacyFiles = { 'memory/image.png': Buffer.from('legacy-media-bytes').toString('base64'), 'scripts/unused.py': Buffer.from('unused').toString('base64') };
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], files: legacyFiles,
    memoryFiles: { 'memory/.report.sent': '' }, automations: { routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root } },
  }, () => {});
  const result = await prepareImportedAutomation(root, routine, 'no-media-command', new AbortController().signal, () => {});
  expect(result?.direct).toBe('clean');
  const preserved = await shared.store.read(root, 'bot', () => {});
  expect(preserved?.files).toEqual(legacyFiles);
  expect(preserved?.memoryFiles).toEqual({ 'memory/.report.sent': '' });
  expect(await fs.readdir(directory)).toEqual([]);
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


it('runs a native command with literal argv, cwd, stdin and private env only after handover, and reuses its durable output', async () => {
  const routine = { id: 'routine', botId: 'bot', prompt: 'Command report' } as Routine;
  const marker = path.join(root, 'runs');
  const arg = 'spaces; $(must-not-run)';
  const code = 'const fs=require("node:fs"); fs.appendFileSync(process.argv[1], "x"); process.stdout.write(JSON.stringify([process.argv[2], process.cwd(), fs.readFileSync(0,"utf8"), process.env.FIXTURE_TOKEN]));';
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code, marker, arg], cwd: root,
    input: 'test stdin', env: { FIXTURE_TOKEN: 'fixture-command-secret' }, timeoutSeconds: 10, noOutputTimeoutSeconds: 5, outputMaxBytes: 4096 } };
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'pending', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  expect(await prepareImportedAutomation(root, routine, 'cmd-run', signal, () => {})).toMatchObject({ deferred: true });
  await expect(fs.access(marker)).rejects.toThrow();
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.handover = 'ready'; });
  const result = await prepareImportedAutomation(root, routine, 'cmd-run', signal, () => {});
  expect(JSON.parse(result!.direct!)).toEqual([expect.stringMatching(/^\[command_literal_/), expect.stringMatching(/^\[command_literal_/), expect.stringMatching(/^\[command_literal_/), '[imported_credential_0]']);
  for (const literal of [arg, root, await fs.realpath(root), 'test stdin']) expect(result!.direct).not.toContain(literal);
  expect(await prepareImportedAutomation(root, routine, 'cmd-run', signal, () => {})).toEqual(result);
  expect(await fs.readFile(marker, 'utf8')).toBe('x');
});

it('masks argv-only credentials again before publishing legacy command results', async () => {
  const routine = { id: 'routine', botId: 'bot' } as Routine;
  const original = { payload: { kind: 'command', argv: [process.execPath, '--token=fixture-argv-secret'], input: 'fixture-stdin-secret', cwd: root } };
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  await finishImportedAutomation(root, routine, 'chat', 'legacy-run', `fixture-argv-secret fixture-stdin-secret ${root}`, true, new AbortController().signal, () => {});
  const published = shared.message.mock.calls[0]![1].content;
  expect(published).not.toContain('fixture-argv-secret');
  expect(published).not.toContain('fixture-stdin-secret');
  expect(published).not.toContain(root);
  expect(published).toContain('[command_literal_');
});

it.each(['stdin', 'argv', 'assignment', 'env', 'inherited-env'] as const)('masks nested JSON credentials from %s in execution, cached output and publication', async source => {
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture structured input' } as Routine;
  const secret = 'fixture-nested-"quoted"\n-secret';
  const arraySecret = 'fixture-array-secret';
  const containerSecret = 'fixture-container-secret';
  const privateKey = 'fixture-private-"quoted"\n-key';
  const encodedKey = 'fixture-encoded-"quoted"\n-key';
  const passphrase = 'fixture-passphrase';
  const keyField = source === 'stdin' ? 'private_key' : source === 'argv' ? 'privateKey' : 'signing_key';
  const encodedKeyField = source === 'stdin' ? 'privateKeyPem' : source === 'argv' ? 'private_key_pem' : 'privateKeyBase64';
  const input = JSON.stringify({ credentials: [{ token: secret, api_key: [arraySecret] }, containerSecret],
    [keyField]: privateKey, [encodedKeyField]: { copies: [encodedKey] }, passphrase, passphrases: [passphrase], city: 'Paris report', cities: ['Paris report', 'London'], count: 7 });
  const read = source === 'stdin' ? 'require("node:fs").readFileSync(0,"utf8")'
    : source === 'env' || source === 'inherited-env' ? 'process.env.CONFIG'
      : source === 'assignment' ? 'process.argv[1].slice("--config=".length)' : 'process.argv[1]';
  const code = `const input=JSON.parse(${read}); process.stdout.write(JSON.stringify({token:input.credentials[0].token,arrayToken:input.credentials[0].api_key[0],containerToken:input.credentials[1],privateKey:input.${keyField},encodedKey:input.${encodedKeyField}.copies[0],passphrase:input.passphrase,city:input.city,cities:input.cities,count:input.count}));`;
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code,
    ...(['argv', 'assignment'].includes(source) ? ['--', source === 'assignment' ? `--config=${input}` : input] : [])],
    ...(source === 'stdin' ? { input } : {}), ...(source === 'env' ? { env: { CONFIG: input } } : {}), cwd: root } };
  // An ordinary JSON string setting must not become a global mask for report text.
  const environment: Record<string, string> = { DISPLAY_CONFIG: JSON.stringify('Paris'), RETRY_COUNT: '7', ...(source === 'inherited-env' ? { CONFIG: input } : {}) };
  await shared.store.write(root, 'bot', { version: 1, env: environment, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  const prepared = await prepareImportedAutomation(root, routine, 'structured-run', signal, () => {});
  expect(JSON.parse(prepared!.direct!)).toEqual({ token: expect.stringMatching(/^\[command_literal_/), arrayToken: expect.stringMatching(/^\[command_literal_/), containerToken: expect.stringMatching(/^\[command_literal_/), privateKey: expect.stringMatching(/^\[command_literal_/), encodedKey: expect.stringMatching(/^\[command_literal_/), passphrase: expect.stringMatching(/^\[command_literal_/), city: 'Paris report', cities: ['Paris report', 'London'], count: 7 });
  const savedEnvironment = (await shared.store.read(root, 'bot', () => {}))!;
  expect(savedEnvironment.env).toEqual(environment);
  const saved = savedEnvironment.automations!.routine!;
  expect(saved.original).toEqual(original);
  expect(saved.prepared?.direct).toBe(prepared!.direct);
  // Old private output must be masked even when no process is executed again.
  const legacy = JSON.stringify({ token: secret, arrayToken: arraySecret, containerToken: containerSecret, privateKey, encodedKey, passphrase, city: 'Paris report', cities: ['Paris report', 'London'], count: 7 });
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.prepared = { runId: 'structured-run', prompt: '', direct: legacy };
  });
  expect((await prepareImportedAutomation(root, routine, 'structured-run', signal, () => {}))?.direct).toBe(prepared!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'structured-run', legacy, true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(prepared!.direct);
});

it.each(['env', 'inherited-env', 'stdin', 'argv', 'assignment'] as const)('masks capability URL components from command %s before caching or publishing', async source => {
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture URL report' } as Routine;
  const url = 'https://fixture-user:fixture-password@example.invalid/hooks/fixture%2Fpath?token=fixture%2Bquery&enabled=true#access_token=fixture%2Ffragment%2Bsecret&token_type=Bearer&section=Introduction';
  const input = JSON.stringify({ destinations: [{ endpoint: url }], city: 'Paris' });
  const read = source === 'env' || source === 'inherited-env' ? 'process.env.WEBHOOK_URL'
    : `JSON.parse(${source === 'stdin' ? 'require("node:fs").readFileSync(0,"utf8")' : 'process.argv[1].replace(/^--config=/, "")'}).destinations[0].endpoint`;
  const code = `const url=new URL(${read}); const encoded=url.pathname.split("/").pop(); const fragment=new URLSearchParams(url.hash.slice(1)); process.stdout.write(JSON.stringify({user:url.username,password:url.password,path:decodeURIComponent(encoded),encoded,query:url.searchParams.get("token"),wireQuery:url.search.slice(1).split("&")[0].split("=")[1],fragment:fragment.get("access_token"),wireFragment:url.hash.slice(1).split("&")[0].split("=")[1],tokenType:fragment.get("token_type"),section:fragment.get("section"),enabled:url.searchParams.get("enabled"),route:url.pathname.split("/")[1],city:"Paris"}));`;
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code,
    ...(['argv', 'assignment'].includes(source) ? ['--', source === 'assignment' ? `--config=${input}` : input] : [])], cwd: root,
    ...(source === 'stdin' ? { input } : {}), ...(source === 'env' ? { env: { WEBHOOK_URL: url } } : {}) } };
  const environment: CompanionEnvironment = { version: 1, env: source === 'inherited-env' ? { WEBHOOK_URL: url } : {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } };
  await shared.store.write(root, 'bot', environment, () => {});
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'url-run', signal, () => {});
  const output = JSON.parse(result!.direct!);
  expect(output).toMatchObject({ enabled: 'true', route: 'hooks', city: 'Paris', tokenType: 'Bearer', section: 'Introduction' });
  for (const value of ['fixture-user', 'fixture-password', 'fixture/path', 'fixture%2Fpath', 'fixture+query', 'fixture%2Bquery', 'fixture/fragment+secret', 'fixture%2Ffragment%2Bsecret']) expect(result!.direct).not.toContain(value);
  const saved = (await shared.store.read(root, 'bot', () => {}))!;
  expect(saved.automations!.routine!.original).toEqual(original);
  expect(saved.env).toEqual(environment.env);
  expect(saved.automations!.routine!.prepared?.direct).toBe(result!.direct);
  const legacy = JSON.stringify({ user: 'fixture-user', password: 'fixture-password', path: 'fixture/path', encoded: 'fixture%2Fpath', query: 'fixture+query', wireQuery: 'fixture%2Bquery', fragment: 'fixture/fragment+secret', wireFragment: 'fixture%2Ffragment%2Bsecret', tokenType: 'Bearer', section: 'Introduction', enabled: 'true', route: 'hooks', city: 'Paris' });
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.prepared = { runId: 'url-run', prompt: '', direct: legacy }; });
  expect((await prepareImportedAutomation(root, routine, 'url-run', signal, () => {}))?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.deliveryProgress = { runId: 'url-run', text: legacy, direct: true, deliveries: [], next: 0 };
  });
  expect((await prepareImportedAutomation(root, routine, 'retry-run', signal, () => {}))?.direct).toBe(result!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'retry-run', 'must reuse pending output', true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(result!.direct);
});

it.each(['-H', '--header=', '-Hjoined', '--proxy-header'])('masks an echoed authorization payload from %s before caching and publishing', async option => {
  const header = `${option === '--proxy-header' ? 'Proxy-' : ''}Authorization: Bearer fixture-header-token`;
  const args = option === '--header=' ? [option + header] : option === '-Hjoined' ? ['-H' + header] : [option, header];
  const code = 'const header=process.argv.slice(1).find(arg=>arg.includes("Authorization:")); process.stdout.write(header.split("Bearer ")[1]+" public report");';
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code, '--', ...args], cwd: root } };
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture header report' } as Routine;
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'header-run', signal, () => {});
  expect(result!.direct).not.toContain('fixture-header-token');
  expect(result!.direct).toContain('public report');
  const saved = (await shared.store.read(root, 'bot', () => {}))!;
  expect(saved.automations!.routine!.original).toEqual(original);
  expect(saved.automations!.routine!.prepared?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.prepared = { runId: 'header-run', prompt: '', direct: 'fixture-header-token public report' };
  });
  expect((await prepareImportedAutomation(root, routine, 'header-run', signal, () => {}))?.direct).toBe(result!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'header-run', 'fixture-header-token public report', true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(result!.direct);
});

it.each(['stdin', 'argv', 'assignment', 'env', 'inherited-env'])('masks form credential values from command %s in execution, retries and final publication', async source => {
  const form = 'access_token=fixture-form%2Fsecret%2Bvalue&password=fixture+second+secret&city=Paris&days=7';
  const read = source === 'stdin' ? 'require("node:fs").readFileSync(0,"utf8")'
    : source === 'env' || source === 'inherited-env' ? 'process.env.CONFIG' : 'process.argv[1].replace(/^--data=/, "")';
  const code = `const form=new URLSearchParams(${read});process.stdout.write([form.get("access_token"),form.get("password"),form.get("city"),form.get("days")].join(" | "));`;
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code,
    ...(['argv', 'assignment'].includes(source) ? ['--', source === 'assignment' ? `--data=${form}` : form] : [])], cwd: root,
    ...(source === 'stdin' ? { input: form } : {}), ...(source === 'env' ? { env: { CONFIG: form } } : {}) } };
  const environment: Record<string, string> = source === 'inherited-env' ? { CONFIG: form } : {};
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture form report' } as Routine;
  await shared.store.write(root, 'bot', { version: 1, env: environment, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'form-run', signal, () => {});
  for (const secret of ['fixture-form/secret+value', 'fixture second secret']) expect(result!.direct).not.toContain(secret);
  expect(result!.direct).toContain('Paris | 7');
  const saved = (await shared.store.read(root, 'bot', () => {}))!;
  expect(saved.env).toEqual(environment);
  expect(saved.automations!.routine!.original).toEqual(original);
  expect(saved.automations!.routine!.prepared?.direct).toBe(result!.direct);
  const legacy = 'fixture-form/secret+value | fixture second secret | Paris | 7';
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.prepared = { runId: 'form-run', prompt: '', direct: legacy };
  });
  expect((await prepareImportedAutomation(root, routine, 'form-run', signal, () => {}))?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.deliveryProgress = { runId: 'form-run', text: legacy, direct: true, deliveries: [], next: 0 };
  });
  expect((await prepareImportedAutomation(root, routine, 'retry-run', signal, () => {}))?.direct).toBe(result!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'retry-run', 'must reuse pending output', true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(result!.direct);
});

it.each(['Authorization', 'Proxy-Authorization'])('masks decoded Basic %s credentials from command output, caches and final chat', async name => {
  const userinfo = 'alice:fixture-basic:password';
  const header = `${name}: Basic ${Buffer.from(userinfo).toString('base64')}`;
  const code = 'const u=Buffer.from(process.argv[1].split(/\\s+/).at(-1),"base64").toString();process.stdout.write(u+" | "+u.slice(u.indexOf(":")+1)+" | alice | public report");';
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code, header], cwd: root } };
  const output = `${userinfo} | fixture-basic:password | alice | public report`;
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture Basic report' } as Routine;
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'basic-run', signal, () => {});
  expect(result!.direct).toMatch(/^(?:\[command_literal_\w+\] \| ){2}alice \| public report$/);
  const saved = (await shared.store.read(root, 'bot', () => {}))!;
  expect(saved.automations!.routine!.original).toEqual(original);
  expect(saved.automations!.routine!.prepared?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.prepared = { runId: 'basic-run', prompt: '', direct: output }; });
  expect((await prepareImportedAutomation(root, routine, 'basic-run', signal, () => {}))?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.deliveryProgress = { runId: 'basic-run', text: output, direct: true, deliveries: [], next: 0 }; });
  expect((await prepareImportedAutomation(root, routine, 'retry-run', signal, () => {}))?.direct).toBe(result!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'retry-run', output, true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(result!.direct);
});

it.each(['X-API-Key', 'X-Auth-Token', 'Cookie'])('masks independently echoed %s header values through command execution and retry publication', async name => {
  const header = `${name}: ${name === 'Cookie' ? 'session=fixture-session%2Fsecret; second="fixture-second-cookie"' : 'fixture-header-secret'}`;
  const code = 'const h=process.argv[1];const v=h.slice(h.indexOf(":")+1).trim();process.stdout.write((/^cookie:/i.test(h)?v.split(";").map(p=>decodeURIComponent(p.slice(p.indexOf("=")+1).trim().replace(/^"|"$/g,""))).join(" | "):v)+" | public report");';
  const original = { payload: { kind: 'command', argv: [process.execPath, '-e', code, header], cwd: root } };
  const output = name === 'Cookie' ? 'fixture-session/secret | fixture-second-cookie | public report' : 'fixture-header-secret | public report';
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture header report' } as Routine;
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'header-run', signal, () => {});
  expect(result!.direct).toMatch(/^(?:\[command_literal_\w+\] \| ){1,2}public report$/);
  const saved = (await shared.store.read(root, 'bot', () => {}))!;
  expect(saved.automations!.routine!.original).toEqual(original);
  expect(saved.automations!.routine!.prepared?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.prepared = { runId: 'header-run', prompt: '', direct: output }; });
  expect((await prepareImportedAutomation(root, routine, 'header-run', signal, () => {}))?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.deliveryProgress = { runId: 'header-run', text: output, direct: true, deliveries: [], next: 0 }; });
  expect((await prepareImportedAutomation(root, routine, 'retry-run', signal, () => {}))?.direct).toBe(result!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'retry-run', output, true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(result!.direct);
});

it.each(['-u', '--user', '-U', '--proxy-user', '-ujoined', '-Ujoined', '--user=', '--proxy-user='])
('masks curl %s passwords from output, retry caches and final chat', async option => {
  const userinfo = 'alice:fixture-auth:password';
  const args = option.endsWith('joined') ? [option.slice(0, 2) + userinfo] : option.endsWith('=') ? [option + userinfo] : [option, userinfo];
  const original = { payload: { kind: 'command', argv: ['curl', ...args], cwd: root } };
  const output = 'fixture-auth:password | alice | public report';
  const run = vi.spyOn(importedProcess, 'runImportedProcess').mockResolvedValue({ stdout: output, exitCode: 0 });
  const routine = { id: 'routine', botId: 'bot', prompt: 'Fixture curl report' } as Routine;
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'openclaw', handover: 'ready', original, sourceRoot: root },
  } }, () => {});
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'curl-run', signal, () => {});
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'curl', args }));
  expect(result!.direct).toMatch(/^\[command_literal_\d+\] \| alice \| public report$/);
  expect(result!.direct).toContain('alice | public report');
  const saved = (await shared.store.read(root, 'bot', () => {}))!;
  expect(saved.automations!.routine!.original).toEqual(original);
  expect(saved.automations!.routine!.prepared?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.prepared = { runId: 'curl-run', prompt: '', direct: output };
  });
  expect((await prepareImportedAutomation(root, routine, 'curl-run', signal, () => {}))?.direct).toBe(result!.direct);
  await shared.store.update(root, 'bot', () => {}, env => {
    env.automations!.routine!.deliveryProgress = { runId: 'curl-run', text: output, direct: true, deliveries: [], next: 0 };
  });
  expect((await prepareImportedAutomation(root, routine, 'retry-run', signal, () => {}))?.direct).toBe(result!.direct);
  await finishImportedAutomation(root, routine, 'chat', 'retry-run', 'must reuse pending output', true, signal, () => {});
  expect(shared.message.mock.calls[0]![1].content).toBe(result!.direct);
  expect(run).toHaveBeenCalledTimes(1);
});
