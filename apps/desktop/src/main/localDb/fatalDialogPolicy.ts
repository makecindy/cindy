/**
 * localDb 启动致命错误的对话框呈现策略。
 *
 * ensureReady 失败时 main 侧历史行为是无差别弹原生 `dialog.showMessageBoxSync`
 * （阻塞主进程），renderer 的 LocalDbGate 则渲染空白 —— 用户面对的是
 * "OS 报错框 + 黑屏"，且没有任何安装已暂存更新的入口。
 *
 * MIGRATE_FAILED（典型：旧版本打开被更新代码升级过的共享库）改由 renderer 的
 * LocalDbFatalScreen 全屏接管：它能检测已暂存的更新补丁并提供「重启并安装更新」
 * 恢复路径。错误信息经 `local-db:ensure-ready` invoke reply 原路带回 renderer，
 * 不需要额外通道。其余 code（DB_INIT_FAILED / DB_CORRUPT_NO_BACKUP）保持原生
 * 对话框语义不变。
 */

/** ensureReady 失败结果的稳定错误码集合。 */
export type EnsureReadyErrorCode =
  'DB_INIT_FAILED' | 'DB_CORRUPT_NO_BACKUP' | 'MIGRATE_FAILED' | 'DB_SCHEMA_LOCKED';

/** 迁移失败与租约阻断由 renderer 恢复界面接管；其余 code 维持原生对话框。 */
export function shouldShowNativeFatalDialog(code: EnsureReadyErrorCode): boolean {
  return code !== 'MIGRATE_FAILED' && code !== 'DB_SCHEMA_LOCKED';
}
