import type { Server as HttpServer } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net';

import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';

/**
 * 测试专用的最小 SOCKS5 服务端桩(RFC 1928 / 1929)。记录客户端发来的每一步,按
 * options 决定应答形态,成功时把隧道接到本机指定端口。socks5.ts 与 server.ts 的
 * 出站代理用例共用。
 */
export interface Socks5StubOptions {
  /** 选择 0x02(用户名/密码)而不是 0x00。 */
  requireAuth?: boolean;
  /** 回 0xff:没有可接受的方法。 */
  rejectAllMethods?: boolean;
  /** 认证子协商回非 0 状态。 */
  authShouldFail?: boolean;
  /** 认证回复的子协商版本字节,默认 0x01(RFC 1929)。用于构造流错位的不合规代理。 */
  authReplyVersion?: number;
  /** CONNECT 回复码,默认 0x00(成功)。 */
  replyCode?: number;
  /** 成功时把隧道接到本机这个端口;不给则只回复不转发。 */
  tunnelToPort?: number;
  /** 回复里 BND.ADDR 的形态,默认 ipv4。 */
  replyAddressType?: 'ipv4' | 'domain' | 'ipv6';
  /** 收到 CONNECT 后不回复直接关闭连接(模拟代理握手中途断开)。 */
  closeAfterConnect?: boolean;
}

export interface Socks5Stub {
  port: number;
  /** 每条连接协商时客户端提供的认证方法列表。 */
  offeredMethods: number[][];
  /** RFC 1929 认证收到的明文凭证。 */
  credentials: Array<{ username: string; password: string }>;
  /** 每条 CONNECT 请求的目标(atyp 用于验证域名没有被本地预解析)。 */
  requests: Array<{ atyp: number; host: string; port: number }>;
  close: () => Promise<void>;
}

/** 顺序读辅助 —— SOCKS5 握手是严格的请求/应答往返。 */
function createReader(socket: Socket): (n: number) => Promise<Buffer> {
  let buffered: Buffer = Buffer.alloc(0);
  let waiter: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  const settle = (): void => {
    if (!waiter || buffered.length < waiter.need) return;
    const { need, resolve } = waiter;
    waiter = null;
    resolve(buffered.subarray(0, need));
    buffered = buffered.subarray(need);
  };
  socket.on('data', (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    settle();
  });
  const abort = (): void => {
    const pending = waiter;
    waiter = null;
    pending?.reject(new Error('socks5 stub: socket closed mid-handshake'));
  };
  socket.on('error', abort);
  socket.on('close', abort);
  return (n: number) => new Promise<Buffer>((resolve, reject) => {
    waiter = { need: n, resolve, reject };
    settle();
  });
}

function formatBoundAddress(kind: Socks5StubOptions['replyAddressType']): Buffer {
  if (kind === 'domain') {
    const domain = Buffer.from('proxy.local', 'utf8');
    return Buffer.concat([Buffer.of(0x03, domain.length), domain]);
  }
  if (kind === 'ipv6') return Buffer.concat([Buffer.of(0x04), Buffer.alloc(16)]);
  return Buffer.concat([Buffer.of(0x01), Buffer.of(0, 0, 0, 0)]);
}

export async function startSocks5Stub(options: Socks5StubOptions = {}): Promise<Socks5Stub> {
  const offeredMethods: number[][] = [];
  const credentials: Array<{ username: string; password: string }> = [];
  const requests: Array<{ atyp: number; host: string; port: number }> = [];

  const server = createNetServer((socket) => {
    const read = createReader(socket);
    void (async () => {
      const greeting = await read(2);
      offeredMethods.push([...await read(greeting[1])]);
      if (options.rejectAllMethods) { socket.end(Buffer.of(0x05, 0xff)); return; }
      const method = options.requireAuth ? 0x02 : 0x00;
      socket.write(Buffer.of(0x05, method));

      if (method === 0x02) {
        await read(1);  // 子协商版本
        const username = (await read((await read(1))[0])).toString('utf8');
        const password = (await read((await read(1))[0])).toString('utf8');
        credentials.push({ username, password });
        socket.write(Buffer.of(options.authReplyVersion ?? 0x01, options.authShouldFail ? 0x01 : 0x00));
        if (options.authShouldFail) { socket.end(); return; }
      }

      const head = await read(4);
      const atyp = head[3];
      let host = '';
      if (atyp === 0x01) {
        host = [...await read(4)].join('.');
      } else if (atyp === 0x03) {
        host = (await read((await read(1))[0])).toString('utf8');
      } else {
        const raw = await read(16);
        host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':');
      }
      const port = (await read(2)).readUInt16BE(0);
      requests.push({ atyp, host, port });
      if (options.closeAfterConnect) { socket.end(); return; }

      const replyCode = options.replyCode ?? 0x00;
      const reply = Buffer.concat([
        Buffer.of(0x05, replyCode, 0x00),
        formatBoundAddress(options.replyAddressType),
        Buffer.of(0x00, 0x00),
      ]);
      if (replyCode !== 0x00) { socket.end(reply); return; }
      if (options.tunnelToPort === undefined) { socket.write(reply); return; }

      // 先接通目标再回 0x00(RFC 1928 的语义,真实代理也是这个顺序),并且回复与
      // pipe 在同一个同步块里完成 —— 否则客户端收到回复后立刻发出的首个请求包会
      // 落进本桩的握手 reader 而不是隧道,表现为请求永久挂起。
      const upstream = netConnect(options.tunnelToPort, '127.0.0.1', () => {
        socket.write(reply);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    })().catch(() => socket.destroy());
  });

  const port = await listenOnAvailableLoopbackPort(server as unknown as HttpServer);
  return {
    port,
    offeredMethods,
    credentials,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
