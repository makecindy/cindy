/**
 * LocalDbFatalScreen 的视图态映射（纯函数，便于单测）。
 *
 * 本地数据库启动失败（典型 MIGRATE_FAILED：旧版本打开被更新代码升级过的库）时，
 * 恢复路径取决于应用更新补丁的暂存状态：
 * - `install-update`：补丁已就绪（ready）——主按钮「重启并安装更新」。
 * - `preparing-update`：正在检查/下载，或旧补丁正被更新版本替换（superseding，
 *   与 UpdateBanner 一致此时禁止 relaunch，防止装到旧补丁）——按钮转圈等待。
 * - `no-update`：无补丁可装（idle/error）——引导「重新检查更新」。
 * - `init-failed`：DB_INIT_FAILED（如插件目录 EPERM）——不引导更新，给中性说明与「重试」。
 * - `corrupt`：DB_CORRUPT_NO_BACKUP——可能是自动恢复已耗尽，也可能是共享库被其它实例占用
 *   （关闭后重试可恢复），故保留「重试」，并额外提供复制技术细节的求助入口。
 */
export type LocalDbFatalView =
  | 'install-update'
  | 'preparing-update'
  | 'no-update'
  | 'retry-local-db'
  | 'init-failed'
  | 'corrupt';

export type UpdateStatusValue = UpdateStatusPayload['status'];

export function resolveLocalDbFatalView(
  status: UpdateStatusValue | undefined,
  code?: string,
): LocalDbFatalView {
  if (code === 'DB_SCHEMA_LOCKED') return 'retry-local-db';
  // 错误码是第一决策维度：只有 MIGRATE_FAILED（或未知码，保持旧行为）才走更新链路。
  if (code === 'DB_CORRUPT_NO_BACKUP') return 'corrupt';
  if (code === 'DB_INIT_FAILED') return 'init-failed';
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
