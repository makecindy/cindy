/** Behavior tier: the released Node worker ABI must run without Electron and
 * keep authorization replies off public stdio. A real child catches bootstrap,
 * FD framing, argv and lifecycle differences that injected processes cannot. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { createNativeNodeWorkerProcess } from './nativeProcess.js';
import type { NodeWorkerProcess } from './processTypes.js';
import { GhostNodeRuntimeBroker } from './nodeRuntimeBroker.js';
import type { NodeRuntimeInstallation } from './hostTypes.js';
import { NativePluginHost } from './nativeHost.js';
import { installedGhostStoragePart } from './shared/pluginIdentity.js';

describe('native plugin worker', () => {
  let directory: string, workerPath: string, snapshotWorkerPath: string;
  const children = new Set<NodeWorkerProcess>();
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-plugin-runtime-'));
    workerPath = path.join(directory, 'worker.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./nativeWorkerEntry.ts', import.meta.url))], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
    snapshotWorkerPath = path.join(directory, 'snapshot.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./nativeSnapshotWorker.ts', import.meta.url))], outfile: snapshotWorkerPath, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  });
  afterAll(async () => { for (const child of children) child.kill('SIGKILL'); await fs.rm(directory, { recursive: true, force: true }); });
  async function start(source: string, args?: string[]) {
    const entry = path.join(directory, `plugin-${children.size}.cjs`);
    await fs.writeFile(entry, source);
    const child = createNativeNodeWorkerProcess({ nodePath: process.execPath, workerPath }, entry, directory, 'synthetic-plugin', args);
    children.add(child);
    const lines: string[] = [];
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; lines.push(...output.split('\n').slice(0, -1)); output = output.split('\n').at(-1)!; });
    const ready = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Worker exited: ${code}`))); });
    await ready;
    return { child, lines, async line() { return new Promise<string>((resolve, reject) => {
      if (lines.length) { resolve(lines.shift()!); return; }
      let ended = false;
      const timer = setTimeout(() => { ended = true; reject(new Error('No worker reply')); }, 1500);
      const poll = () => { if (ended) return; if (lines.length) { clearTimeout(timer); resolve(lines.shift()!); } else setImmediate(poll); };
      setImmediate(poll);
    }); } };
  }
  it('runs unchanged stdio and request-scoped authorization over a private control FD', async () => {
    const { child, line } = await start(`
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', async raw => {
        const request = JSON.parse(raw);
        const authorize = globalThis.__CINDY_NODE__.bindAuthorization();
        const result = await authorize({kind:'device',url:'https://example.com/device',userCode:'TEST-1234'});
        process.stdout.write(JSON.stringify({id:request.id, privateResult:result.kind, leaked: typeof process.send !== 'undefined' || typeof process.channel !== 'undefined', hostSecret:process.env.CINDY_TEST_HOST_SECRET || null})+'\\n');
      });`);
    const control = new Promise<Record<string, unknown>>(resolve => child.onControl!(value => resolve(value as Record<string, unknown>)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'login', cindy: { cancelWithCall: true } }) + '\n');
    const message = await control;
    expect(message.type).toBe('plugin-authorize'); expect(message.rpcId).toBe('1');
    child.sendControl!({ type: 'plugin-authorize-result', reqId: message.reqId, ok: true, result: { kind: 'opened' } });
    expect(JSON.parse(await line())).toEqual({ id: '1', privateResult: 'opened', leaked: false, hostSecret: null });
    child.kill();
  });
  it('preserves raw child argv and binary stdin without granting delegation', async () => {
    const { child, line } = await start(`
      process.stdin.on('data', data => process.stdout.write(JSON.stringify({argv:process.argv.slice(2),data:data.toString('base64'),api:typeof globalThis.__CINDY_NODE__})+'\\n'));`, ['one', '二']);
    const bytes = Buffer.from([0, 255, 229, 0]); child.stdin.write(bytes.toString('base64'));
    expect(JSON.parse(await line())).toEqual({ argv: ['one', '二'], data: bytes.toString('base64'), api: 'undefined' });
    child.kill();
  });
  it('uses the shared broker for real Node RPC and revokes a changed owner', async () => {
    const entry = path.join(directory, 'broker-plugin.cjs');
    await fs.writeFile(entry, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.params})+'\\n');});`);
    const installed: NodeRuntimeInstallation = { dir: directory, enabled: true, manifest: { id: 'fixture', name: 'Fixture', node: { entry: 'broker-plugin.cjs', protocol: 'json-rpc-stdio' } } };
    let generation = 1;
    const spawnProcess = (entry: string, cwd: string, id: string, args?: string[]) => {
      const child = createNativeNodeWorkerProcess({ nodePath: process.execPath, workerPath }, entry, cwd, id, args);
      children.add(child); return child;
    };
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => installed, instanceId: () => 'fixture', spawnProcess, spawnChildProcess: spawnProcess,
      ownerScope: { capture: () => generation, isCurrent: value => value === generation, isStable: () => true },
      bindDeviceAuthorizationTarget: () => { throw new Error('Not declared by fixture'); },
      bindPluginAuthorizationTarget: () => { throw new Error('Not declared by fixture'); },
    });
    try {
      expect(await broker.handleRequest('fixture', { type: 'node-request', method: 'echo', params: { native: true } })).toEqual({ ok: true, result: { native: true } });
      generation++;
      // A new owner cannot use the old worker captured by its predecessor.
      const next = await broker.handleRequest('fixture', { type: 'node-request', method: 'echo', params: 'new-owner' });
      expect(next.ok).toBe(false);
    } finally { await broker.stopAndWait('fixture'); }
  });

  // Behavior tier: terminal vault reads wait for encrypted writes. Revoking the
  // owner during that await must never deliver the old account's key to a worker.
  it('awaits a native vault read and rejects owner changes before worker dispatch', async () => {
    const installed: NodeRuntimeInstallation = { dir: directory, enabled: true, manifest: {
      id: 'vault-fixture', name: 'Vault fixture', node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio',
        secretBindings: [{key:'api_key',label:'API key',methods:['echo']}] },
    } };
    let generation = 1, started = false;
    let release!: (value: string) => void;
    let reading!: () => void;
    const readStarted = new Promise<void>(resolve => { reading = resolve; });
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => installed, instanceId: () => 'vault-fixture',
      ownerScope: {capture: () => generation, isCurrent: value => value === generation, isStable: () => true},
      readSecret: async () => { reading(); return new Promise<string>(resolve => { release = resolve; }); },
      spawnProcess: () => { started = true; throw new Error('Revoked request must not start'); },
      spawnChildProcess: () => { throw new Error('Not declared'); },
      bindDeviceAuthorizationTarget: () => { throw new Error('Not declared'); },
      bindPluginAuthorizationTarget: () => { throw new Error('Not declared'); },
    });
    try {
      const pending = broker.handleRequest('vault-fixture', {type:'node-request',method:'echo',params:{}});
      await readStarted; generation++; release('synthetic-only-key');
      expect(await pending).toMatchObject({ok:false,errorCode:'PERMISSION_DENIED'});
      expect(started).toBe(false);
    } finally { broker.destroyAll(); }
  });

  it('loads an approved installed plugin and preserves receipts across native host restart', async () => {
    const root = path.join(directory, 'approved-store');
    const options = {
      manager: { getRootDir: () => path.join(root, 'content'), getStateDir: () => path.join(root, 'state') },
      node: { nodePath: process.execPath, workerPath, snapshotWorkerPath },
      broker: {},
      ...(process.env.CINDY_TEST_CHROMIUM ? {web: {
        executablePath: process.env.CINDY_TEST_CHROMIUM,
        mailRuntimeSource: await fs.readFile(new URL('./mailComposeRuntime.js', import.meta.url), 'utf8'),
        receive: async () => ({ok:false,errorCode:'UNSUPPORTED_CAPABILITY'}),
      }} : {}),
    };
    const archive = new JSZip();
    archive.file('ghost.json', JSON.stringify({ schemaVersion: 2, id: 'fixture', name: 'Fixture', version: '1.0.0', kind: 'chip', entry: 'main.js', slots: ['tool', 'node', 'skill'], tools: [{ name: 'echo', description: 'Echo' }], node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio', lifecycle: 'resident' }, skill: { items: [{ name: 'fixture-guide', description: 'Fixture guide', dir: 'skills/fixture-guide' }] } }));
    archive.file('main.js', `cindy.onHostMessage(async request => {
      const reply = await cindy.node.request({method:'echo',params:request.args,callId:request.callId,cancelWithCall:true});
      await cindy.send({type:'tool-result',callId:request.callId,ok:true,result:reply});
    });`);
    archive.file('skills/fixture-guide/SKILL.md', '---\nname: fixture-guide\ndescription: Fixture guide\n---\n\nUse the fixture.\n');
    archive.file('worker.cjs', `require('node:readline').createInterface({input:process.stdin}).on('line',raw=>{const r=JSON.parse(raw);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.params})+'\\n');});`);
    const file = path.join(directory, 'fixture.cindy'); await fs.writeFile(file, await archive.generateAsync({ type: 'nodebuffer' }));
    const first = new NativePluginHost(options);
    await first.open();
    try {
      const result = await first.manager.install(file);
      expect(result).not.toHaveProperty('rejection');
      await first.refresh();
      const ghost = first.list()[0];
      expect(ghost).toMatchObject({ enabled: true, approval: { state: 'approved' } });
      expect(await first.manager.verifyApprovedSkillSnapshot(ghost)).toBe(true);
      const id = installedGhostStoragePart(ghost);
      expect(first.node.stateOf(id)).toBe('running');
      expect(await first.handleNodeRequest(id, { type: 'node-request', method: 'echo', params: 'native-store' })).toEqual({ ok: true, result: 'native-store' });
      if (first.dispatcher) {
        expect(await first.dispatcher.callGhostTool({ghostId:id,tool:'echo',args:{browserToNode:true},timeoutMs:2000})).toEqual({ok:true,result:{ok:true,result:{browserToNode:true}}});
      }
      const revision = ghost.approval;
      await first.close();
      const second = new NativePluginHost({...options,deferStart:true});
      try {
        await second.open(); expect(second.list()[0].approval).toEqual(revision);
        await second.refresh();
        expect(second.node.stateOf(id)).toBe('off');
        await second.start();
        expect(second.node.stateOf(id)).toBe('running');
        expect(await second.handleNodeRequest(id,{type:'node-request',method:'echo',params:'after-host-composition'})).toEqual({ok:true,result:'after-host-composition'});
      }
      finally { await second.close(); }
    } finally { await first.close(); }
  });
});
