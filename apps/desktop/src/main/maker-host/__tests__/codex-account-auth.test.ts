import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  owner: { dataOwnerId: 'owner-a', generation: 1 },
  raw: '',
  hold: false,
  child: null as any,
}));
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => state.owner }));
vi.mock('../../agent-binaries/index.js', () => ({
  getCachedBinaryStatus: () => ({ binaryPath: '/fake/codex' }),
  isVettedAgentBinaryPath: () => true,
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: ['account-a', 'account-b'].map((id) => ({
      id,
      source: 'user',
      auth: { native: 'codex' },
    })),
  }),
}));
vi.mock('../codex-global-skills.js', () => ({ prepareCodexGlobalSkillsLinks: vi.fn() }));
vi.mock('../codex-global-rules.js', () => ({ prepareCodexGlobalRulesCopy: vi.fn() }));
vi.mock('../codex-global-plugins.js', () => ({
  prepareCodexGlobalPluginsBridge: async () => ({ routingFailures: [] }),
}));
vi.mock('../codex-auth-state.js', () => ({
  terminateCodexLoginProcess: (child: EventEmitter) => child.emit('exit', 1),
}));
vi.mock('node:child_process', () => ({
  spawn: (_binary: string, _args: string[], options: any) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    state.child = child;
    setImmediate(() => {
      if (state.hold) return;
      fs.writeFileSync(path.join(options.env.CODEX_HOME, 'auth.json'), state.raw);
      child.emit('exit', 0);
    });
    return child;
  },
}));

import {
  cancelCodexAccountLogin,
  codexAccountHome,
  codexAccountState,
  invalidateCodexAccount,
  loginCodexAccount,
  logoutCodexAccount,
  parseCodexAccountIdentity,
  setCodexAccountRetirement,
} from '../codex-account-auth';

function credential(subject: string, account = 'workspace') {
  const claims = Buffer.from(
    JSON.stringify({ sub: subject, email: `${subject}@example.test` }),
  ).toString('base64url');
  return JSON.stringify({
    tokens: {
      account_id: account,
      access_token: `header.${claims}.signature`,
      id_token: `header.${claims}.signature`,
    },
  });
}
beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-account-auth-'));
  state.owner = { dataOwnerId: 'owner-a', generation: 1 };
  state.raw = credential('person-a');
  state.hold = false;
  state.child = null;
  setCodexAccountRetirement(async () => {});
});
afterEach(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('native Codex account credentials', () => {
  it('ignores an old failed token after reconnect and invalidates only its own account', async () => {
    await loginCodexAccount('account-a', () => true);
    const oldToken = JSON.parse(state.raw).tokens.access_token;
    const refreshed = JSON.parse(state.raw);
    refreshed.tokens.access_token += '-refreshed';
    fs.writeFileSync(path.join(codexAccountHome('account-a'), 'auth.json'), JSON.stringify(refreshed));
    state.raw = credential('person-b');
    await loginCodexAccount('account-b', () => true);

    await invalidateCodexAccount('account-a', 'token_invalidated', oldToken);
    expect(codexAccountState('account-a').authenticated).toBe(true);
    await invalidateCodexAccount('account-a', 'token_invalidated', refreshed.tokens.access_token);
    expect(codexAccountState('account-a').authenticated).toBe(false);
    expect(codexAccountState('account-b').authenticated).toBe(true);
  });
  it('returns identity without exposing bearer credentials and distinguishes workspaces', () => {
    expect(parseCodexAccountIdentity(state.raw)?.label).toBe('person-a@example.test');
    expect(parseCodexAccountIdentity(state.raw)).not.toHaveProperty('tokens');
    expect(parseCodexAccountIdentity(state.raw)?.principal).not.toBe(
      parseCodexAccountIdentity(credential('person-a', 'other-workspace'))?.principal,
    );
  });
  it('isolates login, logout and owner directories', async () => {
    expect((await loginCodexAccount('account-a', () => true)).ok).toBe(true);
    state.raw = credential('person-b');
    expect((await loginCodexAccount('account-b', () => true)).ok).toBe(true);
    await logoutCodexAccount('account-a');
    expect(codexAccountState('account-a').authenticated).toBe(false);
    expect(codexAccountState('account-b').identity).toBe('person-b@example.test');
    const oldHome = codexAccountHome('account-b');
    state.owner = { dataOwnerId: 'owner-b', generation: 2 };
    expect(codexAccountHome('account-b')).not.toBe(oldHome);
    expect(codexAccountState('account-b').authenticated).toBe(false);
  });
  it('rejects replacing a provider with a different account', async () => {
    await loginCodexAccount('account-a', () => true);
    state.raw = credential('person-b');
    expect(await loginCodexAccount('account-a', () => true)).toMatchObject({
      ok: false,
      reason: 'account_mismatch',
    });
    expect(codexAccountState('account-a').identity).toBe('person-a@example.test');
  });
  it('rolls back a committed login when its IPC owner cancels', async () => {
    const result = await loginCodexAccount('account-a', () => true);
    expect(result.rollbackCredentials?.()).toBe(true);
    expect(codexAccountState('account-a').authenticated).toBe(false);
  });
  it('cancels a pending login without installing its credentials', async () => {
    state.hold = true;
    const pending = loginCodexAccount('account-a', () => true);
    await vi.waitFor(() => expect(state.child).not.toBeNull());
    cancelCodexAccountLogin('account-a');
    expect(await pending).toMatchObject({ ok: false, reason: 'login_cancelled' });
    expect(codexAccountState('account-a').authenticated).toBe(false);
  });
});
