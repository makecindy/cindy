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
 */
import { afterEach, expect, it } from 'vitest';
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

async function openAgainstRelay(options: { autoPong: boolean }) {
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
  const socket = await AgentNetWorkerSocket.open({
    workerFile: fakeWorker, client, userId: 'unit-user', log: { info: () => {}, warn: (line: string) => { warnings.push(line); } },
    uplinkKeepalive: { intervalMs: 10, timeoutMs: 50 },
  } as Parameters<typeof AgentNetWorkerSocket.open>[0]);
  cleanup.push(() => { socket.terminate(); for (const peer of relay.clients) peer.terminate(); relay.close(); });
  const [server] = await accepted;
  return { server, warnings };
}

it('drops a relay connection whose pings are never answered, so the worker reconnects it (2026-11-13)', async () => {
  const { server, warnings } = await openAgainstRelay({ autoPong: false });
  await new Promise<void>((resolve) => { server.on('close', () => resolve()); });
  expect(warnings).toEqual([expect.stringMatching(/^agent-net relay connection is not answering \(no pong for \d+ms, \d+ bytes waiting to be sent\); reconnecting$/)]);
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
