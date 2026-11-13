/**
 * 生产入口：AgentNetWorkerSocket.open + worker 请求 Main 建立网络 ws（ws-open）。
 * Bug：#10270 —— 系统唤醒重连丢弃这条加密连接时，异步工厂才返回的 ws 仍处于 CONNECTING，
 * 未挂 error 监听就被 terminate()，ws 下一 tick 派发的 error 变成 Main 的 uncaughtException。
 * 现有覆盖缺口：socket.integration.test.ts 的工厂是同步的，从不在建连途中关闭。
 * 最小失败输入：worker 发出 ws-open → 工厂未返回时 terminate() → 工厂返回 CONNECTING ws。
 * tier：unit，内联最小 worker 与本机回环 TCP（只接受连接不回握手，保证停在 CONNECTING）。
 */
import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
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
