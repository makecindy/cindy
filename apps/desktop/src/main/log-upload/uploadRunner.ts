/**
 * 一次上报的完整编排：授权闸 → 采集 → 发送 → 标记收尾。
 *
 * 三条路径（手动 / 崩溃即时 / 启动补传）共用这一条编排，差别只在 `reason`、锚点与标记处置。
 *
 * 失败语义（需求 §4.5「全链路失败静默」）：任何异常都收敛成一个 `UploadOutcome`，
 * 不抛、不弹错误、不影响业务。IPC 层再把 outcome 翻成错误码给 renderer。
 *
 * 纯逻辑：采集能力、发送能力、闸、标记存储、时钟、随机数全部注入。
 */

import type { LogUploadReason } from '../../shared/logUpload';
import { AUTO_UPLOAD_MIN_INTERVAL_MS } from './limits';
import { evaluateGate, type ConsentGateDeps } from './consentGate';
import type { ClaimedMarker, PendingMarkerStore } from './pendingMarkers';
import type { LogSinkResult } from './logSink';
import type { CollectResult, LogUploadMeta, LogUploadTarget } from './types';

export type UploadOutcome =
  | { kind: 'uploaded'; uploadCode: string; recordCount: number }
  | { kind: 'skipped-not-configured' }
  | { kind: 'skipped-no-consent' }
  | { kind: 'skipped-crash-auto-off' }
  | { kind: 'skipped-consent-unknown' }
  | { kind: 'skipped-throttled' }
  | { kind: 'empty' }
  | { kind: 'failed'; status: number }
  | { kind: 'error' };

export interface UploadRunnerDeps {
  gate: ConsentGateDeps;
  /** 已配置的目标；闸放行后必定非 null（闸的第一条就是「未配置」）。 */
  resolveTarget(): LogUploadTarget | null;
  collect(request: { reason: LogUploadReason; anchors: number[] }): Promise<CollectResult>;
  send(
    target: LogUploadTarget,
    meta: LogUploadMeta,
    records: CollectResult['records'],
  ): Promise<LogSinkResult>;
  /** 组装环境元数据（uploadCode 由 runner 生成后传入）。 */
  buildMeta(args: {
    uploadCode: string;
    reason: LogUploadReason;
    crashToken?: string;
    crashAtMs?: number;
  }): LogUploadMeta;
  generateUploadCode(): string;
  markers: PendingMarkerStore;
  now(): number;
  log: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
}

export interface RunUploadRequest {
  reason: LogUploadReason;
  /** 崩溃锚点。手动为空。 */
  anchors: number[];
  /** 本次上报覆盖的已认领标记；成功且非空才清除，失败还原。 */
  claimed: ClaimedMarker[];
  /** 归组令牌：崩溃即时与补传是两次独立上报，靠它在后台归成同一次崩溃。 */
  crashToken?: string;
  crashAtMs?: number;
}

/**
 * 自动路径的节流状态。模块级：崩溃-重启-崩溃的循环里每次都是新进程，所以这道闸只挡得住
 * **同一进程内**的连续自动上传（需求 §4.5 的措辞正是「同一进程内」）。跨进程的循环由
 * 「标记只在成功后清除 + 每次启动只补一次」自然限流。
 */
let lastAutoUploadAtMs = 0;

export function resetThrottleForTests(): void {
  lastAutoUploadAtMs = 0;
}

export async function runUpload(
  deps: UploadRunnerDeps,
  request: RunUploadRequest,
): Promise<UploadOutcome> {
  try {
    return await runUploadInner(deps, request);
  } catch (err) {
    // 全链路失败静默:收敛成一个 outcome,绝不让异常冒出去影响业务。
    deps.log.warn('log upload threw (swallowed)', err);
    for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
    return { kind: 'error' };
  }
}

async function runUploadInner(
  deps: UploadRunnerDeps,
  request: RunUploadRequest,
): Promise<UploadOutcome> {
  const verdict = evaluateGate(deps.gate, request.reason);
  if (verdict.kind === 'denied') {
    // 「未配置」不是用户撤回授权,而是**这个构建传不了**(典型:无版本 / dev 包没有
    // config/log-upload.json,或注入短暂异常)。dev/正式版共享同一份 userData —— 若在这里
    // 清标记,用户「先用一个没配上报的构建打开」就会把正式版还没来得及补传的崩溃现场永久删掉
    // (2026-08-04 review P1)。所以只 release(保留标记),留给能上报的构建下次补;绝不 clearAll。
    if (verdict.reason === 'not-configured') {
      for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
      return { kind: 'skipped-not-configured' };
    }
    // 明确的用户 opt-out(未同意 / 关掉了崩溃自动上传):清掉所有待补传标记(含本次认领的)。
    // 用户关闭授权后不得在下次启动偷偷补传。
    for (const claim of request.claimed) deps.markers.resolveClaimed(claim);
    deps.markers.clearAll();
    switch (verdict.reason) {
      case 'no-consent':
        return { kind: 'skipped-no-consent' };
      case 'crash-auto-off':
        return { kind: 'skipped-crash-auto-off' };
    }
  }
  if (verdict.kind === 'unknown') {
    // 结论不明确:不上传、不清标记,把最终判定留给下次启动的可靠读取。
    for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
    return { kind: 'skipped-consent-unknown' };
  }

  if (request.reason !== 'manual') {
    const since = deps.now() - lastAutoUploadAtMs;
    if (lastAutoUploadAtMs > 0 && since < AUTO_UPLOAD_MIN_INTERVAL_MS) {
      // 节流命中:标记还原,下次启动再传(不是丢弃)。
      for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
      return { kind: 'skipped-throttled' };
    }
    lastAutoUploadAtMs = deps.now();
  }

  const target = deps.resolveTarget();
  if (!target) {
    // 闸已经查过一次;这里是防御(闸与解析用同一份配置,理论不可达)。
    for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
    return { kind: 'skipped-not-configured' };
  }

  const collected = await deps.collect({ reason: request.reason, anchors: request.anchors });
  if (collected.records.length === 0) {
    // 采到 0 条:**保留**标记,下次启动重试(需求 §4.5「不丢」)。
    for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
    deps.log.info('log upload collected 0 records; keeping pending markers', collected.stats);
    return { kind: 'empty' };
  }

  const uploadCode = deps.generateUploadCode();
  const meta = deps.buildMeta({
    uploadCode,
    reason: request.reason,
    crashToken: request.crashToken,
    crashAtMs: request.crashAtMs,
  });
  const result = await deps.send(target, meta, collected.records);

  if (!result.ok) {
    for (const claim of request.claimed) deps.markers.releaseClaimed(claim);
    deps.log.warn(
      `log upload failed: code=${uploadCode} status=${result.status} ` +
        `batches=${result.batches} sentRecords=${result.sentRecords}`,
    );
    return { kind: 'failed', status: result.status };
  }

  // 只清**其崩溃窗口确被本次采集覆盖**的标记;没覆盖到的(超大文件里同一天靠后那次崩溃落在
  // 窗口外)保留待下次补传 —— 否则一次「非空但没含这次崩溃」的成功上报会把它永久清掉
  // (2026-08-04 review)。coveredAnchors 的判定见 collect。
  const covered = new Set(collected.coveredAnchors);
  let keptUncovered = 0;
  for (const claim of request.claimed) {
    if (covered.has(claim.marker.crashAtMs)) {
      deps.markers.resolveClaimed(claim);
    } else {
      deps.markers.releaseClaimed(claim);
      keptUncovered += 1;
    }
  }

  deps.log.info(
    `log upload succeeded: code=${uploadCode} reason=${request.reason} ` +
      `records=${result.records} batches=${result.batches} ` +
      `lookbackDays=${collected.stats.lookbackDays} bytesRead=${collected.stats.bytesRead} ` +
      `droppedBySource=${collected.stats.droppedBySource} droppedByCap=${collected.stats.droppedByCap} ` +
      `keptUncoveredMarkers=${keptUncovered}`,
  );

  return { kind: 'uploaded', uploadCode, recordCount: result.records };
}
