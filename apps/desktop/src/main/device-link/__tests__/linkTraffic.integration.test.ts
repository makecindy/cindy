/**
 * 依据：按本机实际传输的字节比较两种连接，重启后保留、换账号隔离。
 * 覆盖缺口：纯计数器无法发现 WebSocket 压缩后字节数取错或旧连接结算到新账号。
 * 最小失败输入：同一份可压缩内容分别经两个 relay socket 传输，然后带着未关闭的 socket 换账号。
 * tier：integration；回环 WebSocket 和独立临时目录，完全绕开外部账号、代理与网络。
 */
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { currentLinkTraffic, flushLinkTraffic } from '../linkTraffic.desktop';
import { openLinkWebSocket } from '../linkWebSocket.desktop';

const session = vi.hoisted(() => ({ owner: 'a', generation: 1, directory: '' }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => session.owner + session.generation,
  getActiveAppSession: () => ({ dataOwnerId: session.owner }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(session.directory, session.owner, ...parts),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/outbound-fetch.desktop', () => ({
  createOutboundHttpAgent: async () => undefined,
  createOutboundHttpAgentWithDecision: async () => ({
    agent: undefined,
    decision: { kind: 'direct' as const, reason: 'no-proxy' as const },
  }),
}));

it('counts encoded relay bytes once, pins late close bytes to their owner and restores both routes', async () => {
  session.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-link-traffic-'));
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  const clients: WebSocket[] = [];
  try {
    await once(relay, 'listening');
    const addr = relay.address();
    if (!addr || typeof addr === 'string') throw new Error('Missing test port');
    const url = 'ws://127.0.0.1:' + addr.port;
    relay.on('connection', peer => peer.on('message', () => peer.send('ack')));
    const source = currentLinkTraffic();
    const body = 'stable UTF-8 统计'.repeat(4096);
    for (const kind of ['device-link', 'agent-net'] as const) {
      const ws = await openLinkWebSocket(kind, url, { perMessageDeflate: kind === 'agent-net' });
      clients.push(ws);
      await once(ws, 'open');
      const reply = once(ws, 'message');
      ws.send(body);
      await reply;
    }
    session.owner = 'b';
    const other = currentLinkTraffic();
    await flushLinkTraffic(); // Finish the sign-out checkpoint before the old socket's final bytes.
    const lateReply = once(clients[0], 'message');
    clients[0].send('late'.repeat(512));
    await lateReply;
    for (const ws of clients) {
      const closed = once(ws, 'close');
      ws.close();
      await closed;
    }
    await flushLinkTraffic(); // The quit hook only has the global entry point.
    const a = source.snapshot()!.lastDay, b = other.snapshot()!.lastDay;
    expect(a['device-link'].sent).toBeGreaterThan(Buffer.byteLength(body) + 2048);
    expect(a['agent-net'].sent).toBeGreaterThan(0);
    expect(a['agent-net'].sent).toBeLessThan(Buffer.byteLength(body) / 10);
    expect(a['agent-net'].received).toBeGreaterThan(0);
    expect(b).toEqual({ 'agent-net': { sent: 0, received: 0 }, 'device-link': { sent: 0, received: 0 } });
    session.owner = 'a';
    session.generation++;
    const restarted = currentLinkTraffic();
    await restarted.flush();
    expect(restarted.snapshot()?.lastDay).toEqual(a);
    restarted.record('agent-net', 19, 0);
    session.owner = 'b';
    currentLinkTraffic();
    session.owner = 'a';
    const returned = currentLinkTraffic();
    await returned.flush();
    expect(returned.snapshot()?.lastDay['agent-net'].sent).toBe(a['agent-net'].sent + 19);
  } finally {
    for (const ws of clients) ws.terminate();
    for (const peer of relay.clients) peer.terminate();
    await new Promise<void>(resolve => relay.close(() => resolve()));
    await flushLinkTraffic();
    await fs.rm(session.directory, { recursive: true, force: true });
  }
});

// Two isolated module instances share only the on-disk owner directory, as two desktop processes do.
// A truncated hour used to stop all subsequent writes to that rotating slot.
it('repairs a malformed hour and refreshes its committed bytes in a running standby instance', async () => {
  session.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-link-traffic-'));
  session.owner = 'shared-owner';
  session.generation++;
  const now = Date.UTC(2026, 10, 19, 12, 10);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const directory = path.join(session.directory, session.owner, 'device-link', 'traffic-v1');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, Math.floor(now / 3_600_000) % 25 + '.json'), '[');
    const writer = currentLinkTraffic();
    vi.resetModules();
    const standby = (await import('../linkTraffic.desktop')).currentLinkTraffic();
    await Promise.all([writer.flush(), standby.flush()]);
    writer.record('agent-net', 32_768, 3);
    await writer.flush();
    clock.mockReturnValue(now + 60_001);
    standby.snapshot(); // Schedules the bounded refresh without blocking the panel.
    await standby.flush();
    expect(standby.snapshot()?.lastDay['agent-net']).toEqual({ sent: 32_768, received: 3 });
    standby.record('agent-net', 1, 0);
    writer.record('agent-net', 0, 5);
    await Promise.all([writer.flush(), standby.flush()]);
    session.generation++;
    const restarted = currentLinkTraffic();
    await restarted.flush();
    expect(restarted.snapshot()?.lastDay['agent-net']).toEqual({ sent: 32_769, received: 8 });
  } finally {
    clock.mockRestore();
    await fs.rm(session.directory, { recursive: true, force: true });
  }
});
