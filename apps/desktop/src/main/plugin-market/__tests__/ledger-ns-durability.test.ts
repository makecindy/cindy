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
  pluginMarketLedgerRevision,
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
      'ledger.v1.pending.json',
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
    expect(fs.existsSync(path.join(path.dirname(filePath), 'ledger.v1.pending.json'))).toBe(false);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(path.dirname(filePath), NS_LEDGER_FILE), 'utf8'),
    ) as { installations: Record<string, { namespace?: string | null }> };
    expect(sidecar.installations['_ns__acme__helper']).toMatchObject({ namespace: 'acme' });
  });
});

/* 测试价值（PR #12731 独立审查 C2：安装代次）
 * - 生产入口与可观察结果：真实 PluginMarketLedger 写入与读取时的日志重放，pluginMarketLedgerRevision()。
 * - 覆盖缺口：写完日志后目标文件写失败时，变更由下一次读取重放才落地；计数不前进，市场在途读取的代次判断就看不到
 *   这次变更（例如远程操作证据补写，之后的读取仍并入补写前的在途读取）。
 * - 最小失败输入：主账本写失败一次，再读一次；改前计数在整个过程中都不变。
 * - tier：unit。
 */
describe('PluginMarketLedger write revision', () => {
  it('advances for a change that lands through the journal replay as well as for a direct write', () => {
    const { ledger } = harness();
    const start = pluginMarketLedgerRevision();
    ledger.upsertInstallation(record());
    const written = pluginMarketLedgerRevision();
    expect(written).toBeGreaterThan(start);
    expect(ledger.read()).toBeTruthy();
    expect(pluginMarketLedgerRevision()).toBe(written);
    crash.failMain = true;
    expect(() => ledger.upsertInstallation(record({ version: '2.0.0' }))).toThrow(/simulated crash/);
    crash.failMain = false;
    const failed = pluginMarketLedgerRevision();
    expect(failed).toBeGreaterThan(written);
    expect(ledger.installationForPlugin({ ghostId: 'cindy-test', namespace: null })).toMatchObject({ version: '2.0.0' });
    expect(pluginMarketLedgerRevision()).toBeGreaterThan(failed);
  });
});
