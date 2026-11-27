/**
 * 生产入口：AgentNetWorkerSocket.open + worker 请求 Main 建立网络 ws（ws-open）。
 * Bug：#10270 —— 系统唤醒重连丢弃这条加密连接时，异步工厂才返回的 ws 仍处于 CONNECTING，
 * 未挂 error 监听就被 terminate()，ws 下一 tick 派发的 error 变成 Main 的 uncaughtException。
 * 现有覆盖缺口：socket.integration.test.ts 的工厂是同步的，从不在建连途中关闭。
 * 最小失败输入：worker 发出 ws-open → 工厂未返回时 terminate() → 工厂返回 CONNECTING ws。
 * tier：unit，内联最小 worker 与本机回环 TCP（只接受连接不回握手，保证停在 CONNECTING）。
 *
 * 中继连接保活（同一生产入口，ws 由 Main 建立后开始 ping）：
 * Bug：2026-11-13 一台 Mac 到 Agent-Net 中继的连接「能收不能发」，device-link 心跳在 worker 内
 * 就地应答、从不经过中继，察觉不到；对端互判离线 9 / 15 分钟，重连后 1 秒内恢复。
 * 可观察结果：中继不回 pong 时 Main 断开这条 ws（中继侧看到关闭，交由 worker 既有重连）并记一条
 * 警告；中继正常回 pong 时，超过超时时长也不断开。
 * 现有覆盖缺口：此前 Main 侧没有任何中继连接活性判断，相邻用例只覆盖建连途中关闭。
 * 最小失败输入：本机中继 autoPong=false，连接打开后保持沉默超过 timeoutMs。
 * tier：unit，本机回环真实 WebSocket，间隔压到毫秒级（整文件约 1 秒内）。
 *
 * 中继发送排队上限（同一生产入口，worker 经 ws-send 让 Main 写数据报）：
 * Bug：2026-11-13 17:23–17:35 一台对端的中继路径变慢，TCP 连接只排队不丢包，确认等到 156 秒，
 * 传输核心的重发又排在原数据后面，结果和请求迟到几分钟才送达、执行。
 * 可观察结果：中继停止读取、最早一笔写入等待超过上限后，之后的数据报不再写进连接（中继恢复读取后
 * 收不到），并记一条警告；队列重新流动后恢复写入；停顿前正常写入的数据报一个不少。
 * 现有覆盖缺口：此前只有 1 MiB 字节上限，慢连接上在到达它之前已经排了几分钟。
 * 最小失败输入：中继暂停读取，填满系统缓冲直到本进程开始排队（仍远低于 1 MiB），等待超过上限后再发几个数据报。
 *
 * 中转连接状态（同一生产入口，Desktop 据此在设置页说明「连不上中转」）：中转连接打开时报连着并马上测一次往返（远程连接页显示），
 * 中转断开后报断开并发一次事件。
 * Bug：2026-11-17 审查，中转断了连接本身还开着，设置页一直显示已连接。最小失败输入：连上后中转关掉这条连接。
 *
 * 换网后的探测（同一生产入口，Desktop 的网络监听调 networkChanged）：
 * Bug：2026-11-17 审查，换网的通知到不了 Agent-Net（Device Link 的探测在那条连接里由本机回答），中转连接要等 45 秒的保活才换。
 * 可观察结果：换网后中转在探测时限内不回 pong，Main 断开这条 ws 并记一条警告；常规保活此时还远没到。
 * 最小失败输入：中转 autoPong=false、常规保活设成很长，连接打开后换网一次。
 *
 * 经中转的数据报走 UDP 还是 WebSocket（同一生产入口，worker 的状态快照带上它，Desktop 远程连接页写在中转点上）：
 * Bug：2026-11-18 用户反馈，拓扑看不出中转走的是 Agent-Net 的 UDP、WS 还是 Device Link，延迟一直是 WebSocket 心跳的。
 * 可观察结果：`relayRoute()` 给出走法和那条路的往返（UDP 用 worker 报的、WebSocket 用心跳的），切换时发 `relay-route`
 * 并记一行日志，往返刷新不算切换，中转断开后为 null。现有覆盖缺口：此前 Main 只有心跳往返。
 * 最小失败输入：worker 先后报 UDP（两次不同往返）、WebSocket，再关掉中转。
 *
 * 对端走直连还是中转（同一生产入口，worker 的 `path` 消息与状态快照，日志是排查线上连接的唯一记录）：
 * Bug：2026-11-21 一份对比报告据日志写「电脑之间都经中转」，实际 8 台里 6 台直连：连接都是先经中转建立再换到直连，
 * 而日志只在建立和断开时记路径。可观察结果：快照里已连上的对端换了路径时记一行「moved from … to …」，来回跳动时
 * 在间隔内只记一次、间隔过后记下最后停在哪条路；建立与断开各记一行，没连上过的对端不记。
 * 现有覆盖缺口：路径日志此前没有测试。最小失败输入：对端经中转连上，快照先后报直连、中转、直连，再断开。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { AgentNetClient } from '@cindy/agent-net-relay/client';
import { AgentNetWorkerSocket } from '../workerSocket.js';

const fakeWorker = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type !== 'init') return;
  parentPort.postMessage({ type: 'ready' });
  parentPort.postMessage({ type: 'ws-open', id: 1, url: m.client.base.replace(/^http/, 'ws') + '/ws', headers: {} });
});
`));

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

it('discards a still-CONNECTING network socket without an uncaught error when closed mid-open (#10270)', async () => {
  const held: net.Socket[] = [];
  const server = net.createServer((socket) => { held.push(socket); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => { for (const socket of held) socket.destroy(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

  let release!: (ws: WebSocket) => void;
  let opened!: Promise<AgentNetWorkerSocket>;
  const requested = new Promise<void>((resolve) => {
    const client = {
      base, path: (value: string) => value, delegation: undefined, rootPublicKey: 'root',
      identity: { deviceId: 'unit-device' }, certificate: { subject: 'unit-user' },
      transport: {
        ownerPinnedHttp: false,
        createWebSocket: () => { resolve(); return new Promise<WebSocket>((done) => { release = done; }); },
      },
    } as unknown as AgentNetClient;
    opened = AgentNetWorkerSocket.open({ workerFile: fakeWorker, client } as Parameters<typeof AgentNetWorkerSocket.open>[0]);
  });
  const socket = await opened;
  await requested;

  socket.terminate();
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  cleanup.push(() => ws.terminate());
  release(ws);

  // Only a 'close' listener: events.once() would add an 'error' listener and mask the bug.
  await new Promise<void>((resolve) => { ws.on('close', () => resolve()); });
  expect(ws.readyState).toBe(WebSocket.CLOSED);
});

async function openAgainstRelay(options: { autoPong: boolean; keepalive?: { intervalMs: number; timeoutMs: number }; networkChangeProbeMs?: number; relayStuckMs?: number; workerFile?: URL }) {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: options.autoPong });
  await once(relay, 'listening');
  const accepted = once(relay, 'connection') as Promise<[WebSocket]>;
  const base = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`;
  const client = {
    base, path: (value: string) => value, delegation: undefined, rootPublicKey: 'root',
    identity: { deviceId: 'unit-device' }, certificate: { subject: 'unit-user' },
    transport: { ownerPinnedHttp: false, createWebSocket: (url: string, opts: WebSocket.ClientOptions) => new WebSocket(url, opts) },
  } as unknown as AgentNetClient;
  const warnings: string[] = [];
  const infos: string[] = [];
  const socket = await AgentNetWorkerSocket.open({
    workerFile: options.workerFile ?? fakeWorker, client, userId: 'unit-user',
    log: { info: (line: string) => { infos.push(line); }, warn: (line: string) => { warnings.push(line); } },
    uplinkKeepalive: options.keepalive ?? { intervalMs: 10, timeoutMs: 50 },
    ...(options.networkChangeProbeMs ? { networkChangeProbeMs: options.networkChangeProbeMs } : {}),
    ...(options.relayStuckMs ? { relayStuckMs: options.relayStuckMs } : {}),
  } as Parameters<typeof AgentNetWorkerSocket.open>[0]);
  cleanup.push(() => { socket.terminate(); for (const peer of relay.clients) peer.terminate(); relay.close(); });
  const [server] = await accepted;
  return { server, warnings, infos, socket, relay };
}

it('drops a relay connection whose pings are never answered, so the worker reconnects it (2026-11-13)', async () => {
  const { server, warnings } = await openAgainstRelay({ autoPong: false });
  await new Promise<void>((resolve) => { server.on('close', () => resolve()); });
  expect(warnings).toEqual([expect.stringMatching(/^agent-net relay connection is not answering \(no pong for \d+ms, \d+ bytes waiting to be sent\); reconnecting$/)]);
});

/**
 * 测试价值
 * - 生产入口与可观察结果：`AgentNetWorkerSocket.open` 之后中转连接断了，worker 却一直不再请求连接（它的重连卡住了）：
 *   Main 在 `relayStuckMs` 后让 worker 从头重连（`relay-restart`），中转看到新连接，日志记一条警告。
 * - Bug 依据：2026-11-25 一台 Mac 的中转连接 04:26 断开后 worker 再没请求过连接，只经中转能到的设备离线 4.5 小时，
 *   重启 App 才恢复。那条原因已在 worker 里修掉（socket.integration.test.ts「reconnects its relay after ending …」），这里是
 *   Main 侧的兜底：以后再有让 worker 停止重连的原因，也不必重启。
 * - 现有覆盖缺口：此前 Main 只管已打开的中转连接是否活着（保活、换网探测），连接断开以后完全交给 worker。
 * - 最小失败输入：中转关掉唯一的连接，worker 不再发 `ws-open`。
 * - tier：unit，内联最小 worker 与本机回环真实 WebSocket，时限压到 100 毫秒。
 */
it('tells a worker whose relay reconnect is stuck to start over (2026-11-25)', async () => {
  const stuckWorker = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
let url, id = 0;
parentPort.on('message', (m) => {
  if (m.type === 'init') { url = m.client.base.replace(/^http/, 'ws') + '/ws'; parentPort.postMessage({ type: 'ready' }); }
  if (m.type === 'init' || m.type === 'relay-restart') parentPort.postMessage({ type: 'ws-open', id: ++id, url, headers: {} });
});
`));
  const { server, socket, warnings, relay } = await openAgainstRelay({ autoPong: true, keepalive: { intervalMs: 60_000, timeoutMs: 120_000 },
    relayStuckMs: 100, workerFile: stuckWorker });
  await vi.waitFor(() => expect(socket.relayConnected()).toBe(true));
  // An open relay connection is never restarted, however long it stays open.
  // real-wait: only time past relayStuckMs (100 ms) on a real open connection shows the watchdog stays quiet; Main's timers run in real time here.
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(warnings).toEqual([]);
  const reconnected = once(relay, 'connection');
  const droppedAt = performance.now();
  server.close();
  await reconnected;
  // The worker gets the whole period from the drop, however long ago it last connected (here 250 ms, more than the period).
  expect(performance.now() - droppedAt).toBeGreaterThanOrEqual(100);
  await vi.waitFor(() => expect(socket.relayConnected()).toBe(true));
  expect(warnings).toEqual([expect.stringMatching(/^agent-net relay connection is down and no reconnect was attempted for \d+s; restarting it$/)]);
});

it('reports whether its relay connection is open, and when that changes', async () => {
  const { server, socket } = await openAgainstRelay({ autoPong: true, networkChangeProbeMs: 50, keepalive: { intervalMs: 60_000, timeoutMs: 120_000 } });
  await vi.waitFor(() => expect(socket.relayConnected()).toBe(true));
  // 中转的往返时间（远程连接页显示）：连上就先测一次，不等第一次保活。
  await vi.waitFor(() => expect(socket.relayRttMs()).toEqual(expect.any(Number)));
  // A single stalled peer must not disconnect an answering relay.
  const ping = once(server, 'ping');
  socket.relayStalled();
  await ping;
  await new Promise(resolve => setTimeout(resolve, 75));
  expect(socket.relayConnected()).toBe(true);
  const changes: boolean[] = [];
  socket.on('relay', (up: boolean) => { changes.push(up); });
  server.close();
  await vi.waitFor(() => expect(changes).toEqual([false]));
  expect(socket.relayConnected()).toBe(false);
  expect(socket.relayRttMs()).toBeNull();
});

/** Like fakeWorker, and reports how relayed datagrams travel (the real worker does it in each status snapshot) when told to. */
const relayRouteWorker = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'init') {
    parentPort.postMessage({ type: 'ready' });
    parentPort.postMessage({ type: 'ws-open', id: 1, url: m.client.base.replace(/^http/, 'ws') + '/ws', headers: {} });
  }
  if (m.type === 'frame') {
    parentPort.postMessage({ type: 'ack', bytes: m.bytes });
    parentPort.postMessage({ type: 'status', queued: 0, known: [], peers: [], relayRoute: JSON.parse(m.frame) });
  }
});
`));

it('reports whether relayed datagrams go over the relay UDP port or the WebSocket, with that path\'s round trip (2026-11-18)', async () => {
  const { server, socket, infos } = await openAgainstRelay({ autoPong: true, keepalive: { intervalMs: 60_000, timeoutMs: 120_000 }, workerFile: relayRouteWorker });
  // 还没走 UDP：WebSocket，往返是心跳的。
  await vi.waitFor(() => expect(socket.relayRoute()).toEqual({ via: 'websocket', rttMs: expect.any(Number) }));
  const changes: string[] = [];
  socket.on('relay-route', (via: string) => { changes.push(via); });
  socket.send(JSON.stringify({ via: 'udp', rttMs: 7 }));
  await vi.waitFor(() => expect(socket.relayRoute()).toEqual({ via: 'udp', rttMs: 7 }));
  // 往返刷新不算切换。
  socket.send(JSON.stringify({ via: 'udp', rttMs: 9 }));
  await vi.waitFor(() => expect(socket.relayRoute()).toEqual({ via: 'udp', rttMs: 9 }));
  // UDP 不通、退回 WebSocket：往返换回心跳的，不留 UDP 的旧值。
  socket.send(JSON.stringify({ via: 'websocket', rttMs: null }));
  await vi.waitFor(() => expect(socket.relayRoute()?.via).toBe('websocket'));
  expect(socket.relayRoute()!.rttMs).toBe(socket.relayRttMs());
  expect(changes).toEqual(['udp', 'websocket']);
  expect(infos.filter((line) => line.startsWith('agent-net relayed datagrams'))).toEqual([
    'agent-net relayed datagrams now go over the relay UDP port',
    'agent-net relayed datagrams now go over the relay WebSocket',
  ]);
  // 中转连接断了：没有经中转的路可说。
  server.close();
  await vi.waitFor(() => expect(socket.relayRoute()).toBeNull());
});

// PR #11236: the cached directory can show the peer offline during a LAN dial.
// Unit, real WorkerSocket: one cached same-account device, one pending dial,
// no routable path. Existing live-relay tests only exercise available peers.
// Keep the worker alive until cleanup: a once-only listener can let it exit
// after ready and clear the route before the Windows CI assertion runs.
it('reports a LAN handshake while the cached directory marks the peer offline', async () => {
  // The handshake is still in progress: keep this worker alive until cleanup.
  // A once listener let it exit just after ready, racing the route assertion.
  const workerFile = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (message) => {
  if (message.type !== 'init') return;
  const deviceId = 'lan-peer';
  parentPort.postMessage({ type: 'directory', directory: [{ certificate: { deviceId } }], cached: true });
  parentPort.postMessage({ type: 'status', queued: 0, known: [deviceId],
    peers: [[deviceId, { available: false, path: null, rttMs: null, dialing: true }]] });
  parentPort.postMessage({ type: 'ready' });
});
`));
  const client = { identity: { deviceId: 'unit-device' }, transport: {} } as unknown as AgentNetClient;
  const socket = await AgentNetWorkerSocket.open({ workerFile, client, userId: 'unit-user' });
  cleanup.push(() => socket.terminate());
  expect(socket.peerRoutes()).toEqual([{ deviceId: 'lan-peer', path: 'connecting', rttMs: null }]);
});

it.each(['networkChanged', 'relayStalled'] as const)('probes a silent relay after %s before the keepalive would', async trigger => {
  const { server, warnings, socket } = await openAgainstRelay({ autoPong: false, keepalive: { intervalMs: 60_000, timeoutMs: 120_000 }, networkChangeProbeMs: 30 });
  const closed = new Promise<void>((resolve) => { server.on('close', () => resolve()); });
  await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  socket[trigger]();
  socket[trigger]();
  await closed;
  expect(warnings).toEqual([expect.stringContaining('relay connection did not answer')]);
});

/** Turns each application frame `{ tag, count, size }` into that many relay datagrams; byte 0 is the tag. */
const datagramWorker = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'init') {
    parentPort.postMessage({ type: 'ready' });
    parentPort.postMessage({ type: 'ws-open', id: 1, url: m.client.base.replace(/^http/, 'ws') + '/ws', headers: {} });
  }
  if (m.type === 'frame') {
    const { tag, count, size } = JSON.parse(m.frame);
    for (let i = 0; i < count; i++) { const data = new Uint8Array(size); data[0] = tag; parentPort.postMessage({ type: 'ws-send', id: 1, data }); }
    parentPort.postMessage({ type: 'ack', bytes: m.bytes });
  }
});
`));

const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

it('stops queueing datagrams behind a relay connection that no longer moves, and resumes once it does (2026-11-13)', async () => {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  const accepted = once(relay, 'connection') as Promise<[WebSocket, { socket: net.Socket }]>;
  const base = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`;
  let uplink!: WebSocket;
  const client = {
    base, path: (value: string) => value, delegation: undefined, rootPublicKey: 'root',
    identity: { deviceId: 'unit-device' }, certificate: { subject: 'unit-user' },
    transport: { ownerPinnedHttp: false, createWebSocket: (url: string, opts: WebSocket.ClientOptions) => (uplink = new WebSocket(url, opts)) },
  } as unknown as AgentNetClient;
  const warnings: string[] = [];
  let moving!: () => void;
  const movedAgain = new Promise<void>((resolve) => { moving = resolve; });
  const socket = await AgentNetWorkerSocket.open({
    workerFile: datagramWorker, client, userId: 'unit-user', uplinkMaxQueueDelayMs: 30,
    uplinkKeepalive: { intervalMs: 60_000, timeoutMs: 120_000 },
    log: { info: (line: string) => { if (line.includes('send queue moving again')) moving(); }, warn: (line: string) => { warnings.push(line); } },
  } as Parameters<typeof AgentNetWorkerSocket.open>[0]);
  cleanup.push(() => { socket.terminate(); for (const peer of relay.clients) peer.terminate(); relay.close(); });
  const [server, request] = await accepted;
  if (uplink.readyState !== WebSocket.OPEN) await once(uplink, 'open');
  const tags = new Map<number, number>();
  server.on('message', (data: Buffer) => { tags.set(data[0], (tags.get(data[0]) ?? 0) + 1); });
  /** Resolves once Main has handled every datagram the worker produced for this frame. */
  const emit = async (tag: number, count: number, size: number) => {
    socket.send(JSON.stringify({ tag, count, size }));
    while (socket.bufferedAmount > 0) await tick();
  };

  // Healthy sending that lasts longer than the delay budget loses nothing.
  for (let i = 0; i < 3; i++) { await emit(0, 4, 1024); await sleep(25); }
  // The relay stops reading: fill the system buffers until writes start waiting in this process.
  request.socket.pause();
  for (let i = 0; i < 1024 && uplink.bufferedAmount === 0; i++) await emit(1, 1, 64 * 1024);
  expect(uplink.bufferedAmount).toBeGreaterThan(0);
  // Far below the old 1 MiB cap, which therefore cannot be what drops the next datagrams.
  expect(uplink.bufferedAmount).toBeLessThan(512 * 1024);
  await sleep(80);
  await emit(2, 8, 1024);
  request.socket.resume();
  // Main reports when the queue moves again; a build without the limit never does, so also accept an emptied queue.
  await Promise.race([movedAgain, (async () => { while (uplink.bufferedAmount > 0) await tick(); await sleep(50); })()]);
  await emit(3, 1, 1024);
  while (!tags.has(3)) await tick();

  expect(tags.get(0)).toBe(12);
  expect(tags.has(2)).toBe(false);
  expect(warnings).toEqual([expect.stringMatching(/^agent-net relay send queue has not moved for \d+ms \(\d+ bytes waiting\); dropping new datagrams/)]);
});

it('keeps a relay connection that answers pings past the silence budget', async () => {
  const { server, warnings } = await openAgainstRelay({ autoPong: true });
  // Eight answered pings span ~80ms, longer than the 50ms budget.
  await new Promise<void>((resolve) => { let pings = 0; server.on('ping', () => { if (++pings === 8) resolve(); }); });
  expect(server.readyState).toBe(WebSocket.OPEN);
  expect(warnings).toEqual([]);
});

it('logs when a connected peer moves between the relay and a direct path (2026-11-21)', async () => {
  const workerFile = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'init') { parentPort.postMessage({ type: 'ready' }); return; }
  if (m.type !== 'frame') return;
  for (const message of JSON.parse(m.frame)) parentPort.postMessage(message);
  parentPort.postMessage({ type: 'ack', bytes: m.bytes });
});
`));
  const infos: string[] = [];
  const rebounds: string[] = [];
  const client = { identity: { deviceId: 'unit-device' }, transport: {} } as unknown as AgentNetClient;
  const socket = await AgentNetWorkerSocket.open({ workerFile, client, userId: 'unit-user', pathMoveLogIntervalMs: 40,
    onUdpRebound: (reason) => { rebounds.push(reason); },
    log: { info: (line: string) => { infos.push(line); }, warn: () => undefined } });
  cleanup.push(() => socket.terminate());
  const status = (path: 'direct' | 'relay' | null, other: 'relay' | null = null) => ({ type: 'status', queued: 0, known: ['peer-a', 'peer-b'], peers: [
    ['peer-a', { available: path !== null, path, rttMs: 1, dialing: false }], ['peer-b', { available: other !== null, path: other, rttMs: null, dialing: false }]] });
  const post = async (...messages: unknown[]) => { socket.send(JSON.stringify(messages)); while (socket.bufferedAmount > 0) await new Promise((resolve) => setImmediate(resolve)); };
  const lines = () => infos.filter((line) => line.startsWith('agent-net peer'));

  // Control the logging interval without depending on worker scheduling or CI load.
  let now = 1_000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());

  // A device that is known but never connected is not reported, in snapshots either.
  await post(status(null));
  await post({ type: 'path', id: 'peer-a', path: 'relay' }, status('relay'));
  expect(lines()).toEqual(['agent-net peer peer-a connected via relay']);
  await post(status('direct'));
  expect(lines()).toEqual(['agent-net peer peer-a connected via relay', 'agent-net peer peer-a moved from relay to direct']);
  // Flipping inside the interval writes nothing more; after it, where the route ended up.
  now += 39;
  await post(status('relay'), status('direct'), status('relay'));
  expect(lines()).toHaveLength(2);
  now += 1;
  await post(status('relay'));
  expect(lines().slice(2)).toEqual(['agent-net peer peer-a moved from direct to relay']);
  await post({ type: 'path', id: 'peer-a', path: null }, status(null));
  expect(lines().slice(3)).toEqual(['agent-net peer peer-a disconnected']);
  await post({ type: 'udp-rebound', reason: 'udp-blackhole' }, { type: 'udp-rebound', reason: 'bogus' });
  expect(infos).toContain('agent-net rebound UDP socket (reason=udp-blackhole)');
  expect(infos).toContain('agent-net rebound UDP socket (reason=unknown)');
  expect(rebounds).toEqual(['udp-blackhole']);
});

/**
 * 测试价值
 * - 生产入口与可观察结果：`AgentNetWorkerSocket.open` 透传 `bindPort` 给 worker、`setStunServers` 推送动态 STUN 列表，
 *   并把 worker 发出的 `log` 消息转给宿主 `log.info` / `log.warn`。
 * - Bug／规则依据：双区 STUN 异步补齐与固定 UDP 端口冲突回退日志均跨 worker 线程边界传递。
 * - 现有覆盖缺口：已有 workerSocket 测试未覆盖 `bindPort` 初始化透传、`set-stun-servers` 消息与 worker 日志回传。
 * - 最小失败输入：携带 `bindPort: 41641` 打开 worker，调用 `setStunServers`，并由 worker 上报一条 info 与一条 warn 日志。
 * - tier：unit（内联最小 worker，不启网络）。
 */
it('forwards bindPort, setStunServers, and worker log lines across the worker boundary', async () => {
  const workerFile = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'init') {
    parentPort.postMessage({ type: 'log', level: 'info', message: 'init-port:' + m.options.bindPort });
    parentPort.postMessage({ type: 'ready' });
  }
  if (m.type === 'set-stun-servers') {
    parentPort.postMessage({ type: 'log', level: 'warn', message: 'stuns:' + m.servers.join(',') });
  }
});
`));
  const infos: string[] = [];
  const warnings: string[] = [];
  const client = { identity: { deviceId: 'unit-device' }, transport: {} } as unknown as AgentNetClient;
  const socket = await AgentNetWorkerSocket.open({
    workerFile, client, userId: 'unit-user', bindPort: 41641,
    log: { info: (line) => { infos.push(line); }, warn: (line) => { warnings.push(line); } },
  });
  cleanup.push(() => socket.terminate());
  socket.setStunServers(['agent-net-stun.cindy.com.cn:3479', 'agent-net-stun.cindy.app:3479']);
  await vi.waitFor(() => expect(warnings).toEqual(['stuns:agent-net-stun.cindy.com.cn:3479,agent-net-stun.cindy.app:3479']));
  expect(infos).toEqual(['init-port:41641']);
});
