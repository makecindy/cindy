/**
 * 正式 profile 上的 dev writer 不得应用 pending migration。
 *
 * 2026-08-16：含 0091 的 checkout 以 writer 打开正式 Cindy 目录，把安装版
 * 0.1.50（只到 0090）打挂。`assertSharedDevMigrationPolicy` 只拦「未合入
 * origin/main」的产物；已合入主干、但安装包还没带上的 migration 照样会写进
 * 共享库。这一层看真实 profile + pending，不看 isolated 旗标。
 */
export function shouldRefuseOfficialProfileWriterMigration(input: {
  isPackaged: boolean;
  officialSharedProfile: boolean;
  pendingCount: number;
}): boolean {
  return !input.isPackaged && input.officialSharedProfile && input.pendingCount > 0;
}

export function officialProfileWriterMigrationMessage(pendingNames: readonly string[]): string {
  const pending = pendingNames.length > 0 ? pendingNames.join(', ') : '(unknown)';
  return (
    `开发版不能把正式 Cindy 目录的数据库升到当前 checkout 的 schema（待执行 ${pending}）。` +
    '请改用 --isolated=<名字>，或等包含这些 migration 的正式版发布后再用共享目录。'
  );
}
