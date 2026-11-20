/**
 * Test value: AppConnection's real stdio initialize/discover/call/release path,
 * including a uvx-shaped launcher and worker, cannot be established by SDK mocks.
 * Minimal failures: forced shutdown skips a final save, or a launcher exits on
 * stdin EOF and leaves its worker alive. PID checks alone cannot detect the former.
 * User contract: credentials stay private and owned processes end with their
 * connection. Real processes live in the explicit e2e tier, never default unit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConnection, type AppServerConfig } from '../connection.js';
import { stdioAppEnvironment } from '../stdioTransport.js';
import { configureWindowsMcpJob, resolveWindowsMcpJob } from '../../windowsMcpJob.js';
import { McpAppsHost } from '../host.js';
import { createMcpAppsRuntime } from '../runtimeCore.js';
import { createAppServerProxyFactory } from '../serverProxy.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => state.home }));

let directory: string;
let file: string;
const connections = new Set<AppConnection>();
const children = new Set<number>();
const secret = 'invalid-fixture-stdio-secret';

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-stdio-mcp-'));
  state.home = directory;
  if (process.platform === 'win32') {
    configureWindowsMcpJob({
      sourceFile: fileURLToPath(new URL('../../../../native/windows-mcp-stdio-job/main.rs', import.meta.url)),
      cacheDir: directory,
    });
    await resolveWindowsMcpJob();
  }
  file = path.join(directory, 'fixture.cjs');
  await fs.writeFile(file, `
const fs = require('node:fs');
// On Windows the Node launcher can clean up an attached worker by itself.
// A detached worker survives the launcher and exercises Cindy's own Job Object.
const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  stdio:'ignore', detached:process.platform==='win32', windowsHide:true,
});
const identity = () => ({pid:process.pid,worker:worker.pid,cwd:process.cwd(),args:process.argv.slice(2),authenticated:process.env.DATA_TOKEN === '${secret}',isolated:!process.env.CINDY_OTHER_TOKEN});
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, JSON.stringify(identity()));
process.stderr.write('stderr must not escape: '+process.env.DATA_TOKEN+'\\n');
const rl = require('node:readline').createInterface({input:process.stdin});
const reply = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
let held;
rl.on('line',line=>{
  const request=JSON.parse(line); if(!('id' in request)) return;
  if(request.method==='initialize') {
    if(process.env.FIXTURE_MODE==='hang') return;
    if(process.env.FIXTURE_MODE==='fail') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'private '+process.env.DATA_TOKEN}})+'\\n');
    return reply(request.id,{protocolVersion:'2025-11-25',capabilities:{tools:{},resources:{},prompts:{},completions:{}},serverInfo:{name:'fixture',version:'1'}});
  }
  if(request.method==='tools/list') return reply(request.id,{tools:[{name:'identity',description:process.env.DATA_TOKEN,inputSchema:{type:'object',properties:{description:{type:'string',description:process.env.DATA_TOKEN}}},_meta:{ui:{resourceUri:'ui://fixture'}}},{name:'echo_secret',inputSchema:{type:'object'}}]});
  if(request.method==='prompts/get') return reply(request.id,{description:process.env.DATA_TOKEN,messages:[
    {role:'user',content:{type:'text',text:'Prompt: '+process.env.DATA_TOKEN}},
    {role:'user',content:{type:'resource',resource:{uri:'fixture://result',text:process.env.DATA_TOKEN}}}
  ]});
  if(request.method==='completion/complete') return reply(request.id,{completion:{values:[process.env.DATA_TOKEN],total:1}});
  if(request.method==='resources/read') return reply(request.id,{contents:[{uri:'ui://fixture',mimeType:'text/html;profile=mcp-app',text:'<html>Fixture</html>',_meta:{ui:{}}}]});
  if(request.params?.name==='echo_secret') {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{level:'info',data:process.env.DATA_TOKEN}})+'\\n');
    return reply(request.id,{content:[{type:'text',text:process.env.DATA_TOKEN},{type:'resource',resource:{uri:'fixture://result',mimeType:'text/plain',text:process.env.DATA_TOKEN}}]});
  }
  if(request.params?.arguments?.hold) { held=request.id; fs.writeFileSync(process.env.HOLD_FILE,'ready'); return; }
  if(request.params?.arguments?.release && held!==undefined) { reply(held,{content:[{type:'text',text:JSON.stringify(identity())}]}); held=undefined; }
  reply(request.id,{content:[{type:'text',text:JSON.stringify(identity())}]});
});
rl.on('close',async ()=>{
  if(process.env.FIXTURE_MODE==='stubborn') return;
  if(process.env.EXIT_FILE) await fs.promises.writeFile(process.env.EXIT_FILE,'saved on EOF');
  process.exit(0);
});
`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled([...connections].map(connection => connection.close()));
  connections.clear();
  // Only fake processes whose identity the fixture returned can reach this fallback.
  for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  children.clear();
});
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function config(env: Record<string, string> = {}): Extract<AppServerConfig, { transport: 'stdio' }> {
  return { id: 'fixture', transport: 'stdio', command: process.execPath,
    args: [file, 'argument with spaces', '$(not-a-shell)'], cwd: directory, env: { DATA_TOKEN: secret, ...env } };
}
function connection(value = config()) { const result = new AppConnection(value); connections.add(result); return result; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function identity(current: AppConnection) {
  const client = await current.getClient();
  const result = await client.callTool({ name: 'identity', arguments: {} });
  const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
    pid: number; worker: number; cwd: string; args: string[]; authenticated: boolean; isolated: boolean;
  };
  children.add(payload.pid); children.add(payload.worker); return payload;
}
async function gone(...pids: number[]) {
  // OS exit/reaping is asynchronous; the bounded poll observes a real process,
  // it is not a sleep used to orchestrate a unit-test race.
  await expect.poll(() => pids.every(pid => !alive(pid)), { timeout: 2_000, interval: 20 }).toBe(true);
}

describe('owned stdio MCP processes', () => {
  it('initializes, discovers and calls tools, allows a final save on EOF, then reclaims the worker left by the launcher', async () => {
    vi.stubEnv('CINDY_OTHER_TOKEN', 'invalid-unrelated-host-secret');
    const finalSave = path.join(directory, 'final-save');
    const current = connection(config({ EXIT_FILE: finalSave, PROTOCOL_VALUE: '2025-11-25', TOOL_VALUE: 'identity', LOG_VALUE: 'info', RESOURCE_VALUE: 'fixture://result' }));
    const [first, second] = await Promise.all([current.getClient(), current.getClient()]);
    expect(first).toBe(second);
    const tools = await current.tools();
    expect(tools.map(tool => tool.name)).toEqual(['identity', 'echo_secret']);
    expect(tools[0]).toMatchObject({ description: '[redacted]', inputSchema: {
      properties: { description: { type: 'string', description: '[redacted]' } },
    } });
    const prompt = await first.getPrompt({ name: 'fixture' });
    expect(prompt).toMatchObject({ description: '[redacted]', messages: [
      { role: 'user', content: { type: 'text', text: 'Prompt: [redacted]' } },
      { role: 'user', content: { type: 'resource', resource: { uri: 'fixture://result', text: '[redacted]' } } },
    ] });
    const completion = await first.complete({ ref: { type: 'ref/prompt', name: 'fixture' }, argument: { name: 'query', value: '' } });
    expect(completion.completion).toEqual({ values: ['[redacted]'], total: 1 });
    const observed = await identity(current);
    expect(observed).toMatchObject({ authenticated: true, isolated: true, args: ['argument with spaces', '$(not-a-shell)'] });
    expect(await fs.realpath(observed.cwd)).toBe(await fs.realpath(directory));
    const notifications: unknown[] = [];
    const unlisten = current.listen(message => notifications.push(message));
    const echoed = await first.callTool({ name: 'echo_secret', arguments: {} });
    unlisten();
    expect(JSON.stringify(echoed)).not.toContain(secret);
    expect(JSON.stringify(echoed)).toContain('[redacted]');
    expect(echoed.content).toContainEqual({ type: 'resource', resource: { uri: 'fixture://result', mimeType: 'text/plain', text: '[redacted]' } });
    expect(notifications).toContainEqual(expect.objectContaining({ method: 'notifications/message', params: { level: 'info', data: '[redacted]' } }));
    await Promise.all([current.close(), current.close()]);
    expect(await fs.readFile(finalSave, 'utf8')).toBe('saved on EOF');
    await gone(observed.pid, observed.worker);
  });

  it('reclaims a worker after its launcher crashes and keeps the other connection usable', async () => {
    const first = connection();
    const second = connection();
    const [crashing, survivor] = await Promise.all([identity(first), identity(second)]);
    process.kill(crashing.pid, 'SIGKILL');
    await gone(crashing.pid, crashing.worker);
    expect((await identity(second)).pid).toBe(survivor.pid);
  });

  it.runIf(process.platform === 'win32')('preserves literal arguments through a Windows .cmd launcher', async () => {
    const script = path.join(directory, 'fixture launcher.cmd');
    await fs.writeFile(script, '@echo off\r\n@"%FIXTURE_NODE%" "%FIXTURE_SCRIPT%" %*\r\n');
    const args = ['', 'ends in a backslash \\', 'embedded"quote', '测试工具'];
    const current = connection({ ...config({ FIXTURE_NODE: process.execPath, FIXTURE_SCRIPT: file }), command: script, args });
    const observed = await identity(current);
    expect(observed.args).toEqual(args);
    await current.close();
    await gone(observed.pid, observed.worker);
  });

  it.each(['fail', 'hang', 'stubborn'])('reclaims %s initialization/closure paths without leaking error credentials', async mode => {
    const pidFile = path.join(directory, `${mode}.json`);
    const current = connection(config({ FIXTURE_MODE: mode, PID_FILE: pidFile }));
    const pending = current.getClient();
    const settled = pending.then(() => 'connected', (error: Error) => error.message);
    await expect.poll(() => fs.readFile(pidFile, 'utf8').then(value => JSON.parse(value), () => null), { timeout: 2_000, interval: 20 }).not.toBeNull();
    const observed = JSON.parse(await fs.readFile(pidFile, 'utf8'));
    children.add(observed.pid); children.add(observed.worker);
    if (mode === 'fail') {
      const error = await settled;
      expect(error).not.toContain(secret);
      expect(error).not.toBe('connected');
    } else if (mode === 'stubborn') await pending;
    await current.close();
    expect(await settled).not.toContain(secret);
    await gone(observed.pid, observed.worker);
  });

  it('keeps a released process while an App View owns it, then retires it with the last View', async () => {
    const owner = {};
    const current = connection();
    let saved = current.config;
    const host = new McpAppsHost({ owner: () => owner, config: () => saved,
      readCard: async () => record, writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {} });
    const connectionId = host.registerConnection(current);
    const record: import('../../../shared/mcpApps.js').McpAppRecord = { version: 1, serverId: current.config.id, serverRevision: host.serverRevision(current.config), connectionId,
      resourceUri: 'ui://fixture', tool: (await current.tools())[0]!, arguments: {}, result: { content: [] } };
    const observed = await identity(current);
    try {
      await host.open('renderer:fixture', 'fixture-task', 'fixture-card', {});
      saved = { ...config(), env: { DATA_TOKEN: 'updated-fixture-secret' } };
      await host.reconcileStdioConnections();
      await host.releaseConnection(current);
      expect((await identity(current)).pid).toBe(observed.pid);
      await host.releaseCaller('renderer:fixture');
      await gone(observed.pid, observed.worker);
    } finally { await host.reset(); }
  });

  it('keeps edited stdio snapshots, retires deleted ones and awaits repeated resets', async () => {
    const runtime = createMcpAppsRuntime();
    const owner = {};
    const a = connection();
    const b = connection({ ...config(), id: 'second' });
    const host = new McpAppsHost({ owner: () => owner, config: runtime.readAppServer,
      readCard: async () => { throw new Error('unused'); }, writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {} });
    runtime.setMcpAppsHost(host);
    runtime.registerAppServer(a.config.id, () => a.config);
    runtime.registerAppServer(b.config.id, () => b.config);
    host.registerConnection(a); host.registerConnection(b);
    const [first, other] = await Promise.all([identity(a), identity(b)]);
    runtime.registerAppServer(a.config.id, () => ({ id: a.config.id, transport: 'http', url: 'https://fixture.invalid' }));
    await runtime.reconcileStdioAppServers();
    expect((await identity(a)).pid).toBe(first.pid);
    runtime.clearAppServerConfigs();
    runtime.registerAppServer(b.config.id, () => b.config);
    await runtime.reconcileStdioAppServers();
    await gone(first.pid, first.worker);
    expect((await identity(b)).pid).toBe(other.pid);
    const firstReset = runtime.resetAppServers();
    await runtime.resetAppServers();
    expect(alive(other.pid)).toBe(false);
    await firstReset;
    await gone(other.pid, other.worker);
  });

  it('finishes a call across an edit, keeps the old facade snapshot and starts the next facade with new env', async () => {
    const runtime = createMcpAppsRuntime();
    const owner = {};
    const host = new McpAppsHost({ owner: () => owner, config: runtime.readAppServer,
      readCard: async () => { throw new Error('unused'); }, writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {} });
    runtime.setMcpAppsHost(host);
    const saved = config({ HOLD_FILE: path.join(directory, 'held-call') });
    runtime.registerAppServer(saved.id, () => saved);
    const createAppServerProxy = createAppServerProxyFactory(runtime);
    const peers: Array<{ client: Client; facade: ReturnType<typeof createAppServerProxy> }> = [];
    const connect = async () => {
      const facade = createAppServerProxy(() => runtime.readAppServer(saved.id)!, {
        agentKind: 'codex', sessionId: 'fixture-task', workingDir: '',
      });
      const client = new Client({ name: 'fixture-model', version: '1' });
      peers.push({ client, facade });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await facade.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    };
    const callIdentity = async (client: Client, args: Record<string, boolean> = {}) => {
      const result = await client.callTool({ name: 'identity', arguments: args });
      const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      children.add(value.pid); children.add(value.worker); return value;
    };
    try {
      const oldClient = await connect();
      const first = await callIdentity(oldClient);
      const pending = callIdentity(oldClient, { hold: true });
      await expect.poll(() => fs.readFile(saved.env.HOLD_FILE!, 'utf8').catch(() => ''), { timeout: 2_000, interval: 20 }).toBe('ready');
      saved.env.DATA_TOKEN = 'different-fixture-secret';
      await runtime.reconcileStdioAppServers();
      expect((await callIdentity(oldClient, { release: true })).pid).toBe(first.pid);
      expect(await pending).toMatchObject({ pid: first.pid, authenticated: true });
      const next = await callIdentity(await connect());
      expect(next.pid).not.toBe(first.pid);
      expect(next.authenticated).toBe(false);
      expect((await callIdentity(oldClient)).authenticated).toBe(true);
      runtime.registerAppServer(saved.id, () => { throw new Error('Invalid saved configuration'); });
      await runtime.reconcileStdioAppServers();
      await gone(first.pid, first.worker, next.pid, next.worker);
      runtime.registerAppServer(saved.id, () => saved);
      await expect(oldClient.listTools()).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    } finally {
      for (const peer of peers) { await peer.client.close(); await peer.facade.close(); }
      await runtime.resetAppServers();
    }
  });

  it('reports missing executables and invalid cwd using safe errors', async () => {
    await expect(connection({ ...config(), command: path.join(directory, 'missing-executable') }).getClient()).rejects.toThrow('MCP_STDIO_COMMAND_NOT_FOUND');
    await expect(connection({ ...config(), cwd: path.join(directory, 'missing-directory') }).getClient()).rejects.toThrow('MCP_STDIO_INVALID_CWD');
  });

  it('appends the user bin fallback and lets explicit PATH override the recovered host path', async () => {
    const bin = path.join(directory, '.local', 'bin');
    await fs.mkdir(bin, { recursive: true });
    expect((await stdioAppEnvironment({}, { PATH: '/fixture/system' }, 'darwin', directory)).PATH?.split(':')).toContain(bin);
    expect((await stdioAppEnvironment({ PATH: '/explicit' }, { PATH: '/fixture/system' }, 'darwin', directory)).PATH).toBe('/explicit');
  });
});
