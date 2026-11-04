/**
 * Active data-owner context for owner-scoped preference files.
 *
 * The Desktop main process and the Node host both keep per-owner settings, but
 * only Desktop owns an in-process account session. This module lets either one
 * install the facts once, so settings stores no longer import `electron` through
 * the session module just to answer "which owner root".
 */

import path from 'node:path';

import { dataOwnerStorageKey } from './dataOwnerPath.js';
import { getUserDataDir } from './userDataPath.js';

export interface OwnerContextFacts {
  /** Server-confirmed owner id; null while signed out or unsettled. */
  dataOwnerId: string | null;
  /** Bumped on every owner commit so caches can be dropped. */
  generation: number;
  /** True while an owner transition is in flight; reads must fail closed. */
  boundaryPending: boolean;
}

export interface OwnerContextConfig {
  read(): OwnerContextFacts;
  /**
   * Where owner-scoped reads go when no owner is committed (Desktop: a private
   * per-process temp namespace). Hosts without that fallback should throw here
   * so a misconfigured owner never writes into another account's state.
   */
  fallbackBaseDir(): string;
}

let config: OwnerContextConfig | null = null;

export function configureOwnerContext(next: OwnerContextConfig): void {
  config = next;
}

function requireConfig(): OwnerContextConfig {
  if (!config) {
    throw new Error('owner context is not configured; call configureOwnerContext() during startup');
  }
  return config;
}

/**
 * `<userData>/owners/<key>/<parts...>`, or the configured fallback while no owner
 * is committed. Callers must not silently treat the fallback as real owner data.
 */
export function ownerScopedPath(...parts: string[]): string {
  const active = requireConfig();
  const ownerId = active.read().dataOwnerId;
  if (!ownerId) return path.join(active.fallbackBaseDir(), ...parts);
  return path.join(getUserDataDir(), 'owners', dataOwnerStorageKey(ownerId), ...parts);
}

/** Current committed owner id, or null while signed out / unsettled. */
export function activeDataOwnerId(): string | null {
  return requireConfig().read().dataOwnerId;
}

/** True while an owner transition is in flight. */
export function isOwnerBoundaryPending(): boolean {
  return requireConfig().read().boundaryPending;
}

/** Commit generation for cache invalidation; changes on login/logout/switch. */
export function ownerGeneration(): number {
  return requireConfig().read().generation;
}

/** True when the owner namespace is real (not the no-owner fallback). */
export function hasCommittedOwner(): boolean {
  return requireConfig().read().dataOwnerId !== null;
}
