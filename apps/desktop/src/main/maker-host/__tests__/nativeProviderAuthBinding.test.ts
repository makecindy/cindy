import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const userDataDir = '/tmp/native-provider-auth-binding-test';
const session = { dataOwnerId: 'owner-a' as string | null };

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: session.dataOwnerId ? 'cloud' : 'signed-out',
    dataOwnerId: session.dataOwnerId,
    generation: 1,
  }),
}));

import {
  claimDetectedNativeProviderAuth,
  isNativeProviderAuthBound,
  migrateLegacyNativeProviderAuthBindings,
  unbindNativeProviderAuth,
} from '../nativeProviderAuthBinding.js';

const bindingFile = path.join(userDataDir, 'native-provider-auth.json');

afterEach(() => {
  session.dataOwnerId = 'owner-a';
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('native provider auth legacy binding', () => {
  it('claims available legacy credentials for the first owner only', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {
      anthropic: true,
      openai: false,
    });

    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('does not reclaim a legacy credential after logout', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });
    unbindNativeProviderAuth('xai');
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(false);
  });
});

describe('claimDetectedNativeProviderAuth', () => {
  it('repairs the binding when the one-shot migration consumed the claim before the credential appeared', () => {
    // 复现主 bug:legacy 迁移在 reconcile 硬链建立之前跑掉,openai 名额以 false 被消费。
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: false });
    expect(isNativeProviderAuthBound('openai')).toBe(false);

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('openai')).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('claims for the current owner when no legacy claim ever ran (local mode path)', () => {
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({ openai: 'owner-a' });
  });

  it('stays fail-closed for an account that did not win the legacy claim', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {});
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('never overwrites a binding held by another owner', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: true });
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    session.dataOwnerId = 'owner-a';
    expect(isNativeProviderAuthBound('openai')).toBe(true);
  });

  it('writes nothing without a committed owner or without a credential', () => {
    session.dataOwnerId = null;
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    session.dataOwnerId = 'owner-a';
    expect(claimDetectedNativeProviderAuth('openai', () => false)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('treats corrupted falsy slot values as claimed-by-unknown and fails closed', () => {
    // 键存在但值为假(损坏 / 异常写入):按「归属不明」拒绝,绝不重认领。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ legacyClaimOwner: '' });
  });
});
