/**
 * 组设置与任务绑定的本机存储：坏形态清洗与容量淘汰；读写链路走真文件(临时目录)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-store-test-'));

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
  activeOwnerScopeKey: () => 'owner-test',
}));

const store = await import('../store.js');
const bindings = await import('../bindings.js');

describe('provider group store', () => {
  it('drops invalid groups and empty groups when reading', () => {
    expect(store.__testing.normalize({
      groups: {
        anthropic: { strategy: 'least', members: [{ kind: 'local' }] },
        'bad id': { members: [{ kind: 'local' }] },
        empty: { members: [] },
      },
    })).toEqual({
      groups: {
        anthropic: {
          strategy: 'least',
          autoSwitch: true,
          members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
        },
      },
    });
  });

  it('writes, reads back and deletes a group', async () => {
    const written = await store.writeProviderGroup('anthropic', {
      strategy: 'order',
      members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' }],
    });
    expect(written?.members).toHaveLength(2);
    expect(store.readProviderGroup('anthropic')?.strategy).toBe('order');
    await store.writeProviderGroup('anthropic', null);
    expect(store.readProviderGroup('anthropic')).toBeNull();
  });
});

describe('provider group bindings', () => {
  it('keeps only well-formed bindings', () => {
    expect(bindings.__testing.normalize({
      sessions: {
        s1: { providerId: 'anthropic', memberKey: 'local', at: 5 },
        's 2': { providerId: 'anthropic', memberKey: 'local', at: 5 },
        s3: { providerId: 'bad id', memberKey: 'local' },
      },
    })).toEqual({ sessions: { s1: { providerId: 'anthropic', memberKey: 'local', at: 5 } } });
  });

  it('evicts the oldest bindings beyond capacity', () => {
    const sessions = Object.fromEntries(
      Array.from({ length: bindings.MAX_PROVIDER_GROUP_BINDINGS + 3 }, (_, i) => [`s${i}`, { providerId: 'p', memberKey: 'local', at: i }]),
    );
    const pruned = bindings.__testing.prune(sessions);
    expect(Object.keys(pruned)).toHaveLength(bindings.MAX_PROVIDER_GROUP_BINDINGS);
    expect(pruned.s0).toBeUndefined();
    expect(pruned[`s${bindings.MAX_PROVIDER_GROUP_BINDINGS + 2}`]).toBeDefined();
  });

  it('writes and clears a binding', async () => {
    await bindings.writeProviderGroupBinding('s1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 42);
    expect(bindings.readProviderGroupBinding('s1')).toEqual({ providerId: 'anthropic', memberKey: 'device:mini:x', at: 42 });
    await bindings.writeProviderGroupBinding('s1', null);
    expect(bindings.readProviderGroupBinding('s1')).toBeNull();
  });

  it('releases bindings of removed computers and of deleted groups only', async () => {
    await bindings.writeProviderGroupBinding('a', { providerId: 'anthropic', memberKey: 'local' }, 1);
    await bindings.writeProviderGroupBinding('b', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 2);
    await bindings.writeProviderGroupBinding('c', { providerId: 'openai', memberKey: 'device:mini:y' }, 3);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']));
    expect(bindings.readProviderGroupBinding('a')).not.toBeNull();
    expect(bindings.readProviderGroupBinding('b')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('a')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
  });

  it('keeps bindings to a group on another computer in their own file, one group per task', async () => {
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini' }, 7);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 7 });
    // 本机的组只数本机那份：另一台电脑的组不进本机分配器的统计，也不被本机删组时清掉。
    expect(bindings.listProviderGroupBindings().r1).toBeUndefined();
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeDefined();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('r1')).not.toBeNull();
    // 降级后的旧版本只读本机那份，读不到它。
    const localFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8'));
    expect(localFile.sessions?.r1).toBeUndefined();
    // 改归本机的组时另一份里的同一任务一并清掉。
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local' }, 8);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', at: 8 });
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeUndefined();
    await bindings.writeProviderGroupBinding('r1', null);
    expect(bindings.readProviderGroupBinding('r1')).toBeNull();
  });

  it('drops remote bindings without a valid group computer', () => {
    expect(bindings.__testing.normalizeRemote({
      sessions: {
        r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 },
        r2: { providerId: 'anthropic', memberKey: 'local' },
        r3: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'bad id' },
      },
    })).toEqual({ sessions: { r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 } } });
  });
});
