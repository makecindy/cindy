export function codexUserAgentAtLeast(
  userAgent: string | undefined,
  minimum: readonly [number, number, number],
): boolean {
  const match = /\/(\d+)\.(\d+)\.(\d+)(?:[-+ )]|$)/.exec(userAgent ?? '');
  if (!match) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i]! > minimum[i]!) return true;
    if (version[i]! < minimum[i]!) return false;
  }
  return true;
}

/**
 * thread/rollback 在 Codex 0.156.0 被移除(openai/codex#44915)。按 initialize userAgent
 * 门控:≥ 0.156.0 的 daemon 不再尝试该方法,直接走 fork;版本未知或更老的远端 daemon
 * 仍先试 rollback,由 isCodexRollbackUnavailableError 兜住实际拒绝。
 */
export function supportsCodexThreadRollback(userAgent: string | undefined): boolean {
  return !codexUserAgentAtLeast(userAgent, [0, 156, 0]);
}

/**
 * `approvalsReviewer` is verified against the app-server bundled with Codex 0.144.6.
 * Remote hosts may keep an older standalone binary across desktop upgrades, so parse the
 * initialize userAgent and conservatively omit the field unless that verified floor is met.
 */
export function supportsCodexApprovalsReviewerProtocol(userAgent: string | undefined): boolean {
  return codexUserAgentAtLeast(userAgent, [0, 144, 6]);
}

/**
 * Runtime workspace roots and named permission profiles were verified against
 * the app-server bundled with Codex 0.144.6. Keep older remote daemons
 * fail-closed: without profiles, legacy workspace-write would make every
 * runtime root writable.
 */
export function supportsCodexReadonlyReferenceDirs(userAgent: string | undefined): boolean {
  return supportsCodexApprovalsReviewerProtocol(userAgent);
}

/**
 * Per-thread plugin config for capability arbitration was verified against
 * Codex 0.145.0. If the host policy needs those overrides, an older daemon must
 * be rejected rather than silently starting with the downstream plugins active.
 */
export function supportsCodexCapabilityRoutingProtocol(userAgent: string | undefined): boolean {
  return codexUserAgentAtLeast(userAgent, [0, 145, 0]);
}

/**
 * `excludeTurns` was introduced in Codex 0.125.0 and later marked experimental.
 * Older remote daemons can outlive desktop upgrades, so omit the unknown field
 * and preserve their legacy full-history resume behavior.
 */
export function supportsCodexResumeExcludeTurns(userAgent: string | undefined): boolean {
  return codexUserAgentAtLeast(userAgent, [0, 125, 0]);
}

/**
 * `thread/fork.excludeTurns` was verified against the app-server bundled with
 * Codex 0.145.0. Without it, the fork response inlines the entire source-thread
 * history in one NDJSON line — a 47MB rollout produced a 31MiB single line that
 * exceeded the client's 16MiB maxLineBytes guard and killed the whole
 * connection (2026-08-08 field incident). Older daemons keep the legacy
 * full-history fork response.
 */
export function supportsCodexForkExcludeTurns(userAgent: string | undefined): boolean {
  return codexUserAgentAtLeast(userAgent, [0, 145, 0]);
}

/** Direct lastTurnId fork is used only together with the bounded response contract. */
export function supportsCodexNativeTurnFork(userAgent: string | undefined): boolean {
  return supportsCodexForkExcludeTurns(userAgent);
}
