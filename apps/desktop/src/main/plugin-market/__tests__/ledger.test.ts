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

  it('recovers installations from .bak instead of reading a missing file as empty', () => {
    const h = harness();
    h.ledger.upsertInstallation(record({ ghostId: 'cindy-kept' }));
    // 模拟 Windows 备份交换与回滚都失败:主文件缺失,.bak 是唯一有效快照。
    fs.renameSync(h.filePath, `${h.filePath}.bak`);

    // 读取入口必须恢复 .bak;否则这里读成空账本,下面的写入会把唯一快照覆盖掉,
    // 已安装插件的溯源记录永久丢失。
    expect(h.ledger.read().installations['cindy-kept']).toMatchObject({
      ghostId: 'cindy-kept',
      installed: true,
    });

    h.ledger.upsertInstallation(record({ ghostId: 'cindy-added' }));
    const after = h.ledger.read().installations;
    expect(Object.keys(after).sort()).toEqual(['cindy-added', 'cindy-kept']);
  });

  it('keeps custom-market provenance out of the main ledger file', () => {
    const h = harness();
    const customPath = path.join(path.dirname(h.filePath), 'custom-ledger.v1.json');
    h.ledger.upsertInstallation(record({ ghostId: 'cindy-server', source: 'market' }));
    h.ledger.upsertInstallation(
      record({
        ghostId: 'cindy-custom',
        pluginId: 'custom:team-lib/cindy-custom',
        source: 'git-market',
        sourceKey: 'git:https://x.test/r.git#:',
      }),
    );

    // 主账本文件不得出现旧版本不认识的 source:旧版 validRecord 是封闭枚举,
    // 会把它们过滤并重写落盘,自定义安装的溯源随降级永久丢失。
    const main = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
    expect(Object.keys(main.installations)).toEqual(['cindy-server']);
    const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    expect(Object.keys(custom.installations)).toEqual(['cindy-custom']);
    // 合并读仍是完整视图。
    expect(Object.keys(h.ledger.read().installations).sort()).toEqual([
      'cindy-custom',
      'cindy-server',
    ]);
  });

  it('survives an old-version rewrite that drops unknown sources from the main ledger', () => {
    const h = harness();
    h.ledger.upsertInstallation(record({ ghostId: 'cindy-server', source: 'market' }));
    h.ledger.upsertInstallation(
      record({
        ghostId: 'cindy-custom',
        pluginId: 'custom:team-lib/cindy-custom',
        source: 'local-market',
        sourceKey: 'local:/tmp/team-lib',
      }),
    );

    // 模拟降级后的旧版本写入:旧版 read() 只保留 market/legacy-adopted,
    // 任意一次写入都会把过滤后的主账本整份重写。
    const main = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
    main.installations = Object.fromEntries(
      Object.entries(main.installations).filter(([, value]) =>
        ['market', 'legacy-adopted'].includes((value as { source: string }).source),
      ),
    );
    fs.writeFileSync(h.filePath, JSON.stringify(main));

    // 再升级:自定义溯源在独立文件里,原样还在,不会被投影成本地冲突项。
    expect(h.ledger.read().installations['cindy-custom']).toMatchObject({
      source: 'local-market',
      sourceKey: 'local:/tmp/team-lib',
      installed: true,
    });
  });

  it('does not let a stale custom record shadow a newer server record for the same ghostId', () => {
    const h = harness();
    const customPath = path.join(path.dirname(h.filePath), 'custom-ledger.v1.json');
    // 降级窗口:新版装过自定义 X(记录在 custom 账本)→ 降级后旧版卸载它并从
    // 服务端装了同 ghostId(只写主账本)→ 升级回来。custom 账本里的陈旧记录若
    // 无条件覆盖,服务端安装会被错误归属给自定义来源,并允许该来源提供更新。
    fs.mkdirSync(path.dirname(h.filePath), { recursive: true });
    fs.writeFileSync(
      customPath,
      JSON.stringify({
        schemaVersion: 1,
        installations: {
          'cindy-x': record({
            ghostId: 'cindy-x',
            pluginId: 'custom:team-lib/cindy-x',
            source: 'git-market',
            sourceKey: '["git","https://x.test/r.git",null,[]]',
            updatedAt: '2026-07-01T00:00:00.000Z',
          }),
        },
      }),
    );
    fs.writeFileSync(
      h.filePath,
      JSON.stringify({
        schemaVersion: 1,
        installations: {
          'cindy-x': record({
            ghostId: 'cindy-x',
            source: 'market',
            updatedAt: '2026-08-01T00:00:00.000Z',
          }),
        },
        defaultInstallOptOuts: {},
      }),
    );

    expect(h.ledger.read().installations['cindy-x']).toMatchObject({ source: 'market' });

    // 反向仍成立:custom 记录更新(正常使用中主账本残留陈旧 server 记录)时 custom 胜。
    fs.writeFileSync(
      h.filePath,
      JSON.stringify({
        schemaVersion: 1,
        installations: {
          'cindy-x': record({
            ghostId: 'cindy-x',
            source: 'market',
            installed: false,
            updatedAt: '2026-06-01T00:00:00.000Z',
          }),
        },
        defaultInstallOptOuts: {},
      }),
    );
    expect(h.ledger.read().installations['cindy-x']).toMatchObject({ source: 'git-market' });
  });

  it('migrates stray custom records out of the main ledger on the next write', () => {
    const h = harness();
    const customPath = path.join(path.dirname(h.filePath), 'custom-ledger.v1.json');
    // 早期开发版把自定义记录直接写进了主账本。
    fs.mkdirSync(path.dirname(h.filePath), { recursive: true });
    fs.writeFileSync(
      h.filePath,
      JSON.stringify({
        schemaVersion: 1,
        installations: {
          'cindy-custom': record({
            ghostId: 'cindy-custom',
            pluginId: 'custom:team-lib/cindy-custom',
            source: 'git-market',
          }),
        },
        defaultInstallOptOuts: {},
      }),
    );

    // 读取兼容合并;任意一次写入即按 source 归位。
    expect(h.ledger.read().installations['cindy-custom']).toBeDefined();
    h.ledger.upsertInstallation(record({ ghostId: 'cindy-server', source: 'market' }));

    const main = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
    expect(Object.keys(main.installations)).toEqual(['cindy-server']);
    const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    expect(Object.keys(custom.installations)).toEqual(['cindy-custom']);
  });
});
