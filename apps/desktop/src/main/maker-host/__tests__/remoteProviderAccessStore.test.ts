/**
 * 供应商「允许被远程调用」默认对自己的电脑开放（2026-11-10 用户裁决）。
 * 规则依据：控制本机开着时，同账号电脑就能借用本机的模型；用户手动关掉的要记住。
 * 覆盖缺口：旧文件只记「开了」的供应商，分不清「没设置过」与「特意关掉」。迁移时本机已有分享
 * 却没开放的供应商（为暂停分享而关掉）必须保持关闭，不能让分享出去的人恢复使用。
 * 生产入口：store 的读写与迁移函数；真实临时文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-provider-access-test-'));

vi.mock('../../ownerContext.js', () => ({ ownerScopedPath: (name: string) => path.join(tmpDir, name) }));
vi.mock('../../device-link/providerShareAvailabilityPolicy.js', () => ({
  withAvailabilityPolicyMutation: (_providerId: string | undefined, work: () => Promise<unknown>) => work(),
  withAvailabilityPolicyLock: (work: () => Promise<unknown>) => work(),
}));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const store = await import('../remote-provider-access-store.js');

afterAll(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

describe('remote provider access default', () => {
  it('opens every provider to own computers once, except ones closed to pause an existing share', async () => {
    fs.writeFileSync(path.join(tmpDir, 'remote-provider-access-prefs.json'),
      JSON.stringify({ allowedProviders: { anthropic: true } }));
    // Before the share snapshot is known nothing changes: the old file still means "off".
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
    expect(store.isRemoteProviderInvocationAllowed('paused-share')).toBe(false);

    await store.migrateRemoteProviderAccessDefault(new Set(['paused-share', 'anthropic']));
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('paused-share')).toBe(false);

    // A later turn-off is remembered, and a second migration does not reopen anything.
    await store.setRemoteProviderInvocationEnabled('openai', false);
    await store.migrateRemoteProviderAccessDefault(new Set());
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
    await store.setRemoteProviderInvocationEnabled('paused-share', true);
    expect(store.isRemoteProviderInvocationAllowed('paused-share')).toBe(true);
  });

  // PR #9740 review：分享快照还没到时关掉的供应商，迁移后不能被重新打开。
  it('keeps a provider turned off before the migration closed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'remote-provider-access-prefs.json'),
      JSON.stringify({ allowedProviders: { anthropic: true, openai: true } }));
    await store.setRemoteProviderInvocationEnabled('anthropic', false);
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(false);
    await store.migrateRemoteProviderAccessDefault(new Set());
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(false);
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(true);
  });
});
