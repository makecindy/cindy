/**
 * Production entry: the Desktop's AgentNetSocket on the native engine's Node module (packages/agent-net-native/node) against a
 * Desktop on the WASM core, through a real private relay on loopback HTTP/WS/UDP.
 * Basis: the Desktop moves its transport to the native engine (2026-11-23: same speed as WASM on shaped lines, 20–35% less CPU,
 * about 3× on loopback); peers on either engine must keep working with each other, the engine must take the Desktop's stored
 * keys (not only a seed, as on phones), and a module that is missing, does not load or comes up with another identity must
 * leave the Desktop on WASM rather than without Agent-Net.
 * Coverage gap: native.integration.test.ts loads the engine through its C ABI from Python, as a phone would; nothing loaded the
 * Node module, drove it from NativeTransport in Node, or chose between the engines in socket.ts.
 * Minimal failing input: a session request with a multi-megabyte result each way between the two engines; a binding path that
 * does not exist.
 * Tier: integration. Real sockets and a temporary relay directory; keys are generated in memory for the test only.
 * The native cases run when CINDY_AGENT_NET_NODE_BINDING names a built module (cargo build --release in
 * packages/agent-net-native/node, then the cdylib renamed to .node); the fallback case always runs.
 */
import { afterEach, expect, it } from 'vitest';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateNetwork, startAgentNetRelay, generateIdentity, createJoinRequest, approveJoin } from '@cindy/agent-net-relay';
import { AgentNetClient, submitJoin } from '@cindy/agent-net-relay/client';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { AgentNetSocket } from '../socket.js';
import { AgentNetWorkerSocket } from '../workerSocket.js';
import { NativeTransport } from '../nativeTransport.js';
import { loadNodeNativeBinding, type NodeNativeBinding } from '../nodeNativeEngine.js';

const binding = process.env.CINDY_AGENT_NET_NODE_BINDING;
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('UNTIL_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const transportOf = (socket: AgentNetSocket) => (socket as unknown as { transport: unknown }).transport;

/** A private relay, a computer on the WASM core (`a-wasm`) and one for the native engine (`b-native`); both keep stored keys. */
async function network() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-node-native-'));
  cleanups.push(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('cindy-agent-net-node-native-')) throw new Error('UNSAFE_TEST_DIRECTORY');
    await rm(directory, { recursive: true, force: true });
  });
  const owner = generateIdentity('a-wasm');
  const { root, bootstrap } = createPrivateNetwork('node native fixture', owner);
  const relay = await startAgentNetRelay({ dataDir: directory, bootstrap, udpPort: 0 });
  cleanups.push(() => relay.close());
  const udpServer = '127.0.0.1:' + relay.udpAddress!.port, userId = bootstrap.ownerCertificate.subject;
  const hostApi = new AgentNetClient(relay.url, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  const member = generateIdentity('b-native');
  const code = await hostApi.request<{ joinCode: string }>('POST', '/join-codes');
  const join = createJoinRequest(member, bootstrap.networkId, code.joinCode, 'Native computer', 'unit-public-pairing-fixture');
  await submitJoin(relay.url, join);
  const certificate = approveJoin(root, join, 'unit-public-pairing-fixture', bootstrap.ownerCertificate.subject);
  await hostApi.request('POST', '/join-requests/' + join.requestId + '/approve', { certificate });
  const memberApi = new AgentNetClient(relay.url, member, certificate, bootstrap.rootPublicKey);
  return { owner, member, hostApi, memberApi, udpServer, userId };
}
const hello = (socket: AgentNetSocket) => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello',
  payload: { deviceName: socket.deviceId, platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));

/** Both computers answer `test:echo` with its argument and `test:large` with a large result; returns the native side's session. */
async function serveSessions(wasm: AgentNetSocket, native: AgentNetSocket, results: { wasm: string; native: string }) {
  for (const [socket, large] of [[wasm, results.wasm], [native, results.native]] as const) {
    socket.useSessions({ laneFor: () => 'normal', handlers: (peer) => ({
      onOpen: (id) => { socket.session(peer)!.accept(id, { appVersion: socket.deviceId }); },
      onRequest: (request) => { socket.session(peer)!.respond(request.id, { ok: true, result: request.channel === 'test:large' ? large : request.args[0] }); },
    }) });
    hello(socket);
  }
}

// `direct`: both have UDP, so the candidates they exchange give them a direct path on this machine. `relayed`: the WASM computer
// has no UDP, so every packet goes through the relay: the native engine's over relay UDP, the other's over its relay WebSocket.
for (const route of ['direct', 'relayed'] as const) {
  it.skipIf(!binding)(`runs sessions and large results both ways between a computer on the native engine and one on WASM (${route})`, async () => {
    const net = await network();
    const fallbacks: string[] = [];
    const wasm = await AgentNetSocket.open({ client: net.hostApi, userId: net.userId, lanDiscovery: false, udp: route === 'direct',
      stunServers: [net.udpServer], relayUdpServer: net.udpServer });
    cleanups.push(() => wasm.close());
    const udpTraffic = new BigUint64Array(2);
    const native = await AgentNetSocket.open({ client: net.memberApi, userId: net.userId, lanDiscovery: false,
      stunServers: [net.udpServer], relayUdpServer: net.udpServer, udpTraffic,
      native: { binding: binding!, onFallback: code => fallbacks.push(code) } });
    cleanups.push(() => native.close());
    expect(fallbacks).toEqual([]);
    const transport = transportOf(native);
    expect(transport).toBeInstanceOf(NativeTransport);
    const results = { wasm: 'wasm-computer-result-'.repeat(120_000), native: 'native-computer-result-'.repeat(110_000) };
    await serveSessions(wasm, native, results);
    // The relay's STUN answered on the engine's own port, and relayed datagrams went over relay UDP once it acknowledged; the
    // connection page reads that route with its registration round trip (engine `relayRoute`).
    await until(() => (transport as NativeTransport).relayOverUdp);
    await until(() => native.relayRoute()?.via === 'udp' && typeof native.relayRoute()?.rttMs === 'number');
    await until(() => native.supports(net.owner.deviceId) && wasm.supports(net.member.deviceId));
    expect(await native.connectSession(net.owner.deviceId)).toBe(true);
    await until(() => !!native.session(net.owner.deviceId) && !!wasm.session(net.member.deviceId));
    const session = native.session(net.owner.deviceId)!;
    await expect(session.open({ controllerName: 'native' }, 5_000)).resolves.toEqual({ appVersion: 'a-wasm' });
    await expect(session.request('test:echo', ['hello'], { timeoutMs: 5_000 })).resolves.toEqual({ ok: true, result: 'hello' });
    if (route === 'direct') await until(() => native.peerSnapshot(net.owner.deviceId)?.path === 'direct' && wasm.peerSnapshot(net.member.deviceId)?.path === 'direct');
    await expect(session.request('test:large', [], { timeoutMs: 20_000 })).resolves.toEqual({ ok: true, result: results.wasm });
    await expect(wasm.session(net.member.deviceId)!.request('test:large', [], { timeoutMs: 20_000 }))
      .resolves.toEqual({ ok: true, result: results.native });
    expect(native.peerSnapshot(net.owner.deviceId)?.path).toBe(route === 'direct' ? 'direct' : 'relay');
    // The computer's UDP traffic meter counts the engine's socket: both results went over UDP, directly or through relay UDP.
    await until(() => Number(udpTraffic[0]) > results.native.length && Number(udpTraffic[1]) > results.wasm.length);
  }, 60_000);
}

it.skipIf(!binding)('keeps a computer on WASM when the native engine comes up with another identity', async () => {
  const net = await network();
  const fallbacks: string[] = [];
  // A module that ignored the keys it was given (or a mix-up of identities) would present a key no peer knows this device by.
  const real = loadNodeNativeBinding(binding!), other = generateIdentity('b-native');
  const raw = (key: import('node:crypto').KeyObject) => key.export({ format: 'jwk' }).d!;
  const swapped: NodeNativeBinding = { create: (options, wakePort) => real.create(JSON.stringify({ ...JSON.parse(options),
    keys: { transport: raw(other.transportPrivateKey), signing: raw(other.signingPrivateKey) } }), wakePort) };
  const socket = await AgentNetSocket.open({ client: net.memberApi, userId: net.userId, lanDiscovery: false,
    native: { binding: swapped, onFallback: code => fallbacks.push(code) } });
  cleanups.push(() => socket.close());
  expect(fallbacks).toEqual(['AGENT_NET_NATIVE_IDENTITY_MISMATCH']);
  expect(transportOf(socket)).not.toBeInstanceOf(NativeTransport);
}, 30_000);

it('keeps a computer on WASM, and reachable, when the native module does not load', async () => {
  const net = await network();
  const fallbacks: string[] = [];
  const wasm = await AgentNetSocket.open({ client: net.hostApi, userId: net.userId, lanDiscovery: false, udp: false });
  cleanups.push(() => wasm.close());
  const socket = await AgentNetSocket.open({ client: net.memberApi, userId: net.userId, lanDiscovery: false, udp: false,
    native: { binding: path.join(tmpdir(), 'cindy-agent-net-missing', 'agent-net.node'), onFallback: code => fallbacks.push(code) } });
  cleanups.push(() => socket.close());
  expect(fallbacks).toEqual(['AGENT_NET_NATIVE_FAILED']);
  expect(transportOf(socket)).not.toBeInstanceOf(NativeTransport);
  await serveSessions(wasm, socket, { wasm: 'w', native: 'n' });
  await until(() => socket.supports(net.owner.deviceId));
  expect(await socket.connectSession(net.owner.deviceId)).toBe(true);
  await until(() => !!socket.session(net.owner.deviceId));
  await expect(socket.session(net.owner.deviceId)!.open({ controllerName: 'fallback' }, 5_000)).resolves.toEqual({ appVersion: 'a-wasm' });
  await expect(socket.session(net.owner.deviceId)!.request('test:echo', ['ok'], { timeoutMs: 5_000 })).resolves.toEqual({ ok: true, result: 'ok' });
}, 30_000);

// The Desktop's own path: Main opens the Agent-Net worker (dist/node-worker.mjs, built by `node build.mjs`) with the module's
// path; the worker loads it, reports which engine it runs on, and Main logs a fallback with its reason.
for (const loads of [true, false]) {
  it.skipIf(loads && !binding)(`runs the Agent-Net worker on the ${loads ? 'native engine' : 'WASM core when the module does not load'} and reports it`, async () => {
    const net = await network();
    const module = await WebAssembly.compile(await readFile(new URL('../../../agent-net-core/dist/core.wasm', import.meta.url)));
    const wasm = await AgentNetSocket.open({ client: net.hostApi, userId: net.userId, lanDiscovery: false, udp: false });
    cleanups.push(() => wasm.close());
    const fallbacks: string[] = [], logged: string[] = [];
    const worker = await AgentNetWorkerSocket.open({ workerFile: new URL('../../dist/node-worker.mjs', import.meta.url),
      client: net.memberApi, userId: net.userId, module, lanDiscovery: false,
      log: { info: line => logged.push(line), warn: line => logged.push(line) },
      native: { binding: loads ? binding! : path.join(tmpdir(), 'cindy-agent-net-missing', 'agent-net.node'), onFallback: code => fallbacks.push(code) } });
    cleanups.push(() => worker.close());
    expect(worker.engineInUse()).toBe(loads ? 'native' : 'wasm');
    expect(fallbacks).toEqual(loads ? [] : ['AGENT_NET_NATIVE_FAILED']);
    expect(logged.some(line => line.includes(loads ? 'runs on the native engine' : 'native engine unavailable (AGENT_NET_NATIVE_FAILED)'))).toBe(true);
    wasm.useSessions({ laneFor: () => 'normal', handlers: (peer) => ({
      onOpen: (id) => { wasm.session(peer)!.accept(id, { appVersion: 'a-wasm' }); },
      onRequest: (request) => { wasm.session(peer)!.respond(request.id, { ok: true, result: request.args[0] }); },
    }) });
    worker.useSessions({ laneFor: () => 'normal', handlers: () => ({}) });
    await until(() => worker.supports(net.owner.deviceId));
    expect(await worker.connectSession(net.owner.deviceId)).toBe(true);
    await until(() => !!worker.session(net.owner.deviceId));
    await expect(worker.session(net.owner.deviceId)!.open({ controllerName: 'worker' }, 5_000)).resolves.toEqual({ appVersion: 'a-wasm' });
    await expect(worker.session(net.owner.deviceId)!.request('test:echo', ['through the worker'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ ok: true, result: 'through the worker' });
  }, 30_000);
}

// Node unloads a native module when the last worker that loaded it ends, while the threads the module started can still run its
// code (the pump thread for up to 250 ms, a relay or STUN name lookup for as long as DNS takes). In Electron 42 they came back to
// unmapped code and the whole process crashed (2026-11-23, exit code 139 between two rounds of the bulk benchmark, whose workers
// had both loaded the engine and ended). Node 24 unloads it the same way; the module pins itself (lib.rs `pin_module`).
it.skipIf(!binding)('keeps the native module loaded after the only worker that loaded it ends', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-pin-'));
  cleanups.push(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('cindy-agent-net-pin-')) throw new Error('UNSAFE_TEST_DIRECTORY');
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });
  // A copy of its own: no other test in this process has loaded this file.
  const copy = path.join(directory, 'agent-net.node');
  await copyFile(binding!, copy);
  const loaded = () => (process.report.getReport() as { sharedObjects: string[] }).sharedObjects
    .some(file => file.includes(path.basename(directory)));
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    const engine = require(workerData).create(JSON.stringify({ seed: Buffer.alloc(32, 9).toString('base64url'), context: 'pin', deviceId: 'pin' }), 9);
    engine.destroy(); parentPort.postMessage('created');`, { eval: true, workerData: copy });
  await new Promise(resolve => worker.once('message', resolve));
  expect(loaded()).toBe(true);
  await worker.terminate();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(loaded()).toBe(true);
}, 30_000);
