import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureRecoveredNamespaceEntry,
  censusNamespaceMigration,
  dropNamespaceMigrationEntry,
  classifyNamespaceMigration,
  createNamespaceMigrationStore,
  isCensusCandidate,
  isPendingNamespaceGhost,
  parseNamespaceMigrationLedger,
  pendingNamespaceGhostIds,
  planNamespaceCommit,
  readNamespaceMigrationInstallOrigin,
  readNamespaceMigrationMarketRecord,
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
      [candidate('xd-feishu'), candidate('new-plugin')],
      '2026-09-23T00:00:00.000Z',
    );
    expect(again).toEqual({ kind: 'unchanged', ledger: created.ledger });

    const duringUpdateBackup = censusNamespaceMigration(
      { kind: 'ok', ledger: created.ledger },
      [],
      '2026-09-23T00:00:00.000Z',
    );
    expect(duringUpdateBackup).toEqual({ kind: 'unchanged', ledger: created.ledger });
    expect(dropNamespaceMigrationEntry(created.ledger, 'xd-feishu').entries).toEqual({});
  });

  it('does not mistake inherited object keys for pending plugin ids', () => {
    const created = censusNamespaceMigration({ kind: 'missing' }, [], NOW);
    if (created.kind !== 'created') throw new Error('expected census');
    expect(isPendingNamespaceGhost(created.ledger, 'constructor')).toBe(false);
    expect(dropNamespaceMigrationEntry(created.ledger, 'constructor')).toBe(created.ledger);
    const captured = captureRecoveredNamespaceEntry(created.ledger, candidate('constructor'), NOW);
    expect(isPendingNamespaceGhost(captured, 'constructor')).toBe(true);
  });

  it('does not recensus a corrupt or unreadable ledger', () => {
    for (const kind of ['corrupt', 'unreadable'] as const) {
      expect(censusNamespaceMigration({ kind }, [candidate('hello')], NOW))
        .toEqual({ kind: 'blocked', reason: kind });
    }
  });
});

describe('classifyNamespaceMigration', () => {
  it('commits builtin and public/personal/custom market installs as root', () => {
    const cases: [Partial<ClassifyNamespaceMigrationInput> & { ghostId: string }, string][] = [
      [{ ghostId: 'cindy-art', builtin: true }, 'builtin'],
      [{ ghostId: 'helper', marketRecord: { scope: 'public', source: 'market', organizationId: null } }, 'market-public'],
      [{ ghostId: 'helper', marketRecord: { scope: 'personal', source: 'market', organizationId: 'user-1' } }, 'market-personal'],
      [{ ghostId: 'helper', marketRecord: { scope: 'public', source: 'git-market', organizationId: null } }, 'market-custom'],
    ];
    for (const [input, basis] of cases) {
      expect(classify(input)).toEqual({ kind: 'commit', namespace: null, basis });
    }
  });

  it('commits organization installs in place when orgSlug is a trusted current-org fact', () => {
    const cases: [Partial<ClassifyNamespaceMigrationInput> & { ghostId: string }, ReturnType<typeof classify>][] = [
      [{ ghostId: 'xd-feishu', marketRecord: { scope: 'organization', source: 'market', organizationId: 'org-xd', namespace: 'xd' },
        currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' } },
      { kind: 'commit', namespace: 'xd', basis: 'market-organization' }],
      [{ ghostId: 'helper', marketRecord: { scope: 'organization', source: 'market', organizationId: 'org-acme' },
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' } },
      { kind: 'commit', namespace: 'acme', basis: 'market-organization' }],
      [{ ghostId: 'helper', marketRecord: { scope: 'organization', source: 'market', organizationId: 'org-acme' },
        currentOrganization: { organizationId: 'org-other', orgSlug: 'other', pluginPrefix: 'oth' } },
      { kind: 'pending', reason: 'awaiting-organization-namespace' }],
    ];
    for (const [input, expected] of cases) expect(classify(input)).toEqual(expected);
  });

  it('commits a known root namespace on the market record, and waits without market facts', () => {
    expect(classify({
      ghostId: 'helper',
      marketRecord: { scope: 'public', source: 'market', organizationId: null, namespace: null },
    })).toEqual({ kind: 'commit', namespace: null, basis: 'explicit-root' });
    expect(classify({ ghostId: 'xd-feishu' })).toEqual({
      kind: 'pending',
      reason: 'awaiting-market-facts',
    });
  });

  it('commits explicit Forge self-tests to the current orgSlug', () => {
    expect(classify({
      ghostId: 'acme-tool', installOrigin: 'agent-forge',
      currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
    })).toEqual({ kind: 'commit', namespace: 'acme', basis: 'forge-current-org' });
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

  it('keeps old installs pending when market records cannot be read or resolved', () => {
    const organizationRecord = { scope: 'organization' as const, source: 'market' as const, organizationId: 'org-xd' };
    const unavailable = readNamespaceMigrationMarketRecord(() => { throw new Error('locked ledger'); });
    const ambiguous = readNamespaceMigrationMarketRecord(() => [organizationRecord, organizationRecord]);
    expect(unavailable).toBeUndefined();
    expect(ambiguous).toBeUndefined();
    expect(readNamespaceMigrationMarketRecord(() => [])).toBeNull();
    for (const marketRecord of [unavailable, ambiguous]) {
      expect(classify({ ghostId: 'xd-feishu', marketSyncCompleted: true, marketRecord }))
        .toEqual({ kind: 'pending', reason: 'awaiting-market-facts' });
    }
    expect(classify({
      ghostId: 'xd-feishu',
      marketSyncCompleted: true,
      marketRecord: readNamespaceMigrationMarketRecord(() => [organizationRecord]),
      currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' },
    })).toEqual({ kind: 'commit', namespace: 'xd', basis: 'market-organization' });
  });

  it('does not treat a removed organization route as evidence for a manual replacement', () => {
    const removed = { scope: 'organization' as const, source: 'market' as const, organizationId: 'org-acme', namespace: 'acme', installed: false };
    const record = readNamespaceMigrationMarketRecord(() => [removed]);
    expect(classify({
      ghostId: 'helper',
      marketRecord: record,
      marketSyncCompleted: true,
      installOrigin: 'manual',
      currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: null },
    })).toEqual({ kind: 'commit', namespace: null, basis: 'manual-after-sync' });
    expect(classify({
      ghostId: 'helper', marketRecord: removed, marketSyncCompleted: true, installOrigin: 'manual',
    })).toEqual({ kind: 'commit', namespace: null, basis: 'manual-after-sync' });
  });

  it('does not turn an unreadable approved origin into a manual root install', () => {
    const unavailable = readNamespaceMigrationInstallOrigin(() => { throw new Error('locked receipt'); });
    const currentOrganization = { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: null };
    expect(unavailable).toBeUndefined();
    const cases: [Partial<ClassifyNamespaceMigrationInput> & { ghostId: string }, ReturnType<typeof classify>][] = [
      [{ ghostId: 'acme-tool', installOrigin: unavailable }, { kind: 'pending', reason: 'awaiting-install-origin' }],
      [{ ghostId: 'acme-tool', installOrigin: unavailable, builtin: true }, { kind: 'commit', namespace: null, basis: 'builtin' }],
      [{ ghostId: 'acme-tool', installOrigin: unavailable, marketRecord: { scope: 'public', source: 'market', organizationId: null } },
        { kind: 'commit', namespace: null, basis: 'market-public' }],
      [{ ghostId: 'acme-tool', installOrigin: readNamespaceMigrationInstallOrigin(() => 'agent-forge'), currentOrganization },
        { kind: 'pending', reason: 'awaiting-market-facts' }],
      [{ ghostId: 'local-tool', installOrigin: readNamespaceMigrationInstallOrigin(() => 'manual') },
        { kind: 'commit', namespace: null, basis: 'manual-after-sync' }],
    ];
    for (const [input, expected] of cases) {
      expect(classify({ marketSyncCompleted: true, ...input })).toEqual(expected);
    }
  });
});

describe('commit and install conflict', () => {
  it('removes only captured pending ids after their receipts are committed', () => {
    const created = censusNamespaceMigration({ kind: 'missing' }, [candidate('hello')], NOW);
    if (created.kind !== 'created') throw new Error('expected census');
    const committed = dropNamespaceMigrationEntry(created.ledger, 'hello');
    expect(committed.entries).toEqual({});
    expect(pendingNamespaceGhostIds(committed)).toEqual([]);
    expect(isPendingNamespaceGhost(committed, 'hello')).toBe(false);
    expect(censusNamespaceMigration(
      { kind: 'ok', ledger: committed }, [candidate('hello')], NOW,
    )).toEqual({ kind: 'unchanged', ledger: committed });
  });

  it('reads old committed entries without reopening the one-shot census', () => {
    const parsed = parseNamespaceMigrationLedger({
      schemaVersion: 1,
      censusedAt: NOW,
      entries: {
        hello: { ghostId: 'hello', relId: 'hello', capturedAt: NOW, status: 'committed', namespace: null, committedAt: NOW, basis: 'builtin' },
        helper: { ghostId: 'helper', relId: 'helper', capturedAt: NOW, status: 'pending' },
      },
    });
    expect(parsed?.entries).toEqual({
      helper: { ghostId: 'helper', relId: 'helper', capturedAt: NOW, status: 'pending' },
    });
    expect(censusNamespaceMigration({ kind: 'ok', ledger: parsed! }, [candidate('hello')], NOW).kind).toBe('unchanged');
    expect(parseNamespaceMigrationLedger({
      schemaVersion: 1,
      censusedAt: NOW,
      entries: { hello: { ghostId: 'hello', relId: 'hello', capturedAt: NOW, status: 'committed', namespace: 'INVALID', committedAt: NOW, basis: 'builtin' } },
    })).toBeNull();
  });

  it('blocks a same-name org install until the pending identity is committed', () => {
    type Input = Parameters<typeof resolveInstallAgainstPending>[0];
    const waiting: Input['classification'][] = [
      { kind: 'pending', reason: 'awaiting-market-facts' },
      { kind: 'commit', namespace: null, basis: 'market-public' },
    ];
    for (const classification of waiting) {
      expect(resolveInstallAgainstPending({ ghostId: 'hello', requestedNamespace: 'acme', pending: true, classification }))
        .toMatchObject({ kind: 'wait' });
    }
    const cases: [Omit<Input, 'ghostId'>, ReturnType<typeof resolveInstallAgainstPending>][] = [
      [{ requestedNamespace: 'acme', pending: true, classification: { kind: 'commit', namespace: 'acme', basis: 'market-organization' } }, { kind: 'already-installed' }],
      [{ requestedNamespace: null, pending: true, classification: null }, { kind: 'already-installed' }],
      [{ requestedNamespace: 'acme', pending: false, classification: null }, { kind: 'proceed' }],
    ];
    for (const [input, expected] of cases) {
      expect(resolveInstallAgainstPending({ ghostId: 'hello', ...input })).toEqual(expected);
    }
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
  const cases: [string, Parameters<typeof planNamespaceCommit>[0], ReturnType<typeof planNamespaceCommit>][] = [
    ['recovers a receipt that already has namespace even when the plugin is busy',
      { pending: true, busy: true, receiptNamespace: 'xd', requested: { namespace: null, basis: 'builtin' } },
      { kind: 'write-ledger-only', namespace: 'xd', basis: 'receipt-recovered' }],
    ['blocks the first receipt write while the plugin is busy',
      { pending: true, busy: true, requested: { namespace: 'acme', basis: 'market-organization' } },
      { kind: 'skip', reason: 'busy' }],
    ['applies the requested namespace when the receipt is still legacy',
      { pending: true, busy: false, requested: { namespace: 'acme', basis: 'market-organization' } },
      { kind: 'write-receipt-and-ledger', namespace: 'acme', basis: 'market-organization' }],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(planNamespaceCommit(input)).toEqual(expected);
  });
});
