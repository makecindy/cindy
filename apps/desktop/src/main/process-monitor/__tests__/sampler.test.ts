import { describe, expect, it, vi } from 'vitest';

import type { ProcessMonitorSample } from '../../../shared/processMonitor.js';
import type { OsProcessRow, OsProcessSnapshot } from '../agent-scan.js';
import { buildChildrenByParent } from '../agent-scan.js';
import {
  createProcessMonitorSampler,
  type ChromiumProcessMetric,
  type ProcessMonitorSamplerDeps,
} from '../sampler.js';

const SELF_PID = 100;

function osRow(partial: Partial<OsProcessRow> & { pid: number; ppid: number }): OsProcessRow {
  return {
    state: null,
    cmdLineLower: '',
    memoryKb: 0,
    cpuPercent: 0,
    cpuTimeMs: null,
    startIdentity: `start:${partial.pid}`,
    ...partial,
  };
}

function snapshotOf(rows: OsProcessRow[]): OsProcessSnapshot {
  return { rows, childrenByParent: buildChildrenByParent(rows) };
}

function metric(partial: Partial<ChromiumProcessMetric> & { pid: number }): ChromiumProcessMetric {
  return {
    type: 'Utility',
    cpu: { percentCPUUsage: 1 },
    memory: { workingSetSize: 1024 },
    ...partial,
  };
}

interface HarnessOverrides {
  metrics?: ChromiumProcessMetric[];
  snapshot?: OsProcessSnapshot;
  deps?: Partial<ProcessMonitorSamplerDeps>;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const state = {
    metrics: overrides.metrics ?? [],
    snapshot: overrides.snapshot ?? snapshotOf([]),
    nowMs: 10_000,
    scanCalls: 0,
  };
  const log = { warn: vi.fn() };
  const sampler = createProcessMonitorSampler({
    getMetrics: () => state.metrics,
    scanOsProcesses: () => {
      state.scanCalls += 1;
      return Promise.resolve(state.snapshot);
    },
    describeRendererProcess: () => null,
    classify: (cmd) => {
      if (cmd.includes('claude-marker')) return 'claude';
      if (cmd.includes('codex-marker')) return 'codex';
      if (cmd.includes('pi-marker')) return 'pi';
      return null;
    },
    resolveAgentProcessRegistration: (pid) => {
      const row = state.snapshot.rows.find((candidate) => candidate.pid === pid);
      if (!row) return null;
      const kind = row.cmdLineLower.includes('claude-marker')
        ? 'claude'
        : row.cmdLineLower.includes('codex-marker')
          ? 'codex'
          : row.cmdLineLower.includes('pi-marker')
            ? 'pi'
            : null;
      return kind
        ? { kind, role: 'task-host', instanceId: `start:${pid}` }
        : null;
    },
    selfPid: SELF_PID,
    log,
    osScanIntervalMs: 5_000,
    now: () => state.nowMs,
    ...overrides.deps,
  });
  return { state, sampler, log };
}

function entryByPid(sample: ProcessMonitorSample, pid: number) {
  return sample.entries.find((e) => e.pid === pid);
}

describe('createProcessMonitorSampler', () => {
  it('Chromium 指标映射 kind 与标签;renderer 走注入的标签查询', async () => {
    const { sampler } = makeHarness({
      metrics: [
        metric({ pid: 100, type: 'Browser' }),
        metric({ pid: 200, type: 'Tab' }),
        metric({ pid: 300, type: 'GPU' }),
        metric({ pid: 400, type: 'Utility', serviceName: 'node-runtime' }),
      ],
      deps: { describeRendererProcess: (pid) => (pid === 200 ? '设置' : null) },
    });
    const sample = await sampler.sample();
    expect(entryByPid(sample, 100)).toMatchObject({ kind: 'main', terminable: false });
    expect(entryByPid(sample, 200)).toMatchObject({ kind: 'renderer', label: '设置' });
    expect(entryByPid(sample, 300)).toMatchObject({ kind: 'gpu' });
    expect(entryByPid(sample, 400)).toMatchObject({ kind: 'utility', label: 'node-runtime' });
  });

  it('agent 根进程按整棵子树聚合 CPU / 内存 / 进程数,外部进程不认领', async () => {
    const { sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({ pid: 501, ppid: SELF_PID, cmdLineLower: 'x claude-marker y', cpuPercent: 10, memoryKb: 100 }),
        osRow({ pid: 502, ppid: 501, cmdLineLower: 'bash worker', cpuPercent: 40, memoryKb: 200 }),
        osRow({ pid: 503, ppid: 502, cmdLineLower: 'node mcp', cpuPercent: 5, memoryKb: 300 }),
        // ppid 不是本进程:哪怕命中 marker 也不算我们的(另一实例的 agent)。
        osRow({ pid: 601, ppid: 999, cmdLineLower: 'claude-marker other', cpuPercent: 99, memoryKb: 999 }),
      ]),
    });
    const sample = await sampler.sample();
    const agent = entryByPid(sample, 501);
    expect(agent).toMatchObject({
      kind: 'agent-claude',
      cpuPercent: 55,
      memoryKb: 600,
      processCount: 3,
      terminable: true,
      processInstanceId: 'start:501',
    });
    expect(entryByPid(sample, 601)).toBeUndefined();
  });

  it('Codex 任务宿主与控制面服务带角色，控制面不可终止', async () => {
    const { sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({ pid: 701, ppid: SELF_PID, cmdLineLower: 'codex-marker task' }),
        osRow({ pid: 702, ppid: SELF_PID, cmdLineLower: 'codex-marker service' }),
      ]),
      deps: {
        resolveAgentProcessRegistration: (pid) => ({
          kind: 'codex',
          role: pid === 701 ? 'task-host' : 'control-plane-service',
          instanceId: `instance:${pid}`,
        }),
      },
    });
    const sample = await sampler.sample();
    expect(entryByPid(sample, 701)).toMatchObject({
      agentRole: 'task-host',
      terminable: true,
    });
    expect(entryByPid(sample, 702)).toMatchObject({
      agentRole: 'control-plane-service',
      terminable: false,
    });
  });

  it('Codex 角色未知时按不可终止处理', async () => {
    const { sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({ pid: 703, ppid: SELF_PID, cmdLineLower: 'codex-marker unknown' }),
      ]),
      deps: { resolveAgentProcessRegistration: () => null },
    });
    expect(entryByPid(await sampler.sample(), 703)).toMatchObject({
      kind: 'agent-codex',
      terminable: false,
    });
  });

  it('OS 未提供出生身份时即使归属明确也不可终止', async () => {
    const { sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({
          pid: 704,
          ppid: SELF_PID,
          cmdLineLower: 'claude-marker unknown-start',
          startIdentity: null,
        }),
      ]),
    });
    expect(entryByPid(await sampler.sample(), 704)).toMatchObject({
      kind: 'agent-claude',
      terminable: false,
    });
    expect(entryByPid(await sampler.sample(), 704)?.processInstanceId).toBeUndefined();
  });

  it('Windows conhost 不计入可见进程数，但资源仍计入整棵树', async () => {
    const { sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({
          pid: 801,
          ppid: SELF_PID,
          cmdLineLower: 'c:\\cindy\\codex-marker.exe app-server',
          cpuPercent: 4,
          memoryKb: 100,
        }),
        osRow({
          pid: 802,
          ppid: 801,
          cmdLineLower: '\\??\\c:\\windows\\system32\\conhost.exe 0x4',
          cpuPercent: 1,
          memoryKb: 20,
        }),
      ]),
    });
    const entry = entryByPid(await sampler.sample(), 801);
    expect(entry).toMatchObject({
      processCount: 1,
      cpuPercent: 5,
      memoryKb: 120,
    });
  });

  it('OS 扫描按周期缓存:未过期不重扫,过期后重扫', async () => {
    const { state, sampler } = makeHarness();
    await sampler.sample();
    expect(state.scanCalls).toBe(1);
    state.nowMs += 2_000; // 未过期
    await sampler.sample();
    expect(state.scanCalls).toBe(1);
    state.nowMs += 5_000; // 过期
    await sampler.sample();
    expect(state.scanCalls).toBe(2);
  });

  it('Windows CPU 差分:首个样本 0,第二个样本按累计时间差算百分比', async () => {
    const { state, sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({ pid: 700, ppid: SELF_PID, cmdLineLower: 'codex-marker', cpuPercent: null, cpuTimeMs: 1_000, memoryKb: 10 }),
      ]),
    });
    const first = await sampler.sample();
    expect(entryByPid(first, 700)?.cpuPercent).toBe(0);

    state.nowMs += 5_000;
    state.snapshot = snapshotOf([
      osRow({ pid: 700, ppid: SELF_PID, cmdLineLower: 'codex-marker', cpuPercent: null, cpuTimeMs: 2_500, memoryKb: 10 }),
    ]);
    const second = await sampler.sample();
    // Δcpu 1500ms / Δwall 5000ms = 30%
    expect(entryByPid(second, 700)?.cpuPercent).toBe(30);
  });

  it('Windows 同一 pid 的出生身份变化时重置 CPU 差分基线', async () => {
    const { state, sampler } = makeHarness({
      snapshot: snapshotOf([
        osRow({
          pid: 710,
          ppid: SELF_PID,
          cmdLineLower: 'claude-marker',
          cpuPercent: null,
          cpuTimeMs: 8_000,
          startIdentity: 'start:old',
        }),
      ]),
    });
    await sampler.sample();

    state.nowMs += 5_000;
    state.snapshot = snapshotOf([
      osRow({
        pid: 710,
        ppid: SELF_PID,
        cmdLineLower: 'claude-marker',
        cpuPercent: null,
        cpuTimeMs: 500,
        startIdentity: 'start:new',
      }),
    ]);
    expect(entryByPid(await sampler.sample(), 710)?.cpuPercent).toBe(0);
  });

  it('OS 扫描失败降级为无 agent 条目,Chromium 部分照常且失败被记录', async () => {
    const { sampler, log } = makeHarness({
      metrics: [metric({ pid: 100, type: 'Browser' })],
      deps: { scanOsProcesses: () => Promise.reject(new Error('ps blew up')) },
    });
    const sample = await sampler.sample();
    expect(sample.entries).toHaveLength(1);
    expect(entryByPid(sample, 100)?.kind).toBe('main');
    expect(log.warn).toHaveBeenCalledWith(
      'process monitor os scan failed',
      expect.objectContaining({ error: 'ps blew up' }),
    );
  });

  it('Windows 预热首帧不等待 OS 扫描，完成后由下一 tick 补齐 agent', async () => {
    let resolveScan!: (snapshot: OsProcessSnapshot) => void;
    const pendingScan = new Promise<OsProcessSnapshot>((resolve) => {
      resolveScan = resolve;
    });
    const { sampler } = makeHarness({
      metrics: [metric({ pid: 100, type: 'Browser' })],
      deps: {
        deferOsScan: true,
        scanOsProcesses: () => pendingScan,
      },
    });

    const first = await sampler.sample();
    expect(first.entries).toHaveLength(1);
    expect(entryByPid(first, 100)?.kind).toBe('main');

    resolveScan(
      snapshotOf([osRow({ pid: 501, ppid: SELF_PID, cmdLineLower: 'x claude-marker y' })]),
    );
    await pendingScan;
    await Promise.resolve();

    expect(entryByPid(await sampler.sample(), 501)?.kind).toBe('agent-claude');
  });
});
