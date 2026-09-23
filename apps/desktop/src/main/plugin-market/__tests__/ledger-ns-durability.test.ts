import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const crash = vi.hoisted(() => ({
  failMain: false,
  writes: [] as string[],
}));

vi.mock('../../utils/atomicWriteFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/atomicWriteFile.js')>();
  return {
    ...actual,
    atomicWriteFileSync(filePath: string, contents: string) {
      crash.writes.push(path.basename(filePath));
      if (crash.failMain && path.basename(filePath) === 'ledger.v1.json') {
        throw new Error('simulated crash after ns sidecar');
      }
      actual.atomicWriteFileSync(filePath, contents);
    },
  };
});

import {
  NS_LEDGER_FILE,
  PluginMarketLedger,
  type PluginMarketInstallationRecord,
} from '../ledger';

const roots: string[] = [];

afterEach(() => {
  crash.failMain = false;
  crash.writes = [];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-ledger-ns-'));
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

describe('PluginMarketLedger namespace write order', () => {
  it('writes the ns sidecar before rewriting the main ledger', () => {
    const { ledger } = harness();
    ledger.upsertInstallation(
      record({ ghostId: 'helper', namespace: null, pluginId: `c${'a'.repeat(24)}` }),
    );
    crash.writes = [];
    ledger.upsertInstallation(
      record({
        ghostId: 'helper',
        namespace: 'acme',
        pluginId: `c${'b'.repeat(24)}`,
        scope: 'organization',
        organizationId: 'org_1',
      }),
    );
    expect(crash.writes).toEqual([
      'ns-ledger.v1.json',
      'custom-ledger.v1.json',
      'ledger.v1.json',
    ]);
  });

  it('keeps org provenance if the main ledger rewrite fails after the sidecar write', () => {
    const { filePath, ledger } = harness();
    ledger.upsertInstallation(
      record({
        ghostId: 'helper',
        namespace: 'acme',
        pluginId: `c${'b'.repeat(24)}`,
        scope: 'organization',
        organizationId: 'org_1',
      }),
    );
    crash.failMain = true;
    expect(() =>
      ledger.upsertInstallation(
        record({ ghostId: 'helper', namespace: null, pluginId: `c${'a'.repeat(24)}` }),
      ),
    ).toThrow(/simulated crash after ns sidecar/);
    crash.failMain = false;
    expect(ledger.installationForPlugin({ ghostId: 'helper', namespace: 'acme' })).toMatchObject({
      namespace: 'acme',
      pluginId: `c${'b'.repeat(24)}`,
    });
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(path.dirname(filePath), NS_LEDGER_FILE), 'utf8'),
    ) as { installations: Record<string, { namespace?: string | null }> };
    expect(sidecar.installations['_ns__acme__helper']).toMatchObject({ namespace: 'acme' });
  });
});
