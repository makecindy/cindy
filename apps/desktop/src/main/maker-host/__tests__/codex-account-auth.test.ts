import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { shell } from 'electron';
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
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    state.child = child;
    setImmediate(() => {
      if (state.hold) return;
      child.stderr.write('Open https://auth.openai.com/authorize?test=1\n');
      child.stdout.write('https://auth.openai.com/authorize?test=1\n');
      fs.writeFileSync(path.join(options.env.CODEX_HOME, 'auth.json'), state.raw);
      child.emit('exit', 0);
    });
    return child;
  },
}));

import {
  cancelCodexAccountLogin,
  codexAccountHome,
  codexAccountLoginName,
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
  vi.clearAllMocks();
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
  it('leaves opening the authorization page to Codex even when both streams print its URL', async () => {
    const progress = vi.fn();
    expect((await loginCodexAccount('account-a', () => true, progress)).ok).toBe(true);
    expect(progress.mock.calls).toEqual([['https://auth.openai.com/authorize?test=1'], [null]]);
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(codexAccountState('account-a').authenticated).toBe(true);
  });
  it('retains a chunked fallback URL while the CLI waits, rejects unrelated output and clears on cancel', async () => {
    state.hold = true;
    const progress = vi.fn();
    const pending = loginCodexAccount('account-a', () => true, progress);
    await vi.waitFor(() => expect(state.child).not.toBeNull());
    state.child.stderr.write('https://auth.openai.com.evil.test/oauth/authorize?bad=1\n');
    state.child.stderr.write('https://auth.openai.com/not-login?bad=1\n');
    state.child.stderr.write('x'.repeat(17_000) + 'https://auth.openai.com/authorize?bad=1\n');
    state.child.stderr.write('If your browser did not open, navigate to this URL to authenticate:\nhttps://auth.openai.com/oauth/author');
    expect(progress).not.toHaveBeenCalled();
    state.child.stderr.write('ize?state=fake&code_challenge=fake\n');
    expect(progress).toHaveBeenCalledExactlyOnceWith('https://auth.openai.com/oauth/authorize?state=fake&code_challenge=fake');
    expect(shell.openExternal).not.toHaveBeenCalled();
    cancelCodexAccountLogin('account-a');
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'login_cancelled' });
    expect(progress).toHaveBeenLastCalledWith(null);
    state.child.stderr.write('https://auth.openai.com/authorize?late=1\n');
    expect(progress).toHaveBeenCalledTimes(2);
  });
  it('updates generated names after login while preserving custom names and avoiding duplicates', () => {
    const oldIdentity = 'person-a@example.test';
    const newIdentity = 'person-b@example.test';
    const next = `OpenAI · ${newIdentity}`;
    for (const name of ['OpenAI', `OpenAI · ${oldIdentity}`, `OpenAI · ${oldIdentity} (2)`, `OpenAI · ${oldIdentity} (10)`]) {
      expect(codexAccountLoginName(name, oldIdentity, newIdentity, new Set([next]))).toBe(`${next} (2)`);
    }
    expect(codexAccountLoginName('My work account', oldIdentity, newIdentity, new Set())).toBeUndefined();
    expect(codexAccountLoginName(`OpenAI · ${oldIdentity} custom`, oldIdentity, newIdentity, new Set())).toBeUndefined();
    expect(codexAccountLoginName('OpenAI', undefined, newIdentity, new Set())).toBe(next);
    expect(codexAccountLoginName(`OpenAI · ${oldIdentity}`, oldIdentity, oldIdentity, new Set())).toBeUndefined();
  });
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
  it.each([
    ['person-b', 'workspace'],
    ['person-a', 'other-workspace'],
    ['person-a', 'workspace'],
  ])('reconnects as %s in %s without changing another connection', async (subject, workspace) => {
    await loginCodexAccount('account-a', () => true);
    await loginCodexAccount('account-b', () => true);
    await logoutCodexAccount('account-a');
    const retire = vi.fn(async () => {
      expect(codexAccountState('account-a').authenticated).toBe(false);
    });
    setCodexAccountRetirement(retire);
    state.raw = credential(subject, workspace);
    expect(await loginCodexAccount('account-a', () => true)).toMatchObject({
      ok: true,
      firstLogin: false,
      previousIdentity: 'person-a@example.test',
    });
    expect(retire).toHaveBeenCalledExactlyOnceWith('account-a');
    expect(codexAccountState('account-a').identity).toBe(`${subject}@example.test`);
    expect(codexAccountState('account-b').identity).toBe('person-a@example.test');
  });
  it('keeps rejecting credentials replaced outside an explicit login', async () => {
    await loginCodexAccount('account-a', () => true);
    fs.writeFileSync(path.join(codexAccountHome('account-a'), 'auth.json'), credential('person-b'));
    expect(codexAccountState('account-a')).toMatchObject({
      authenticated: false,
      errorReason: 'account_mismatch',
    });
  });
  it('restores the disconnected identity when a replacement login is rolled back', async () => {
    await loginCodexAccount('account-a', () => true);
    await logoutCodexAccount('account-a');
    const home = codexAccountHome('account-a');
    const identity = fs.readFileSync(path.join(home, 'account.json'), 'utf8');
    state.raw = credential('person-b');
    const result = await loginCodexAccount('account-a', () => true);
    expect(result.ok).toBe(true);
    expect(result.rollbackCredentials?.()).toBe(true);
    expect(codexAccountState('account-a').authenticated).toBe(false);
    expect(fs.readFileSync(path.join(home, 'account.json'), 'utf8')).toBe(identity);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);
  });
  it('does not commit a replacement cancelled while retiring the old runtime', async () => {
    await loginCodexAccount('account-a', () => true);
    await logoutCodexAccount('account-a');
    let current = true;
    setCodexAccountRetirement(async () => { current = false; });
    state.raw = credential('person-b');
    expect(await loginCodexAccount('account-a', () => current)).toMatchObject({
      ok: false,
      reason: 'login_cancelled',
    });
    expect(codexAccountState('account-a').authenticated).toBe(false);
    expect(fs.existsSync(path.join(codexAccountHome('account-a'), 'auth.json'))).toBe(false);
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
