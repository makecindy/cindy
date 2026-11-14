import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_USER_DISCONNECT_REASON,
  isDurableDisconnectMarker,
  readInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  shouldSuppressLocalCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
  writeUnprovenCodexAuthSuppressionMarker,
} from '../../../desktop/src/main/maker-host/codex-auth-invalidation.js';
import { currentCodexCredentialGeneration, parseCodexCredentialGeneration } from '../../../desktop/src/main/maker-host/codexCredentialRead.js';
import { isNativeProviderAuthBound, isNativeProviderAuthRevoked, unbindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { getActiveAppSession } from '../../../desktop/src/main/appSessionState.js';
import { detectHostCodexCredentialScope } from './codex-system-login.js';
import { codexAuthPathsShareEntry } from '../../../desktop/src/main/maker-host/codex-auth-link.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

const log = createLogger('host-codex-invalidation');

/**
 * Where a runtime that never reconciles with the system login (a source run, see
 * codex-system-login.ts) points the marker: a path inside codex-home that never exists, so
 * the marker is the one the desktop writes when no system login is present.
 */
const NO_SYSTEM_CODEX_AUTH = '.cindy-host-no-system-codex-auth.json';
const markerSystemPath = (codexHome: string, systemAuthPath: string | null | undefined) =>
  systemAuthPath ?? path.join(codexHome, NO_SYSTEM_CODEX_AUTH);
type CredentialScope = 'instance-isolated' | 'system-shared' | 'unknown';

export type HostCodexInvalidationResult = 'invalidated' | 'stale' | 'unproven' | 'not-native' | 'failed';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Whether a login of the native connection is in progress; an unreadable answer counts as one. */
const loginWindowOpen = (input: { loginInProgress?: () => boolean }) => {
  try { return input.loginInProgress?.() ?? false; } catch { return true; }
};

/**
 * The desktop adapter's readCodexCredentialScope: the detected scope, else the last one known. The
 * desktop keeps that in memory and, after a restart, restores it from the marker; the Host keeps
 * no state and reads the marker, so a profile whose auth.json is gone keeps the scope its earlier
 * invalidation recorded.
 */
function readHostCodexCredentialScope(codexHome: string, systemAuthPath: string | null | undefined): CredentialScope {
  const detected = detectHostCodexCredentialScope(codexHome, systemAuthPath ?? null);
  if (detected !== 'unknown') return detected;
  const restored = restoreInvalidationStateOnStartup(codexHome, markerSystemPath(codexHome, systemAuthPath), path.join(codexHome, 'auth.json'));
  return restored.credentialScope && restored.credentialScope !== 'unknown' ? restored.credentialScope : 'unknown';
}

/**
 * The desktop's commitExplicitCodexDisconnectBoundary for the profile's native login: the durable
 * disconnect marker over the current file. It stops the reconciliation with the system login and
 * suppresses that file until a new login replaces it; the file itself stays. Throws when the
 * marker cannot be written, as the desktop's logout does.
 */
export function commitHostCodexDisconnectBoundary(codexHome: string, systemAuthPath?: string | null): void {
  const persisted = writeInvalidatedSystemCodexAuthMarker(codexHome, markerSystemPath(codexHome, systemAuthPath),
    CODEX_USER_DISCONNECT_REASON, path.join(codexHome, 'auth.json'));
  if (!persisted) throw new Error('failed to persist Codex disconnect state');
}

/**
 * The invalidation the profile's marker still reports, as the desktop restores it on
 * startup: the rejected login is still in place (or gone) and nothing replaced it.
 */
export function readHostCodexInvalidation(codexHome: string, systemAuthPath?: string | null): { reason: string; credentialScope: CredentialScope } | null {
  const restored = restoreInvalidationStateOnStartup(codexHome, markerSystemPath(codexHome, systemAuthPath), path.join(codexHome, 'auth.json'));
  return restored.invalidatedReason ? { reason: restored.invalidatedReason, credentialScope: restored.credentialScope ?? 'unknown' } : null;
}

/**
 * The desktop's recovery requirement (oauthRecoveryRequiredReason): the invalidated login was
 * replaced, but no account request has proven the replacement yet.
 */
export function readHostCodexRecoveryRequirement(codexHome: string, systemAuthPath?: string | null): { reason: string; credentialScope: CredentialScope } | null {
  const restored = restoreInvalidationStateOnStartup(codexHome, markerSystemPath(codexHome, systemAuthPath), path.join(codexHome, 'auth.json'));
  return restored.recoveryRequiredReason ? { reason: restored.recoveryRequiredReason, credentialScope: restored.credentialScope ?? 'unknown' } : null;
}

/**
 * Server-side invalidation of the profile's native OpenAI login, in the order of the
 * desktop Codex adapter's instance-isolated branch (auth-adapters.ts invalidate and
 * disconnectCodexOAuth): the marker over the rejected credential, the native
 * authorization unbound, the rejected auth.json removed, the local Codex host disposed,
 * the account-less models cache removed, then the change announced. The marker is
 * written only when the rejected credential is still the current one.
 */
export async function invalidateHostCodexLogin(input: {
  codexHome: string;
  /** The system login this runtime reconciles with (codex-system-login.ts); null when none. */
  systemAuthPath?: string | null;
  /** Reported by the engine with its context, as the desktop's invalidate(reason, context). */
  hostBound?: boolean;
  reason: string;
  /** The provider of the reporting task, as maker-core reports it. */
  providerId?: string;
  /**
   * The desktop's isCodexAccountProvider: an independent Codex account retires its own host and
   * is invalidated through the account service, never here.
   */
  isCodexAccountProvider: (providerId: string) => boolean;
  /** maker-core's credential generation (JSON of the rejected auth.json fingerprint). */
  credentialGeneration?: string | null;
  credentialAttribution?: 'unproven';
  /** Whether a login of the native connection is in progress (the account service's). */
  loginInProgress?: () => boolean;
  /**
   * The desktop's isCodexDisconnectCurrent: whether the owner that started this invalidation is
   * still current. The cleanup stops where the desktop's logout stops once it is not.
   */
  isCurrent?: () => boolean;
  /** The desktop's onLogoutSuccess: retire the local Codex host holding the old token. */
  disposeLocalHost?: () => Promise<void>;
  /** The desktop's onInvalidatedBroadcast, called last, after the marker write and cleanup. */
  onInvalidated?: (credentialScope: CredentialScope) => void | Promise<void>;
}): Promise<HostCodexInvalidationResult> {
  // As the desktop: only an independent account is left to the account service. A task on the
  // gateway or a custom provider that reports a ChatGPT login failure invalidates the native login.
  if (input.providerId && input.isCodexAccountProvider(input.providerId)) return 'not-native';
  const authPath = path.join(input.codexHome, 'auth.json');
  if (input.credentialAttribution === 'unproven') return invalidateUnattributed(input, authPath);
  const existing = readInvalidatedSystemCodexAuthMarker(input.codexHome);
  if (existing && isDurableDisconnectMarker(existing) && (!fs.existsSync(authPath) || shouldSuppressLocalCodexAuth(input.codexHome, authPath))) {
    // As on the desktop: a late failure after an explicit disconnect changes nothing.
    log.info('ignoring stale Codex invalidation after explicit disconnect', { reason: input.reason });
    return 'stale';
  }
  const current = currentCodexCredentialGeneration(authPath);
  const captured = parseCodexCredentialGeneration(input.credentialGeneration);
  // As the desktop: the profile's file being gone is no reason to skip the invalidation (a late
  // failure after an earlier invalidation re-asserts it), except while a login in progress owns
  // that gap (the desktop's loginCleanupOwnsMissingCredential). After an explicit disconnect the
  // durable marker above has already ended it.
  if (captured && !current && loginWindowOpen(input)) {
    log.info('ignoring stale Codex invalidation during login credential cleanup', { reason: input.reason });
    return 'stale';
  }
  // As the desktop (auth-adapters.ts invalidate): the generation the engine captured is compared
  // with the current file. A changed file identity proves an outside atomic replacement, and a
  // login in progress (the desktop's open login cancellation window) is still finalizing the
  // replacement it selected; either way the current credential is left alone.
  const contentChanged = Boolean(captured && current && captured.sha256 !== current.sha256);
  const identityChanged = Boolean(contentChanged && captured && current && captured.ino !== '0' && current.ino !== '0'
    && (captured.dev !== current.dev || captured.ino !== current.ino));
  if (contentChanged && (identityChanged || loginWindowOpen(input))) {
    log.info('ignoring stale Codex invalidation from an older credential generation', { reason: input.reason });
    return 'stale';
  }
  log.warn('codex auth invalidated', { reason: input.reason });
  // As the desktop: a rewrite in place (or a file without identity) is ambiguous, so the marker
  // carries no invalidated fingerprint and suppresses the current file without attributing the
  // rejected credential to it. Without a captured generation there is no fingerprint either.
  const invalidatedFingerprint = contentChanged || !captured ? null
    : { dev: Number(captured.dev), ino: Number(captured.ino), size: captured.size, mtimeMs: captured.mtimeMs, sha256: captured.sha256 };
  // As the desktop: the scope the credential has, and for a shared system login the owner a
  // renewed system login is restored to. An engine-reported invalidation of a shared system
  // login without an invalidated fingerprint cannot prove which file failed (the user may have
  // logged in again in between), so it is recorded as unknown.
  const detectedScope = readHostCodexCredentialScope(input.codexHome, input.systemAuthPath);
  const markerScope: CredentialScope = input.hostBound === true && detectedScope === 'system-shared' && !invalidatedFingerprint
    ? 'unknown' : detectedScope;
  const activeOwnerId = getActiveAppSession().dataOwnerId;
  const recoveryOwnerId = markerScope === 'system-shared' && activeOwnerId && isNativeProviderAuthBound('openai') ? activeOwnerId : undefined;
  const committed = writeInvalidatedSystemCodexAuthMarker(input.codexHome, markerSystemPath(input.codexHome, input.systemAuthPath),
    input.reason, authPath, markerScope, recoveryOwnerId, invalidatedFingerprint ?? undefined);
  let credentialScope: CredentialScope = markerScope;
  let fallbackCommitted = false;
  if (!committed) {
    // As on the desktop: the provider revocation becomes the coarser cross-restart boundary
    // (recovery then needs an explicit login), and the cleanup below still runs.
    log.error('failed to persist Codex invalidation marker; revoking the native authorization', { reason: input.reason });
    try {
      unbindNativeProviderAuth('openai', { revoked: true });
      fallbackCommitted = isNativeProviderAuthRevoked('openai');
      if (fallbackCommitted) credentialScope = 'unknown';
    } catch (error) {
      log.error('failed to persist fallback Codex provider revocation', { error: errorText(error) });
    }
  }
  try { unbindNativeProviderAuth('openai'); } catch (error) {
    log.warn('early unbind after Codex invalidation failed', { error: errorText(error) });
  }
  await cleanUpAfterInvalidation(input, authPath, committed || fallbackCommitted);
  // As the desktop: no announcement once the invalidation is no longer the current one (a later
  // invalidation with another reason or scope, a login that replaced the credential, an explicit
  // disconnect). The desktop compares its in-memory reason and scope; the Host keeps no state and
  // reads the marker as getState does. Without a committed marker there is nothing newer to
  // compare with, and it announces as the desktop does from memory.
  if (committed) {
    const now = readHostCodexInvalidation(input.codexHome, input.systemAuthPath);
    if (now?.reason !== input.reason || now.credentialScope !== credentialScope) {
      log.info('Codex invalidation superseded during cleanup; not announcing', { reason: input.reason });
      return 'invalidated';
    }
  }
  await announce(input, credentialScope);
  return committed || fallbackCommitted ? 'invalidated' : 'failed';
}

/**
 * The desktop's logout({ preserveInvalidatedReason }) cleanup (runLogout, disconnectCodexOAuth), in
 * its order. As there, each step runs only while the owner that started it is still current
 * (isCodexDisconnectCurrent before the removal, after it, after the host retirement and after the
 * models cache): what is left belongs to the next owner, whose binding the last unbind would clear.
 */
async function cleanUpAfterInvalidation(input: Parameters<typeof invalidateHostCodexLogin>[0], authPath: string, committed: boolean) {
  const current = () => { try { return input.isCurrent?.() ?? true; } catch { return false; } };
  if (!current()) return;
  try {
    // As the desktop's disconnectCodexOAuth: a server invalidation never removes auth.json when the
    // profile's entry is the system login's own (codex-home is, or links to, ~/.codex). Checked
    // against the system login this runtime uses and, as the desktop's getCodexCliAuthPath, the
    // user's ~/.codex/auth.json. A failed check keeps the file.
    const systemEntries = [input.systemAuthPath, path.join(os.homedir(), '.codex', 'auth.json')];
    if (!systemEntries.some(entry => entry && codexAuthPathsShareEntry(authPath, entry))) {
      await fs.promises.rm(authPath, { force: true });
    }
  } catch (error) {
    log.warn(committed
      ? 'remove Codex auth.json after committed invalidation failed; credential remains suppressed'
      : 'remove Codex auth.json after uncommitted invalidation failed', { error: errorText(error) });
  }
  if (!current()) return;
  try { await input.disposeLocalHost?.(); } catch (error) {
    log.warn('Codex host disposal after invalidation failed', { error: errorText(error) });
  }
  if (!current()) return;
  try { await fs.promises.rm(path.join(input.codexHome, 'models_cache.json'), { force: true }); } catch (error) {
    log.warn('remove stale Codex models_cache.json failed', { error: errorText(error) });
  }
  if (!current()) return;
  try { unbindNativeProviderAuth('openai'); } catch (error) {
    log.warn('unbind Codex OAuth provider after invalidation failed', { error: errorText(error) });
  }
}

async function announce(input: Parameters<typeof invalidateHostCodexLogin>[0], credentialScope: CredentialScope) {
  try { await input.onInvalidated?.(credentialScope); } catch (error) {
    log.warn('onInvalidatedBroadcast threw', { error: errorText(error) });
  }
}

/**
 * The desktop's branch for a child that failed without saying which auth.json it loaded:
 * keep the credential byte for byte, and suppress the current one with a marker that a
 * replacement login releases. Explicit disconnects and logins in progress are left alone.
 */
async function invalidateUnattributed(input: Parameters<typeof invalidateHostCodexLogin>[0], authPath: string): Promise<HostCodexInvalidationResult> {
  const existing = readInvalidatedSystemCodexAuthMarker(input.codexHome);
  if (existing && isDurableDisconnectMarker(existing)) {
    log.info('ignoring unproven Codex invalidation after explicit disconnect', { reason: input.reason });
    return 'stale';
  }
  let loginActive: boolean;
  try { loginActive = input.loginInProgress?.() ?? false; } catch { loginActive = true; }
  if (loginActive) {
    log.info('ignoring unproven Codex invalidation while a tracked login is active', { reason: input.reason });
    return 'stale';
  }
  const detectedScope = readHostCodexCredentialScope(input.codexHome, input.systemAuthPath);
  const activeOwnerId = getActiveAppSession().dataOwnerId;
  const recoveryOwnerId = detectedScope === 'system-shared' && activeOwnerId && isNativeProviderAuthBound('openai') ? activeOwnerId : undefined;
  const committed = writeUnprovenCodexAuthSuppressionMarker(input.codexHome, markerSystemPath(input.codexHome, input.systemAuthPath),
    authPath, input.reason, detectedScope, recoveryOwnerId);
  let credentialScope: CredentialScope = detectedScope;
  let fallbackCommitted = false;
  if (!committed) {
    log.error('failed to persist unproven Codex suppression marker; revoking provider claim', { reason: input.reason });
    try {
      // The child generation is unknown, so this revokes only the provider claim and keeps
      // auth.json intact; an explicit login proves the replacement and clears it.
      unbindNativeProviderAuth('openai', { revoked: true });
      fallbackCommitted = isNativeProviderAuthRevoked('openai');
      if (fallbackCommitted) credentialScope = 'unknown';
    } catch (error) {
      log.error('failed to persist fallback Codex provider revocation', { error: errorText(error) });
    }
  }
  log.warn('codex child auth invalidated without credential attribution; preserving auth.json',
    { reason: input.reason, markerCommitted: committed, durableFallbackCommitted: fallbackCommitted });
  await announce(input, credentialScope);
  return committed || fallbackCommitted ? 'unproven' : 'failed';
}
