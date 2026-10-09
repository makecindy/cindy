import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { migrateAtlassianAccountsWithResult, XD_ATLASSIAN_GHOST_ID, XD_ATLASSIAN_SECRET_KEY } from '../atlassianAccountsMigration.js';
const FILO_GOOGLE_GHOST_ID = 'filo-google';
const FILO_GOOGLE_SECRET_KEY = 'google_account';
import { isCindyOfficialTrustInfo, CINDY_OFFICIAL_GHOST_TRUST } from '../GhostManager.js';
import { GhostOauthAccountManager } from '../ghostOauthAccounts.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

const loadActivation = createGhostProductionCallbacks<{ activateGhostsAndMigrateLegacyAccounts: () => string }>({
  variables: ['activateGhostsAndMigrateLegacyAccounts'],
});

function legacyAccountsFixture(id: string) {
  const secretKey = id === XD_ATLASSIAN_GHOST_ID ? XD_ATLASSIAN_SECRET_KEY : FILO_GOOGLE_SECRET_KEY;
  const oauth = { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: id === FILO_GOOGLE_GHOST_ID ? 'https://oauth2.googleapis.com/token' : 'https://auth.atlassian.com/oauth/token',
    clientId: 'fake-legacy-client', scopes: [],
    ...(id === XD_ATLASSIAN_GHOST_ID ? { tokenBroker: 'jira', redirectPort: 53682 } : {}),
  };
  let qualified = true;
  const ghost: InstalledGhost = { manifest: { schemaVersion: 3, id, name: id, version: '1.0.0',
    kind: 'chip', entry: 'main.js', network: { hosts: ['api.example.com'], secrets: [{ key: secretKey,
      label: 'Account', source: 'oauth', inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.com'] }, oauth }] } },
    dir: '/plugins/' + id, enabled: true, namespace: null,
    approval: { state: 'approved', revision: 'legacy' },
  };
  const data = new Map<string, string>();
  const vault = { read: (targetId: string, key: string) => data.get(targetId + ' ' + key) ?? null,
    store: (targetId: string, key: string, value: string) => { data.set(targetId + ' ' + key, value); return true; },
    remove: (targetId: string, key: string) => { data.delete(targetId + ' ' + key); },
  };
  const readLegacyEncryptedSecret = vi.fn(() => ({ status: 'available', value: 'fake-legacy-refresh-token' }));
  const log = { info: vi.fn(), warn: vi.fn() };
  const manager = { list: () => [ghost], reconcilePendingRootNamespaces: async () => {},
    readLegacyFirstPartyEligible: () => qualified,
    readApprovedInstallReceipt: (targetId: string, revision: string) => targetId === id &&
      ghost.approval?.state === 'approved' && ghost.approval.revision === revision
      ? { legacyFirstPartyEligible: qualified, trust: ghost.trust } : null,
  };
  const api = loadActivation({ manager, installedGhostStoragePart, isCindyOfficialTrustInfo,
    findGhostForPhysicalStoragePart: (targetId: string) => installedGhostStoragePart(ghost) === targetId ? ghost : null,
    spawnIfResident: vi.fn(), getActiveAppSession: () => ({ dataOwnerId: 'owner' }),
    getAppCapabilities: () => ({ canUseCindyAccountServices: true }), hasLegacyOwnerNamespaceClaim: () => true,
    app: { getPath: () => '/test-user-data' }, path, log, readLegacyEncryptedSecret,
    readLegacyJson: () => ({ status: 'available', value: { email: 'fake@example.com',
      accounts: [{ id: 'account', email: 'fake@example.com', credentialProfileId: 'filoCurrent', updatedAt: 1 }] } }),
    readGhostSecret: vault.read, storeGhostSecret: vault.store, removeGhostSecret: vault.remove,
    migrateAtlassianAccountsWithResult,
    XD_ATLASSIAN_GHOST_ID, XD_ATLASSIAN_SECRET_KEY, FILO_GOOGLE_GHOST_ID, FILO_GOOGLE_SECRET_KEY,
    LEGACY_JIRA_RT_FILE: 'jira_refresh_token.enc', LEGACY_JIRA_CONNECTION_FILE: 'jira_connection.json',
    CINDY_GITHUB_GHOST_ID: 'cindy-github', CINDY_GITLAB_GHOST_ID: 'cindy-gitlab',
    getGhostSetupChangeBus: () => ({ emit: vi.fn() }),
  });
  return { ...api, ghost, vault, data, readLegacyEncryptedSecret, secretKey,
    replaceSource: () => { qualified = false; data.clear(); ghost.approval = { state: 'approved', revision: 'replacement' }; },
  };
}

describe('legacy account activation source boundaries', () => {
  it('does not import legacy Google accounts into Filo', () => {
    const fixture = legacyAccountsFixture(FILO_GOOGLE_GHOST_ID);
    expect(fixture.activateGhostsAndMigrateLegacyAccounts()).toBe('completed');
    expect(fixture.readLegacyEncryptedSecret).not.toHaveBeenCalled();
    expect(fixture.data.size).toBe(0);
  });

  it.each([XD_ATLASSIAN_GHOST_ID])('does not restore archived %s tokens to a replacement source', async (id) => {
    const fixture = legacyAccountsFixture(id);
    fixture.ghost.namespace = 'acme';
    fixture.activateGhostsAndMigrateLegacyAccounts();
    expect(fixture.readLegacyEncryptedSecret).toHaveBeenCalled();
    expect(fixture.data.size).toBeGreaterThan(0);
    fixture.replaceSource();
    fixture.readLegacyEncryptedSecret.mockClear();
    fixture.activateGhostsAndMigrateLegacyAccounts();
    expect(fixture.data.size).toBe(0);
    expect(fixture.readLegacyEncryptedSecret).not.toHaveBeenCalled();
    const oauth = fixture.ghost.manifest.network!.secrets![0].oauth!;
    oauth.tokenUrl = 'https://attacker.example/token';
    delete oauth.tokenBroker;
    expect(fixture.activateGhostsAndMigrateLegacyAccounts()).toBe('completed');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }));
    const accounts = new GhostOauthAccountManager({ vault: fixture.vault, openExternal: vi.fn(), fetchImpl });
    expect(await accounts.getFreshAccessToken(id, fixture.secretKey, oauth)).toEqual({ ok: false, error: 'NO_ACCOUNT' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fixture.readLegacyEncryptedSecret).not.toHaveBeenCalled();
    expect(fixture.data.size).toBe(0);
  });

  it.each([XD_ATLASSIAN_GHOST_ID, FILO_GOOGLE_GHOST_ID])('does not migrate %s to a different physical instance', (id) => {
    const fixture = legacyAccountsFixture(id);
    fixture.ghost.dir = '/plugins/_ns/_root/' + id;
    fixture.activateGhostsAndMigrateLegacyAccounts();
    expect(fixture.readLegacyEncryptedSecret).not.toHaveBeenCalled();
    expect(fixture.data.size).toBe(0);
  });

  it.each([XD_ATLASSIAN_GHOST_ID, FILO_GOOGLE_GHOST_ID])('does not migrate %s to an incompatible OAuth provider', (id) => {
    const fixture = legacyAccountsFixture(id);
    fixture.ghost.manifest.network!.secrets![0].oauth!.tokenUrl = 'https://attacker.example/token';
    delete fixture.ghost.manifest.network!.secrets![0].oauth!.tokenBroker;
    fixture.activateGhostsAndMigrateLegacyAccounts();
    expect(fixture.readLegacyEncryptedSecret).not.toHaveBeenCalled();
    expect(fixture.data.size).toBe(0);
  });

  it('does not import legacy Google accounts into a trusted bundled Filo install', () => {
    const fixture = legacyAccountsFixture(FILO_GOOGLE_GHOST_ID);
    fixture.ghost.builtin = true;
    fixture.ghost.trust = CINDY_OFFICIAL_GHOST_TRUST;
    fixture.activateGhostsAndMigrateLegacyAccounts();
    expect(fixture.readLegacyEncryptedSecret).not.toHaveBeenCalled();
    expect(fixture.data.size).toBe(0);
  });
});

describe('legacy Ghost recovery acknowledgement orchestration', () => {
  it('routes startup migration through the stable-owner task instead of timing callbacks', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n?/g, '\n');

    expect(source).toContain('stableOwnerPostCommitTask = async (reason, scope) => {');
    expect(source).not.toContain("scheduleBuiltinReconcile('startup')");
    expect(source).not.toContain("scheduleBuiltinReconcile('auth-change')");
    expect(source).not.toContain('ghost oauth startup reconciliation failed');
    expect(source).not.toContain('queueMicrotask(() => {\n      void reconcileGhostOauthAccountsForActiveOwner()');
    expect(source).toContain("return migrationNeedsRetry ? 'retry-pending' : 'completed';");
    expect(source).toContain('migrationNeedsRetry ||= approvalNeedsRetry;');
    expect(source).toContain('approvalNeedsRetry = true;');
    expect(source).toContain("if (outcome === 'deferred') return outcome;");
    expect(source).toContain('if (dataOwnerId !== null) {');
    expect(source).toContain('activeOwnerScopeKey() !== scope.scopeKey');
    expect(source).toContain('getActiveAppSession().dataOwnerId !== scope.dataOwnerId');
    expect(source).toContain('const activationOutcome = activateGhostsAndMigrateLegacyAccounts();');
    expect(source).toContain("return outcome === 'failed'");
    expect(source).toContain(
      "const activateGhostsAndMigrateLegacyAccounts = (): 'completed' | 'retry-pending' => {",
    );
    expect(
      source.match(/if \(migration\.retryPending\) legacyMigrationNeedsRetry = true;/g),
    ).toHaveLength(3);
    expect(
      source.match(/catch \(err\) \{\n\s+legacyMigrationNeedsRetry = true;/g),
    ).toHaveLength(3);
    expect(source).toContain(
      "return legacyMigrationNeedsRetry ? 'retry-pending' : 'completed';",
    );
    expect(source).toContain(
      "outcome === 'retry-pending' || activationOutcome === 'retry-pending'",
    );
    expect(source).toContain("(error as NodeJS.ErrnoException).code === 'ENOENT'");
    expect(source).toContain('LEGACY_MIGRATION_RETRYABLE_FAILURE');
  });

  it('keeps both retry-pending and deterministic backfill failures in the durable marker', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const start = source.indexOf(
      'const backfill = await getGhostManager().backfillRecoveredLegacyGhosts(',
    );
    const end = source.indexOf("log.warn('recovered legacy ghost backfill pass failed'", start);
    const acknowledgementBlock = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(acknowledgementBlock).toContain('const pending = new Set(backfill.pending ?? []);');
    expect(acknowledgementBlock).toContain('const failed = new Set(backfill.failed);');
    expect(acknowledgementBlock).toContain(
      'recoveredLegacyIds.filter((id) => !pending.has(id) && !failed.has(id))',
    );
    expect(acknowledgementBlock).not.toContain('captureRecoveredLegacyNamespace(');
    expect(acknowledgementBlock).toContain('await acknowledgeRecoveredLegacyGhosts(');
  });
});
