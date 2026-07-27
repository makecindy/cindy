import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PluginMarketLedger,
  type PluginMarketInstallationRecord,
} from '../ledger';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-ledger-'));
  roots.push(root);
  const filePath = path.join(root, 'plugin-market', 'ledger.v1.json');
  return { filePath, ledger: new PluginMarketLedger(filePath) };
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
    installed: true,
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('PluginMarketLedger', () => {
  it('writes provenance atomically and reads it back', () => {
    const { filePath, ledger } = harness();
    ledger.upsertInstallation(record());

    expect(ledger.installationForGhost('cindy-test')).toMatchObject({
      pluginId: `c${'a'.repeat(24)}`,
      installed: true,
      source: 'market',
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(
      fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('records defaultInstall opt-out per authenticated user on removal', () => {
    const { ledger } = harness();
    ledger.upsertInstallation(record());
    ledger.markRemoved('cindy-test', 'user-a');

    expect(ledger.installationForGhost('cindy-test')?.installed).toBe(false);
    expect(
      ledger.isDefaultInstallSuppressed('user-a', `c${'a'.repeat(24)}`),
    ).toBe(true);
    expect(
      ledger.isDefaultInstallSuppressed('user-b', `c${'a'.repeat(24)}`),
    ).toBe(false);
  });

  it('fails closed to an empty ledger for malformed or future data', () => {
    const { filePath, ledger } = harness();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"schemaVersion":99,"installations":{"x":{}}}');

    expect(ledger.read()).toEqual({
      schemaVersion: 1,
      installations: {},
      defaultInstallOptOuts: {},
    });
  });

  it('resolves the owner-scoped path for every operation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-ledger-owner-'));
    roots.push(root);
    let owner = 'owner-a';
    const ledger = new PluginMarketLedger(() =>
      path.join(root, owner, 'ledger.v1.json'),
    );

    ledger.upsertInstallation(record());
    owner = 'owner-b';

    expect(ledger.installationForGhost('cindy-test')).toBeNull();
    expect(fs.existsSync(path.join(root, 'owner-a', 'ledger.v1.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'owner-b', 'ledger.v1.json'))).toBe(false);
  });

  it('keeps a bound owner path stable after the active owner changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-ledger-bound-'));
    roots.push(root);
    let owner = 'owner-a';
    const ledger = new PluginMarketLedger(() =>
      path.join(root, owner, 'ledger.v1.json'),
    );
    const bound = ledger.bind(path.join(root, owner, 'ledger.v1.json'));

    owner = 'owner-b';
    bound.upsertInstallation(record());

    expect(fs.existsSync(path.join(root, 'owner-a', 'ledger.v1.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'owner-b', 'ledger.v1.json'))).toBe(false);
  });
});
