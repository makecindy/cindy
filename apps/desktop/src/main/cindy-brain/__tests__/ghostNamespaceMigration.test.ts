import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  censusNamespaceMigration,
  classifyNamespaceMigration,
  commitNamespaceMigration,
  commitRootNamespaceMigration,
  createNamespaceMigrationStore,
  isCensusCandidate,
  isPendingNamespaceGhost,
  parseNamespaceMigrationLedger,
  pendingNamespaceGhostIds,
  planNamespaceCommit,
  resolveInstallAgainstPending,
  type ClassifyNamespaceMigrationInput,
  type NamespaceCensusCandidate,
} from '../ghostNamespaceMigration.js';

const NOW = '2026-09-22T12:00:00.000Z';

function candidate(ghostId: string, identitySource?: object): NamespaceCensusCandidate {
  return { ghostId, relId: ghostId, ...(identitySource ? { identitySource } : {}) };
}

function classify(
  partial: Partial<ClassifyNamespaceMigrationInput> & Pick<ClassifyNamespaceMigrationInput, 'ghostId'>,
) {
  return classifyNamespaceMigration({
    builtin: false,
    installOrigin: 'manual',
    marketSyncCompleted: false,
    marketRecord: null,
    currentOrganization: null,
    ...partial,
  });
}

describe('isCensusCandidate', () => {
  it('accepts root-dir installs whose identity has not recorded namespace', () => {
    expect(isCensusCandidate(candidate('xd-feishu'))).toBe(true);
    expect(isCensusCandidate(candidate('hello', { id: 'hello' }))).toBe(true);
    expect(isCensusCandidate(candidate('hello', { namespace: null }))).toBe(false);
    expect(isCensusCandidate(candidate('hello', { namespace: 'acme' }))).toBe(false);
    expect(isCensusCandidate({ ghostId: 'hello', relId: '_ns/acme/hello' })).toBe(false);
    expect(isCensusCandidate({ ghostId: 'BAD', relId: 'BAD' })).toBe(false);
  });
});

describe('censusNamespaceMigration', () => {
  it('captures only legacy root installs the first time, then closes the door', () => {
    const created = censusNamespaceMigration(
      { kind: 'missing' },
      [
        candidate('xd-feishu'),
        candidate('hello', { namespace: null }),
        { ghostId: 'helper', relId: '_ns/acme/helper' },
      ],
      NOW,
    );
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    expect(Object.keys(created.ledger.entries)).toEqual(['xd-feishu']);
    expect(created.ledger.entries['xd-feishu']?.status).toBe('pending');

    const again = censusNamespaceMigration(
      { kind: 'ok', ledger: created.ledger },
      [candidate('new-plugin')],
      '2026-09-23T00:00:00.000Z',
    );
    expect(again).toEqual({ kind: 'unchanged', ledger: created.ledger });
  });

  it('does not recensus a corrupt or unreadable ledger', () => {
    expect(
      censusNamespaceMigration({ kind: 'corrupt' }, [candidate('hello')], NOW),
    ).toEqual({ kind: 'blocked', reason: 'corrupt' });
    expect(
      censusNamespaceMigration({ kind: 'unreadable' }, [candidate('hello')], NOW),
    ).toEqual({ kind: 'blocked', reason: 'unreadable' });
  });
});

describe('classifyNamespaceMigration', () => {
  it('commits builtin and public/personal/custom market installs as root', () => {
    expect(classify({ ghostId: 'cindy-art', builtin: true })).toEqual({
      kind: 'commit',
      namespace: null,
      basis: 'builtin',
    });
    expect(
      classify({
        ghostId: 'helper',
        marketRecord: { scope: 'public', source: 'market', organizationId: null },
      }),
    ).toEqual({ kind: 'commit', namespace: null, basis: 'market-public' });
    expect(
      classify({
        ghostId: 'helper',
        marketRecord: { scope: 'personal', source: 'market', organizationId: 'user-1' },
      }),
    ).toEqual({ kind: 'commit', namespace: null, basis: 'market-personal' });
    expect(
      classify({
        ghostId: 'helper',
        marketRecord: { scope: 'public', source: 'git-market', organizationId: null },
      }),
    ).toEqual({ kind: 'commit', namespace: null, basis: 'market-custom' });
  });

  it('commits organization installs in place when orgSlug is a trusted current-org fact', () => {
    expect(
      classify({
        ghostId: 'xd-feishu',
        marketRecord: {
          scope: 'organization',
          source: 'market',
          organizationId: 'org-xd',
          namespace: 'xd',
        },
        currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' },
      }),
    ).toEqual({ kind: 'commit', namespace: 'xd', basis: 'market-organization' });
    expect(
      classify({
        ghostId: 'helper',
        marketRecord: {
          scope: 'organization',
          source: 'market',
          organizationId: 'org-acme',
        },
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      }),
    ).toEqual({ kind: 'commit', namespace: 'acme', basis: 'market-organization' });
    expect(
      classify({
        ghostId: 'helper',
        marketRecord: {
          scope: 'organization',
          source: 'market',
          organizationId: 'org-acme',
        },
        currentOrganization: { organizationId: 'org-other', orgSlug: 'other', pluginPrefix: 'oth' },
      }),
    ).toEqual({ kind: 'pending', reason: 'awaiting-organization-namespace' });
  });

  it('commits a known root namespace on the market record, and waits without market facts', () => {
    expect(
      classify({
        ghostId: 'helper',
        marketRecord: {
          scope: 'public',
          source: 'market',
          organizationId: null,
          namespace: null,
        },
      }),
    ).toEqual({ kind: 'commit', namespace: null, basis: 'explicit-root' });
    expect(classify({ ghostId: 'xd-feishu' })).toEqual({
      kind: 'pending',
      reason: 'awaiting-market-facts',
    });
  });

  it('commits explicit Forge self-tests to the current orgSlug', () => {
    expect(
      classify({
        ghostId: 'acme-tool',
        installOrigin: 'agent-forge',
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      }),
    ).toEqual({ kind: 'commit', namespace: 'acme', basis: 'forge-current-org' });
  });

  it('commits unmatched manual installs only after a completed market sync', () => {
    expect(classify({ ghostId: 'local-tool', marketSyncCompleted: false })).toEqual({
      kind: 'pending',
      reason: 'awaiting-market-facts',
    });
    expect(classify({ ghostId: 'local-tool', marketSyncCompleted: true })).toEqual({
      kind: 'commit',
      namespace: null,
      basis: 'manual-after-sync',
    });
  });
});

describe('commit and install conflict', () => {
  it('stamps only captured pending ids as committed root', () => {
    const created = censusNamespaceMigration({ kind: 'missing' }, [candidate('hello')], NOW);
    if (created.kind !== 'created') throw new Error('expected census');
    const committed = commitRootNamespaceMigration(created.ledger, 'hello', 'builtin', NOW);
    expect(committed.entries.hello).toMatchObject({
      status: 'committed',
      namespace: null,
      basis: 'builtin',
    });
    expect(pendingNamespaceGhostIds(committed)).toEqual([]);
    expect(isPendingNamespaceGhost(committed, 'hello')).toBe(false);

    const orgCreated = censusNamespaceMigration({ kind: 'missing' }, [candidate('xd-feishu')], NOW);
    if (orgCreated.kind !== 'created') throw new Error('expected census');
    const orgCommitted = commitNamespaceMigration(
      orgCreated.ledger,
      'xd-feishu',
      'xd',
      'market-organization',
      NOW,
    );
    expect(orgCommitted.entries['xd-feishu']).toMatchObject({
      status: 'committed',
      namespace: 'xd',
      relId: 'xd-feishu',
      basis: 'market-organization',
    });
  });

  it('blocks a same-name org install until the pending instance is classified as root', () => {
    expect(
      resolveInstallAgainstPending({
        ghostId: 'hello',
        requestedNamespace: 'acme',
        pending: true,
        classification: { kind: 'pending', reason: 'awaiting-market-facts' },
      }),
    ).toMatchObject({ kind: 'wait' });
    expect(
      resolveInstallAgainstPending({
        ghostId: 'hello',
        requestedNamespace: 'acme',
        pending: true,
        classification: { kind: 'commit', namespace: null, basis: 'market-public' },
      }),
    ).toEqual({ kind: 'proceed' });
    expect(
      resolveInstallAgainstPending({
        ghostId: 'hello',
        requestedNamespace: 'acme',
        pending: true,
        classification: { kind: 'commit', namespace: 'acme', basis: 'market-organization' },
      }),
    ).toEqual({ kind: 'already-installed' });
    expect(
      resolveInstallAgainstPending({
        ghostId: 'hello',
        requestedNamespace: null,
        pending: true,
        classification: null,
      }),
    ).toEqual({ kind: 'already-installed' });
    expect(
      resolveInstallAgainstPending({
        ghostId: 'hello',
        requestedNamespace: 'acme',
        pending: false,
        classification: null,
      }),
    ).toEqual({ kind: 'proceed' });
  });
});

describe('namespace migration store', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('round-trips a census and refuses to write over an unreadable path', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-mig-'));
    const filePath = path.join(dir, 'namespace-migration.v1.json');
    const store = createNamespaceMigrationStore(filePath);
    expect(store.read()).toEqual({ kind: 'missing' });
    const created = censusNamespaceMigration({ kind: 'missing' }, [candidate('hello')], NOW);
    if (created.kind !== 'created') throw new Error('expected census');
    store.write(created.ledger);
    const read = store.read();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(parseNamespaceMigrationLedger(read.ledger)).toEqual(read.ledger);
    expect(pendingNamespaceGhostIds(read.ledger)).toEqual(['hello']);
  });
});

describe('planNamespaceCommit', () => {
  const requested = { namespace: null as string | null, basis: 'builtin' as const };

  it('recovers a receipt that already has namespace even when the plugin is busy', () => {
    expect(
      planNamespaceCommit({
        pending: true,
        busy: true,
        receiptNamespace: 'xd',
        requested,
      }),
    ).toEqual({
      kind: 'write-ledger-only',
      namespace: 'xd',
      basis: 'receipt-recovered',
    });
  });

  it('blocks the first receipt write while the plugin is busy', () => {
    expect(
      planNamespaceCommit({
        pending: true,
        busy: true,
        requested: { namespace: 'acme', basis: 'market-organization' },
      }),
    ).toEqual({ kind: 'skip', reason: 'busy' });
  });

  it('applies the requested namespace when the receipt is still legacy', () => {
    expect(
      planNamespaceCommit({
        pending: true,
        busy: false,
        requested: { namespace: 'acme', basis: 'market-organization' },
      }),
    ).toEqual({
      kind: 'write-receipt-and-ledger',
      namespace: 'acme',
      basis: 'market-organization',
    });
  });
});

