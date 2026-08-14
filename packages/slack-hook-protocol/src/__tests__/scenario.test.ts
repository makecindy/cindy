/**
 * 协议场景测试: 在真实 TCP 回环 socket 上模拟 server 与 desktop 两端,
 * 用 NDJSON 帧(每行一帧)跑完整协议生命周期 —— 验证的不是单个函数,
 * 而是「构造 -> 序列化 -> 过真实网络边界(含帧被 TCP 分片/粘连) -> 解析 ->
 * 状态机联动」这条完整链路:
 *
 *   1. 四幕 happy path: hello -> welcome -> dispatch -> ack(accepted) -> turn.end
 *   2. requestId 幂等: 同一任务重投两次, desktop 只执行一次、ack 原样回放
 *   3. 拒绝路径: 未注册的 workspace 别名 -> rejected(unknown_workspace)
 *
 * 传输层帧边界(NDJSON 切分/缓冲)是测试自带的最小实现 —— 协议包本身
 * 传输无关, 这里只为让帧真实经过 socket。
 */

import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import {
  makeHello,
  makePing,
  makeTaskAck,
  makeTaskDispatch,
  makeTurnEnd,
  makeWelcome,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type HookTaskAckMessage,
} from '../index';

/** 往 socket 写一帧(NDJSON: 序列化 + 换行)。 */
function sendFrame(sock: Socket, message: HookMessage): void {
  sock.write(serializeHookMessage(message) + '\n');
}

/**
 * 帧读取器: 处理 TCP 分片/粘连, 每解析出一帧就入队;
 * next() 返回下一帧(已过 parseHookMessage, 坏帧直接抛错让测试失败)。
 */
function frameReader(sock: Socket): { next: () => Promise<HookMessage> } {
  let buffer = '';
  const queue: HookMessage[] = [];
  const waiters: Array<(m: HookMessage) => void> = [];

  sock.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const parsed = parseHookMessage(line);
      if (!parsed.ok) throw new Error(`bad frame on wire: ${parsed.error}`);
      const waiter = waiters.shift();
      if (waiter) waiter(parsed.message);
      else queue.push(parsed.message);
    }
  });

  return {
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift() as HookMessage)
        : new Promise((resolve) => waiters.push(resolve)),
  };
}

/** 起一个 TCP 回环对: 返回 server 侧与 desktop(client)侧的 socket + 读取器。 */
async function loopbackPair(): Promise<{
  server: Server;
  serverSock: Socket;
  desktopSock: Socket;
  serverRead: ReturnType<typeof frameReader>;
  desktopRead: ReturnType<typeof frameReader>;
  close: () => Promise<void>;
}> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');

  const { connect } = await import('node:net');
  const acceptPromise = once(server, 'connection');
  const desktopSock = connect(addr.port, '127.0.0.1');
  await once(desktopSock, 'connect');
  const [serverSock] = (await acceptPromise) as [Socket];

  return {
    server,
    serverSock,
    desktopSock,
    serverRead: frameReader(serverSock),
    desktopRead: frameReader(desktopSock),
    close: async () => {
      desktopSock.destroy();
      serverSock.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 模拟 desktop 侧 dispatcher 的最小状态机:
 * 别名白名单校验 + requestId 幂等表(重投回放上次 ack, 不重复执行)。
 */
function createMiniDesktop(workspaces: Set<string>) {
  const ackByRequestId = new Map<string, HookTaskAckMessage['payload']>();
  let executions = 0;

  return {
    get executions() {
      return executions;
    },
    handleDispatch(payload: {
      requestId: string;
      workspace: string | null;
      sessionId: string | null;
    }): HookTaskAckMessage['payload'] {
      const replay = ackByRequestId.get(payload.requestId);
      if (replay) return replay; // 幂等: 重投只回放, 不再执行
      let ack: HookTaskAckMessage['payload'];
      if (payload.sessionId === null && !workspaces.has(payload.workspace ?? '')) {
        ack = {
          requestId: payload.requestId,
          result: 'rejected',
          reason: 'unknown_workspace',
          sessionId: null,
          queuePosition: null,
        };
      } else {
        executions += 1;
        ack = {
          requestId: payload.requestId,
          result: 'accepted',
          reason: null,
          sessionId: `sess-${payload.requestId}`,
          queuePosition: null,
        };
      }
      ackByRequestId.set(payload.requestId, ack);
      return ack;
    },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe('协议场景: 真实 socket 上的完整生命周期', () => {
  it('四幕 happy path: hello -> welcome -> dispatch -> ack -> turn.end', async () => {
    const pair = await loopbackPair();
    cleanup = pair.close;
    const { serverSock, desktopSock, serverRead, desktopRead } = pair;

    // 第一幕: desktop 自报家门, server 应答
    sendFrame(
      desktopSock,
      makeHello({
        deviceId: 'dev-1',
        deviceName: 'Cindy',
        workspaces: ['cindy'],
        agents: ['cc'],
      }),
    );
    const hello = await serverRead.next();
    expect(hello.type).toBe('hello');
    if (hello.type !== 'hello') return;
    expect(hello.payload.workspaces).toEqual(['cindy']);

    sendFrame(serverSock, makeWelcome({ serverName: 'my-hooks', features: [] }));
    const welcome = await desktopRead.next();
    expect(welcome.type).toBe('welcome');

    // 心跳走一个来回
    sendFrame(serverSock, makePing());
    expect((await desktopRead.next()).type).toBe('ping');

    // 第二幕: server 派活, desktop 立即 ack
    const desktop = createMiniDesktop(new Set(hello.payload.workspaces));
    sendFrame(
      serverSock,
      makeTaskDispatch({
        requestId: 'req-100',
        externalKey: 'team-slack:C123:1720000.123',
        workspace: 'cindy',
        prompt: '看下 #632 的 CI 为什么挂了',
      }),
    );
    const dispatch = await desktopRead.next();
    expect(dispatch.type).toBe('task.dispatch');
    if (dispatch.type !== 'task.dispatch') return;
    sendFrame(desktopSock, makeTaskAck(desktop.handleDispatch(dispatch.payload)));

    const ack = await serverRead.next();
    expect(ack.type).toBe('task.ack');
    if (ack.type !== 'task.ack') return;
    expect(ack.payload).toMatchObject({ requestId: 'req-100', result: 'accepted' });
    expect(desktop.executions).toBe(1);

    // 第四幕: 交差, server 按 externalKey 收到原样回传的回邮地址
    sendFrame(
      desktopSock,
      makeTurnEnd({
        requestId: 'req-100',
        externalKey: dispatch.payload.externalKey,
        sessionId: ack.payload.sessionId,
        status: 'ok',
        finalText: 'CI 挂在 typecheck, 已定位',
        errorMessage: null,
        usage: { durationMs: 42_000 },
      }),
    );
    const turnEnd = await serverRead.next();
    expect(turnEnd.type).toBe('turn.end');
    if (turnEnd.type !== 'turn.end') return;
    expect(turnEnd.payload.externalKey).toBe('team-slack:C123:1720000.123');
    expect(turnEnd.payload.status).toBe('ok');
  });

  it('requestId 幂等: 重投同一任务只执行一次, ack 原样回放', async () => {
    const pair = await loopbackPair();
    cleanup = pair.close;
    const { serverSock, desktopSock, serverRead, desktopRead } = pair;
    const desktop = createMiniDesktop(new Set(['cindy']));

    const dispatchMsg = makeTaskDispatch({
      requestId: 'req-200',
      externalKey: 'team-slack:C123:1720009.999',
      workspace: 'cindy',
      prompt: '干活',
    });

    // 模拟断线重连后 server 重投: 同 requestId 发两次
    for (let i = 0; i < 2; i++) {
      sendFrame(serverSock, dispatchMsg);
      const d = await desktopRead.next();
      if (d.type !== 'task.dispatch') throw new Error('unexpected frame');
      sendFrame(desktopSock, makeTaskAck(desktop.handleDispatch(d.payload)));
    }

    const ack1 = await serverRead.next();
    const ack2 = await serverRead.next();
    if (ack1.type !== 'task.ack' || ack2.type !== 'task.ack') throw new Error('unexpected frame');
    expect(desktop.executions).toBe(1); // 只执行一次
    expect(ack2.payload).toEqual(ack1.payload); // 回放的 ack 完全一致
  });

  it('拒绝路径: 未注册的 workspace 别名被 rejected', async () => {
    const pair = await loopbackPair();
    cleanup = pair.close;
    const { serverSock, desktopSock, serverRead, desktopRead } = pair;
    const desktop = createMiniDesktop(new Set(['cindy']));

    sendFrame(
      serverSock,
      makeTaskDispatch({
        requestId: 'req-300',
        externalKey: 'gh:cindy/protocol-demo:issue:632',
        workspace: 'not-registered',
        prompt: '修一下',
      }),
    );
    const d = await desktopRead.next();
    if (d.type !== 'task.dispatch') throw new Error('unexpected frame');
    sendFrame(desktopSock, makeTaskAck(desktop.handleDispatch(d.payload)));

    const ack = await serverRead.next();
    if (ack.type !== 'task.ack') throw new Error('unexpected frame');
    expect(ack.payload).toMatchObject({
      result: 'rejected',
      reason: 'unknown_workspace',
      sessionId: null,
    });
    expect(desktop.executions).toBe(0);
  });
});
