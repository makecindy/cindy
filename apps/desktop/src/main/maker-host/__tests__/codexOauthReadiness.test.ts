import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bound: true,
  suppressed: false,
  userData: `/tmp/cindy-codex-oauth-readiness-${process.pid}`,
}));

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }));
vi.mock('../nativeProviderAuthBinding.js', () => ({
  isNativeProviderAuthBound: () => h.bound,
}));
vi.mock('../codex-auth-invalidation.js', () => ({
  shouldSuppressLocalCodexAuth: () => h.suppressed,
}));

import { hasCodexOAuthLoginReadOnly } from '../codex-oauth-readiness.js';

const authPath = path.join(h.userData, 'codex-home', 'auth.json');

beforeEach(async () => {
  h.bound = true;
  h.suppressed = false;
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: 'oauth-token' } }));
});

afterEach(async () => {
  await fs.rm(h.userData, { recursive: true, force: true });
});

describe('hasCodexOAuthLoginReadOnly', () => {
  it('仅在当前 owner 已绑定且本地 token 未被抑制时返回 true', () => {
    expect(hasCodexOAuthLoginReadOnly()).toBe(true);

    h.bound = false;
    expect(hasCodexOAuthLoginReadOnly()).toBe(false);
    h.bound = true;
    h.suppressed = true;
    expect(hasCodexOAuthLoginReadOnly()).toBe(false);
  });

  it('auth 文件缺失、损坏或 token 为空时 fail-closed', async () => {
    await fs.writeFile(authPath, '{bad json');
    expect(hasCodexOAuthLoginReadOnly()).toBe(false);
    await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: '' } }));
    expect(hasCodexOAuthLoginReadOnly()).toBe(false);
    await fs.rm(authPath);
    expect(hasCodexOAuthLoginReadOnly()).toBe(false);
  });
});
