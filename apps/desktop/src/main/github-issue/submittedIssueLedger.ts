/**
 * 本机「产品内提交过哪些 issue」的账本。
 *
 * 为什么需要它:平台代发路径在 GitHub 上的作者是 cindy-issue App,正文里只有一行
 * 公开署名,而署名可编辑、可重名 —— 光靠 GitHub 侧数据无法可靠判断「这条是我提的」。
 * 服务端(独立仓)也只有创建接口、没有「我的 issue」列表接口。所以提交成功的那一刻
 * 在本机记一条,是这一半归属信息的唯一可靠来源。
 *
 * 存储走 electron-store + ownerScopedUserDataPath():账本天然按 Cindy 账号隔离,
 * 换号后互不可见。跨设备不同步是这个方案已知的边界(换机 / 重装看不到旧记录)。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import Store from 'electron-store';

import type { SubmittedIssueRecord } from '../../shared/myIssues.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

interface SubmittedIssueLedgerShape {
  issues: SubmittedIssueRecord[];
}

const MAX_SUBMITTED_ISSUES = 500;

let storeInstance: Store<SubmittedIssueLedgerShape> | null = null;
let storePath: string | null = null;

function getStore(): Store<SubmittedIssueLedgerShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<SubmittedIssueLedgerShape>({
      name: 'submitted-issues',
      cwd: currentPath,
      defaults: { issues: [] },
      schema: { issues: { type: 'array' } },
      clearInvalidConfig: true,
    });
    storePath = currentPath;
  }
  return storeInstance;
}

function isValidRecord(value: unknown): value is SubmittedIssueRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as SubmittedIssueRecord;
  return (
    typeof r.number === 'number' &&
    Number.isInteger(r.number) &&
    r.number > 0 &&
    typeof r.url === 'string' &&
    r.url.length > 0 &&
    typeof r.title === 'string' &&
    (r.type === 'bug' || r.type === 'feature') &&
    typeof r.submittedAt === 'string' &&
    Number.isFinite(Date.parse(r.submittedAt)) &&
    (r.identity === 'github-user' || r.identity === 'platform')
  );
}

/**
 * 清洗持久化内容:丢掉形状不对的条目,按提交时间倒序,同一 issue 号只留最新一条,
 * 并把总量压在上限内。纯函数,单测直接调(不碰 electron-store)。
 */
export function normalizeSubmittedIssues(value: unknown): SubmittedIssueRecord[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(isValidRecord);
  // 倒序在前、去重在后 —— 保证同号冲突时留下的是提交时间更新的那条。
  const sorted = [...valid].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const seen = new Set<number>();
  const records: SubmittedIssueRecord[] = [];
  for (const record of sorted) {
    if (seen.has(record.number)) continue;
    seen.add(record.number);
    records.push(record);
    if (records.length >= MAX_SUBMITTED_ISSUES) break;
  }
  return records;
}

export function listSubmittedIssues(): SubmittedIssueRecord[] {
  return normalizeSubmittedIssues(getStore().get('issues', []));
}

/** 记一条提交成功的 issue;同号重复提交按最新一条覆盖。 */
export function recordSubmittedIssue(record: SubmittedIssueRecord): SubmittedIssueRecord[] {
  const next = normalizeSubmittedIssues([record, ...listSubmittedIssues()]);
  getStore().set('issues', next);
  return next;
}
