/**
 * Which session update patches leave updatedAt alone: moved verbatim out of updateSessionInDb
 * (localDb/ipc/sessions.ts, which imports electron), which calls it where the check stood. The Node
 * Host's /sessions/update decides the same way.
 */

/** updateSessionInDb's check: true when every field of the patch is a setting (no updatedAt bump). */
export function isSessionSettingsOnlyPatch(p: Record<string, unknown>): boolean {
  // 只有纯设置字段(model/effort 等)才跳过 bump；凡带 activity 字段
  // (clearedAt / sdkSessionId / status / token 用量等)仍需更新 updatedAt，
  // 否则本地 /clear 后重启侧栏时间回退旧值。
  const SETTINGS_ONLY_FIELDS = new Set([
    'model',
    'effort',
    'permissionMode',
    'fastMode',
    'planModeEnabled',
    'providerId',
    'contextWindowBudget',
    'orcaRole',
    'extraDirs',
    'writableDirs',
    'pinnedAt',
    'notificationsMuted',
    'snoozedUntil',
    'workingDir',
    'workspaceKind',
    'title',
  ]);
  const isSettingsOnly = Object.keys(p).every((k) => SETTINGS_ONLY_FIELDS.has(k));
  return isSettingsOnly;
}
