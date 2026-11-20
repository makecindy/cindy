/**
 * Agent-Net 基准的共用环境：本机 V2 中转 + 每台设备一条限速线路 + 两个真正的 DeviceLinkClient。
 *
 * 中转与限速线路默认在单独的进程里（network-process.ts），不受两台设备主线程上的卡顿影响。
 * 限速代理模拟每台设备到中转的接入线路：按速率排队、加单程延迟，排队超过上限时暂停读取，
 * 让发送方的 socket 缓冲真实地堵住（中转和 Main 的排队上限因此会生效）。不模拟丢包。
 * DeviceLinkClient 用生产默认计时，不覆盖重发和超时参数。
 *
 * 默认只在本机回环运行；`--remote-network <地址>:<端口>` 时中转与线路在另一台电脑上（network-process.ts 的 --listen），
 * 两台设备仍在本进程里，数据走两台电脑之间的真实线路。临时目录建在系统临时目录下并在结束时删除；
 * 身份和配对秘密只在内存里（压测专用、用完即弃），不读用户凭据。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPrivateNetwork, startAgentNetRelay, generateIdentity, createJoinRequest, approveJoin } from '@cindy/agent-net-relay';
import { AgentNetClient, submitJoin } from '@cindy/agent-net-relay/client';
import {
  DeviceLinkClient, PROTOCOL_VERSION, buildRelayJoinLink, createRelayJoinIdentity, createRelayPairSecret,
  createRelaySigningKey, issueRelayDeviceCert, parseRelayJoinLink, submitRelayPairRequest, verifyRelayPairProof, waitForRelayApproval,
  type InvokePayload, type RelayFetch,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto as relayCrypto } from '@cindy/device-link/node-relay-crypto';
import { createDeviceCredential, initializeRelay, startRelayServer } from '@cindy/device-link-relay';
import { AgentNetWorkerSocket, type AgentNetAppSocket } from '../src/workerSocket.js';
import { AgentNetSocket } from '../src/socket.js';
import { LinkDirection, startShapedProxy, startUdpProxy, type LinkProfile } from './network.js';
import { resolveInvokePriority } from '../../device-link/src/invokePolicy.js';
import type { SessionLane } from '../src/session/lanes.js';
export type { LinkProfile } from './network.js';


export const PROFILES: Record<string, LinkProfile> = {
  /** 对照：本机回环不限速，区分「线路慢」和「协议本身慢」。 */
  unshaped: { name: 'unshaped', rateBytesPerSec: 1_000_000_000, oneWayDelayMs: 0, queueLimitBytes: 64 * 1024 * 1024 },
  /** 真实线路（配 --remote-network）：不再加限速和延迟，速度、往返与抖动都来自两台电脑之间的实际网络。 */
  real: { name: 'real', rateBytesPerSec: 1_000_000_000, oneWayDelayMs: 0, queueLimitBytes: 64 * 1024 * 1024 },
  fast: { name: 'fast', rateBytesPerSec: 1_000_000, oneWayDelayMs: 20, queueLimitBytes: 256 * 1024 },
  'fast-jitter': { name: 'fast-jitter', rateBytesPerSec: 1_000_000, oneWayDelayMs: 20, queueLimitBytes: 256 * 1024, jitterMs: 30 },
  slow: { name: 'slow', rateBytesPerSec: 250_000, oneWayDelayMs: 50, queueLimitBytes: 128 * 1024 },
  'very-slow': { name: 'very-slow', rateBytesPerSec: 64_000, oneWayDelayMs: 100, queueLimitBytes: 64 * 1024 },
  /** 家宽：每秒 12.5 MB（100 Mbit/s），端到端往返约 32 毫秒（两段各 8 毫秒单程），队列 40 毫秒。 */
  wide: { name: 'wide', rateBytesPerSec: 12_500_000, oneWayDelayMs: 8, queueLimitBytes: 500 * 1024 },
  /** 跨地区：每秒 6.25 MB（50 Mbit/s），端到端往返约 200 毫秒，队列 100 毫秒。 */
  far: { name: 'far', rateBytesPerSec: 6_250_000, oneWayDelayMs: 50, queueLimitBytes: 625 * 1024 },
};

/** 小请求用真实的交互类业务通道名，控制端调度按交互类放行；被控端这里不执行业务，只回显。 */
export const TAP_CHANNEL = 'maker:input:stop';
/** 大消息用前台读取的通道名，形状对应日志里的大任务列表结果。 */
export const BULK_CHANNEL = 'local-db:sessions:list';
export const BULK_BYTES = 1024 * 1024;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** `--log`：把 Device Link 与 Agent-Net 的 info/warn 日志带相对时间打到 stderr。 */
const TRACE = process.argv.includes('--log');
const traceStart = performance.now();
export function trace(role: string, level: string, message: unknown): void {
  if (!TRACE) return;
  console.error(`[${((performance.now() - traceStart) / 1000).toFixed(1)}s][${role}][${level}] ${String(message)}`);
}


/** 一个方向线路上的计量：总字节（含各层重发）、其中走 UDP 的字节、尾部丢弃的包数。 */
export interface MeterView { readonly bytes: number; readonly udpBytes: number; readonly dropped: number }
export interface Meters { hostUp: MeterView; hostDown: MeterView; controllerUp: MeterView; controllerDown: MeterView }

/**
 * 中转与限速线路。默认放在单独的进程里（network-process.ts）：两台设备的 Device Link 在本进程主线程上处理大消息时
 * 事件循环会卡几十毫秒，线路和中转也在这里的话，转发的包跟着被推迟，往返一阵一阵地跳，被拥塞控制当成排队；
 * 真实部署里中转在服务器上。`--in-process-network` 改回本进程，复现 2026-11-14 之前的数字。
 */
interface BenchNetwork {
  meters: Meters;
  /** 读一份最新的计量（单独进程时计量每 50 毫秒推一次，算总量前要同步）。 */
  syncMeters(): Promise<void>;
  agentNetRelay(dataDir: string, bootstrap: Parameters<typeof startAgentNetRelay>[0]['bootstrap']): Promise<{ url: string; udpPort: number | null }>;
  /** 原来的 Device Link 中转：在网络所在的那一边初始化并启动。localUrl 给管理请求用，port 是中转自己的端口（给线路代理）。 */
  v1Relay(dataDir: string, init: V1RelayInit): Promise<{ localUrl: string; port: number }>;
  proxyFor(relayPort: number): Promise<{ host: string; controller: string }>;
  udpProxyFor(relayUdpPort: number): Promise<{ host: string; controller: string }>;
}

type V1RelayInit = Omit<Parameters<typeof initializeRelay>[0], 'dataDir'>;

function inProcessNetwork(profile: LinkProfile, cleanup: Array<() => Promise<unknown> | unknown>): BenchNetwork {
  const meters = {
    hostUp: new LinkDirection(profile), hostDown: new LinkDirection(profile),
    controllerUp: new LinkDirection(profile), controllerDown: new LinkDirection(profile),
  };
  return {
    meters,
    syncMeters: async () => undefined,
    async agentNetRelay(dataDir, bootstrap) {
      const relay = await startAgentNetRelay({ dataDir, bootstrap, udpPort: 0 });
      cleanup.push(() => relay.close());
      return { url: relay.url, udpPort: relay.udpAddress?.port ?? null };
    },
    async v1Relay(dataDir, init) {
      await initializeRelay({ ...init, dataDir });
      const relay = await startRelayServer({ dataDir, port: 0 });
      cleanup.push(() => relay.close());
      return { localUrl: relay.localUrl, port: Number(new URL(relay.localUrl).port) };
    },
    async proxyFor(relayPort) {
      const hostProxy = await startShapedProxy(relayPort, meters.hostUp, meters.hostDown);
      const controllerProxy = await startShapedProxy(relayPort, meters.controllerUp, meters.controllerDown);
      cleanup.push(() => hostProxy.close(), () => controllerProxy.close());
      return { host: `http://127.0.0.1:${hostProxy.port}`, controller: `http://127.0.0.1:${controllerProxy.port}` };
    },
    async udpProxyFor(relayUdpPort) {
      const hostProxy = await startUdpProxy(relayUdpPort, meters.hostUp, meters.hostDown);
      const controllerProxy = await startUdpProxy(relayUdpPort, meters.controllerUp, meters.controllerDown);
      cleanup.push(() => hostProxy.close(), () => controllerProxy.close());
      return { host: `127.0.0.1:${hostProxy.port}`, controller: `127.0.0.1:${controllerProxy.port}` };
    },
  };
}

/** 网络进程的指令通道：本机 fork 出来的子进程（IPC），或另一台电脑上的 network-process.ts --listen（TCP 上一行一条 JSON）。 */
interface NetworkChannel { send(message: unknown): void; onMessage(listener: (message: any) => void): void; close(): void }

function forkedChannel(): NetworkChannel {
  const child = fork(fileURLToPath(new URL('./network-process.ts', import.meta.url)), [], { execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return {
    send: (message) => child.send(message as never),
    onMessage: (listener) => child.on('message', listener),
    close: () => { if (child.exitCode === null) child.kill(); },
  };
}

async function remoteChannel(address: string): Promise<NetworkChannel> {
  const at = address.lastIndexOf(':');
  const socket = net.connect(Number(address.slice(at + 1)), address.slice(0, at));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.setNoDelay(true);
  const listeners: Array<(message: any) => void> = [];
  let buffered = '';
  socket.on('data', (data) => {
    buffered += data.toString('utf8');
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (line) { const message = JSON.parse(line); for (const listener of listeners) listener(message); }
    }
  });
  socket.on('error', () => undefined);
  return { send: (message) => socket.write(JSON.stringify(message) + '\n'), onMessage: (listener) => listeners.push(listener), close: () => socket.destroy() };
}

async function processNetwork(profile: LinkProfile, cleanup: Array<() => Promise<unknown> | unknown>): Promise<BenchNetwork> {
  const remote = argument('--remote-network');
  const child = remote ? await remoteChannel(remote) : forkedChannel();
  const empty = () => ({ bytes: 0, udpBytes: 0, dropped: 0 });
  const meters: Meters = { hostUp: empty(), hostDown: empty(), controllerUp: empty(), controllerDown: empty() };
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 0;
  child.onMessage((message: { id?: number; ok?: boolean; result?: unknown; error?: string; meters?: Meters }) => {
    if (message.meters) { Object.assign(meters, message.meters); return; }
    const entry = message.id === undefined ? undefined : waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id!);
    if (message.ok) entry.resolve(message.result); else entry.reject(new Error(message.error));
  });
  const call = <T>(op: string, args: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    child.send({ id, op, ...args });
  });
  cleanup.push(async () => {
    await Promise.race([call('close'), sleep(5_000)]).catch(() => undefined);
    child.close();
  });
  // --no-line（只配 --remote-network）：不经线路代理，设备直接连另一台电脑上的中转；没有计量。
  await call('init', { profile, direct: !!remote && process.argv.includes('--no-line') });
  return {
    meters,
    async syncMeters() { Object.assign(meters, await call<Meters>('meters')); },
    agentNetRelay: (dataDir, bootstrap) => call('agent-net-relay', { dataDir, bootstrap }),
    v1Relay: (dataDir, init) => call('v1-relay', { dataDir, init }),
    proxyFor: (relayPort) => call('tcp', { relayPort }),
    udpProxyFor: (relayUdpPort) => call('udp', { relayUdpPort }),
  };
}

/**
 * `worker`：Desktop 生产用的 AgentNetWorkerSocket（传输在独立线程，Main 代理中转连接）。
 * `portable`：同一份传输逻辑跑在当前线程（手机等使用的形态），用来区分线程间转发的开销，也能直接读核心统计。
 * `v1`：不用 Agent-Net，两台设备经原来的 Device Link 中转（生产的自建中转内核 `@cindy/device-link-relay`）。
 *       设备不加签名，和经官方中转时的线上行为一样（中转只转发签名字段、不要求签名）。
 * `udp-relay`：同 `worker`，但打开 UDP、中转转发走 UDP（relayUdp.ts）；只交换公网候选地址，本机回环上不会打通直连，
 *       所以数据仍经中转，只是从 443 WebSocket 换成 UDP。
 * `session`：同 `udp-relay` 的线路与中转，但两台节点之间走 Agent-Net 自建的会话层（src/session/），不经过 DeviceLinkClient；
 *       当前线程形态。docs/agent-net-session-plan.md 第 10.1 节。
 * `worker-session`：同 `session`，但和 Desktop 一样会话跑在 Agent-Net 的 worker 里（session/workerSessions.ts），
 *       核心和会话层的收发不和这里的业务代码抢同一个线程。
 */
export type SocketMode = 'worker' | 'portable' | 'v1' | 'udp-relay' | 'session' | 'worker-session';

/** 一台设备怎么连上「中转」：返回 DeviceLinkClient 要的连接参数。 */
interface DeviceConnection {
  getWsUrl(): string;
  getToken(): Promise<string>;
  authorizationScheme?: 'CindyRelay';
  open(url: string, headers: Record<string, string>): Promise<AgentNetAppSocket>;
}

async function startAgentNetNetwork(directory: string, network: BenchNetwork, module: WebAssembly.Module, mode: Exclude<SocketMode, 'v1'>) {
  const owner = generateIdentity('a-host');
  const { root, bootstrap } = createPrivateNetwork('bench network', owner);
  const relay = await network.agentNetRelay(directory, bootstrap);
  const base = await network.proxyFor(Number(new URL(relay.url).port));
  // 中转在另一台电脑上时走明文 http（压测专用的私有网络、用完即弃），按自建中转的「主人钉住的 http」放行；本机回环本来就放行。
  const transport = argument('--remote-network') ? { ownerPinnedHttp: true } : {};
  const a = new AgentNetClient(base.host, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey, undefined, transport);
  const member = generateIdentity('b-controller');
  const code = await a.request<{ joinCode: string }>('POST', '/join-codes');
  const join = createJoinRequest(member, bootstrap.networkId, code.joinCode, 'Controller', 'bench-only-pairing-secret');
  await submitJoin(base.controller, join, transport);
  const certificate = approveJoin(root, join, 'bench-only-pairing-secret', bootstrap.ownerCertificate.subject);
  await a.request('POST', '/join-requests/' + join.requestId + '/approve', { certificate });
  const b = new AgentNetClient(base.controller, member, certificate, bootstrap.rootPublicKey, undefined, transport);
  const workerFile = new URL('../dist/node-worker.mjs', import.meta.url);
  const udpServers = mode === 'udp-relay' || mode === 'session' || mode === 'worker-session' ? await network.udpProxyFor(relay.udpPort!) : null;
  const connect = (api: AgentNetClient, role: 'host' | 'controller'): DeviceConnection => ({
    getWsUrl: () => 'ws://local-node.invalid',
    getToken: async () => 'local-node-marker',
    open: async () => {
      const log = { info: (message: string) => trace(role, 'agent-net', message), warn: (message: string) => trace(role, 'agent-net warn', message) };
      const transport = udpServers
        // 中转的 UDP 端口经这台设备自己的限速线路；STUN 也走它，查到的是本机回环地址，会被「只交换公网地址」滤掉。
        ? { udp: true, publicCandidatesOnly: true, relayUdpServer: udpServers[role], stunServers: [udpServers[role]] }
        : { udp: false };
      const options = { client: api, userId: bootstrap.ownerCertificate.subject, module,
        // 中转在另一台电脑上时 UDP 要能发出本机；只交换公网候选地址，局域网与 VPN 地址照样被滤掉，数据仍经中转。
        bindAddress: argument('--remote-network') ? '0.0.0.0' : '127.0.0.1', lanDiscovery: false, ...transport };
      return mode === 'portable' || mode === 'session' ? AgentNetSocket.open(options) : AgentNetWorkerSocket.open({ ...options, workerFile, log });
    },
  });
  return { host: connect(a, 'host'), controller: connect(b, 'controller') };
}

/** 与 `packages/device-link-relay/scripts/run-interop.ts` 相同的加入流程：加入码 → 申请 → 主人核对证明并同意。 */
async function startV1Network(directory: string, network: BenchNetwork) {
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(relayCrypto);
  const relayId = randomUUID();
  const relay = await network.v1Relay(directory, {
    name: 'Bench relay', ownerUserId: 'bench-account', ownerDeviceId: 'a-host', ownerDeviceName: 'a-host',
    ownerCredentialHash: owner.credentialHash, relayId, ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(relayCrypto, ownerKey.seed, { relayId, deviceId: 'a-host', publicKey: ownerKey.publicKey, role: 'owner', issuedAt: Date.now() }),
  });
  const direct = relay.localUrl;
  const admin = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(direct + pathname, { method, headers: { authorization: `CindyRelay ${owner.credential}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`V1_RELAY_ADMIN_FAILED ${method} ${pathname} ${response.status}`);
    return response.json() as Promise<Record<string, any>>;
  };
  const { code } = await admin('POST', '/api/device-link/relay/admin/join-codes');
  const pairSecret = createRelayPairSecret(relayCrypto);
  const link = parseRelayJoinLink(buildRelayJoinLink({ baseUrl: direct, code, ownerPublicKey: ownerKey.publicKey, pairSecret, app: 'cindy' }))!;
  const relayFetch: RelayFetch = (url, init) => fetch(url, init);
  const identity = createRelayJoinIdentity(relayCrypto, link, relayId, 'b-controller');
  const request = await submitRelayPairRequest(relayFetch, link, { deviceId: 'b-controller', deviceName: 'b-controller', platform: 'test',
    appVersion: 'bench', accountUserId: 'bench-account', publicKey: identity.publicKey, proof: identity.proof });
  const approval = waitForRelayApproval(relayFetch, link, request, { deadlineMs: 30_000 });
  const { requests } = await admin('GET', '/api/device-link/relay/admin/pair-requests');
  const pending = (requests as Array<Record<string, string>>).find((entry) => entry.requestId === request.requestId)!;
  if (!verifyRelayPairProof(relayCrypto, pairSecret, { relayId, deviceId: 'b-controller', publicKey: pending.publicKey, proof: pending.proof })) {
    throw new Error('V1_RELAY_PAIRING_PROOF_MISMATCH');
  }
  await admin('POST', `/api/device-link/relay/admin/pair-requests/${request.requestId}/approve`, {
    cert: issueRelayDeviceCert(relayCrypto, ownerKey.seed, { relayId, deviceId: 'b-controller', publicKey: pending.publicKey, role: 'member', issuedAt: Date.now() }),
  });
  const admitted = await approval;
  const base = await network.proxyFor(relay.port);
  const connect = (proxyBase: string, credential: string): DeviceConnection => ({
    getWsUrl: () => proxyBase.replace(/^http/, 'ws') + '/api/device-link/ws',
    getToken: async () => credential,
    authorizationScheme: 'CindyRelay',
    open: async (url, headers) => new WebSocket(url, { headers }) as unknown as AgentNetAppSocket,
  });
  return { host: connect(base.host, owner.credential), controller: connect(base.controller, admitted.credential) };
}

export async function setup(profile: LinkProfile, module: WebAssembly.Module, mode: SocketMode = 'worker') {
  const cleanup: Array<() => Promise<unknown> | unknown> = [];
  const prefix = path.join(tmpdir(), 'cindy-agent-net-bench-');
  const directory = await mkdtemp(prefix);
  cleanup.push(async () => {
    if (!path.resolve(directory).startsWith(prefix)) throw new Error('UNSAFE_BENCH_DIRECTORY');
    await rm(directory, { recursive: true, force: true });
  });
  if (process.argv.includes('--in-process-network') && argument('--remote-network')) throw new Error('--in-process-network and --remote-network exclude each other');
  const network = process.argv.includes('--in-process-network') ? inProcessNetwork(profile, cleanup) : await processNetwork(profile, cleanup);
  const meters = network.meters;
  const devices = mode === 'v1'
    ? await startV1Network(directory, network)
    : await startAgentNetNetwork(directory, network, module, mode);

  if (mode === 'session' || mode === 'worker-session') return sessionFixture(devices, network, cleanup);
  const diagnostics = { warnings: 0, headRetries: 0 };
  const sockets = new Map<string, AgentNetAppSocket>();
  const make = (device: DeviceConnection, role: string, remoteControlEnabled: boolean) => {
    const client = new DeviceLinkClient({
      getWsUrl: device.getWsUrl,
      getToken: device.getToken,
      ...(device.authorizationScheme ? { authorizationScheme: device.authorizationScheme } : {}),
      // 和 Desktop 一样：经 Agent-Net 时声明下层逐对端可靠(apps/desktop/src/main/device-link/index.ts)。
      ...(mode !== 'v1' ? { reliablePeerTransport: () => true } : {}),
      getHello: () => ({ deviceName: role === 'host' ? 'a-host' : 'b-controller', platform: 'test', appVersion: 'bench', remoteControlEnabled, busy: false }),
      createWebSocket: async (url, headers) => {
        const socket = await device.open(url, headers);
        sockets.set(role, socket);
        return socket;
      },
      logger: {
        debug: (message: unknown) => {
          if (String(message).startsWith('reliable head retry')) diagnostics.headRetries++;
          trace(role, 'debug', message);
        },
        info: (message: unknown) => trace(role, 'info', message),
        warn: (message: unknown) => { diagnostics.warnings++; trace(role, 'warn', message); },
        error: (message: unknown) => { diagnostics.warnings++; trace(role, 'error', message); },
      },
    });
    cleanup.push(() => client.stop());
    client.start();
    return client;
  };
  const host = make(devices.host, 'host', true);
  const controller = make(devices.controller, 'controller', false);
  await Promise.all([host.waitUntilOnline(10_000), controller.waitUntilOnline(10_000)]);

  const bulkPayload = randomBytes(Math.ceil((BULK_BYTES * 3) / 4)).toString('base64').slice(0, BULK_BYTES);
  const hostReceivedAt = new Map<string, number>();
  host.onFrame((env) => {
    if (!env.src || !env.id) return;
    if (env.kind === 'link-open') { host.sendLinkAccept(env.src, env.id, { appVersion: 'bench', allowlistHash: 'bench' }); return; }
    if (env.kind !== 'invoke') return;
    const { channel, args } = env.payload as InvokePayload;
    if (channel === TAP_CHANNEL) {
      hostReceivedAt.set(String(args[0]), performance.now());
      host.sendInvokeResult(env.src, env.id, { ok: true, result: args[0] });
    } else if (channel === BULK_CHANNEL) {
      // ['down'] 回整条大消息；['down', 字节数] 回这么长的一块（按块拉取，见 bulk-transfer.ts）。
      const size = typeof args[1] === 'number' ? args[1] : BULK_BYTES;
      host.sendInvokeResult(env.src, env.id, { ok: true, result: args[0] === 'up' ? 'stored' : bulkPayload.slice(0, size) });
    }
  });
  const openPayload = { controllerName: 'bench', protocolVersion: PROTOCOL_VERSION, appVersion: 'bench' };
  await controller.openLink('a-host', openPayload);
  // 和 Desktop 控制端一样（apps/desktop/src/main/device-link/index.ts 的远程调用前）：链路需要恢复时先重新建链再发请求。
  let reopening: Promise<void> | null = null;
  const ensureLink = async () => {
    if (!controller.needsLinkRecovery('a-host')) return;
    reopening ??= controller.openLink('a-host', openPayload).then(() => undefined).finally(() => { reopening = null; });
    await reopening;
  };
  return {
    host, controller, meters, diagnostics, hostReceivedAt, bulkPayload,
    /** 读一份最新的线路计量，算一段的总字节前调用。 */
    syncMeters: () => network.syncMeters(),
    /** 控制端发一个请求，带上 Desktop 的建链恢复。`background`：同业务调用的后台提示（远程任务的上传块）。 */
    async request(payload: InvokePayload, timeoutMs: number | undefined, options?: { background?: boolean }) {
      await ensureLink();
      return controller.invoke('a-host', payload, timeoutMs, options?.background ? { background: true } : undefined);
    },
    socket(role: 'host' | 'controller'): AgentNetAppSocket {
      const value = sockets.get(role);
      if (!value) throw new Error('BENCH_SOCKET_MISSING ' + role);
      return value;
    },
    async close() { for (const dispose of cleanup.splice(0).reverse()) { try { await dispose(); } catch { /* best effort */ } } },
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * `session` 方式的环境：两台节点只用 Agent-Net 的会话层，被控端和 Device Link 方式回同样的结果（小请求回显、大消息回
 * 同样大小的数据）。返回和 Device Link 方式同样形状的对象，脚本不用分两套；`host`/`controller` 在这个方式下不可用。
 */
async function sessionFixture(devices: { host: DeviceConnection; controller: DeviceConnection }, network: BenchNetwork,
  cleanup: Array<() => Promise<unknown> | unknown>) {
  const laneFor = (channel: string, background?: boolean): SessionLane => {
    const priority = resolveInvokePriority(channel, background);
    return priority === 'interactive' ? 'control' : priority === 'background' ? 'background' : 'normal';
  };
  const host = await devices.host.open('', {}) as unknown as AgentNetSocket;
  const controller = await devices.controller.open('', {}) as unknown as AgentNetSocket;
  cleanup.push(() => host.close(), () => controller.close());
  const bulkPayload = randomBytes(Math.ceil((BULK_BYTES * 3) / 4)).toString('base64').slice(0, BULK_BYTES);
  const hostReceivedAt = new Map<string, number>();
  host.useSessions({ laneFor, handlers: () => ({
    onOpen: (id) => { host.session('b-controller')?.accept(id, { appVersion: 'bench', allowlistHash: 'bench' }); },
    onRequest: (request) => {
      const session = host.session('b-controller');
      if (!session) return;
      if (request.channel === TAP_CHANNEL) {
        hostReceivedAt.set(String(request.args[0]), performance.now());
        session.respond(request.id, { ok: true, result: request.args[0] });
      } else if (request.channel === BULK_CHANNEL) {
        const size = typeof request.args[1] === 'number' ? request.args[1] : BULK_BYTES;
        session.respond(request.id, { ok: true, result: request.args[0] === 'up' ? 'stored' : bulkPayload.slice(0, size) });
      }
    },
  }) });
  controller.useSessions({ laneFor, handlers: () => ({}) });
  for (const [socket, name] of [[host, 'a-host'], [controller, 'b-controller']] as const) {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: name, platform: 'test', appVersion: 'bench', remoteControlEnabled: name === 'a-host', busy: false } }));
  }
  const deadline = performance.now() + 10_000;
  while (!controller.knowsPeer('a-host') && performance.now() < deadline) await sleep(20);
  // 同一线程的节点可以直接拨号；worker 里的节点在发往对端的第一帧时自己去连。
  if (typeof controller.dial === 'function') await controller.dial('a-host');
  else controller.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'a-host', payload: { channel: 'bench:connect', payload: null } }));
  while ((!controller.session('a-host') || !host.session('b-controller')) && performance.now() < deadline) await sleep(20);
  const session = controller.session('a-host');
  if (!session) throw new Error('BENCH_SESSION_NOT_ESTABLISHED');
  await session.open({ controllerName: 'bench', appVersion: 'bench' }, 10_000);
  return {
    host: null as unknown as DeviceLinkClient, controller: null as unknown as DeviceLinkClient,
    meters: network.meters, diagnostics: { warnings: 0, headRetries: 0 }, hostReceivedAt, bulkPayload,
    syncMeters: () => network.syncMeters(),
    async request(payload: InvokePayload, timeoutMs: number | undefined, options?: { background?: boolean }) {
      const current = controller.session('a-host');
      if (!current) return { ok: false as const, error: { code: 'DEVICE_OFFLINE', message: 'no session' } };
      return current.request(payload.channel, payload.args ?? [], { timeoutMs, ...(options?.background ? { background: true } : {}) });
    },
    socket(role: 'host' | 'controller'): AgentNetAppSocket { return (role === 'host' ? host : controller) as unknown as AgentNetAppSocket; },
    async close() { for (const dispose of cleanup.splice(0).reverse()) { try { await dispose(); } catch { /* best effort */ } } },
  };
}
