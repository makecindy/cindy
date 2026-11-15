/**
 * SSH part of new-computer setup (docs/product-rules/new-device-setup-migration.md).
 *
 * Other computer: lists the servers Cindy shows there (how to reach them and the host key it
 * already trusts) and, after a person allowed it there, appends the new computer's public key to
 * each server's `~/.ssh/authorized_keys` over the connection it already has.
 * This computer: adds those servers to Cindy's own SSH file with its new key, seeds the trusted
 * fingerprint for the first connection and checks that each one connects.
 *
 * Private keys never leave their computer; servers that cannot be reached this way stay on the
 * one-time checklist.
 */
import { hostKeyId, type HostConfig } from '@cindy/maker-remote-ssh';
import type { SetupSnapshotSshHost, SetupTransferSshResult } from '@cindy/device-link';

import { createLogger } from '../logger.js';
import {
  addRemoteSshHost,
  ensureRemoteHostReady,
  getRemoteSshHostKeyStore,
  getRemoteSshPool,
  getRemoteSshPoolHydrated,
} from './index.js';
import { getSshHostDisplayName } from './ssh-host-prefs-store.js';
import { AUTHORIZE_SCRIPT, isLoopbackSshHostname, shellQuote } from './setupMigrationSshScript.js';

const log = createLogger('setup-migration-ssh');
const AUTHORIZE_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;

export async function listSetupSshHosts(): Promise<SetupSnapshotSshHost[]> {
  const pool = await getRemoteSshPoolHydrated();
  const store = getRemoteSshHostKeyStore();
  const out: SetupSnapshotSshHost[] = [];
  for (const snapshot of pool.list()) {
    const config = snapshot.config;
    if (isLoopbackSshHostname(config.hostname)) continue;
    let hostKey: string | null = null;
    try {
      hostKey = await store.get(hostKeyId(config.hostname, config.port));
    } catch {
      hostKey = null;
    }
    out.push({
      id: config.id,
      displayName: getSshHostDisplayName(config.id),
      hostname: config.hostname,
      port: config.port,
      user: config.user,
      hostKey,
    });
  }
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : String(error);
  return /^\[([A-Z][A-Z0-9_]{1,63})\]/.exec(message)?.[1] ?? 'SSH_AUTHORIZE_FAILED';
}

/** Other computer: runs only after its person allowed this request. */
export async function authorizeSetupSshKey(
  hosts: readonly string[],
  publicKey: string,
): Promise<SetupTransferSshResult[]> {
  await getRemoteSshPoolHydrated();
  return mapLimit(hosts, CONCURRENCY, async (id): Promise<SetupTransferSshResult> => {
    const host = getRemoteSshPool().get(id);
    if (!host || isLoopbackSshHostname(host.config.hostname)) {
      return { host: id, outcome: 'failed', code: 'SSH_HOST_NOT_FOUND' };
    }
    try {
      await ensureRemoteHostReady(id);
      const ready = getRemoteSshPool().get(id);
      if (!ready) return { host: id, outcome: 'failed', code: 'SSH_HOST_NOT_FOUND' };
      const result = await ready.exec(`sh -c ${shellQuote(AUTHORIZE_SCRIPT)}`, {
        input: publicKey,
        timeoutMs: AUTHORIZE_TIMEOUT_MS,
        label: 'setup authorize key',
      });
      const answer = result.stdout.trim().split('\n').pop();
      if (result.exitCode === 0 && answer === 'ADDED') return { host: id, outcome: 'added' };
      if (result.exitCode === 0 && answer === 'PRESENT') return { host: id, outcome: 'present' };
      return { host: id, outcome: 'failed', code: 'SSH_AUTHORIZE_FAILED' };
    } catch (error) {
      log.warn('setup ssh authorize failed', { host: id, code: failureCode(error) });
      return { host: id, outcome: 'failed', code: failureCode(error) };
    }
  });
}

export type SetupSshAddOutcome = { outcome: 'done' } | { outcome: 'failed'; code: string };

/**
 * This computer: adds one server with the new key, trusts the fingerprint the other computer
 * already trusted (only when this computer has none for it), then checks it connects.
 */
export async function addAndCheckSetupSshHost(
  host: SetupSnapshotSshHost,
  identityFile: string,
): Promise<SetupSshAddOutcome> {
  try {
    if (host.hostKey) {
      const store = getRemoteSshHostKeyStore();
      const id = hostKeyId(host.hostname, host.port);
      if ((await store.get(id)) === null) await store.set(id, host.hostKey);
    }
    await addRemoteSshHost({
      id: host.id,
      displayName: host.displayName,
      hostname: host.hostname,
      port: host.port,
      user: host.user,
      authMethod: 'key' satisfies HostConfig['authMethod'],
      identityFile,
    });
  } catch (error) {
    return { outcome: 'failed', code: failureCode(error) };
  }
  try {
    await ensureRemoteHostReady(host.id);
    return { outcome: 'done' };
  } catch (error) {
    return { outcome: 'failed', code: failureCode(error) };
  } finally {
    // Only a check: leave the connection to the user's own auto-connect choice.
    await getRemoteSshPool().disconnect(host.id).catch(() => {});
  }
}

/** Aliases already known here (Cindy's file and the user's own SSH config). */
export async function localSshHostIds(): Promise<Set<string>> {
  const pool = await getRemoteSshPoolHydrated();
  return new Set(pool.list().map((snapshot) => snapshot.config.id));
}
