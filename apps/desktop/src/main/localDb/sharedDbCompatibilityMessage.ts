/**
 * shared userData 的 passive dev 与 packaged read-only 启动遇到 migration 兼容性失败时的恢复说明。
 *
 * 只有 checkout 存在待迁移 schema 时才能建议切换为 primary 执行 migration；
 * 历史记录或运行时身份不一致必须改用兼容 checkout 或隔离数据库。
 */

import type { MigrationCompatibilityIssue, MigrationCompatibilityReport } from './migrationRunner';

export function buildPackagedReadOnlyCompatibilityMessage(
  compatibility: MigrationCompatibilityReport,
): string {
  const issueSummary = compatibility.issues
    .slice(0, 3)
    .map((issue) => issue.kind)
    .join(', ');
  return (
    '当前安装版无法安全打开共享数据库。请关闭其它开发实例后重试，或安装包含该本地数据 schema 的更新版本。' +
    `（详情：${issueSummary || '未知原因'}）`
  );
}

function hasIssue(
  issues: readonly MigrationCompatibilityIssue[],
  kind: MigrationCompatibilityIssue['kind'],
): boolean {
  return issues.some((issue) => issue.kind === kind);
}

function hasNonVersionIssue(issues: readonly MigrationCompatibilityIssue[]): boolean {
  return issues.some(
    (issue) => issue.kind !== 'schema-version-ahead' && issue.kind !== 'schema-version-behind',
  );
}

export function buildSharedDbCompatibilityMessage(
  compatibility: MigrationCompatibilityReport,
): string {
  const issueSummary = compatibility.issues
    .slice(0, 3)
    .map((issue) => issue.kind)
    .join(', ');

  if (hasNonVersionIssue(compatibility.issues)) {
    return (
      '共享数据的 schema、migration 记录或运行时身份与当前开发版不一致。为保护数据，Cindy 没有打开它。' +
      '请使用与该数据匹配的 checkout，或改用 --isolated。' +
      `（详情：${issueSummary || 'unknown'}）`
    );
  }

  if (hasIssue(compatibility.issues, 'schema-version-ahead')) {
    return (
      `共享数据已是 schema ${compatibility.databaseVersion}，而此开发版只支持到 ` +
      `${compatibility.checkoutVersion}。为保护数据，Cindy 没有打开它。` +
      '请使用包含该 schema 的 checkout 启动开发版；重启或把当前 checkout 设为 primary 都不会降级数据库。' +
      '如只需隔离测试，可改用 --isolated。' +
      `（详情：${issueSummary || 'unknown'}）`
    );
  }

  if (hasIssue(compatibility.issues, 'schema-version-behind')) {
    return (
      `共享数据是 schema ${compatibility.databaseVersion}，而此开发版包含到 ` +
      `schema ${compatibility.checkoutVersion}。为保护数据，Cindy 没有打开它。` +
      '请先关闭共享数据的 passive 实例，再用当前 checkout 作为 primary 完成迁移。' +
      '如只需隔离测试，可改用 --isolated。' +
      `（详情：${issueSummary || 'unknown'}）`
    );
  }

  return '共享数据的 migration 兼容性状态未知。请改用 --isolated。';
}
