/** Defaults follow the official Antigravity CLI settings schema.
 * The CLI removes keys equal to defaults when saving. Reject overrides and bad types.
 * The host admits only a signature-verified CLI that speaks personal OAuth ACP.
 */
export function assertAntigravitySubscriptionSettings(settings: Record<string, unknown>, user: Record<string, unknown> = {}): void {
  const safeDefaults = (value: Record<string, unknown>) =>
    (value.useG1Credits === undefined || value.useG1Credits === false) &&
    (value.modelProvider === undefined || value.modelProvider === '') &&
    (value.agentMode === undefined || value.agentMode === '') &&
    (value.enableAdc === undefined || value.enableAdc === false) &&
    value.gcp === undefined;
  if (!safeDefaults(settings) || !safeDefaults(user) || settings.toolPermission !== 'strict' || (user.toolPermission !== undefined && user.toolPermission !== 'strict')) {
    throw new Error('ANTIGRAVITY_SUBSCRIPTION_ONLY_REQUIRED');
  }
}

/** Generation is opt-in for this connection. Native credits policy is supplied
 * independently through the CLI's session settings on every launch. */
export function assertAntigravityGenerationAllowed(config: Record<string, unknown>): void {
  if (config.authDisconnected === true) throw new Error('Google 订阅连接已断开，请先在 Cindy 中重新连接。');
  if (config.generationMode !== 'subscription-only') throw new Error('Google 生成已暂停，本次没有发送请求。');
}

/** CLI session override applies to the same process serving ACP. */
export function antigravitySubscriptionArgs(geminiDir: string, permissionMode?: string, httpMcp = false): string[] {
  if (permissionMode && !['ask', 'default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(permissionMode)) throw new Error('ANTIGRAVITY_PERMISSION_UNSUPPORTED');
  const full = permissionMode === 'bypassPermissions';
  const toolPermission = full ? 'always-proceed' : permissionMode === 'auto' || permissionMode === 'acceptEdits' ? 'request-review' : 'strict';
  const nativeSettings = JSON.stringify({ useG1Credits: false, modelProvider: '', toolPermission, ...(full ? { allowNonWorkspaceAccess: true } : {}) });
  return ['--settings', nativeSettings, 'acp', ...(httpMcp ? ['--process-per-session'] : []),
    ...(full ? ['--dangerously-skip-permissions'] : []), '--gemini-dir', geminiDir, '--app-data-dir', 'antigravity-cli', '--disable-telemetry'];
}
