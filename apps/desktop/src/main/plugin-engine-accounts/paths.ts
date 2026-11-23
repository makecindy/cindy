/**
 * Where Cindy keeps the accounts it adds to a plugin engine (subscription-account-pools.md
 * 插件引擎的账号): `owners/<account>/plugin-engine-accounts/<plugin instance>/<engine id>/<account id>/`.
 * The plugin's agent keeps that account's sign-in and history there; the plugin never picks the path.
 * The agent's original login has no directory here.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
/** Same shape as the built-in pool's account ids, so shared validators accept them. */
const ACCOUNT_ID = /^cindy-[a-f0-9]{12}-[a-f0-9-]{36}$/;

function segment(value: string): string {
  return SEGMENT.test(value) && value !== '.' && value !== '..'
    ? value
    : `h-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function ownerPrefix(): string | null {
  const owner = getActiveAppSession().dataOwnerId;
  return owner ? createHash('sha256').update(owner).digest('hex').slice(0, 12) : null;
}

export function isPluginEngineAccountId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'default' || ACCOUNT_ID.test(value));
}

/** A new account id of the current Cindy account. */
export function newPluginEngineAccountId(): string {
  const prefix = ownerPrefix();
  if (!prefix) throw new Error('An active owner is required');
  return `cindy-${prefix}-${randomUUID()}`;
}

/** The engine's own account root; null while no Cindy account is active. */
export function pluginEngineAccountRoot(ghostId: string, harnessId: string): string | null {
  if (!getActiveAppSession().dataOwnerId) return null;
  return ownerScopedUserDataPath('plugin-engine-accounts', segment(ghostId), segment(harnessId));
}

/** Directory of an account Cindy added; the original login (`default`) has none. */
export function pluginEngineAccountDir(ghostId: string, harnessId: string, accountId: string): string {
  const prefix = ownerPrefix();
  const root = pluginEngineAccountRoot(ghostId, harnessId);
  if (!root || !prefix || accountId === 'default' || !ACCOUNT_ID.test(accountId) || !accountId.startsWith(`cindy-${prefix}-`))
    throw new Error('Plugin engine account is unavailable');
  return path.join(root, accountId);
}

export async function ensurePluginEngineAccountDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Uninstalling a plugin removes the accounts Cindy added to its engines (their sign-ins and
 * history) together with its other data; disabling it keeps them.
 */
export async function removePluginEngineAccountsOfPlugin(ghostId: string): Promise<void> {
  if (!getActiveAppSession().dataOwnerId) return;
  await fs.rm(ownerScopedUserDataPath('plugin-engine-accounts', segment(ghostId)), { recursive: true, force: true });
}
