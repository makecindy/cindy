import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PluginMarketInstallationRecord } from '../ledger';
import {
  PluginRecoveryStore,
  pluginInstallationKey,
  pluginRecoveryCandidateKey,
} from '../recoveryStore';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-recovery-store-'));
  roots.push(root);
  const ledgerPath = path.join(root, 'plugin-market', 'ledger.v1.json');
  return {
    root,
    ledgerPath,
    recoveryPath: path.join(root, 'plugin-market', 'recovery.v1.json'),
    store: new PluginRecoveryStore(ledgerPath),
  };
}

function record(
  overrides: Partial<PluginMarketInstallationRecord> = {},
): PluginMarketInstallationRecord {
  return {
    pluginId: `c${'a'.repeat(24)}`,
    ghostId: 'cindy-test',
    releaseId: 'release-1',
    version: '1.0.0',
    sha256: 'b'.repeat(64),
    scope: 'public',
    organizationId: null,
    source: 'market',
    installed: false,
    updatedAt: '2026-08-09T10:59:55.000Z',
    manifestDigest: 'c'.repeat(64),
    ...overrides,
  };
}

describe('PluginRecoveryStore', () => {
  it('keys evidence and decisions to the exact installation and removal candidate', () => {
    const first = record();
    const changedRelease = record({ releaseId: 'release-2' });

    expect(pluginInstallationKey(first)).not.toBe(pluginInstallationKey(changedRelease));
    expect(pluginRecoveryCandidateKey(first)).not.toBe(
      pluginRecoveryCandidateKey(record({ updatedAt: '2026-08-10T00:00:00.000Z' })),
    );
  });

  it('persists decisions, explicit-removal receipts, and verified source evidence', () => {
    const h = harness();
    const candidate = record();
    h.store.recordDecision(candidate, 'review');
    h.store.recordRemoval(candidate, 'user-uninstall');
    h.store.recordSourceContentDigest(candidate, 'd'.repeat(64));

    const reopened = new PluginRecoveryStore(h.ledgerPath);
    expect(reopened.decisionFor(candidate)).toBe('review');
    expect(reopened.hasRemovalReceipt(candidate)).toBe(true);
    expect(reopened.hasRemovalReceipt(record({ releaseId: 'release-2' }))).toBe(false);
    expect(reopened.hasRemovalReceipt(record({ updatedAt: '2026-08-10T00:00:00.000Z' }))).toBe(
      false,
    );
    expect(reopened.sourceContentDigest(candidate)).toBe('d'.repeat(64));

    reopened.clearRemoval(candidate.ghostId);
    expect(reopened.hasRemovalReceipt(candidate)).toBe(false);
  });

  it('does not persist a custom source path in clear text', () => {
    const h = harness();
    const sourceKey = 'local:C:\\Users\\person\\private-plugin-market';
    const candidate = record({
      pluginId: 'custom:private/cindy-test',
      source: 'local-market',
      sourceKey,
    });
    h.store.recordDecision(candidate, 'keep');
    h.store.recordRemoval(candidate, 'user-uninstall');
    h.store.recordSourceContentDigest(candidate, 'e'.repeat(64));

    expect(fs.readFileSync(h.recoveryPath, 'utf8')).not.toContain(sourceKey);
  });

  it('treats keep as reminder-only mute without erasing review classification', () => {
    const h = harness();
    const candidate = record();
    h.store.recordDecision(candidate, 'review');
    h.store.recordDecisions([candidate], 'keep');

    const reopened = new PluginRecoveryStore(h.ledgerPath);
    expect(reopened.decisionFor(candidate)).toBe('review');
    expect(reopened.isNoticeMuted(candidate)).toBe(true);
  });

  it('fails closed for malformed or future store data', () => {
    const h = harness();
    fs.mkdirSync(path.dirname(h.recoveryPath), { recursive: true });
    fs.writeFileSync(h.recoveryPath, '{"schemaVersion":99,"decisions":{"x":{}}}');

    expect(h.store.decisionFor(record())).toBeNull();
    expect(h.store.hasRemovalReceipt(record())).toBe(false);
    expect(h.store.sourceContentDigest(record())).toBeNull();
  });

  it('keeps a bound owner path stable after the active owner changes', () => {
    const h = harness();
    let owner = 'owner-a';
    const dynamic = new PluginRecoveryStore(() =>
      path.join(h.root, owner, 'plugin-market', 'ledger.v1.json'),
    );
    const bound = dynamic.bind(path.join(h.root, owner, 'plugin-market', 'ledger.v1.json'));

    owner = 'owner-b';
    bound.recordDecision(record(), 'keep');

    expect(fs.existsSync(path.join(h.root, 'owner-a', 'plugin-market', 'recovery.v1.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(h.root, 'owner-b', 'plugin-market', 'recovery.v1.json'))).toBe(
      false,
    );
  });
});
