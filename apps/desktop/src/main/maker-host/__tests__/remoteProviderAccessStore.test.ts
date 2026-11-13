/**
 * 撤回 2026-11-10 的「供应商默认对自己的电脑开放」（2026-11-12 用户裁决：那是开了不该开的）。
 * 规则依据：用户没开的不开；能确定 11-10 之前没开的还原回去；用户自己开了的照旧。「让我的其他电脑
 * 用本机模型」放在「远程连接」里，默认关闭，只由用户打开。
 * 覆盖缺口：11-10 版本写过的文件带 defaultOpen，读法变了；那段时间在默认开放的供应商上建的分享
 * 是用户自己要分享，不能被撤回连带暂停。
 * 生产入口：store 的读写与撤回函数；真实临时文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-provider-access-test-'));
let tmpDir = fixtureRoot;

vi.mock('../../ownerContext.js', () => ({ ownerScopedPath: (name: string) => path.join(tmpDir, name) }));
vi.mock('../../device-link/providerShareAvailabilityPolicy.js', () => ({
  withAvailabilityPolicyMutation: (_providerId: string | undefined, work: () => Promise<unknown>) => work(),
  withAvailabilityPolicyLock: (work: () => Promise<unknown>) => work(),
}));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const store = await import('../remote-provider-access-store.js');
const prefsFile = () => path.join(tmpDir, 'remote-provider-access-prefs.json');

beforeEach(() => {
  // PR #9837 Windows CI: overwriting the previous case's file can keep the same
  // mtime and reuse its cached settings. Give each scenario its own path.
  tmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
});
afterAll(async () => { await fs.promises.rm(fixtureRoot, { recursive: true, force: true }); });

describe('remote provider access after reverting the 11-10 default', () => {
  it('closes what only the default opened, keeps what the user opened, and keeps shares made meanwhile', async () => {
    // 11-10 版本迁移过的文件：anthropic 是用户自己开的，paused-share 为暂停分享关着，turned-off 是之后手动关的。
    fs.writeFileSync(prefsFile(), JSON.stringify({
      allowedProviders: { anthropic: true },
      disabledProviders: { 'paused-share': true, 'turned-off': true },
      defaultOpen: true,
    }));
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
    expect(store.isRemoteProviderOpenToOwnComputers('openai')).toBe(false);
    expect(store.isOwnComputerModelUseEnabled()).toBe(false);

    // 那段时间里在默认开放的 new-share 上建了分享：补记为打开。其余一律不动。
    await store.keepSharedProvidersOpen(new Set(['new-share', 'paused-share', 'turned-off']));
    expect(store.isRemoteProviderInvocationAllowed('new-share')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('paused-share')).toBe(false);
    expect(store.isRemoteProviderInvocationAllowed('turned-off')).toBe(false);
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);

    // 只做一次：之后再出现的分享不会顺带打开供应商。
    await store.keepSharedProvidersOpen(new Set(['openai']));
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
  });

  // PR #10150 review: a shared OpenAI pool is checked account by account, including accounts imported from
  // old Codex connections, so the revert must keep those connections open alongside openai itself.
  it('keeps the imported connections of a shared OpenAI pool open, unless the user turned them off', async () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({ defaultOpen: true, disabledProviders: { 'openai-old-b': true } }));
    const legacy = { 'openai-old-a': 'cindy-x-1', 'openai-old-b': 'cindy-x-2' };
    expect([...store.sharedProviderIdsForRevert([{ providerId: 'anthropic' }], () => legacy)!]).toEqual(['anthropic']);
    await store.keepSharedProvidersOpen(store.sharedProviderIdsForRevert([{ providerId: 'openai' }], () => legacy)!);
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('openai-old-a')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('openai-old-b')).toBe(false);
  });

  // PR #10150 review: an unreadable account-pool file must postpone the one-time revert, not finish it.
  it('postpones the revert while the OpenAI account pool cannot be read', () => {
    expect(store.sharedProviderIdsForRevert([{ providerId: 'openai' }], () => null)).toBeNull();
    expect([...store.sharedProviderIdsForRevert([{ providerId: 'anthropic' }], () => null)!]).toEqual(['anthropic']);
  });

  it('does not open anything for a file the 11-10 version never migrated', async () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({ allowedProviders: { anthropic: true } }));
    await store.keepSharedProvidersOpen(new Set(['openai']));
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(true);
  });

  it('opens every provider to own computers only while the user keeps the 远程连接 switch on', async () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({ allowedProviders: { anthropic: true } }));
    await store.setOwnComputerModelUse(true);
    expect(store.isRemoteProviderOpenToOwnComputers('openai')).toBe(true);
    // 分享出去的人与供应商组仍只看逐个供应商的「允许被远程调用」。
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
    expect(JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).ownComputerModelUse).toBe(true);

    await store.setOwnComputerModelUse(false);
    expect(store.isRemoteProviderOpenToOwnComputers('openai')).toBe(false);
    expect(store.isRemoteProviderOpenToOwnComputers('anthropic')).toBe(true);
  });
});
