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
import { isMyIssueUrl } from '../../shared/myIssues.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('github-issue/ledger');

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
    // url 与其它字段一样按不可信输入清洗:它必须指向本仓这一号 issue。落盘文件
    // 被篡改或损坏时,不让一条「你提交的 issue」把用户带去别处。
    typeof r.url === 'string' &&
    isMyIssueUrl(r.url, r.number) &&
    typeof r.title === 'string' &&
    (r.type === 'bug' || r.type === 'feature') &&
    typeof r.submittedAt === 'string' &&
    Number.isFinite(Date.parse(r.submittedAt)) &&
    (r.identity === 'github-user' || r.identity === 'platform')
  );
}

/**
 * 清洗**读出来的**账本内容并返回,不回写 —— 落盘的坏数据不会被自动修好,每次读都
 * 重新过滤一遍(真正改写只发生在 recordSubmittedIssue 那次 set)。
 * 丢掉形状不对的条目,按提交时间倒序,同一 issue 号只留最新一条,并把总量压在上限内。
 * 纯函数,单测直接调(不碰 electron-store)。
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

/**
 * 记一条提交成功的 issue;同号重复提交按最新一条覆盖。
 *
 * `expectedScope` **必填**且必须是**提交发起时**取的 activeOwnerScopeKey():
 * getStore() 走 ownerScopedUserDataPath(),读的是「此刻」的账号路径。提交请求在飞
 * 期间切号,落地时写入就会把账号 A 的提交记进账号 B 的账本、出现在 B 的列表里。
 * 参数设成必填而不是可选,是为了让新调用点不可能忘记带上作用域。
 */
export function recordSubmittedIssue(
  record: SubmittedIssueRecord,
  expectedScope: string,
): SubmittedIssueRecord[] {
  const currentScope = activeOwnerScopeKey();
  if (currentScope !== expectedScope) {
    // 放弃写入而不是写进别人的账本。这条提交在 GitHub 上已经成功,只是本机
    // 少一条记录(平台读接口就绪后仍会出现在原账号的列表里)。
    log.warn('dropping submitted-issue record: active account changed since submit started', {
      issueNumber: record.number,
    });
    return listSubmittedIssues();
  }
  const next = normalizeSubmittedIssues([record, ...listSubmittedIssues()]);
  getStore().set('issues', next);
  return next;
}
