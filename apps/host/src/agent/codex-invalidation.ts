import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  isDurableDisconnectMarker,
  readInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  shouldSuppressLocalCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
  writeUnprovenCodexAuthSuppressionMarker,
} from '../../../desktop/src/main/maker-host/codex-auth-invalidation.js';
import { currentCodexCredentialGeneration } from '../../../desktop/src/main/maker-host/codexCredentialRead.js';
import { isNativeProviderAuthBound, isNativeProviderAuthRevoked, unbindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { getActiveAppSession } from '../../../desktop/src/main/appSessionState.js';
import { detectHostCodexCredentialScope } from './codex-system-login.js';
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

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  /** Independent accounts are invalidated through the account store, never here. */
  providerId?: string;
  /** The access token the server rejected, when the caller has it. */
  failedAccessToken?: string;
  /** maker-core's credential generation (JSON of the rejected auth.json fingerprint). */
  credentialGeneration?: string | null;
  credentialAttribution?: 'unproven';
  /** Whether a login of the native connection is in progress (the account service's). */
  loginInProgress?: () => boolean;
  /** The desktop's onLogoutSuccess: retire the local Codex host holding the old token. */
  disposeLocalHost?: () => Promise<void>;
  /** The desktop's onInvalidatedBroadcast, called last, after the marker write and cleanup. */
  onInvalidated?: (credentialScope: CredentialScope) => void | Promise<void>;
}): Promise<HostCodexInvalidationResult> {
  if (input.providerId && input.providerId !== 'openai') return 'not-native';
  const authPath = path.join(input.codexHome, 'auth.json');
  if (input.credentialAttribution === 'unproven') return invalidateUnattributed(input, authPath);
  const existing = readInvalidatedSystemCodexAuthMarker(input.codexHome);
  if (existing && isDurableDisconnectMarker(existing) && (!fs.existsSync(authPath) || shouldSuppressLocalCodexAuth(input.codexHome, authPath))) {
    // As on the desktop: a late failure after an explicit disconnect changes nothing.
    log.info('ignoring stale Codex invalidation after explicit disconnect', { reason: input.reason });
    return 'stale';
  }
  const current = currentCodexCredentialGeneration(authPath);
  if (!current) return 'stale';
  if (input.failedAccessToken !== undefined) {
    let token: unknown;
    try { token = JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens?.access_token; } catch { token = undefined; }
    if (typeof token !== 'string' || !sameToken(token, input.failedAccessToken)) return 'stale';
  }
  if (input.credentialGeneration) {
    let sha256: unknown;
    try { sha256 = JSON.parse(input.credentialGeneration).sha256; } catch { sha256 = undefined; }
    if (sha256 !== current.sha256) return 'stale';
  }
  log.warn('codex auth invalidated', { reason: input.reason });
  // As the desktop (auth-adapters.ts invalidate): the scope the credential has, and for a
  // shared system login the owner a renewed system login is restored to.
  const detectedScope = detectHostCodexCredentialScope(input.codexHome, input.systemAuthPath ?? null);
  // As the desktop: an engine-reported invalidation of a shared system login without the spawn's
  // credential generation cannot prove which file failed (the user may have logged in again in
  // between), so it is recorded as unknown, without the invalidated fingerprint.
  const ambiguousShared = input.hostBound === true && detectedScope === 'system-shared' && !input.credentialGeneration;
  const markerScope: CredentialScope = ambiguousShared ? 'unknown' : detectedScope;
  const activeOwnerId = getActiveAppSession().dataOwnerId;
  const recoveryOwnerId = markerScope === 'system-shared' && activeOwnerId && isNativeProviderAuthBound('openai') ? activeOwnerId : undefined;
  const committed = writeInvalidatedSystemCodexAuthMarker(input.codexHome, markerSystemPath(input.codexHome, input.systemAuthPath),
    input.reason, authPath, markerScope, recoveryOwnerId, ambiguousShared ? undefined
      : { dev: Number(current.dev), ino: Number(current.ino), size: current.size, mtimeMs: current.mtimeMs, sha256: current.sha256 });
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
  try { await fs.promises.rm(authPath, { force: true }); } catch (error) {
    log.warn(committed || fallbackCommitted
      ? 'remove Codex auth.json after committed invalidation failed; credential remains suppressed'
      : 'remove Codex auth.json after uncommitted invalidation failed', { error: errorText(error) });
  }
  try { await input.disposeLocalHost?.(); } catch (error) {
    log.warn('Codex host disposal after invalidation failed', { error: errorText(error) });
  }
  try { await fs.promises.rm(path.join(input.codexHome, 'models_cache.json'), { force: true }); } catch (error) {
    log.warn('remove stale Codex models_cache.json failed', { error: errorText(error) });
  }
  try { unbindNativeProviderAuth('openai'); } catch (error) {
    log.warn('unbind Codex OAuth provider after invalidation failed', { error: errorText(error) });
  }
  await announce(input, credentialScope);
  return committed || fallbackCommitted ? 'invalidated' : 'failed';
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
  const detectedScope = detectHostCodexCredentialScope(input.codexHome, input.systemAuthPath ?? null);
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
