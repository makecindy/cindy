import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: vi.fn(), ownerScopedUserDataPath: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../ownerContext.js', () => ({ ownerScopedPath: (name: string) => path.join(root, owner, name) }));
vi.mock('../../maker-host/logger-adapter.js', () => { const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }; return { desktopMakerLogger: log, createMakerLogger: () => log }; });
import { setProviderDisabled } from '../../maker-host/model-disable-store';
vi.mock('../providerShareAvailabilityPolicy.js', () => ({ withAvailabilityPolicyMutation: (_id: string, work: () => Promise<unknown>) => work() }));
import * as locks from '../crossProcessLock';
import { createRemoteModelAccessStore } from '../remoteModelAccess';
import { setMergedProviderPoolResolver } from '../../maker-host/mergedProviderPool';
import { isRemoteModelSelection } from '../../../shared/remoteModelAccess';

/* 测试价值：用户要求本机与远程权限独立、按人限制。新生产存储的持久化、交集、空授权、损坏与切号
 * 原有供应商开关测试均未覆盖。最小输入：供应商的两个型号、两个成员；unit，临时目录可靠回收。耗时见执行报告。 */
let root: string;
let owner: string;
const filePath = () => path.join(root, owner, 'models.json');
const make = () => createRemoteModelAccessStore({ filePath, scopeKey: () => owner });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-remote-models-')); owner = 'a'; });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('remote model permissions', () => {
  // PR #11312 review (Greptile P1, Codex P1): an old connection merged into an account pool is hidden with its
  // own remote model range. A remote task still on the old id takes the pool's provider-wide range, neither blocked
  // nor widened by the hidden one, while a share made on the old connection keeps its members' grants, which sharing
  // still writes under the old id; stopping the old connection still applies.
  // Minimal input: pool allows A and C, old allows B, the old share's member only C.
  it('takes the pool range for a merged connection and keeps its own share members and stop', async () => {
    const store = make();
    const ok = () => {};
    await store.set('openai', ['model-a', 'model-c'], undefined, ok);
    await store.set('old-openai', ['model-b'], undefined, ok);
    await store.set('old-openai', ['model-c'], 'guest', ok);
    setMergedProviderPoolResolver((id) => (id === 'old-openai' ? 'openai' : undefined));
    try {
      expect(store.allows('old-openai', 'model-a')).toBe(true);
      expect(store.allows('old-openai', 'model-b')).toBe(false);
      expect(store.read('old-openai').models).toEqual(['model-a', 'model-c']);
      expect(store.allows('old-openai', 'model-c', 'guest')).toBe(true);
      expect(store.allows('old-openai', 'model-a', 'guest')).toBe(false);
      expect(store.read('old-openai', 'guest').models).toEqual(['model-c']);
      setProviderDisabled('old-openai', true);
      expect(store.allows('old-openai', 'model-a')).toBe(false);
      expect(store.allowsDelegatedExecution('old-openai', 'model-c', 'guest')).toBe(false);
      expect(store.allows('openai', 'model-a')).toBe(true);
      setProviderDisabled('old-openai', false);
    } finally { setMergedProviderPoolResolver(null); }
    // Split back into its own provider, its own range applies again.
    expect(store.allows('old-openai', 'model-b')).toBe(true);
  });
  // PR #11312 review (Codex P1): an unreadable rule on a merged connection must keep denying instead of being
  // replaced by the pool's range, including after other providers are saved. Minimal input: old rule members=null.
  it('keeps denying an unreadable merged-connection rule across pool inheritance and later writes', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ providers: { openai: { models: ['model-a'], members: {} }, 'old-openai': { members: null } } }));
    const store = make();
    setMergedProviderPoolResolver((id) => (id === 'old-openai' ? 'openai' : undefined));
    try {
      expect(store.allows('old-openai', 'model-a')).toBe(false);
      expect(store.allows('old-openai', 'model-a', 'guest')).toBe(false);
      expect(store.allowsDelegatedExecution('old-openai', 'model-a', 'guest')).toBe(false);
      await store.set('anthropic', ['claude'], undefined, () => {});
      expect(make().allows('old-openai', 'model-a')).toBe(false);
      expect(store.allows('openai', 'model-a')).toBe(true);
      // Saving the old connection's own share again replaces the unreadable rule.
      await store.set('old-openai', ['model-a'], 'guest', () => {});
      expect(store.allows('old-openai', 'model-a', 'guest')).toBe(true);
    } finally { setMergedProviderPoolResolver(null); }
  });
  // Unit regression: a persisted local disable must veto remote grants without rewriting
  // either choice. Existing tests covered remote model subsets, not provider suspension.
  it('preserves an existing disable across reload, denies owner/guest/delegated calls, and recovers on enable', () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const prefs = path.join(root, owner, 'model-disable-prefs.json');
    const original = JSON.stringify({ disabledProviders: { p: true }, disabledModels: {} });
    fs.writeFileSync(prefs, original);
    const store = make();
    const permissions = () => [store.allows('p', 'large'), store.allows('p', 'large', 'alice'),
      store.allowsDelegatedExecution('p', 'large', 'alice')];
    expect(permissions()).toEqual([false, false, false]);
    expect(make().allows('p', 'large')).toBe(false);
    expect(fs.readFileSync(prefs, 'utf8')).toBe(original);
    expect(store.allows('q', 'large')).toBe(true);
    setProviderDisabled('p', false);
    expect(permissions()).toEqual([true, true, true]);
    setProviderDisabled('p', true);
    expect(permissions()).toEqual([false, false, false]);
  });
  it('keeps legacy access and future models open, distinguishes an empty grant, and restores inherited defaults', async () => {
    const store = make();
    expect(store.allows('p', 'future')).toBe(true);
    await store.set('p', [], undefined, () => {});
    expect(make().allows('p', 'future')).toBe(false);
    await store.set('p', null, undefined, () => {});
    expect(make().allows('p', 'future')).toBe(true);
  });
  it('intersects individual selections with the remote ceiling without changing other people or providers', async () => {
    const store = make();
    await store.set('p', ['small', 'large'], undefined, () => {});
    await store.set('p', ['small', 'future'], 'alice', () => {});
    await store.set('p', ['large'], 'bob', () => {});
    expect([store.allows('p', 'small', 'alice'), store.allows('p', 'large', 'alice'), store.allows('p', 'future', 'alice')]).toEqual([true, false, false]);
    expect(store.allows('p', 'large', 'bob')).toBe(true);
    expect(store.allows('p', 'large', 'new-person')).toBe(true);
    expect(store.allows('q', 'future', 'alice')).toBe(true);
    await store.set('p', ['small'], undefined, () => {});
    expect(store.allows('p', 'large', 'bob')).toBe(false);
    await store.set('p', null, 'alice', () => {});
    expect(make().read('p', 'alice').models).toBeNull();
  });
  it('isolates accounts and retains each account’s permissions after reopening', async () => {
    const store = make();
    await store.set('p', [], undefined, () => {});
    owner = 'b';
    expect(store.allows('p', 'large')).toBe(true);
    await store.set('p', ['large'], 'alice', () => {});
    owner = 'a';
    expect(store.allows('p', 'large')).toBe(false);
    owner = 'b';
    expect(make().allows('p', 'small', 'alice')).toBe(false);
  });
  it('merges concurrent scope changes instead of overwriting another person’s selection', async () => {
    await Promise.all([make().set('p', ['small'], 'alice', () => {}), make().set('p', ['large'], 'bob', () => {})]);
    expect(make().read('p', 'alice').models).toEqual(['small']);
    expect(make().read('p', 'bob').models).toEqual(['large']);
  });
  it('fails closed on damaged permissions and preserves the file for recovery', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), '{broken');
    const store = make();
    expect(store.allows('p', 'large')).toBe(false);
    await expect(store.set('p', ['large'], undefined, () => {})).rejects.toThrow();
    expect(fs.readFileSync(filePath(), 'utf8')).toBe('{broken');
    fs.writeFileSync(filePath(), JSON.stringify({ providers: { p: { models: 'invalid', members: {} } } }));
    expect(make().allows('p', 'large')).toBe(false);
  });
  it('rejects an account change while waiting for the write lock', async () => {
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) => { owner = 'b'; return task({ held: true }); });
    await expect(make().set('p', [], undefined, () => {})).rejects.toThrow();
    expect(fs.existsSync(filePath())).toBe(false);
  });
  // Unit: a committed model grant must notify owner-local consumers even when
  // its caller stops during lock release; the existing tests only revoke before writing.
  it('finishes a committed grant with the owner guard after its caller stops', async () => {
    let installed = true;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) => {
      const result = await task({ held: true }); installed = false; return result;
    });
    const store = make();
    const notified = vi.fn();
    store.subscribe(notified);
    await expect(store.set('p', [], 'member', () => {
      if (!installed) throw new Error('REVOKED');
    }, undefined, () => { if (owner !== 'a') throw new Error('OWNER_CHANGED'); })).resolves.toMatchObject({ models: [] });
    expect(make().allows('p', 'large', 'member')).toBe(false);
    expect(notified).toHaveBeenCalledTimes(1);
  });
  it('still refuses a stopped caller before the grant is written', async () => {
    let installed = true;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) => {
      installed = false; return task({ held: true });
    });
    await expect(make().set('p', [], 'member', () => {
      if (!installed) throw new Error('REVOKED');
    }, undefined, () => undefined)).rejects.toThrow('REVOKED');
    expect(fs.existsSync(filePath())).toBe(false);
  });
  it('does not read or notify a new owner after the committed write', async () => {
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) => {
      const result = await task({ held: true }); owner = 'b'; return result;
    });
    const store = make();
    const notified = vi.fn();
    store.subscribe(notified);
    await expect(store.set('p', [], 'member', () => undefined, undefined, () => {
      if (owner !== 'a') throw new Error('OWNER_CHANGED');
    })).rejects.toThrow('OWNER_CHANGED');
    expect(notified).not.toHaveBeenCalled();
  });
  it('persists member budgets atomically, preserves them for older clients, and keeps the owner exempt', async () => {
    const policy = { rules: [{ id: 'a', models: ['astra'], maxPercent: 30 }], recommendedModel: 'terra', basis: 'member-input-output-7d' as const, enabled: false };
    await make().set('p', null, 'alice', () => {}, policy);
    expect(make().read('p', 'alice').memberBudget).toEqual(policy);
    expect(make().read('p').memberBudget).toBeNull();
    expect(make().read('p', 'bob').memberBudget).toBeNull();
    await make().set('p', ['astra', 'terra'], 'alice', () => {});
    expect(make().read('p', 'alice').memberBudget).toEqual(policy);
    await make().set('p', null, 'alice', () => {}, null);
    expect(make().read('p', 'alice').memberBudget).toBeNull();
  });
  it('denies damaged member rules without changing owner access', () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ providers: { p: { members: {}, budgets: [] } } }));
    expect(make().allows('p', 'astra', 'alice')).toBe(false);
    expect(make().allowsDelegatedExecution('p', 'astra', 'alice')).toBe(false);
    expect(make().allows('p', 'astra')).toBe(true);
  });
  // Unit: the real persisted grant must keep live budgets on O's relay path;
  // ordinary model grants do not distinguish an offline delegated lease.
  it('withdraws delegated eligibility for a live budget and restores it when disabled', async () => {
    const store = make();
    const policy = { rules: [{ id: 'a', models: ['astra'], maxPercent: 30 }], recommendedModel: 'terra', basis: 'member-input-output-7d' as const, enabled: true };
    const eligibility: boolean[] = [];
    store.subscribe(() => { eligibility.push(store.allowsDelegatedExecution('p', 'astra', 'alice')); });
    expect(store.allowsDelegatedExecution('p', 'astra', 'alice')).toBe(true);
    await store.set('p', null, 'alice', () => {}, policy);
    expect(make().allowsDelegatedExecution('p', 'astra', 'alice')).toBe(false);
    expect(store.allows('p', 'astra', 'alice')).toBe(true);
    expect(store.allowsDelegatedExecution('p', 'astra', 'bob')).toBe(true);
    await store.set('p', null, 'alice', () => {}, { ...policy, enabled: false });
    expect(eligibility).toEqual([false, true]);
    await store.set('p', [], 'alice', () => {});
    expect(store.allowsDelegatedExecution('p', 'astra', 'alice')).toBe(false);
  });
  it.each([{}, ['x', 'x'], [''], [' x'], [42], Array(4097).fill('m')])('refuses malformed model selections %#', (value) => {
    expect(isRemoteModelSelection(value)).toBe(false);
  });
});
