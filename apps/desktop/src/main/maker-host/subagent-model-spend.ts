// 子代理审批的**费用记账**(P1-7)。
//
// maxCostUsd 只有配合实际记账才算有效上限:本模块按 approval 的 scopeKey
// (见 maker-core `approvalSpendKey`)在 receipt 结算后累计 USD 金额;
// 扩展/runner 在派发/启动时读取累计值,超过上限则拒绝。
//
// 记账两类金额:
//   - actualUsd:台账确认的真实成本(amount>0 的结算行);
//   - estimatedUsd:BYOM 模型无台账金额时,用参考定价估算的部分(标记为估计)。
// 费用上限按两者合计执行;上限文案必须说明 BYOM 是估计口径。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-spend');

const SPEND_FILE_NAME = 'subagent-model-spend.json';

export interface SpendTotals {
  actualUsd: number;
  estimatedUsd: number;
  updatedAt: number;
}

interface SpendFile {
  version: 1;
  byScope: Record<string, SpendTotals>;
}

export function subagentModelSpendFilePath(): string {
  const root = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  return path.join(root ?? app.getPath('userData'), SPEND_FILE_NAME);
}

function readSpendFile(): SpendFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(subagentModelSpendFilePath(), 'utf8')) as Partial<SpendFile>;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return { version: 1, byScope: {} };
    const byScope: Record<string, SpendTotals> = {};
    const raw = parsed.byScope as Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object') {
      for (const [scopeKey, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as Partial<SpendTotals>;
        if (typeof entry.actualUsd !== 'number' || !Number.isFinite(entry.actualUsd)) continue;
        if (typeof entry.estimatedUsd !== 'number' || !Number.isFinite(entry.estimatedUsd)) continue;
        byScope[scopeKey] = {
          actualUsd: Math.max(0, entry.actualUsd),
          estimatedUsd: Math.max(0, entry.estimatedUsd),
          updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        };
      }
    }
    return { version: 1, byScope };
  } catch {
    return { version: 1, byScope: {} };
  }
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

/** 累计一次结算的费用(实际或估计)。amountUsd<=0 时直接跳过。 */
export function addSubagentModelSpend(
  scopeKey: string,
  amountUsd: number,
  estimated: boolean,
): void {
  if (!scopeKey || !Number.isFinite(amountUsd) || amountUsd <= 0) return;
  const state = readSpendFile();
  const existing = state.byScope[scopeKey] ?? { actualUsd: 0, estimatedUsd: 0, updatedAt: 0 };
  if (estimated) existing.estimatedUsd += amountUsd;
  else existing.actualUsd += amountUsd;
  existing.updatedAt = Date.now();
  state.byScope[scopeKey] = existing;
  writeSpendFile(state);
}

/** 供 Host 侧在决议时核对(扩展/runner 自己的实现读同一文件)。 */
export function readSubagentModelSpend(scopeKey: string): number | undefined {
  const totals = readSpendFile().byScope[scopeKey];
  if (!totals) return undefined;
  return totals.actualUsd + totals.estimatedUsd;
}
