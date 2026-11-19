/**
 * 单独进程里的压测网络：中转（Agent-Net V2 或原来的 Device Link）和每台设备到中转的限速线路。
 * harness.ts 用 fork 启动它，经 IPC 下指令、读计量（见 harness.ts 的 `processNetwork`）。
 *
 * 为什么不放在设备的进程里：两台设备的 Device Link 都在主线程上，处理大消息时事件循环会卡几十毫秒；
 * 中转和限速线路也在这个线程上的话，转发的包跟着被推迟，往返时间一阵一阵地跳，拥塞控制把它当成排队。
 * 真实部署里中转在服务器上，不受设备主线程影响。
 *
 * 放到另一台电脑上（真实网络对比）：在那台电脑的仓库根目录运行
 *   node --import tsx packages/agent-net/bench/network-process.ts --listen 47200 --advertise <这台电脑的地址>
 * 压测那边加 `--remote-network <地址>:47200`。每条控制连接是一次独立的网络（自己的中转、线路和临时目录），连接断开时全部关掉；
 * 代理听所有地址，交回的地址用 --advertise。设备和中转之间的数据就走两台电脑之间的真实线路（来回各一次）。
 * 压测那边再加 `--no-line` 时不经线路代理：中转自己听所有地址，设备直接连它（没有计量），排除代理逐包转发带来的抖动。
 * 公网要走 UDP 时再加 `--tls-cert <证书> --tls-key <私钥>`（自签即可，subjectAltName 写 --advertise 的 IP），压测那边设
 * `NODE_EXTRA_CA_CERTS=<同一张证书>`：客户端只在加密连接上向中转要 UDP 凭据（2026-11-18 起），明文连接时数据报全走中转
 * WebSocket，结果里 udp=0（2026-11-19 公网对照因此没测到 UDP）。
 */
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgentNetRelay } from '@cindy/agent-net-relay';
import { initializeRelay, startRelayServer } from '@cindy/device-link-relay';
import { LinkDirection, startShapedProxy, startUdpProxy, type LinkProfile } from './network.js';

type Meter = { bytes: number; udpBytes: number; dropped: number };
type Request = { id: number } & (
  | { op: 'init'; profile: LinkProfile; direct?: boolean }
  | { op: 'agent-net-relay'; dataDir: string; bootstrap: Parameters<typeof startAgentNetRelay>[0]['bootstrap'] }
  | { op: 'v1-relay'; dataDir: string; init: Omit<Parameters<typeof initializeRelay>[0], 'dataDir'> }
  | { op: 'tcp'; relayPort: number }
  | { op: 'udp'; relayUdpPort: number }
  | { op: 'meters' }
  | { op: 'close' });

/** 中转在另一台电脑上时，管理请求（加入、批准）不经限速线路、也不计入计量。 */
const ADMIN_LINE: LinkProfile = { name: 'admin', rateBytesPerSec: 1_000_000_000, oneWayDelayMs: 0, queueLimitBytes: 64 * 1024 * 1024 };

class Network {
  private lines: Record<'hostUp' | 'hostDown' | 'controllerUp' | 'controllerDown', LinkDirection> | null = null;
  private readonly closers: Array<() => Promise<unknown> | unknown> = [];
  /** 不经线路代理：中转听所有地址，设备直接连（只在另一台电脑上、--no-line 时）。 */
  private direct = false;
  // 计量每 50 毫秒推一次，主进程按需同步读取时另有 `meters` 指令。
  private readonly push = setInterval(() => { if (this.lines) this.reply({ meters: this.snapshot() }); }, 50);

  /** `remote`：另一台电脑来的控制连接；代理听所有地址，交回 advertise 地址，中转数据放在本机自己的临时目录。 */
  constructor(private readonly reply: (message: unknown) => void,
    private readonly remote: { advertise: string; tls?: { cert: string; key: string } } | null) {}

  private snapshot() {
    return Object.fromEntries(Object.entries(this.lines ?? {}).map(([key, line]) =>
      [key, { bytes: line.bytes, udpBytes: line.udpBytes, dropped: line.dropped } satisfies Meter]));
  }

  private get listenHost() { return this.remote ? '0.0.0.0' : '127.0.0.1'; }
  private address(port: number) { return `${this.remote?.advertise ?? '127.0.0.1'}:${port}`; }

  /** 本机进程用 harness 给的目录；另一台电脑上用自己的临时目录，关闭时删掉。 */
  private async dataDir(given: string, name: string): Promise<string> {
    if (!this.remote) return given;
    const prefix = path.join(tmpdir(), 'cindy-agent-net-bench-remote-');
    const directory = await mkdtemp(prefix);
    this.closers.push(async () => {
      if (!path.resolve(directory).startsWith(prefix)) throw new Error('UNSAFE_BENCH_DIRECTORY');
      await rm(directory, { recursive: true, force: true });
    });
    return path.join(directory, name);
  }

  async handle(request: Request): Promise<unknown> {
    switch (request.op) {
      case 'init': {
        this.direct = !!this.remote && request.direct === true;
        const line = () => new LinkDirection(request.profile);
        this.lines = { hostUp: line(), hostDown: line(), controllerUp: line(), controllerDown: line() };
        return null;
      }
      case 'agent-net-relay': {
        const relay = await startAgentNetRelay({ dataDir: await this.dataDir(request.dataDir, 'agent-net'), bootstrap: request.bootstrap, udpPort: 0,
          ...(this.direct ? { host: '0.0.0.0', udpHost: '0.0.0.0' } : {}) });
        this.closers.push(() => relay.close());
        return { url: relay.url, udpPort: relay.udpAddress?.port ?? null };
      }
      case 'v1-relay': {
        const dataDir = await this.dataDir(request.dataDir, 'v1');
        await initializeRelay({ ...request.init, dataDir });
        const relay = await startRelayServer({ dataDir, port: 0, ...(this.direct ? { host: '0.0.0.0' } : {}) });
        this.closers.push(() => relay.close());
        const port = Number(new URL(relay.localUrl).port);
        if (!this.remote) return { localUrl: relay.localUrl, port };
        if (this.direct) return { localUrl: `http://${this.address(port)}`, port };
        const admin = await startShapedProxy(port, new LinkDirection(ADMIN_LINE), new LinkDirection(ADMIN_LINE), this.listenHost);
        this.closers.push(() => admin.close());
        return { localUrl: `http://${this.address(admin.port)}`, port };
      }
      case 'tcp': {
        if (this.direct) return { host: `http://${this.address(request.relayPort)}`, controller: `http://${this.address(request.relayPort)}` };
        const lines = this.lines!;
        const secure = this.remote?.tls;
        const host = await startShapedProxy(request.relayPort, lines.hostUp, lines.hostDown, this.listenHost, secure);
        const controller = await startShapedProxy(request.relayPort, lines.controllerUp, lines.controllerDown, this.listenHost, secure);
        this.closers.push(() => host.close(), () => controller.close());
        const scheme = secure ? 'https' : 'http';
        return { host: `${scheme}://${this.address(host.port)}`, controller: `${scheme}://${this.address(controller.port)}` };
      }
      case 'udp': {
        if (this.direct) return { host: this.address(request.relayUdpPort), controller: this.address(request.relayUdpPort) };
        const lines = this.lines!;
        const host = await startUdpProxy(request.relayUdpPort, lines.hostUp, lines.hostDown, this.listenHost);
        const controller = await startUdpProxy(request.relayUdpPort, lines.controllerUp, lines.controllerDown, this.listenHost);
        this.closers.push(() => host.close(), () => controller.close());
        return { host: this.address(host.port), controller: this.address(controller.port) };
      }
      case 'meters': return this.snapshot();
      case 'close': await this.close(); return null;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.push);
    for (const close of this.closers.splice(0).reverse()) { try { await close(); } catch { /* best effort */ } }
  }
}

const answer = (network: Network, request: Request, reply: (message: unknown) => void) =>
  network.handle(request).then((result) => reply({ id: request.id, ok: true, result }), (error: unknown) => reply({ id: request.id, ok: false, error: String(error) }));

const listenAt = process.argv.indexOf('--listen');
if (listenAt >= 0) {
  const port = Number(process.argv[listenAt + 1]);
  const advertiseAt = process.argv.indexOf('--advertise');
  const advertise = advertiseAt >= 0 ? process.argv[advertiseAt + 1] : undefined;
  if (!Number.isInteger(port) || !advertise) throw new Error('usage: --listen <port> --advertise <address> [--tls-cert <pem> --tls-key <pem>]');
  // --tls-cert/--tls-key：设备到中转的线路代理用 TLS（压测那边用 NODE_EXTRA_CA_CERTS 信任这张证书），设备才会要中转的 UDP 凭据。
  const certAt = process.argv.indexOf('--tls-cert'), keyAt = process.argv.indexOf('--tls-key');
  const secure = certAt >= 0 && keyAt >= 0
    ? { cert: readFileSync(process.argv[certAt + 1], 'utf8'), key: readFileSync(process.argv[keyAt + 1], 'utf8') } : undefined;
  const server = net.createServer((control) => {
    control.setNoDelay(true);
    const reply = (message: unknown) => { if (!control.destroyed) control.write(JSON.stringify(message) + '\n'); };
    const network = new Network(reply, { advertise, ...(secure ? { tls: secure } : {}) });
    let buffered = '';
    control.on('data', (data) => {
      buffered += data.toString('utf8');
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (line) void answer(network, JSON.parse(line) as Request, reply);
      }
    });
    control.on('error', () => undefined);
    // 压测那边断开（跑完、出错或被中断）时，这一次的中转与线路全部关掉，进程留着等下一次。
    control.on('close', () => { void network.close(); });
  });
  server.listen(port, '0.0.0.0', () => console.log(`bench network listening on 0.0.0.0:${port}, advertising ${advertise}${secure ? ' (tls)' : ''}`));
} else {
  const reply = (message: unknown) => process.send?.(message);
  const network = new Network(reply, null);
  process.on('message', (request: Request) => {
    void answer(network, request, reply).then(() => { if (request.op === 'close') setImmediate(() => process.exit(0)); });
  });
  // 主进程意外退出时跟着退出，不留下占着端口的进程。
  process.on('disconnect', () => process.exit(0));
}
