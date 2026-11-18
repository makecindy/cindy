/**
 * 大数据按块传（docs/agent-net-session-plan.md 第 11 节的全面对比）。
 *
 * 经 Device Link 传的大数据都是分块的：远程任务上传附件每块 512 KB（`REMOTE_AGENT_UPLOAD_CHUNK_BYTES`），
 * 大结果按 128 KB 切成传输块。这里照这个用法：一共 20 MiB，每块 512 KB，同时 4 块在途；
 * down 是控制端一块块拉被控端的数据，up 是控制端一块块推给被控端。传的同时每 500 毫秒发一个小请求，看交互延迟。
 * 文件本体在产品里走 WebRTC 数据通道，不在这里。
 *
 * 运行（仓库根目录）：
 *   pnpm --filter @cindy/agent-net run prepare-core
 *   node --import tsx packages/agent-net/bench/bulk-transfer.ts [--profiles fast,wide,far] [--modes v1,worker,udp-relay]
 *     [--runs 1] [--total-mib 20] [--chunk-kib 512] [--concurrency 4] [--out bulk.json]
 *     [--raw]     绕过 Device Link，同样大小的块直接写进 Agent-Net 连接，区分瓶颈在 Device Link 还是在它下面
 *     [--sample]  每 200 毫秒打印发送方的 socket 缓冲、Device Link 待确认队列（portable 方式还有核心统计）和主线程事件循环延迟
 *     [--in-process-network]  中转与限速线路放回本进程（2026-11-14 之前的做法，见 harness.ts 的 BenchNetwork）
 *     [--remote-network <地址>:<端口>] [--no-line]  中转放在另一台电脑上（见 network-process.ts）
 *     [--no-taps] 传的同时不发小请求
 *     [--sample-ms <毫秒>] --sample 的采样间隔，默认 200
 *     [--interleave] 每一轮各方式各跑一次（真实线路上比较时用）
 */
import { readFile, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { PROTOCOL_VERSION } from '@cindy/device-link';
import { PROFILES, BULK_CHANNEL, TAP_CHANNEL, argument, setup, sleep, type Fixture, type SocketMode } from './harness.js';

const TIMEOUT_MS = 600_000;

function stats(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!sorted.length) return null;
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), max: Math.round(sorted[sorted.length - 1]) };
}

/** --raw：绕过 Device Link，把同样大小的块作为推送帧直接写进 Agent-Net socket（积压超过 1 MiB 时等它回落），量到对端收齐为止。
 * 和正常方式对比，区分瓶颈在 Device Link 还是在 Agent-Net 及以下。 */
async function rawTransfer(f: Fixture, direction: 'down' | 'up', totalBytes: number, chunkBytes: number) {
  const [role, receiverRole, peer] = direction === 'down' ? ['host', 'controller', 'b-controller'] as const : ['controller', 'host', 'a-host'] as const;
  const sender = f.socket(role) as unknown as { send(frame: string): void; bufferedAmount?: number };
  const receiver = f.socket(receiverRole) as unknown as { on(e: 'message', l: (raw: { toString(): string }) => void): unknown; off(e: 'message', l: (raw: { toString(): string }) => void): unknown };
  const chunks = Math.ceil(totalBytes / chunkBytes), payload = f.bulkPayload.slice(0, chunkBytes);
  const t0 = performance.now();
  let received = 0;
  const done = new Promise<void>((resolve) => {
    const listener = (raw: { toString(): string }) => { if (raw.toString().includes('"bench:raw-bulk"') && ++received >= chunks) { receiver.off('message', listener); resolve(); } };
    receiver.on('message', listener);
  });
  for (let index = 0; index < chunks; index++) {
    while ((sender.bufferedAmount ?? 0) > 1024 * 1024) await sleep(1);
    sender.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: peer, payload: { channel: 'bench:raw-bulk', args: [index, payload] } }));
  }
  await done;
  return { ms: Math.round(performance.now() - t0), failed: 0, taps: null, tapsFailed: 0 };
}

async function transfer(f: Fixture, direction: 'down' | 'up', totalBytes: number, chunkBytes: number, concurrency: number, tag: string) {
  if (process.argv.includes('--raw')) return rawTransfer(f, direction, totalBytes, chunkBytes);
  const chunk = f.bulkPayload.slice(0, chunkBytes);
  const chunks = Math.ceil(totalBytes / chunkBytes);
  let next = 0, failed = 0, done = false;
  const t0 = performance.now();
  const worker = async () => {
    while (next < chunks) {
      next++;
      const result = await f.request({ channel: BULK_CHANNEL, args: direction === 'down' ? ['down', chunkBytes] : ['up', chunk] }, TIMEOUT_MS)
        .catch(() => ({ ok: false as const }));
      if (!result.ok) failed++;
    }
  };
  const taps: Array<Promise<number>> = [];
  // --no-taps：传的同时不发小请求。会话层的小请求走交互通道，核心会进低排队模式；不发时量的是普通模式的速度。
  const tapLoop = (async () => {
    for (let index = 0; !done && !process.argv.includes('--no-taps'); index++) {
      const sentAt = performance.now();
      taps.push(f.request({ channel: TAP_CHANNEL, args: [`${tag}-${index}`] }, TIMEOUT_MS)
        .then((result) => (result.ok ? performance.now() - sentAt : NaN), () => NaN));
      await sleep(500);
    }
  })();
  // --sample：每 200 毫秒打印发送方的核心统计（portable 方式才读得到）、socket 缓冲和 Device Link 待确认队列。只读私有字段。
  const lag = process.argv.includes('--sample') ? monitorEventLoopDelay({ resolution: 5 }) : null;
  lag?.enable();
  const sampler = process.argv.includes('--sample') ? setInterval(() => {
    const role = direction === 'down' ? 'host' : 'controller', peerId = direction === 'down' ? 'b-controller' : 'a-host';
    const socket = f.socket(role) as unknown as { bufferedAmount?: number; peers?: Map<string, { channel?: { stats?(): Record<string, number> | null } }> };
    const core = socket.peers?.get(peerId)?.channel?.stats?.() ?? null;
    const dl = (role === 'host' ? f.host : f.controller) as unknown as null | { peerTransport?: Map<string, { pending?: Map<number, { lastBlockedBy?: string; sent?: boolean }> }> };
    const pending = [...dl?.peerTransport?.get(peerId)?.pending?.values() ?? []];
    const blocked: Record<string, number> = {};
    for (const item of pending) { const key = item.sent ? 'sent' : (item.lastBlockedBy ?? 'none'); blocked[key] = (blocked[key] ?? 0) + 1; }
    console.log(`  ${Math.round(performance.now() - t0)}ms buffered=${Math.round((socket.bufferedAmount ?? 0) / 1024)}K `
      + (core ? `core=${JSON.stringify(core)} ` : '')
      + `pending=${JSON.stringify(blocked)}`);
  }, Number(argument('--sample-ms') ?? 200)) : null;
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (sampler) clearInterval(sampler);
  if (lag) { lag.disable(); console.log(`  主线程事件循环延迟 p50 ${(lag.percentile(50) / 1e6).toFixed(1)} p99 ${(lag.percentile(99) / 1e6).toFixed(1)} 最大 ${(lag.max / 1e6).toFixed(1)} 毫秒`); }
  const ms = performance.now() - t0;
  done = true;
  await tapLoop;
  const tapRtts = await Promise.all(taps);
  return { ms: Math.round(ms), failed, taps: stats(tapRtts), tapsFailed: tapRtts.filter((value) => !Number.isFinite(value)).length };
}

async function main() {
  const runs = Number(argument('--runs') ?? 1);
  const totalBytes = Number(argument('--total-mib') ?? 20) * 1024 * 1024;
  const chunkBytes = Number(argument('--chunk-kib') ?? 512) * 1024;
  const concurrency = Number(argument('--concurrency') ?? 4);
  const profiles = (argument('--profiles') ?? 'fast,wide,far').split(',').map((name) => {
    const profile = PROFILES[name];
    if (!profile) throw new Error('UNKNOWN_PROFILE ' + name);
    return profile;
  });
  const modes = (argument('--modes') ?? 'v1,worker,udp-relay').split(',') as SocketMode[];
  const module = await WebAssembly.compile(await readFile(new URL('../../agent-net-core/dist/core.wasm', import.meta.url)));
  const results: unknown[] = [];
  // --interleave：每一轮把各方式各跑一次再进下一轮。真实线路的速度随时间变，按方式成批跑会把这段时间的变化算到某一种方式头上。
  const order = process.argv.includes('--interleave')
    ? Array.from({ length: runs }, (_, index) => modes.map((mode) => [mode, index + 1] as const)).flat()
    : modes.map((mode) => Array.from({ length: runs }, (_, index) => [mode, index + 1] as const)).flat();
  for (const profile of profiles) {
    for (const [mode, run] of order) {
      const f = await setup(profile, module, mode);
      try {
        await sleep(1000);
        for (const direction of ['down', 'up'] as const) {
          // 数据方向上的线路字节（含重发、尾部丢弃的包）除以业务字节：分出协议开销和线路利用率。
          const meter = () => (direction === 'down' ? f.meters.hostUp : f.meters.controllerUp);
          await f.syncMeters();
          const wireBefore = meter().bytes, droppedBefore = meter().dropped;
          // 压测进程（两台设备的 Main 和 Agent-Net 线程）这一段用掉的 CPU；中转与线路在别的进程或别的电脑上，不算在内。
          const cpuBefore = process.cpuUsage();
          const result = await transfer(f, direction, totalBytes, chunkBytes, concurrency, `${profile.name}-${mode}-${run}-${direction}`);
          await f.syncMeters();
          const cpu = process.cpuUsage(cpuBefore);
          const cpuMs = Math.round((cpu.user + cpu.system) / 1000), cpuMsPerMiB = Number((cpuMs / (totalBytes / 1048576)).toFixed(1));
          const wireRatio = Number(((meter().bytes - wireBefore) / totalBytes).toFixed(3)), dropped = meter().dropped - droppedBefore;
          const utilization = profile.rateBytesPerSec >= 1e9 ? null : Number(((totalBytes / (result.ms / 1000)) / profile.rateBytesPerSec).toFixed(2));
          results.push({ profile, mode, run, direction, totalBytes, chunkBytes, concurrency, utilization, wireRatio, dropped, cpuMs, cpuMsPerMiB, ...result });
          console.log([profile.name, mode, `run${run}`, direction, `${result.ms}ms`,
            `${(totalBytes / 1e6 / (result.ms / 1000)).toFixed(2)}MB/s`, `util=${utilization ?? '-'}`, `wire=${wireRatio}`, `dropped=${dropped}`, `cpu=${cpuMsPerMiB}ms/MiB`, `failed=${result.failed}`,
            `tapRTT p50/p90/max=${result.taps ? `${result.taps.p50}/${result.taps.p90}/${result.taps.max}` : '-'}`,
            `tapsFailed=${result.tapsFailed}`].join(' '));
          await sleep(1000);
        }
      } finally {
        await f.close();
      }
    }
  }
  const out = argument('--out');
  if (out) await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version,
    platform: `${process.platform}-${process.arch}`, totalBytes, chunkBytes, concurrency, results }, null, 2) + '\n');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
