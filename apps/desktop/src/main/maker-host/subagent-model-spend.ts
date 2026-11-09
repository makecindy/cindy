// 子代理审批的**费用记账**(P1-7 / P0-C)。
//
// maxCostUsd 只有配合实际记账才算有效上限:本模块按 approval 的 scopeKey
// (见 maker-core `approvalSpendKey`)在 receipt 结算后累计 USD 金额;
// 扩展/runner 在派发/启动时读取累计 + 预留值,超过上限则拒绝。
//
// 记账金额三类:
//   - actualUsd:台账确认的真实成本(amount>0 的结算行);
//   - estimatedUsd:BYOM 模型无台账金额时,用参考定价估算的部分(标记为估计);
//   - reservedUsdById:并发 Worker 的**原子预算预留**(P0-C)—— launch 时预留,
//     结算/结束时释放;上限判断 = actual + estimated + reserved。
// 诚实口径:上限按**已结算累计 + 在途预留**度量。单请求中途的实时 token 消费
// 不可拦截,"maxCostUsd 是对单次请求的硬天花板"为不实表述,不得宣称。
//
// 写并发:跨进程(node -e + 主进程 + runner)需要文件锁;用 O_EXCL 锁文件 +
// 短自旋(与本进程内同步读写同临界区)。锁超时 30s 自动失效,避免死锁。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-spend');

const SPEND_FILE_NAME = 'subagent-model-spend.json';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const RESERVATION_TTL_MS = 10 * 60 * 1000; // 在途预留过期自清(防 runner 崩溃泄漏)

export interface ScopeTotals {
  actualUsd: number;
  estimatedUsd: number;
  /** reservationId -> 保留金额(USD)。key 用子会话 id 或 runId:taskId。 */
  reservedUsdById: Record<string, number>;
  updatedAt: number;
}

interface SpendFile {
  version: 2;
  byScope: Record<string, ScopeTotals>;
}

export function subagentModelSpendFilePath(): string {
  const root = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  return path.join(root ?? app.getPath('userData'), SPEND_FILE_NAME);
}

function readSpendFile(): SpendFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(subagentModelSpendFilePath(), 'utf8')) as Partial<SpendFile>;
    if (!parsed || typeof parsed !== 'object' || (parsed.version !== 1 && parsed.version !== 2)) {
      return { version: 2, byScope: {} };
    }
    const byScope: Record<string, ScopeTotals> = {};
    const raw = parsed.byScope as Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object') {
      for (const [scopeKey, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as Partial<ScopeTotals>;
        byScope[scopeKey] = {
          actualUsd: typeof entry.actualUsd === 'number' && Number.isFinite(entry.actualUsd) ? Math.max(0, entry.actualUsd) : 0,
          estimatedUsd: typeof entry.estimatedUsd === 'number' && Number.isFinite(entry.estimatedUsd) ? Math.max(0, entry.estimatedUsd) : 0,
          reservedUsdById: normalizeReserved(entry.reservedUsdById),
          updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        };
      }
    }
    return { version: 2, byScope };
  } catch {
    return { version: 2, byScope: {} };
  }
}

function normalizeReserved(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== 'string' || !id) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[id] = value;
  }
  return out;
}

function writeSpendFile(state: SpendFile): void {
  try {
    fs.mkdirSync(path.dirname(subagentModelSpendFilePath()), { recursive: true });
    const tmp = subagentModelSpendFilePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, subagentModelSpendFilePath());
  } catch (error) {
    log.warn('subagent model spend accumulation failed', { message: String(error) });
  }
}

function acquireSpendLock(): (() => void) | undefined {
  const lockPath = subagentModelSpendFilePath() + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      return () => {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best-effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
      };
    } catch {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      // 锁持有者可能已死:陈旧锁自动失效,不死等。
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* 锁已被回收,重试 */ }
      if (Date.now() > deadline) return undefined;
      // 短自旋等待;同步忙等在单进程里没意义,仅 nanosleep。
      const end = Date.now() + 10;
      while (Date.now() < end) { /* spin */ }
    }
  }
}

function withSpendLock<T>(fn: () => T): T | undefined {
  const release = acquireSpendLock();
  if (!release) return undefined;
  try {
    return fn();
  } finally {
    release();
  }
}

/** 累计一次结算的费用(实际或估计)。amountUsd<=0 时直接跳过。 */
export function addSubagentModelSpend(
  scopeKey: string,
  amountUsd: number,
  estimated: boolean,
): void {
  if (!scopeKey || !Number.isFinite(amountUsd) || amountUsd <= 0) return;
  withSpendLock(() => {
    const state = readSpendFile();
    const existing = state.byScope[scopeKey] ?? { actualUsd: 0, estimatedUsd: 0, reservedUsdById: {}, updatedAt: 0 };
    if (estimated) existing.estimatedUsd += amountUsd;
    else existing.actualUsd += amountUsd;
    existing.updatedAt = Date.now();
    state.byScope[scopeKey] = existing;
    writeSpendFile(state);
  });
}

/**
 * 预算预留(P0-C 并发):在 Worker 启动前把预留额度(plausible upper bound)
 * 记入 reservedUsdById,返回实际预留到的金额(0 表示没有预留到)。
 * 同一 reservationId 幂等(重复 launch 不会重复加)。
 */
export function reserveSubagentModelSpend(
  scopeKey: string,
  reservationId: string,
  amountUsd: number,
): number {
  if (!scopeKey || !reservationId || !Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  const result = withSpendLock(() => {
    const state = readSpendFile();
    const existing = state.byScope[scopeKey] ?? { actualUsd: 0, estimatedUsd: 0, reservedUsdById: {}, updatedAt: 0 };
    if (existing.reservedUsdById[reservationId] !== undefined) {
      return existing.reservedUsdById[reservationId];
    }
    existing.reservedUsdById[reservationId] = amountUsd;
    existing.updatedAt = Date.now();
    state.byScope[scopeKey] = existing;
    writeSpendFile(state);
    return amountUsd;
  });
  return result ?? 0;
}

/** 释放一次预留(任务结束/结算时)。 */
export function releaseSubagentModelSpend(scopeKey: string, reservationId: string): void {
  if (!scopeKey || !reservationId) return;
  withSpendLock(() => {
    const state = readSpendFile();
    const existing = state.byScope[scopeKey];
    if (!existing) return;
    if (!(reservationId in existing.reservedUsdById)) return;
    delete existing.reservedUsdById[reservationId];
    existing.updatedAt = Date.now();
    state.byScope[scopeKey] = existing;
    writeSpendFile(state);
  });
}

/** 供 Host 侧在决议时核对(扩展/runner 自己的实现读同一文件)。 */
export function readSubagentModelSpend(scopeKey: string): number | undefined {
  const totals = readSpendFile().byScope[scopeKey];
  if (!totals) return undefined;
  if (totals.actualUsd === 0 && totals.estimatedUsd === 0 && Object.keys(totals.reservedUsdById).length === 0) {
    return undefined;
  }
  const reserved = Object.values(totals.reservedUsdById).reduce((acc, v) => acc + v, 0);
  return totals.actualUsd + totals.estimatedUsd + reserved;
}
