/**
 * Issue 响应解析(纯函数,无 electron / 无网络)。
 *
 * 两条通道的响应都在这里落地:
 *  - 平台通道 —— 服务端(独立仓)返回的「我提交过的 issue」。它最省力的实现是透传
 *    GitHub 对象,但也可能改成 camelCase,所以两种命名都吃;
 *  - GitHub 通道 —— GitHub REST / 插件响应(插件只剥 API 链接类字段,保留 html_url)。
 *
 * 一律宽容:字段缺失就降级,绝不因为多了 / 少了字段让整张列表报废。
 */

import type { RemoteIssue, RemoteIssuePage } from './myIssuesService';

/**
 * 一页结果。接受三种外层形状:`{ issues: [...] }`、`{ items: [...] }`(GitHub search
 * 的形状)、以及裸数组 —— 服务端用哪种都不用改客户端。
 */
export function parseIssuePage(value: unknown): RemoteIssuePage {
  const record = asRecord(value);
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray(record?.issues)
      ? record.issues
      : Array.isArray(record?.items)
        ? record.items
        : [];
  const issues = rawItems
    .map(parseRemoteIssue)
    .filter((issue): issue is RemoteIssue => issue !== null);
  return { issues, totalCount: readTotalCount(record) };
}

function readTotalCount(record: Record<string, unknown> | null): number | null {
  for (const key of ['total_count', 'totalCount', 'total']) {
    const value = record?.[key];
    if (typeof value === 'number') return value;
  }
  // hasMore 是布尔而非计数;true 时用「比本页多一条」表达「还有更多」。
  const hasMore = record?.hasMore ?? record?.has_more;
  if (hasMore === true && Array.isArray(record?.issues)) return record.issues.length + 1;
  if (hasMore === true && Array.isArray(record?.items)) return record.items.length + 1;
  return null;
}

export function parseRemoteIssue(value: unknown): RemoteIssue | null {
  const record = asRecord(value);
  if (!record) return null;
  const number = readNumber(record, ['number', 'issueNumber']);
  const title = readString(record, ['title']);
  const htmlUrl = readString(record, ['html_url', 'htmlUrl', 'url']);
  const createdAt = readString(record, ['created_at', 'createdAt']);
  // createdAt 必须**可解析**,不只是非空:mergeIssues 的排序比较器直接对它做
  // Date.parse 相减,不可解析会得到 NaN,让整份列表的顺序变成未定义(不是"这条排错
  // 位置",而是整体不稳定)。账本清洗早就这样校验 submittedAt 了 —— 这里补齐对称。
  if (
    number === null ||
    !Number.isInteger(number) ||
    !title ||
    !htmlUrl ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return {
    number,
    title,
    htmlUrl,
    // GitHub 只有 open / closed 两态;非 closed 一律按 open 处理。
    state: readString(record, ['state']) === 'closed' ? 'closed' : 'open',
    labels: parseLabels(record.labels ?? record.type),
    createdAt,
    updatedAt: readString(record, ['updated_at', 'updatedAt']),
    commentCount: readNumber(record, ['comments', 'commentCount']),
  };
}

/**
 * labels 可能是对象数组、纯字符串数组,也可能是服务端直接给的单个类型字符串
 * (提交链路只打 bug / feature 两种标签,单值形态同样够用)。
 */
function parseLabels(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const label of value) {
    if (typeof label === 'string') {
      names.push(label);
      continue;
    }
    const name = asRecord(label)?.name;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

/** 插件 / REST 的 404 文案都会命中;命中后调用方把这一条降级而不是整体失败。 */
export function isGithubNotFoundMessage(message: string): boolean {
  return /HTTP 404|not found/i.test(message);
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
