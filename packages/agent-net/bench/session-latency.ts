/**
 * Agent-Net 会话层方案阶段 0 基线（docs/agent-net-session-plan.md 第 10 节）。
 *
 * 量什么：现有 DeviceLinkClient 经 Agent-Net 中转（UDP 关闭，只走 443 WebSocket）时，
 * 一条大消息在途，小的交互请求要等多久；线路上实际传了多少字节（含各层重发）。
 * 环境见 harness.ts：生产入口 AgentNetWorkerSocket（Desktop 用的独立线程 + Main 代理）+ 真正的 DeviceLinkClient。
 *
 * 运行（仓库根目录）：
 *   pnpm --filter @cindy/agent-net run prepare-core
 *   node --import tsx packages/agent-net/bench/session-latency.ts [--runs 2] [--profiles fast,slow,very-slow] [--out results.json] [--log]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PROFILES, BULK_BYTES, BULK_CHANNEL, TAP_CHANNEL, argument, setup, sleep, trace, type Fixture, type SocketMode } from './harness.js';

const INVOKE_TIMEOUT_MS = 180_000;
/** `--prod-timeouts`：小请求用生产默认超时（DeviceLinkClient 的 30 秒），而不是为测耗时放宽的 180 秒；大消息仍用 180 秒。 */
const TAP_TIMEOUT_MS = process.argv.includes('--prod-timeouts') ? undefined : INVOKE_TIMEOUT_MS;

interface TapSample { ok: boolean; rttMs: number; arriveMs: number | null; error?: string }

function stats(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!sorted.length) return null;
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), max: Math.round(sorted[sorted.length - 1]) };
}

/**
 * idle：只有小请求。down：被控端回一条 1 MiB 结果（对应大任务列表）。up：控制端发一条 1 MiB 请求（对应附件上传）。
 * 大消息发出后，每 500 ms 发一个小请求，一直发到大消息完成后再多 2 秒。
 */
async function scenario(f: Fixture, kind: 'idle' | 'down' | 'up', tag: string) {
  await f.syncMeters();
  const before = {
    hostUp: f.meters.hostUp.bytes, hostDown: f.meters.hostDown.bytes,
    controllerUp: f.meters.controllerUp.bytes, controllerDown: f.meters.controllerDown.bytes,
  };
  const udpBefore = { hostUp: f.meters.hostUp.udpBytes, controllerUp: f.meters.controllerUp.udpBytes };
  const droppedBefore = Object.values(f.meters).reduce((sum, meter) => sum + meter.dropped, 0);
  const retriesBefore = f.diagnostics.headRetries, warningsBefore = f.diagnostics.warnings;
  const t0 = performance.now();
  // 在回调里赋值；初值用断言，免得 TypeScript 把它们收窄成 null。
  let bulkDoneAt = null as number | null;
  let bulkResult = null as { ok: boolean; ms: number; error?: string } | null;
  const bulk = kind === 'idle' ? Promise.resolve() : f.request({
    channel: BULK_CHANNEL, args: kind === 'up' ? ['up', f.bulkPayload] : ['down'],
  }, INVOKE_TIMEOUT_MS).then((result) => {
    bulkDoneAt = performance.now();
    bulkResult = { ok: result.ok, ms: Math.round(bulkDoneAt - t0), ...(result.ok ? {} : { error: result.error.code }) };
  }, (error: { code?: string; message?: string }) => {
    bulkDoneAt = performance.now();
    bulkResult = { ok: false, ms: Math.round(bulkDoneAt - t0), error: String(error.code ?? error.message) };
  });
  if (kind !== 'idle') await sleep(100);
  const taps: Array<Promise<TapSample>> = [];
  for (let index = 0; ; index++) {
    if (kind === 'idle' ? index >= 10 : bulkDoneAt !== null && performance.now() - bulkDoneAt > 2000) break;
    if (performance.now() - t0 > INVOKE_TIMEOUT_MS) break;
    const id = `${tag}-${index}`;
    const sentAt = performance.now();
    taps.push(f.request({ channel: TAP_CHANNEL, args: [id] }, TAP_TIMEOUT_MS).then(
      (result) => {
        const arrived = f.hostReceivedAt.get(id);
        return { ok: result.ok, rttMs: performance.now() - sentAt, arriveMs: arrived === undefined ? null : arrived - sentAt,
          ...(result.ok ? {} : { error: result.error.code }) };
      },
      (error: { code?: string; message?: string }) => ({ ok: false, rttMs: performance.now() - sentAt, arriveMs: null,
        error: String(error.code ?? error.message) }),
    ));
    await sleep(500);
  }
  const samples = await Promise.all(taps);
  await bulk;
  await sleep(500);
  await f.syncMeters();
  const wire = {
    hostUp: f.meters.hostUp.bytes - before.hostUp, hostDown: f.meters.hostDown.bytes - before.hostDown,
    controllerUp: f.meters.controllerUp.bytes - before.controllerUp, controllerDown: f.meters.controllerDown.bytes - before.controllerDown,
  };
  // 大消息方向上的线路字节 / 业务字节。fast 线路上没有重发，用它对照协议本身的开销。
  const bulkWire = kind === 'down' ? wire.hostUp : kind === 'up' ? wire.controllerUp : null;
  // 大消息方向上走 UDP 的比例（udp-relay 模式下应接近 1，否则说明退回了 443 WebSocket）。
  const bulkUdp = kind === 'down' ? f.meters.hostUp.udpBytes - udpBefore.hostUp
    : kind === 'up' ? f.meters.controllerUp.udpBytes - udpBefore.controllerUp : null;
  return {
    kind,
    bulk: bulkResult,
    taps: {
      roundTrip: stats(samples.filter((s) => s.ok).map((s) => s.rttMs)),
      arriveAtHost: stats(samples.map((s) => s.arriveMs ?? NaN)),
      failed: samples.filter((s) => !s.ok).map((s) => s.error),
    },
    wire,
    bulkWireRatio: bulkWire === null ? null : Number((bulkWire / BULK_BYTES).toFixed(2)),
    bulkUdpShare: bulkWire === null || bulkUdp === null || bulkWire === 0 ? null : Number((bulkUdp / bulkWire).toFixed(2)),
    udpDropped: Object.values(f.meters).reduce((sum, meter) => sum + meter.dropped, 0) - droppedBefore,
    deviceLinkHeadRetries: f.diagnostics.headRetries - retriesBefore,
    deviceLinkWarnings: f.diagnostics.warnings - warningsBefore,
  };
}

async function main() {
  const runs = Number(argument('--runs') ?? 2);
  const profiles = (argument('--profiles') ?? 'fast,slow,very-slow').split(',').map((name) => {
    const profile = PROFILES[name];
    if (!profile) throw new Error('UNKNOWN_PROFILE ' + name);
    return profile;
  });
  /** `--modes worker,v1`：worker = 经 Agent-Net（Desktop 生产形态）；v1 = 原来的 Device Link 中转。 */
  const modes = (argument('--modes') ?? 'worker').split(',') as SocketMode[];
  const module = await WebAssembly.compile(await readFile(new URL('../../agent-net-core/dist/core.wasm', import.meta.url)));
  const results: unknown[] = [];
  for (const profile of profiles) {
    for (const mode of modes) for (let run = 1; run <= runs; run++) {
      const f = await setup(profile, module, mode);
      try {
        for (const kind of ['idle', 'down', 'up'] as const) {
          const result = await scenario(f, kind, `${profile.name}-${mode}-${run}-${kind}`);
          results.push({ profile, mode, run, ...result });
          const rt = result.taps.roundTrip, arrive = result.taps.arriveAtHost;
          trace('bench', 'scenario-end', `${profile.name} ${mode} run${run} ${kind}`);
          console.log([profile.name, mode, `run${run}`, kind,
            `bulk=${result.bulk ? `${result.bulk.ms}ms${result.bulk.ok ? '' : ' ' + result.bulk.error}` : '-'}`,
            `tapRTT p50/p90/max=${rt ? `${rt.p50}/${rt.p90}/${rt.max}` : '-'}`,
            `arrive p50/max=${arrive ? `${arrive.p50}/${arrive.max}` : '-'}`,
            `failed=${result.taps.failed.length}`,
            `wireRatio=${result.bulkWireRatio ?? '-'}`,
            `udp=${result.bulkUdpShare ?? '-'}`,
            `drop=${result.udpDropped}`,
            `headRetries=${result.deviceLinkHeadRetries}`].join(' '));
          await sleep(1000);
        }
      } finally {
        await f.close();
      }
    }
  }
  const out = argument('--out');
  if (out) await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version,
    platform: `${process.platform}-${process.arch}`, bulkBytes: BULK_BYTES, results }, null, 2) + '\n');
  // Worker 线程与计时器可能还挂着，基准结束即退出。
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
