import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { getActiveAppSession } from '../appSessionState.js';

type NativeProviderId = 'anthropic' | 'openai' | 'xai';
type BindingFile = Partial<Record<NativeProviderId, string>> & {
  legacyClaimOwner?: string;
};

function bindingPath(): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.json');
}

function readBindings(): BindingFile {
  try {
    const value = JSON.parse(fs.readFileSync(bindingPath(), 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as BindingFile) : {};
  } catch {
    return {};
  }
}

function writeBindings(value: BindingFile): void {
  const file = bindingPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Return true only when the native OAuth credential is explicitly bound to this owner. */
export function isNativeProviderAuthBound(provider: NativeProviderId): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  // During unit/bootstrap code paths there may be no committed owner yet.
  // Owner-bound sessions are fail-closed; pre-session callers retain legacy
  // behavior until authentication commits an owner boundary.
  if (!owner) return true;
  return readBindings()[provider] === owner;
}

/** Bind newly completed native OAuth to the current data owner. */
export function bindNativeProviderAuth(provider: NativeProviderId): void {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) throw new Error('cannot bind native provider auth without an active data owner');
  writeBindings({ ...readBindings(), [provider]: owner });
}

/** Remove the current owner binding after logout/invalidation. */
export function unbindNativeProviderAuth(provider: NativeProviderId): void {
  const bindings = readBindings();
  if (!(provider in bindings)) return;
  delete bindings[provider];
  writeBindings(bindings);
}

/**
 * Claim pre-binding native OAuth credentials for the first verified cloud
 * owner. The durable marker prevents a later account from inheriting a
 * credential that was left in a shared CLI/keychain store after logout.
 */
export function migrateLegacyNativeProviderAuthBindings(
  ownerId: string,
  available: Partial<Record<NativeProviderId, boolean>>,
): void {
  const bindings = readBindings();
  if (bindings.legacyClaimOwner) return;

  const next: BindingFile = { ...bindings, legacyClaimOwner: ownerId };
  for (const provider of ['anthropic', 'openai', 'xai'] as const) {
    if (available[provider] && !next[provider]) next[provider] = ownerId;
  }
  writeBindings(next);
}

/**
 * Claim an auto-detected local CLI credential for the current owner.
 *
 * The Codex import channel materializes its credential lazily (the ~/.codex
 * reconcile hardlink is created after startup), so the one-shot legacy
 * migration above can consume `legacyClaimOwner` while the credential is not
 * visible yet — stranding the intended first-owner auto-connect forever, and
 * local-mode owners never run that migration at all. This repairs exactly
 * that: only when the slot has no owner, the credential exists, and no OTHER
 * account won the legacy claim. An existing binding is never overwritten, so
 * account switches stay fail-closed like migrateLegacyNativeProviderAuthBindings.
 */
export function claimDetectedNativeProviderAuth(
  provider: NativeProviderId,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) return false;
  const bindings = readBindings();
  // Key-presence, not truthiness: a corrupted/empty-string slot must count as
  // "claimed by unknown" and fail closed, never as re-claimable (matches
  // unbindNativeProviderAuth's `in` pattern).
  if (provider in bindings) return false;
  if ('legacyClaimOwner' in bindings && bindings.legacyClaimOwner !== owner) return false;
  if (!hasCredential()) return false;
  writeBindings({ ...bindings, [provider]: owner });
  return true;
}
