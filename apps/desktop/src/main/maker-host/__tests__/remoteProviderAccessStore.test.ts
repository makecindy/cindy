/**
 * 「允许被远程调用」是别的电脑能否用一个供应商的唯一开关（2026-11-18 用户裁决）：旧的总开关、11-10 的默认开放
 * 与按旧分享补记都不再读取或迁移，并进账号池的旧连接跟随账号池。
 * 覆盖缺口：旧版本写过的文件仍带这些字段；读法变了，不能因此替用户打开任何供应商。
 * 生产入口：store 的读写函数；真实临时文件。
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
}));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const store = await import('../remote-provider-access-store.js');
const { setMergedProviderPoolResolver } = await import('../mergedProviderPool.js');
const prefsFile = () => path.join(tmpDir, 'remote-provider-access-prefs.json');

beforeEach(() => {
  // PR #9837 Windows CI: overwriting the previous case's file can keep the same
  // mtime and reuse its cached settings. Give each scenario its own path.
  tmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
});
afterAll(async () => { await fs.promises.rm(fixtureRoot, { recursive: true, force: true }); });

describe('remote provider access', () => {
  // 2026-11-18 user decision: old configuration is not migrated. An 11-10 default-open file opens nothing;
  // only providers the user opened stay open.
  it('opens only what the user opened, whatever an 11-10 file says', async () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({
      allowedProviders: { anthropic: true },
      disabledProviders: { 'turned-off': true },
      defaultOpen: true,
    }));
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(true);
    expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(false);
    await store.setRemoteProviderInvocationEnabled('anthropic', false);
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(false);
    expect(JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).disabledProviders).toMatchObject({ anthropic: true, 'turned-off': true });
  });

  // 2026-11-18 (Dash): one switch decides. A leftover master switch opens nothing, and an old connection
  // merged into a pool follows the pool's switch instead of a hidden one of its own.
  it('reads only the provider switch, and lets a merged connection follow its pool', async () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({ allowedProviders: { 'old-openai': true }, ownComputerModelUse: true }));
    expect(store.isRemoteProviderInvocationAllowed('anthropic')).toBe(false);
    setMergedProviderPoolResolver((id) => (id === 'old-openai' ? 'openai' : undefined));
    try {
      expect(store.isRemoteProviderInvocationAllowed('old-openai')).toBe(false);
      await store.setRemoteProviderInvocationEnabled('openai', true);
      expect(store.isRemoteProviderInvocationAllowed('old-openai')).toBe(true);
      expect(store.isRemoteProviderInvocationAllowed('openai')).toBe(true);
    } finally { setMergedProviderPoolResolver(null); }
  });
});
