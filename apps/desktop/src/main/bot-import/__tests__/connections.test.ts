import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listImportedTools, withImportedConnection } from '../connections.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { discoverImportSources, inspectImportSource } from '../sources.js';
import { createCompanionEnvironmentStore } from '../environment.js';
import { deserializeImportSnapshot, serializeImportSnapshot } from '../files.js';
let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
it('bounds paginated tool discovery and rejects incomplete catalogs instead of publishing a partial page', async () => {
  const tool = { name: 'read', inputSchema: { type: 'object' as const } };
  const listTools = vi.fn().mockResolvedValue({ tools: [tool], nextCursor: 'more' });
  const client = { listTools } as unknown as Client;
  await expect(listImportedTools(client)).rejects.toThrow('Connection page limit exceeded');
  expect(listTools).toHaveBeenCalledTimes(100);
  listTools.mockReset().mockResolvedValueOnce({ tools: Array.from({ length: 1000 }, () => tool), nextCursor: 'overflow' }).mockResolvedValueOnce({ tools: [tool] });
  await expect(listImportedTools(client)).rejects.toThrow('Connection tool limit exceeded');
  expect(listTools).toHaveBeenCalledTimes(2);
  listTools.mockReset().mockResolvedValueOnce({ tools: [tool], nextCursor: 'offline' }).mockRejectedValueOnce(new Error('offline'));
  await expect(listImportedTools(client)).rejects.toThrow('offline');
});
it('queries a real stdio MCP subprocess with the imported credential after a new connection', async () => {
  vi.stubEnv('CINDY_UNRELATED_TEST_SECRET', 'fixture-launch-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://fixture-user:fixture-password@example.invalid');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-mcp-test-'));
  const file = path.join(directory, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline'); let reads = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : r.method === 'tools/list' ? {tools:[{name:'read_data',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}
 : {content:[{type:'text',text:JSON.stringify({pid:process.pid,authenticated:process.env.DATA_TOKEN === 'fixture-mcp-key',isolated:!process.env.CINDY_UNRELATED_TEST_SECRET && !process.env.HTTPS_PROXY,rows:[{id:1}],reads:++reads})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  const connection = { name: 'fixture', command: process.execPath, args: [file], transport: 'stdio' as const };
  await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, async client => {
    expect((await client.listTools()).tools[0]?.name).toBe('read_data');
  });
  const result = await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, client => client.callTool({ name: 'read_data', arguments: {} }));
  expect(JSON.stringify(result)).toContain('authenticated');
  expect(JSON.stringify(result)).toContain('true');
  expect(JSON.stringify(result)).not.toContain('fixture-mcp-key');
  const scope = { identity: 'fixture-companion', signal: new AbortController().signal };
  const first = await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, client => client.callTool({ name: 'read_data', arguments: {} }), scope);
  const second = await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, client => client.callTool({ name: 'read_data', arguments: {} }), scope);
  const payload = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text);
  expect(payload(first).reads).toBe(1);
  expect(payload(first).isolated).toBe(true);
  expect(payload(second).reads).toBe(2);
  // A failed request discards the cached subprocess and leaves no fixture running.
  await expect(withImportedConnection(connection, {}, () => {}, () => { throw new Error('fixture disconnect'); }, scope)).rejects.toThrow('CONNECTION_FAILED');
  // Takeover probes have cancellation but deliberately no persistent cache key.
  const controller = new AbortController();
  let probePid = 0;
  await expect(withImportedConnection(connection, {}, () => {}, async client => {
    probePid = payload(await client.callTool({ name: 'read_data', arguments: {} })).pid;
    controller.abort();
    return new Promise<never>(() => {});
  }, { signal: controller.signal })).rejects.toThrow('CONNECTION_FAILED');
  expect(probePid).toBeGreaterThan(0);
  expect(() => process.kill(probePid, 0)).toThrow();
});

it.each(['hermes', 'openclaw'] as const)('keeps %s stdio working directories through snapshots, storage and real relative-command execution', async kind => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-mcp-cwd-test-'));
  const root = path.join(directory, `.${kind}`);
  const workspace = path.join(root, 'workspace');
  const custom = path.join(workspace, 'server files');
  await fs.mkdir(custom, { recursive: true });
  for (const cwd of [workspace, custom]) {
    await fs.writeFile(path.join(cwd, 'data.txt'), path.basename(cwd));
    await fs.writeFile(path.join(cwd, 'server.cjs'), `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : r.method === 'tools/list' ? {tools:[{name:'read_data',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}
 : {content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),data:require('node:fs').readFileSync('./data.txt','utf8'),authenticated:process.env.KEY === 'fixture-cwd-key'})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  }
  const secretValues = new Map<string, string>();
  const secretIo = { read: (key: string) => secretValues.get(key) ?? null, write: (key: string, value: string) => { secretValues.set(key, value); return true; }, remove: (key: string) => secretValues.delete(key) };
  for (const cwd of [undefined, 'server files', custom, `~/${path.relative(directory, custom).split(path.sep).join('/')}`]) {
    const config = { workdir: workspace, agents: { defaults: { workspace } }, mcpServers: { fixture: { command: process.execPath, args: ['./server.cjs'], ...(cwd === undefined ? {} : { cwd }) } } };
    await fs.writeFile(path.join(root, kind === 'hermes' ? 'config.yaml' : 'openclaw.json'), JSON.stringify(config));
    const readers = { home: directory, env: {}, readCronDatabase: vi.fn(async () => []) };
    const [source] = await discoverImportSources(readers);
    const original = await inspectImportSource(source!, readers);
    const snapshot = deserializeImportSnapshot(serializeImportSnapshot(original));
    const server = snapshot.items.find(item => item.mcp)!.mcp!;
    const expected = cwd === undefined ? workspace : custom;
    expect(server.cwd).toBe(expected);
    expect(JSON.stringify(snapshot.items.map(item => item.view))).not.toContain(expected);
    await createCompanionEnvironmentStore(secretIo).write(directory, 'bot', { version: 1, env: { KEY: 'fixture-cwd-key' }, mcp: [server], credentials: [] }, () => {});
    const restored = (await createCompanionEnvironmentStore(secretIo).read(directory, 'bot', () => {}))!;
    const observed = await withImportedConnection(restored.mcp[0]!, restored.env, () => {}, async client => ({
      tools: await listImportedTools(client),
      result: await client.callTool({ name: 'read_data', arguments: {} }),
    }));
    // Keep assertions outside the connection's foreign-error mask. Windows cwd
    // may retain an 8.3 path; compare both physical directories through realpath.
    expect(observed.tools[0]?.name).toBe('read_data');
    const payload = JSON.parse((observed.result.content as Array<{ text: string }>)[0]!.text);
    expect({ ...payload, cwd: await fs.realpath(payload.cwd) }).toEqual({ cwd: await fs.realpath(expected), data: path.basename(expected), authenticated: true });
  }
});

it('rejects invalid stdio working directories without falling back or exposing paths', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-mcp-invalid-cwd-test-'));
  const file = path.join(directory, 'file.txt');
  await fs.writeFile(file, 'not a directory');
  const run = vi.fn();
  for (const cwd of ['', 'relative', `${directory}\0`, path.join(directory, 'missing'), file]) {
    await expect(withImportedConnection({ name: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd }, {}, () => {}, run)).rejects.toMatchObject({ code: 'CONNECTION_FAILED', message: 'CONNECTION_FAILED' });
  }
  expect(run).not.toHaveBeenCalled();
});

it('terminates an idle credential subprocess after its owner changes and evicts it without affecting another owner', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-idle-mcp-test-'));
  const file = path.join(directory, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline'); let reads = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : {content:[{type:'text',text:JSON.stringify({pid:process.pid,reads:++reads,authenticated:process.env.DATA_TOKEN === 'fixture-token'})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  const server = { name: 'fixture', command: process.execPath, args: [file] };
  let current = true;
  const assertOwner = () => { if (!current) throw new Error('OWNER_CHANGED'); };
  const old = { identity: `${directory}:old`, signal: new AbortController().signal };
  const other = { identity: `${directory}:other`, signal: new AbortController().signal };
  const read = async (scope: typeof old, assert: () => void) => {
    const result = await withImportedConnection(server, { DATA_TOKEN: 'fixture-token' }, assert, client => client.callTool({ name: 'read', arguments: {} }), scope);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { pid: number; reads: number; authenticated: boolean };
  };
  try {
    const first = await read(old, assertOwner); const healthy = await read(other, () => {});
    expect(first.authenticated).toBe(true);
    current = false;
    // No second call is made on the old connection: the idle fence itself closes it.
    await vi.waitFor(() => expect(() => process.kill(first.pid, 0)).toThrow(), { timeout: 5000, interval: 50 });
    expect(await read(other, () => {})).toMatchObject({ pid: healthy.pid, reads: 2 });
    const replacement = await read(old, () => {});
    expect(replacement.pid).not.toBe(first.pid); expect(replacement.reads).toBe(1);
  } finally {
    current = false;
    for (const scope of [old, other]) await withImportedConnection(server, {}, () => {}, async () => { throw new Error('fixture cleanup'); }, scope).catch(() => {});
  }
});

it.each([
  { failure: 'abort', failing: 0, warm: false }, { failure: 'abort', failing: 1, warm: true },
  { failure: 'error', failing: 0, warm: true }, { failure: 'error', failing: 1, warm: false },
])('isolates $failure in concurrent MCP caller $failing (cached beforehand: $warm)', async ({ failure, failing, warm }) => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-parallel-mcp-test-'));
  const file = path.join(directory, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline'); let held; let reads = 0;
const respond = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const payload = () => ({content:[{type:'text',text:JSON.stringify({pid:process.pid,reads:++reads,authenticated:process.env.DATA_TOKEN === 'fixture-token'})}]});
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 if (r.method === 'initialize') return respond(r.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if (r.params?.name === 'hold') { held = r.id; return; }
 if (r.params?.name === 'release' && held !== undefined) { respond(held,payload()); held = undefined; }
 respond(r.id,payload());
});`);
  const server = { name: 'fixture', command: process.execPath, args: [file] };
  const environment = { DATA_TOKEN: 'fixture-token' };
  const identity = directory;
  const controllers = [new AbortController(), new AbortController()];
  const latch = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  };
  const ready = [latch<{ client: Client; pid: number }>(), latch<{ client: Client; pid: number }>()];
  const failures = [latch<void>(), latch<void>()];
  const payload = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text) as { pid: number; authenticated: boolean };
  const initial = warm ? payload(await withImportedConnection(server, environment, () => {}, client => client.callTool({ name: 'identity', arguments: {} }), { identity, signal: new AbortController().signal })) : undefined;
  // Start both before either initialize response: an initializing cache slot must
  // already be reserved, just like an established connection with an active call.
  const calls = controllers.map((controller, index) => withImportedConnection(server, environment, () => {}, async client => {
    const info = payload(await client.callTool({ name: 'identity', arguments: {} }));
    const held = client.callTool({ name: 'hold', arguments: {} });
    ready[index]!.resolve({ client, pid: info.pid });
    return Promise.race([held, failures[index]!.promise.then(() => { throw new Error('fixture-request-failure'); })]);
  }, { identity, signal: controller.signal }));
  const settled = calls.map(call => Promise.allSettled([call]).then(results => results[0]!));
  const healthy = 1 - failing;
  try {
    const active = await Promise.all(ready.map(item => item.promise));
    if (initial) expect(active[0]!.pid).toBe(initial.pid);
    expect(active[0]!.pid).not.toBe(active[1]!.pid);
    if (failure === 'abort') controllers[failing]!.abort();
    else failures[failing]!.resolve();
    expect(await settled[failing]).toMatchObject({ status: 'rejected', reason: { code: 'CONNECTION_FAILED' } });
    await active[healthy]!.client.callTool({ name: 'release', arguments: {} });
    const result = await settled[healthy]!;
    expect(result.status).toBe('fulfilled');
    if (result.status !== 'fulfilled') throw result.reason;
    expect(payload(result.value)).toMatchObject({ pid: active[healthy]!.pid, authenticated: true });
    // The temporary parallel transport is closed even after success.
    expect(() => process.kill(active[1]!.pid, 0)).toThrow();
    const next = payload(await withImportedConnection(server, environment, () => {}, client => client.callTool({ name: 'identity', arguments: {} }), { identity, signal: new AbortController().signal }));
    if (failing === 1) expect(next.pid).toBe(active[0]!.pid);
    else expect(next.pid).not.toBe(active[0]!.pid);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(calls);
    await withImportedConnection(server, environment, () => {}, async () => { throw new Error('fixture cleanup'); }, { identity, signal: new AbortController().signal }).catch(() => {});
  }
});
