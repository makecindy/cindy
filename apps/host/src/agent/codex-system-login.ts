import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexAuthPathsShareEntry, inspectCodexAuthLink, relinkSharedCodexAuth } from '../../../desktop/src/main/maker-host/codex-auth-link.js';
import {
  getActiveInvalidatedSystemCodexAuthMarker,
  readInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  shouldSuppressLocalCodexAuth,
} from '../../../desktop/src/main/maker-host/codex-auth-invalidation.js';
import { codexWorkspaceIdFromTokens } from '../../../desktop/src/main/maker-host/codex-auth-identity.js';
import {
  claimDetectedNativeProviderAuth,
  isNativeProviderAuthBound,
  isNativeProviderAuthSelfAuthorized,
  isNativeProviderAuthSharedSystemCredential,
  markNativeProviderAuthSharedSystemCredential,
  migrateLegacyExplicitNativeProviderAuthToInstanceIsolated,
  readExplicitNativeProviderAuthOwner,
  readLegacyExplicitNativeProviderAuthOwner,
  restoreNativeProviderAuthForRecovery,
} from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { hostRuntimeLayout } from '../runtime-layout.mjs';

const log = createLogger('host-codex-system-login');

/**
 * Source runs only: the system login file to reconcile with, for tests in an isolated HOME.
 * A path, not a switch, so a test can never turn reconciliation on against the real ~/.codex.
 */
export const HOST_TEST_SYSTEM_CODEX_AUTH_ENV = 'CINDY_HOST_TEST_SYSTEM_CODEX_AUTH';

/**
 * The system Codex login the Host reconciles with, as the installed desktop does
 * (codex-shared-auth.ts getPreferredSharedCodexAuthPath, packaged branch: ~/.codex/auth.json).
 * Only an installed Host does this. A source run (development, tests, sandboxes) never reads
 * the system login, as an unpackaged desktop never links ~/.codex; it reconciles only with
 * the file a test names in HOST_TEST_SYSTEM_CODEX_AUTH_ENV. Unknown means source run.
 */
export function resolveHostSystemCodexAuthPath(
  layout: { packaged: boolean } = hostRuntimeLayout(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (layout.packaged === true) return path.join(os.homedir(), '.codex', 'auth.json');
  const override = env[HOST_TEST_SYSTEM_CODEX_AUTH_ENV]?.trim();
  return override && path.isAbsolute(override) ? override : null;
}

/** auth-adapters.ts readCodexAccountId / codexAccountIdFromAuthJson. */
async function readCodexAccountId(authPath: string): Promise<string | null> {
  try {
    const obj = JSON.parse(await fsp.readFile(authPath, 'utf-8')) as { tokens?: { account_id?: unknown; id_token?: unknown } };
    return codexWorkspaceIdFromTokens(obj.tokens);
  } catch {
    return null;
  }
}

/** auth-adapters.ts haveSameStableFileIdentity (that module loads Electron). */
function haveSameStableFileIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.ino !== 0n && right.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

/** auth-adapters.ts pathsReferToSameFileSync. */
function pathsReferToSameFileSync(left: string, right: string): boolean {
  return haveSameStableFileIdentity(fs.statSync(left, { bigint: true }), fs.statSync(right, { bigint: true }));
}

/** auth-adapters.ts hasCodexOAuthLoginUnbound (the Host has no read-only detached state). */
export function hasCodexOAuthLoginUnbound(codexHome: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf-8')) as { tokens?: { access_token?: unknown } };
    return typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}

/** auth-adapters.ts detectCodexCredentialScope, with this runtime's system login path. */
export function detectHostCodexCredentialScope(codexHome: string, systemAuth: string | null): 'system-shared' | 'instance-isolated' | 'unknown' {
  try {
    const localAuth = path.join(codexHome, 'auth.json');
    if (!fs.existsSync(localAuth)) return 'unknown';
    if (systemAuth && fs.existsSync(systemAuth) && pathsReferToSameFileSync(localAuth, systemAuth)) return 'system-shared';
    if (isNativeProviderAuthBound('openai')) {
      if (isNativeProviderAuthSharedSystemCredential('openai')) return 'system-shared';
      if (isNativeProviderAuthSelfAuthorized('openai')) return 'instance-isolated';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The desktop Codex adapter's reconciliation with the system login (auth-adapters.ts
 * reconcileWithSystemCodex, runReconcileWithSystemCodex, claimDetectedCodexOAuthBinding),
 * for one runtime. The desktop keeps the suppression in memory and restores it from the
 * marker at startup; the Host reads the same marker on every run (restoreInvalidationStateOnStartup),
 * which is what a restarted desktop reads. Writes stay inside the profile's codex-home: the
 * system login file is only read and linked to.
 */
export function createHostCodexSystemLogin(options: {
  codexHome: string;
  /** resolveHostSystemCodexAuthPath(); null: this runtime never reconciles. */
  systemAuthPath: string | null;
  /** A native login of this connection is in progress or being cancelled. */
  loginActive(): boolean;
  /** The desktop's onOAuthBindingClaimed. */
  onBindingClaimed?: () => unknown;
}) {
  const myAuth = path.join(options.codexHome, 'auth.json');
  let pending: Promise<void> | null = null;

  /** runReconcileWithSystemCodex, steps 2 to 9 (auth-adapters.ts 1172–1353). */
  async function run(systemAuth: string): Promise<void> {
    // Step 2: an explicit disconnect or an invalidation still covering the system login.
    if (restoreInvalidationStateOnStartup(options.codexHome, systemAuth, myAuth).suppressReconcile) return;
    // Step 3.
    if (!fs.existsSync(systemAuth)) return;
    // Step 4: already the same entry.
    if (codexAuthPathsShareEntry(systemAuth, myAuth)) return;
    // Step 5: a healthy hardlink is marked shared and replaced by a file symlink below.
    const topology = await inspectCodexAuthLink(systemAuth, myAuth);
    if (topology.healthy && topology.linkType === 'hardlink') markNativeProviderAuthSharedSystemCredential('openai');
    if (topology.healthy && topology.linkType === 'symlink') return;
    // Step 6: a login made explicitly in Cindy stays the instance's own.
    const hasLocalEntry = topology.linkType !== 'missing';
    const wasSharedLegacyCredential = topology.linkType === 'file' && isNativeProviderAuthSharedSystemCredential('openai');
    const explicitIsolatedOwner = topology.linkType === 'file' && !wasSharedLegacyCredential
      ? readExplicitNativeProviderAuthOwner('openai') : null;
    const legacyExplicitOwner = topology.linkType === 'file' && !wasSharedLegacyCredential && !explicitIsolatedOwner
      ? readLegacyExplicitNativeProviderAuthOwner('openai') : null;
    if (explicitIsolatedOwner) {
      log.info('keeping explicitly authorized instance-isolated Codex auth',
        { ownerMatchesActive: explicitIsolatedOwner === getActiveAppSession().dataOwnerId });
      return;
    }
    // Step 7: accounts.
    const sysAccount = await readCodexAccountId(systemAuth);
    if (!sysAccount && topology.linkType !== 'hardlink') return;
    const myAccount = hasLocalEntry ? await readCodexAccountId(myAuth) : null;
    if (legacyExplicitOwner && myAccount && myAccount !== sysAccount) {
      const migrated = migrateLegacyExplicitNativeProviderAuthToInstanceIsolated('openai', legacyExplicitOwner);
      log.info('keeping account-distinct legacy explicit Codex auth',
        { provenanceMigrated: migrated, ownerMatchesActive: legacyExplicitOwner === getActiveAppSession().dataOwnerId });
      return;
    }
    // Step 8: Windows keeps a standalone file (no Release snapshot on the Host).
    if (process.platform === 'win32' && topology.linkType === 'file') {
      if (legacyExplicitOwner) migrateLegacyExplicitNativeProviderAuthToInstanceIsolated('openai', legacyExplicitOwner);
      return;
    }
    if (hasLocalEntry) {
      log.warn('unproven Codex auth is an orphan repair candidate',
        { linkType: topology.linkType, accountMatch: myAccount ? myAccount === sysAccount : 'unknown', dryRunCandidate: true });
    }
    // Step 9: the reads above crossed awaits; a login may have started since.
    if (options.loginActive()) return;
    await fsp.mkdir(options.codexHome, { recursive: true }).catch(() => undefined);
    const { kind, error, linkType } = await relinkSharedCodexAuth(systemAuth, myAuth);
    if (kind === 'linked') log.info('codex auth.json linked with shared OpenAI login', { linkType });
    else if (kind === 'link-unsupported') log.warn('shared OpenAI auth link unavailable; use independent login', { error: error?.message });
    else if (kind === 'swap-failed-intact') log.warn('reconcile swap failed, auth.json left intact', { error: error?.message });
    else if (kind === 'recovered') log.warn('reconcile swap failed but auth.json recovered from shared source', { error: error?.message });
    else if (kind === 'lost') log.error('reconcile swap failed and auth.json lost; user must re-login', { error: error?.message });
  }

  /** claimDetectedCodexOAuthBinding (auth-adapters.ts 1061–1135), step 10. */
  function claim(systemAuth: string, sessionAtStart: { generation: number; dataOwnerId: string | null }): void {
    if (options.loginActive()) return;
    const session = getActiveAppSession();
    if (isAppSessionBoundaryPending()) return;
    if (session.generation !== sessionAtStart.generation || session.dataOwnerId !== sessionAtStart.dataOwnerId) return;
    if (restoreInvalidationStateOnStartup(options.codexHome, systemAuth, myAuth).invalidatedReason) return;
    if (shouldSuppressLocalCodexAuth(options.codexHome, myAuth)) return;
    const recoveryMarker = readInvalidatedSystemCodexAuthMarker(options.codexHome);
    const recoveryOwnerId = recoveryMarker?.credentialScope === 'system-shared' && typeof recoveryMarker.recoveryOwnerId === 'string'
      ? recoveryMarker.recoveryOwnerId : null;
    let claimed = false;
    try {
      if (recoveryOwnerId) {
        if (getActiveInvalidatedSystemCodexAuthMarker(options.codexHome, systemAuth, myAuth) !== null) return;
        claimed = restoreNativeProviderAuthForRecovery('openai', recoveryOwnerId, () => hasCodexOAuthLoginUnbound(options.codexHome));
        if (claimed) log.info('renewed shared Codex OAuth credential restored to invalidated owner');
      } else {
        claimed = claimDetectedNativeProviderAuth('openai', () => hasCodexOAuthLoginUnbound(options.codexHome));
        if (claimed) log.info('codex OAuth credential auto-bound to current owner after reconcile');
      }
    } catch (error) {
      log.warn('codex OAuth binding claim failed', { error: error instanceof Error ? error.message : String(error) });
    }
    if (!claimed) return;
    try {
      const result = options.onBindingClaimed?.() as Promise<unknown> | undefined;
      void result?.catch?.((error: unknown) => log.warn('codex OAuth binding claim follow-up failed',
        { error: error instanceof Error ? error.message : String(error) }));
    } catch (error) {
      log.warn('codex OAuth binding claim follow-up threw', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    systemAuthPath: options.systemAuthPath,
    /** reconcileWithSystemCodex: deduplicated; skipped during a login unless the login runs it. */
    reconcile(opts?: { allowCurrentLogin?: boolean }): Promise<void> {
      const systemAuth = options.systemAuthPath;
      if (!systemAuth) return Promise.resolve();
      if (!opts?.allowCurrentLogin && options.loginActive()) return Promise.resolve();
      if (pending) return pending;
      const sessionAtStart = getActiveAppSession();
      const current = run(systemAuth)
        .then(() => claim(systemAuth, sessionAtStart))
        .finally(() => { if (pending === current) pending = null; });
      pending = current;
      return current;
    },
    /** reconcileWithSystemCodexAfterLogin. */
    async reconcileAfterLogin(): Promise<void> {
      const inflight = pending;
      if (inflight) await inflight.catch(() => undefined);
      await this.reconcile();
    },
  };
}
