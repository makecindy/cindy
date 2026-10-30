/**
 * LocalDbFatalScreen 的视图态映射（纯函数，便于单测）。
 *
 * 本地数据库启动失败（典型 MIGRATE_FAILED：旧版本打开被更新代码升级过的库）时，
 * 恢复路径取决于应用更新补丁的暂存状态：
 * - `install-update`：补丁已就绪（ready）——主按钮「重启并安装更新」。
 * - `preparing-update`：正在检查/下载，或旧补丁正被更新版本替换（superseding，
 *   与 UpdateBanner 一致此时禁止 relaunch，防止装到旧补丁）——按钮转圈等待。
 * - `no-update`：无补丁可装（idle/error）——引导「重新检查更新」。
 */
export type LocalDbFatalView =
  'install-update' | 'preparing-update' | 'no-update' | 'retry-local-db';

export type UpdateStatusValue = UpdateStatusPayload['status'];

export function resolveLocalDbFatalView(
  status: UpdateStatusValue | undefined,
  code?: string,
): LocalDbFatalView {
  if (code === 'DB_SCHEMA_LOCKED') return 'retry-local-db';
  switch (status) {
    case 'ready':
      return 'install-update';
    case 'checking':
    case 'downloading':
    case 'superseding':
      return 'preparing-update';
    default:
      return 'no-update';
  }
}
