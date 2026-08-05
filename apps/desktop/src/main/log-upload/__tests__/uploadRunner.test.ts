/**
 * 上报编排的锁：标记收尾语义、节流、以及「不该上传时零请求」。
 *
 * 标记收尾是本功能里最容易静默丢数据的地方，所以每种 outcome 都单独钉住「标记被清除还是被
 * 还原」：
 *  - 成功且非空 ⇒ 清除
 *  - 采到 0 条 / 上传失败 / 授权读不出来 / 节流 ⇒ 还原（下次启动重试）
 *  - 明确拒绝（未同意 / 开关关闭 / 未配置）⇒ 清空全部
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_UPLOAD_MIN_INTERVAL_MS } from '../limits';
import type { ClaimedMarker, PendingMarkerStore } from '../pendingMarkers';
import type { CollectResult, LogUploadTarget, UploadRecord } from '../types';
import {
  resetThrottleForTests,
  runUpload,
  type UploadRunnerDeps,
} from '../uploadRunner';

const TARGET: LogUploadTarget = { project: 'p', logstore: 'l', endpointHost: 'h.example.com' };

function record(msg = 'infra line'): UploadRecord {
  return {
    ts: '2026-08-04T10:00:00.000+08:00',
    level: 'info',
    src: 'main',
    scope: 'lifecycle',
    msg,
  };
}

/** 默认覆盖标准 claim 的锚点，成功路径照旧 resolve；测「未覆盖」时显式传别的集合。 */
function collected(records: UploadRecord[], coveredAnchors = [1_775_000_000_000]): CollectResult {
  return {
    records,
    coveredAnchors,
    stats: {
      filesRead: 1,
      bytesRead: 100,
      filesSkippedLegacyFormat: 0,
      mainFilesStoppedAtViolation: 0,
      linesScanned: records.length,
      kept: records.length,
      droppedBySource: 0,
      droppedByCap: 0,
      lookbackDays: 2,
    },
  };
}

function claim(token: string, crashAtMs = 1_775_000_000_000): ClaimedMarker {
  return {
    marker: {
      v: 1,
      token,
      kind: 'crash',
      crashAtMs,
      appVersion: '1.2.3',
      pid: 1,
      createdAt: '2026-08-04T10:00:00.000Z',
    },
    claimPath: `/tmp/pending-x-${token}.json.claim.1.run`,
    originalPath: `/tmp/pending-x-${token}.json`,
  };
}

interface Harness {
  deps: UploadRunnerDeps;
  markers: {
    resolveClaimed: ReturnType<typeof vi.fn>;
    releaseClaimed: ReturnType<typeof vi.fn>;
    clearAll: ReturnType<typeof vi.fn>;
  };
  send: ReturnType<typeof vi.fn>;
  collect: ReturnType<typeof vi.fn>;
  nowRef: { value: number };
}

function harness(overrides: Partial<UploadRunnerDeps> = {}): Harness {
  const markers = {
    resolveClaimed: vi.fn(),
    releaseClaimed: vi.fn(),
    clearAll: vi.fn(() => 0),
  };
  const collect = vi.fn(async () => collected([record()]));
  const send = vi.fn(async () => ({ ok: true as const, batches: 1, records: 1 }));
  const nowRef = { value: 1_775_000_000_000 };
  const deps: UploadRunnerDeps = {
    gate: {
      isTargetConfigured: () => true,
      refreshFromDisk: () => undefined,
      readPrivacyConsentAccepted: () => true,
      readCrashAutoUploadEnabled: () => true,
    },
    resolveTarget: () => TARGET,
    collect,
    send,
    buildMeta: ({ uploadCode, reason, crashToken, crashAtMs }) => ({
      uploadCode,
      userId: '',
      deviceId: 'd',
      appVersion: '1.2.3',
      region: 'cn',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '24.6.0',
      uiLanguage: 'zh-CN',
      reason,
      crashToken,
      crashAtMs,
    }),
    generateUploadCode: () => 'ABCD-2345',
    markers: markers as unknown as PendingMarkerStore,
    now: () => nowRef.value,
    log: { info: () => undefined, warn: () => undefined },
    ...overrides,
  };
  return { deps, markers, send, collect, nowRef };
}

beforeEach(() => {
  resetThrottleForTests();
});

describe('成功路径', () => {
  it('手动上传成功 ⇒ 返回上传编号与条数', async () => {
    const { deps } = harness();
    const outcome = await runUpload(deps, { reason: 'manual', anchors: [], claimed: [] });
    expect(outcome).toEqual({ kind: 'uploaded', uploadCode: 'ABCD-2345', recordCount: 1 });
  });

  it('补传成功且非空 ⇒ 清除已认领的标记', async () => {
    const { deps, markers } = harness();
    const claims = [claim('t1'), claim('t2')];

    await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1_775_000_000_000],
      claimed: claims,
      crashToken: 't1',
    });

    expect(markers.resolveClaimed).toHaveBeenCalledTimes(2);
    expect(markers.releaseClaimed).not.toHaveBeenCalled();
  });

  /**
   * 2026-08-04 review P1：同一天两次崩溃、当天日志超大时,采集窗口可能只覆盖靠前那次;
   * 上报虽非空,但没含靠后那次崩溃。这时**只清覆盖到的**标记,没覆盖到的保留待补传 ——
   * 否则一次成功上报把没采到的崩溃现场永久清掉。
   */
  it('⚠️ 只清覆盖到的标记：未覆盖的崩溃标记保留待补传', async () => {
    const coveredAt = 1_775_000_000_000;
    const missedAt = 1_775_000_500_000;
    const { deps, markers } = harness({
      collect: vi.fn(async () => collected([record()], [coveredAt])) as never,
    });
    const covered = claim('covered', coveredAt);
    const missed = claim('missed', missedAt);

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [coveredAt, missedAt],
      claimed: [covered, missed],
      crashToken: 'covered',
    });

    expect(outcome.kind).toBe('uploaded');
    // 覆盖到的那条被清除,没覆盖到的被还原(保留),而不是一起清掉。
    expect(markers.resolveClaimed).toHaveBeenCalledTimes(1);
    expect(markers.resolveClaimed).toHaveBeenCalledWith(covered);
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(1);
    expect(markers.releaseClaimed).toHaveBeenCalledWith(missed);
  });

  it('崩溃归组令牌被带进元数据（即时与补传在后台能归成同一次崩溃）', async () => {
    const buildMeta = vi.fn(harness().deps.buildMeta);
    const { deps } = harness({ buildMeta });

    await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1_775_000_000_000],
      claimed: [claim('t1')],
      crashToken: 't1',
      crashAtMs: 1_775_000_000_000,
    });

    expect(buildMeta).toHaveBeenCalledWith(
      expect.objectContaining({ crashToken: 't1', crashAtMs: 1_775_000_000_000 }),
    );
  });
});

describe('不该上传时：零请求 + 标记处置', () => {
  it('未同意隐私政策 ⇒ 不采集、不发送、清空全部标记', async () => {
    const { deps, markers, send, collect } = harness({
      gate: {
        isTargetConfigured: () => true,
        refreshFromDisk: () => undefined,
        readPrivacyConsentAccepted: () => false,
        readCrashAutoUploadEnabled: () => true,
      },
    });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });

    expect(outcome).toEqual({ kind: 'skipped-no-consent' });
    expect(collect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(markers.clearAll).toHaveBeenCalledTimes(1);
  });

  it('崩溃开关关闭 ⇒ 零请求 + 清空标记（不得在下次启动补传）', async () => {
    const { deps, markers, send } = harness({
      gate: {
        isTargetConfigured: () => true,
        refreshFromDisk: () => undefined,
        readPrivacyConsentAccepted: () => true,
        readCrashAutoUploadEnabled: () => false,
      },
    });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });

    expect(outcome).toEqual({ kind: 'skipped-crash-auto-off' });
    expect(send).not.toHaveBeenCalled();
    expect(markers.clearAll).toHaveBeenCalledTimes(1);
  });

  it('未配置目标 ⇒ 零请求', async () => {
    const { deps, send, collect } = harness({
      gate: {
        isTargetConfigured: () => false,
        refreshFromDisk: () => undefined,
        readPrivacyConsentAccepted: () => true,
        readCrashAutoUploadEnabled: () => true,
      },
    });

    const outcome = await runUpload(deps, { reason: 'manual', anchors: [], claimed: [] });

    expect(outcome).toEqual({ kind: 'skipped-not-configured' });
    expect(collect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * 2026-08-04 review P1：`not-configured` 不是用户撤回授权,而是这个构建传不了(无版本/dev 包
   * 没有 config,或注入异常)。dev/正式版共享 userData —— 若清标记,用户先用没配上报的构建打开
   * 就会把正式版还没补传的崩溃现场永久删掉。所以只 release(保留),绝不 clearAll。
   */
  it('⚠️ 未配置目标 + 崩溃补传：保留标记，不清空（dev/正式版共享 userData）', async () => {
    const { deps, markers } = harness({
      gate: {
        isTargetConfigured: () => false,
        refreshFromDisk: () => undefined,
        readPrivacyConsentAccepted: () => true,
        readCrashAutoUploadEnabled: () => true,
      },
    });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1_775_000_000_000],
      claimed: [claim('t1'), claim('t2')],
    });

    expect(outcome).toEqual({ kind: 'skipped-not-configured' });
    expect(markers.clearAll).not.toHaveBeenCalled();
    expect(markers.resolveClaimed).not.toHaveBeenCalled();
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(2); // 两条都还原保留
  });

  it('授权读不出来 ⇒ unknown：不上传但**还原**标记（不能用一次读取失败丢掉崩溃现场）', async () => {
    const { deps, markers, send } = harness({
      gate: {
        isTargetConfigured: () => true,
        refreshFromDisk: () => undefined,
        readPrivacyConsentAccepted: () => {
          throw new Error('not ready');
        },
        readCrashAutoUploadEnabled: () => true,
      },
    });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });

    expect(outcome).toEqual({ kind: 'skipped-consent-unknown' });
    expect(send).not.toHaveBeenCalled();
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(1);
    expect(markers.clearAll).not.toHaveBeenCalled();
  });
});

describe('失败与空结果：标记必须保留', () => {
  it('采到 0 条 ⇒ 还原标记，下次启动重试', async () => {
    const { deps, markers, send } = harness({ collect: vi.fn(async () => collected([])) });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });

    expect(outcome).toEqual({ kind: 'empty' });
    expect(send).not.toHaveBeenCalled();
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(1);
    expect(markers.resolveClaimed).not.toHaveBeenCalled();
  });

  it('上传失败（离线）⇒ 还原标记', async () => {
    const { deps, markers } = harness({
      send: vi.fn(async () => ({ ok: false as const, batches: 0, sentRecords: 0, status: 0 })),
    });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });

    expect(outcome).toEqual({ kind: 'failed', status: 0 });
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(1);
    expect(markers.resolveClaimed).not.toHaveBeenCalled();
  });

  it('采集抛异常 ⇒ 收敛成 error 并还原标记（全链路失败静默，不外抛）', async () => {
    const { deps, markers } = harness({
      collect: vi.fn(async () => {
        throw new Error('EIO');
      }),
    });

    const outcome = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });

    expect(outcome).toEqual({ kind: 'error' });
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(1);
  });
});

describe('节流（崩溃-重启-崩溃循环）', () => {
  it('同一进程内两次自动上传：第二次被节流并还原标记', async () => {
    const { deps, markers } = harness();

    const first = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t1')],
    });
    const second = await runUpload(deps, {
      reason: 'crash-backfill',
      anchors: [1],
      claimed: [claim('t2')],
    });

    expect(first.kind).toBe('uploaded');
    expect(second).toEqual({ kind: 'skipped-throttled' });
    // 被节流的那条不是丢弃,是还原后下次再传。
    expect(markers.releaseClaimed).toHaveBeenCalledTimes(1);
  });

  it('超过最小间隔后自动上传恢复', async () => {
    const { deps, nowRef } = harness();

    await runUpload(deps, { reason: 'crash-backfill', anchors: [1], claimed: [] });
    nowRef.value += AUTO_UPLOAD_MIN_INTERVAL_MS + 1;
    const second = await runUpload(deps, { reason: 'crash-backfill', anchors: [1], claimed: [] });

    expect(second.kind).toBe('uploaded');
  });

  it('手动上传不受节流约束（用户点了就该传）', async () => {
    const { deps } = harness();

    await runUpload(deps, { reason: 'crash-backfill', anchors: [1], claimed: [] });
    const manual = await runUpload(deps, { reason: 'manual', anchors: [], claimed: [] });

    expect(manual.kind).toBe('uploaded');
  });
});
