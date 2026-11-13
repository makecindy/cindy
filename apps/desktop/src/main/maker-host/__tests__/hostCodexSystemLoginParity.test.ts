/**
 * Host vs desktop: the shared system Codex login (release table row 26; user decision
 * 2026-11-13: "和桌面完全一样").
 *
 *   The desktop side is DesktopCodexAuthAdapter as an installed build (isPackaged), whose system
 *   login is ~/.codex/auth.json. The Host side is createCodexLocalCliAuth with that same path
 *   (apps/host/src/agent/codex-system-login.ts, codex-invalidation.ts). Every scenario is built
 *   twice, once per side, each in its own root with a fake HOME. Both sides must leave the same
 *   state, profile link, binding and marker, and neither may change the fake system login
 *   (bytes, inode, modification time). Tokens are synthetic; no CLI or network is used.
 */
import { configureOwnerContext } from '../../ownerContext.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@cindy/maker-core';
import { DesktopCodexAuthAdapter } from '../auth-adapters.js';
import { readInvalidatedSystemCodexAuthMarker } from '../codex-auth-invalidation.js';
import { currentCodexCredentialGeneration } from '../codexCredentialRead.js';
import {
  bindNativeProviderAuth,
  isNativeProviderAuthBound,
  isNativeProviderAuthRevoked,
  isNativeProviderAuthSelfAuthorized,
  isNativeProviderAuthSharedSystemCredential,
} from '../nativeProviderAuthBinding.js';

// Fake HOMEs, links and file identity checks on real temporary files, for both sides.
// An explicit bound instead of the 5 s / 10 s defaults, wide enough for the loaded full desktop pool.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({ userDataDir: '', dataOwnerId: null as string | null, generation: 1 }));

vi.mock('../../userDataPath.js', () => ({ getUserDataDir: () => h.userDataDir, userDataPath: (...parts: string[]) => path.join(h.userDataDir, ...parts) }));
configureOwnerContext({
  read: () => ({ dataOwnerId: h.dataOwnerId, generation: h.generation, boundaryPending: false }),
  fallbackBaseDir: () => h.userDataDir,
});
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, getAppPath: () => h.userDataDir, isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../managed-skills.js', () => ({ listCindyManagedSkills: async () => [], cindyManagedSkillRoots: async () => [] }));
vi.mock('../../device-link/providerShareAvailabilityTransport.js', () => ({
  disableShareAvailability: () => { throw new Error('Unexpected standby-share mutation in credential test'); },
}));
vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return {
    ...actual,
    getActiveAppSession: () => ({ mode: h.dataOwnerId ? ('cloud' as const) : ('signed-out' as const), dataOwnerId: h.dataOwnerId, generation: h.generation }),
    activeOwnerScopeKey: () => `${h.dataOwnerId ? 'cloud' : 'signed-out'}:${h.dataOwnerId ?? 'none'}:${h.generation}`,
    isAppSessionBoundaryPending: () => false,
  };
});

type HostAuth = {
  getState(opts?: Record<string, unknown>): Promise<AuthState>; getAuthEnv(opts?: Record<string, unknown>): Promise<Record<string, string>>;
  /** The runtime's own pass, as its startup (warmUp) and token reads run it. */
  systemLogin: { reconcile(): Promise<void> };
};
type HostInvalidation = {
  invalidateHostCodexLogin(input: Record<string, unknown>): Promise<string>;
};
let createHostAuth: (codexHome: string, systemAuthPath: string, loginActive?: () => boolean) => HostAuth;
/** The Host's own account service for a profile (provider-config.ts createHostCodexAccounts). */
let createHostAccounts: (profileDir: string) => { isCodexAccountLoginActive(providerId: string): boolean };
let createHostAuthWithAccounts: (codexHome: string, systemAuthPath: string, accounts: unknown) => HostAuth & { logout(): Promise<void> };
let hostInvalidation: HostInvalidation;

beforeAll(async () => {
  // A non-literal specifier keeps the Host sources out of the desktop typecheck.
  const hostRuntime = '../../../../../host/src/agent/runtime.ts';
  const hostInvalidationModule = '../../../../../host/src/agent/codex-invalidation.ts';
  const runtime = (await import(/* @vite-ignore */ hostRuntime)) as {
    createCodexLocalCliAuth(gateway: null, route: undefined, codexHome: string, accounts?: unknown, config?: undefined, native?: unknown): Omit<HostAuth, 'systemLogin'>;
  };
  hostInvalidation = (await import(/* @vite-ignore */ hostInvalidationModule)) as HostInvalidation;
  const systemLoginModule = '../../../../../host/src/agent/codex-system-login.ts';
  const { createHostCodexSystemLogin } = (await import(/* @vite-ignore */ systemLoginModule)) as {
    createHostCodexSystemLogin(options: { codexHome: string; systemAuthPath: string | null; loginActive(): boolean }): HostAuth['systemLogin'];
  };
  const providerConfigModule = '../../../../../host/src/agent/provider-config.ts';
  const { createHostCodexAccounts } = (await import(/* @vite-ignore */ providerConfigModule)) as {
    createHostCodexAccounts(options: { profileDir: string }, scope: { owner: string; check(): void; closed(): boolean }): { isCodexAccountLoginActive(providerId: string): boolean };
  };
  createHostAccounts = profileDir => createHostCodexAccounts({ profileDir }, { owner: '', check: () => {}, closed: () => false });
  createHostAuthWithAccounts = (codexHome, systemAuthPath, accounts) => {
    const typed = accounts as { isCodexAccountLoginActive(providerId: string): boolean };
    const systemLogin = createHostCodexSystemLogin({ codexHome, systemAuthPath, loginActive: () => typed.isCodexAccountLoginActive('openai') });
    return Object.assign(runtime.createCodexLocalCliAuth(null, undefined, codexHome, accounts, undefined, { systemLogin }), { systemLogin }) as
      HostAuth & { logout(): Promise<void> };
  };
  // What the Host's Codex runtime builds (codex-runtime.ts), with the fake system login.
  createHostAuth = (codexHome, systemAuthPath, loginActive = () => false) => {
    const systemLogin = createHostCodexSystemLogin({ codexHome, systemAuthPath, loginActive });
    return Object.assign(runtime.createCodexLocalCliAuth(null, undefined, codexHome,
      { isCodexAccountLoginActive: () => loginActive() }, undefined, { systemLogin }), { systemLogin });
  };
}, 120_000);

const roots: string[] = [];
// One owner per scenario (both sides share it): owner-keyed state never leaks between scenarios.
let scenario = 0;
let scenarioOwner = 'owner-0';
type Local = 'missing' | 'hardlink' | 'symlink' | 'file-same-account' | 'file-other-account' | 'directory';
type Binding = 'none' | 'shared' | 'isolated' | 'legacy-explicit';
interface Spec { system?: 'present' | 'missing' | 'no-account'; local: Local; binding: Binding; readOnlyHome?: boolean }

const authJson = (token: string, account: string) => JSON.stringify({ account: { email: 'fixture@example.test' }, tokens: { access_token: token, account_id: account } });

/** One side's copy of a scenario: a fake HOME with ~/.codex/auth.json and a profile codex-home. */
function fixture(spec: Spec) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-system-login-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const systemAuth = path.join(home, '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  if (spec.system === 'no-account') fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'system-token-1' } }), { mode: 0o600 });
  else if (spec.system !== 'missing') fs.writeFileSync(systemAuth, authJson('system-token-1', 'workspace-a'), { mode: 0o600 });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  h.userDataDir = path.join(root, 'user-data');
  h.dataOwnerId = scenarioOwner;
  h.generation = 1;
  const codexHome = path.join(h.userDataDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  if (spec.local === 'hardlink') fs.linkSync(systemAuth, authPath);
  if (spec.local === 'symlink') fs.symlinkSync(systemAuth, authPath);
  if (spec.local === 'file-same-account') fs.writeFileSync(authPath, authJson('local-token-1', 'workspace-a'), { mode: 0o600 });
  if (spec.local === 'file-other-account') fs.writeFileSync(authPath, authJson('local-token-1', 'workspace-b'), { mode: 0o600 });
  if (spec.local === 'directory') fs.mkdirSync(path.join(authPath, 'occupied'), { recursive: true });
  if (spec.binding === 'shared') bindNativeProviderAuth('openai', { sharedSystem: true });
  if (spec.binding === 'isolated') bindNativeProviderAuth('openai', { instanceIsolated: true });
  if (spec.binding === 'legacy-explicit') bindNativeProviderAuth('openai');
  if (spec.readOnlyHome) fs.chmodSync(codexHome, 0o500);
  const systemStat = spec.system !== 'missing' ? fs.statSync(systemAuth) : null;
  const systemBytes = spec.system !== 'missing' ? fs.readFileSync(systemAuth, 'utf8') : null;
  return {
    root, home, systemAuth, codexHome, authPath,
    /** Switch the process-wide fakes (HOME, profile, owner) back to this copy. */
    enter() { vi.spyOn(os, 'homedir').mockReturnValue(home); h.userDataDir = path.join(root, 'user-data'); },
    systemUntouched() {
      if (!systemStat) return !fs.existsSync(systemAuth);
      const now = fs.statSync(systemAuth);
      return fs.readFileSync(systemAuth, 'utf8') === systemBytes && now.ino === systemStat.ino && now.mtimeMs === systemStat.mtimeMs;
    },
    /** A later login in the system CLI (or the ChatGPT App): an atomic replacement. */
    systemRelogin(token = 'system-token-2') {
      const next = `${systemAuth}.next`;
      fs.writeFileSync(next, authJson(token, 'workspace-a'), { mode: 0o600 });
      fs.renameSync(next, systemAuth);
    },
  };
}

const linkKind = (file: string, systemAuth: string) => {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return fs.readlinkSync(file) === systemAuth ? 'symlink-to-system' : 'symlink-elsewhere';
    if (st.isDirectory()) return 'directory';
    return st.nlink > 1 ? 'hardlink' : 'file';
  } catch { return 'missing'; }
};

/** The comparable outcome of one side, read by that side. */
function outcome(f: ReturnType<typeof fixture>, state: AuthState) {
  f.enter();
  const marker = readInvalidatedSystemCodexAuthMarker(f.codexHome);
  return {
    state: {
      authenticated: state.authenticated, authSource: state.authSource, errorReason: state.errorReason,
      credentialScope: state.credentialScope, recoveryRequiredReason: state.recoveryRequiredReason,
    },
    link: linkKind(f.authPath, f.systemAuth),
    binding: {
      bound: isNativeProviderAuthBound('openai'), revoked: isNativeProviderAuthRevoked('openai'),
      sharedSystem: isNativeProviderAuthSharedSystemCredential('openai'), selfAuthorized: isNativeProviderAuthSelfAuthorized('openai'),
    },
    marker: marker && { reason: marker.reason, credentialScope: marker.credentialScope, recoveryOwner: marker.recoveryOwnerId ?? null, unproven: marker.unprovenCredentialAttribution === true },
    systemUntouched: f.systemUntouched(),
  };
}

const desktopRead = async (f: ReturnType<typeof fixture>) => { f.enter(); return outcome(f, await new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' })); };
const hostRead = async (f: ReturnType<typeof fixture>) => { f.enter(); return outcome(f, await createHostAuth(f.codexHome, f.systemAuth).getState({ credentialMode: 'oauth-bearer' })); };

/** Build the scenario once per side, run each side's own steps, compare after every step. */
async function both(spec: Spec, steps: Array<{
  name: string;
  desktop?: (f: ReturnType<typeof fixture>) => Promise<unknown>;
  host?: (f: ReturnType<typeof fixture>) => Promise<unknown>;
  shared?: (f: ReturnType<typeof fixture>) => void;
}> = []) {
  const d = fixture(spec);
  const hst = fixture(spec);
  const results: Array<{ name: string; desktop: unknown; host: unknown }> = [];
  const localId = (f: ReturnType<typeof fixture>) => { try { return String(fs.lstatSync(f.authPath).ino); } catch { return 'missing'; } };
  const seen = new Map<unknown, string>([[d, localId(d)], [hst, localId(hst)]]);
  /** Whether this step replaced the profile's auth.json entry (a relink of a healthy link would). */
  const replaced = (f: ReturnType<typeof fixture>) => { const now = localId(f); const before = seen.get(f); seen.set(f, now); return before !== now; };
  const record = async (name: string) => {
    const desktop = { ...await desktopRead(d), localReplaced: replaced(d) };
    const host = { ...await hostRead(hst), localReplaced: replaced(hst) };
    results.push({ name, desktop, host });
    expect(host, name).toEqual(desktop);
    expect(desktop.systemUntouched || name.includes('relogin'), `${name}: desktop left the system login unchanged`).toBe(true);
    return desktop;
  };
  await record('open');
  for (const step of steps) {
    d.enter(); step.shared?.(d); await step.desktop?.(d);
    hst.enter(); step.shared?.(hst); await step.host?.(hst);
    await record(step.name);
  }
  for (const f of [d, hst]) if (spec.readOnlyHome) fs.chmodSync(f.codexHome, 0o700);
  return results;
}

beforeEach(() => { scenarioOwner = `owner-${++scenario}`; });

afterEach(() => {
  vi.restoreAllMocks();
  h.dataOwnerId = null;
  for (const root of roots.splice(0)) {
    try { fs.chmodSync(path.join(root, 'user-data', 'codex-home'), 0o700); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const invalidateBoth = (kind: 'attributed' | 'unattributed') => ({
  name: `${kind} invalidation`,
  desktop: async (f: ReturnType<typeof fixture>) => new DesktopCodexAuthAdapter().invalidate('token_revoked', kind === 'attributed'
    ? { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(f.authPath)) } : { credentialAttribution: 'unproven' }),
  host: async (f: ReturnType<typeof fixture>) => hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth,
    reason: 'token_revoked', ...(kind === 'attributed'
      ? { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(f.authPath)) } : { credentialAttribution: 'unproven', loginInProgress: () => false }) }),
});
const relogin = { name: 'system relogin', shared: (f: ReturnType<typeof fixture>) => f.systemRelogin() };

describe('the Host reconciles with the system Codex login as the installed desktop does', () => {
  // The eight probe combinations: hard or symbolic link × attributed or unattributed
  // invalidation, each side invalidating its own copy; then a system re-login recovers.
  for (const link of ['hardlink', 'symlink'] as const) {
    for (const kind of ['attributed', 'unattributed'] as const) {
      it(`an inherited ${link}ed login, ${kind} invalidation, then a system re-login`, async () => {
        const results = await both({ local: link, binding: 'shared' }, [invalidateBoth(kind), { name: 'restart' }, relogin, { name: 'after relogin, again' }]);
        expect(results.at(-1)!.desktop).toMatchObject({ link: 'symlink-to-system' });
      });
    }
  }

  it('a fresh profile links and claims an existing system login', async () => {
    const [open] = await both({ local: 'missing', binding: 'none' });
    expect(open!.desktop).toMatchObject({ state: { authenticated: true, credentialScope: 'system-shared' }, link: 'symlink-to-system', binding: { bound: true } });
  });

  it('no system login: nothing is linked', async () => {
    const [open] = await both({ system: 'missing', local: 'missing', binding: 'none' });
    expect(open!.desktop).toMatchObject({ state: { authenticated: false }, link: 'missing' });
  });

  it('a healthy hardlink is replaced by a file symlink', async () => {
    const [open] = await both({ local: 'hardlink', binding: 'shared' });
    expect(open!.desktop).toMatchObject({ link: 'symlink-to-system' });
  });

  it('a login made in Cindy stays the instance\'s own', async () => {
    const [open] = await both({ local: 'file-other-account', binding: 'isolated' });
    expect(open!.desktop).toMatchObject({ link: 'file', state: { authenticated: true, credentialScope: 'instance-isolated' } });
  });

  it('an account-distinct legacy explicit login is kept and promoted', async () => {
    const [open] = await both({ local: 'file-other-account', binding: 'legacy-explicit' });
    expect(open!.desktop).toMatchObject({ link: 'file' });
  });

  it('an unproven local file of the same account is relinked, except on Windows where it is kept', async () => {
    const [open] = await both({ local: 'file-same-account', binding: 'none' });
    // Windows keeps a standalone login file whatever its account (desktop auth-adapters.ts
    // reconcileWithSystemCodex, step 8; Host codex-system-login.ts step 8). both() has already
    // asserted that the Host equals the desktop on this platform.
    expect(open!.desktop).toMatchObject({ link: process.platform === 'win32' ? 'file' : 'symlink-to-system' });
  });

  it('an explicit disconnect suppresses the system login until it is replaced', async () => {
    await both({ local: 'symlink', binding: 'shared' }, [
      { name: 'disconnect', desktop: async () => new DesktopCodexAuthAdapter().logout(),
        host: async f => hostLogout(f) },
      { name: 'restart after disconnect' },
      relogin,
      { name: 'after relogin following a disconnect' },
    ]);
  });

  it('a login in progress is not reconciled', async () => {
    const d = fixture({ local: 'missing', binding: 'none' });
    const adapter = new DesktopCodexAuthAdapter() as unknown as { pendingLogin: unknown; getState(o: unknown): Promise<AuthState> };
    adapter.pendingLogin = {};
    const desktop = outcome(d, await adapter.getState({ credentialMode: 'oauth-bearer' }));
    const hst = fixture({ local: 'missing', binding: 'none' });
    const host = outcome(hst, await createHostAuth(hst.codexHome, hst.systemAuth, () => true).getState({ credentialMode: 'oauth-bearer' }));
    expect(host).toEqual(desktop);
    expect(desktop.link).toBe('missing');
  });

  // Every read above opens a fresh desktop adapter, i.e. a restarted desktop. The desktop also
  // keeps the suppression in memory within one process; the Host reads the marker each time.
  it('within one process, after an invalidation and after the system re-login', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'symlink', binding: 'shared' });
      const adapter = side === 'desktop' ? new DesktopCodexAuthAdapter() : null;
      const auth = side === 'host' ? createHostAuth(f.codexHome, f.systemAuth) : null;
      const read = async () => outcome(f, side === 'desktop'
        ? await adapter!.getState({ credentialMode: 'oauth-bearer' })
        : await auth!.getState({ credentialMode: 'oauth-bearer' }));
      const before = await read();
      if (side === 'desktop') await adapter!.invalidate('token_revoked', { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(f.authPath)) });
      else await hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth, reason: 'token_revoked',
        credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(f.authPath)) });
      const invalidated = await read();
      f.systemRelogin();
      const recovered = await read();
      results.push({ before, invalidated, recovered: { ...recovered, systemUntouched: undefined } });
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('a spawn environment read reconciles only where getAuthEnv does', async () => {
    // getAuthEnv first prepares the Codex runtime assets, which this fixture does not provide.
    vi.spyOn(DesktopCodexAuthAdapter.prototype, 'ensureGlobalCodexAssets').mockResolvedValue(undefined);
    for (const mode of ['oauth-bearer', 'gateway-key', 'provider-oauth'] as const) {
      const results: unknown[] = [];
      for (const side of ['desktop', 'host'] as const) {
        const f = fixture({ local: 'missing', binding: 'none' });
        if (side === 'desktop') await new DesktopCodexAuthAdapter().getAuthEnv({ credentialMode: mode });
        else await createHostAuth(f.codexHome, f.systemAuth).getAuthEnv({ credentialMode: mode });
        results.push({ link: linkKind(f.authPath, f.systemAuth), bound: isNativeProviderAuthBound('openai'), systemUntouched: f.systemUntouched() });
      }
      expect(results[1], mode).toEqual(results[0]);
      expect(results[0], mode).toMatchObject({ link: mode === 'oauth-bearer' ? 'symlink-to-system' : 'missing', systemUntouched: true });
    }
  });

  // The claim is pinned to the session that started the pass: a pass started for one owner
  // never binds for the owner that took over meanwhile; that owner's own next pass (here the
  // token read's) claims for itself.
  it('an owner change during reconciliation never binds the outgoing owner', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'missing', binding: 'none' });
      const outgoing = h.dataOwnerId!;
      const read = side === 'desktop'
        ? new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' })
        : createHostAuth(f.codexHome, f.systemAuth).getState({ credentialMode: 'oauth-bearer' });
      h.dataOwnerId = `${outgoing}-incoming`; h.generation = 2; // committed while the pass awaits
      await read.catch(() => undefined);
      const incomingBound = isNativeProviderAuthBound('openai');
      h.dataOwnerId = outgoing; h.generation = 1;
      results.push({ link: linkKind(f.authPath, f.systemAuth), outgoingBound: isNativeProviderAuthBound('openai'), incomingBound, systemUntouched: f.systemUntouched() });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ outgoingBound: false, systemUntouched: true });
  });

  // The runtime's own single pass (the desktop's warmUp at startup, the Host runtime's) has no
  // later read to fall back on, so its own guards are what is compared here.
  for (const kind of ['attributed', 'unattributed'] as const) {
    it(`a startup pass after an ${kind} invalidation keeps the login suppressed`, async () => {
      const results: unknown[] = [];
      for (const side of ['desktop', 'host'] as const) {
        const f = fixture({ local: 'symlink', binding: 'shared' });
        const generation = JSON.stringify(currentCodexCredentialGeneration(f.authPath));
        if (side === 'desktop') {
          await new DesktopCodexAuthAdapter().invalidate('token_revoked', kind === 'attributed' ? { credentialGeneration: generation } : { credentialAttribution: 'unproven' });
          await new DesktopCodexAuthAdapter().warmUp();
        } else {
          await hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth, reason: 'token_revoked',
            ...(kind === 'attributed' ? { credentialGeneration: generation } : { credentialAttribution: 'unproven', loginInProgress: () => false }) });
          await createHostAuth(f.codexHome, f.systemAuth).systemLogin.reconcile();
        }
        results.push({ link: linkKind(f.authPath, f.systemAuth), bound: isNativeProviderAuthBound('openai'), systemUntouched: f.systemUntouched() });
      }
      expect(results[1]).toEqual(results[0]);
    });
  }

  it('a startup pass during which the owner changes binds nobody', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'missing', binding: 'none' });
      const outgoing = h.dataOwnerId!;
      const pass = side === 'desktop' ? new DesktopCodexAuthAdapter().warmUp() : createHostAuth(f.codexHome, f.systemAuth).systemLogin.reconcile();
      h.dataOwnerId = `${outgoing}-incoming`; h.generation = 2;
      await pass;
      const incomingBound = isNativeProviderAuthBound('openai');
      h.dataOwnerId = outgoing; h.generation = 1;
      results.push({ link: linkKind(f.authPath, f.systemAuth), outgoingBound: isNativeProviderAuthBound('openai'), incomingBound });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ outgoingBound: false, incomingBound: false });
  });

  it('a login that starts during a pass stops it before the link and the claim', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'missing', binding: 'none' });
      let loginActive = false;
      if (side === 'desktop') {
        const adapter = new DesktopCodexAuthAdapter() as unknown as { pendingLogin: unknown; warmUp(): Promise<void> };
        const pass = adapter.warmUp();
        adapter.pendingLogin = {};
        await pass;
      } else {
        const pass = createHostAuth(f.codexHome, f.systemAuth, () => loginActive).systemLogin.reconcile();
        loginActive = true;
        await pass;
      }
      results.push({ link: linkKind(f.authPath, f.systemAuth), bound: isNativeProviderAuthBound('openai') });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toEqual({ link: 'missing', bound: false });
  });

  it('a system login without an account is not linked', async () => {
    const [open] = await both({ system: 'no-account', local: 'missing', binding: 'none' });
    expect(open!.desktop).toMatchObject({ link: 'missing' });
  });

  it('an unbound healthy hardlink is marked shared, relinked and claimed', async () => {
    await both({ local: 'hardlink', binding: 'none' });
  });

  it('a renewed system login is restored only to the owner it was invalidated for', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'symlink', binding: 'shared' });
      const owner = h.dataOwnerId!;
      const generation = JSON.stringify(currentCodexCredentialGeneration(f.authPath));
      if (side === 'desktop') await new DesktopCodexAuthAdapter().invalidate('token_revoked', { credentialGeneration: generation });
      else await hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth, reason: 'token_revoked', credentialGeneration: generation });
      f.systemRelogin();
      h.dataOwnerId = `${owner}-other`;
      const other = side === 'desktop'
        ? outcome(f, await new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' }))
        : outcome(f, await createHostAuth(f.codexHome, f.systemAuth).getState({ credentialMode: 'oauth-bearer' }));
      h.dataOwnerId = owner;
      results.push({ other, ownerBoundAfter: isNativeProviderAuthBound('openai') });
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('a healthy hardlink under a legacy explicit binding is marked shared before the relink', async () => {
    const [open] = await both({ local: 'hardlink', binding: 'legacy-explicit' });
    expect(open!.desktop).toMatchObject({ link: 'symlink-to-system', binding: { sharedSystem: true } });
  });

  // After the system CLI replaced its file atomically, a hardlinked profile keeps the old file:
  // only the shared binding still says it came from the system login.
  it('invalidating a hardlink the system login has left behind keeps the shared scope', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'hardlink', binding: 'shared' });
      f.systemRelogin();
      const generation = JSON.stringify(currentCodexCredentialGeneration(f.authPath));
      if (side === 'desktop') await new DesktopCodexAuthAdapter().invalidate('token_revoked', { credentialGeneration: generation });
      else await hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth, reason: 'token_revoked', credentialGeneration: generation });
      const marker = readInvalidatedSystemCodexAuthMarker(f.codexHome);
      results.push({ scope: marker?.credentialScope ?? null, recoveryOwner: Boolean(marker?.recoveryOwnerId), link: linkKind(f.authPath, f.systemAuth) });
    }
    expect(results[1]).toEqual(results[0]);
  });

  // Without the spawn's credential generation nothing proves which shared file failed. The
  // engine reports with a context (recorded as unknown); the subscription bridge without one.
  for (const source of ['the engine, without a credential generation', 'the subscription bridge, without a context'] as const) {
    it(`invalidating a shared system login reported by ${source}`, async () => {
      const engine = source.startsWith('the engine');
      const results: unknown[] = [];
      for (const side of ['desktop', 'host'] as const) {
        const f = fixture({ local: 'symlink', binding: 'shared' });
        if (side === 'desktop') await new DesktopCodexAuthAdapter().invalidate('token_revoked', engine ? { providerId: 'openai' } : undefined);
        else await hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth, reason: 'token_revoked',
          ...(engine ? { hostBound: true, providerId: 'openai', isCodexAccountProvider: () => false } : {}) });
        const marker = readInvalidatedSystemCodexAuthMarker(f.codexHome);
        const shape = marker && { scope: marker.credentialScope ?? null, recoveryOwner: Boolean(marker.recoveryOwnerId), keys: Object.keys(marker).sort(),
          system: [marker.dev, marker.ino].map(value => (value === 0 ? 0 : 'set')) };
        const read = async () => outcome(f, side === 'desktop'
          ? await new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' })
          : await createHostAuth(f.codexHome, f.systemAuth).getState({ credentialMode: 'oauth-bearer' }));
        const after = await read();
        f.systemRelogin();
        const relogged = await read();
        results.push({ shape, after, relogged: { ...relogged, systemUntouched: undefined } });
      }
      expect(results[1]).toEqual(results[0]);
      expect((results[0] as { shape: { scope: string } }).shape.scope).toBe(engine ? 'unknown' : 'system-shared');
    });
  }

  // The shared file rewritten in place (same inode, new content) after the engine captured its
  // generation: there is no invalidated fingerprint, so the engine's report is recorded as unknown
  // and the marker suppresses the current file.
  it('invalidating a shared system login rewritten in place since the spawn', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const f = fixture({ local: 'symlink', binding: 'shared' });
      const generation = JSON.stringify(currentCodexCredentialGeneration(f.authPath));
      const ino = fs.statSync(f.systemAuth).ino;
      fs.writeFileSync(f.systemAuth, authJson('system-token-1b', 'workspace-a'), { mode: 0o600 });
      expect(fs.statSync(f.systemAuth).ino).toBe(ino);
      const current = currentCodexCredentialGeneration(f.systemAuth)!;
      if (side === 'desktop') await new DesktopCodexAuthAdapter().invalidate('token_revoked', { credentialGeneration: generation });
      else await hostInvalidation.invalidateHostCodexLogin({ codexHome: f.codexHome, systemAuthPath: f.systemAuth, reason: 'token_revoked',
        credentialGeneration: generation, hostBound: true, loginInProgress: () => false });
      const marker = readInvalidatedSystemCodexAuthMarker(f.codexHome);
      const shape = marker && { scope: marker.credentialScope ?? null, recoveryOwner: Boolean(marker.recoveryOwnerId), keys: Object.keys(marker).sort(),
        suppresses: marker.localSha256 === current.sha256 ? 'current' : 'other' };
      const read = async () => outcome(f, side === 'desktop'
        ? await new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' })
        : await createHostAuth(f.codexHome, f.systemAuth).getState({ credentialMode: 'oauth-bearer' }));
      const after = await read();
      f.systemRelogin();
      const relogged = await read();
      results.push({ shape, after: { ...after, systemUntouched: undefined }, relogged: { ...relogged, systemUntouched: undefined } });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ shape: { scope: 'unknown', recoveryOwner: false, suppresses: 'current' } });
  });

  // codex-home is itself a link to the system ~/.codex: the desktop never removes auth.json then
  // (disconnectCodexOAuth, codexAuthPathsShareEntry), so the system login file stays byte for byte.
  it('invalidating when codex-home is a link to the system ~/.codex keeps the system login file', async () => {
    const results: unknown[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-home-link-')));
      roots.push(root);
      const home = path.join(root, 'home');
      const systemDir = path.join(home, '.codex');
      const systemAuth = path.join(systemDir, 'auth.json');
      fs.mkdirSync(systemDir, { recursive: true });
      fs.writeFileSync(systemAuth, authJson('system-token-1', 'workspace-a'), { mode: 0o600 });
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      h.userDataDir = path.join(root, 'user-data');
      h.dataOwnerId = scenarioOwner;
      fs.mkdirSync(h.userDataDir, { recursive: true });
      const codexHome = path.join(h.userDataDir, 'codex-home');
      fs.symlinkSync(systemDir, codexHome, 'dir');
      bindNativeProviderAuth('openai', { sharedSystem: true });
      const before = { bytes: fs.readFileSync(systemAuth, 'utf8'), stat: fs.statSync(systemAuth) };
      const generation = JSON.stringify(currentCodexCredentialGeneration(systemAuth));
      if (side === 'desktop') await new DesktopCodexAuthAdapter().invalidate('token_revoked', { credentialGeneration: generation });
      else await hostInvalidation.invalidateHostCodexLogin({ codexHome, systemAuthPath: systemAuth, reason: 'token_revoked',
        credentialGeneration: generation, hostBound: true, isCodexAccountProvider: () => false });
      const after = fs.existsSync(systemAuth) ? fs.statSync(systemAuth) : null;
      const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
      results.push({
        kept: after !== null,
        bytes: after !== null && fs.readFileSync(systemAuth, 'utf8') === before.bytes,
        inode: after?.ino === before.stat.ino,
        mtime: after?.mtimeMs === before.stat.mtimeMs,
        marker: marker && { reason: marker.reason, scope: marker.credentialScope ?? null },
        bound: isNativeProviderAuthBound('openai'),
      });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ kept: true, bytes: true, inode: true, mtime: true });
  });

  // relinkSharedCodexAuth's failure results. On POSIX the swap is a single rename that never
  // removes the target first, so "recovered" and "lost" (myAuth gone after a failed swap) only
  // occur on Windows; the Host is not released on Windows in M1.
  it('relink failure: the link cannot be created (link-unsupported)', async () => {
    await both({ local: 'missing', binding: 'none', readOnlyHome: true });
  });

  it('relink failure: the swap fails and the entry stays (swap-failed-intact)', async () => {
    const [open] = await both({ local: 'directory', binding: 'none' });
    expect(open!.desktop).toMatchObject({ link: 'directory' });
  });
});

/** The Host's own explicit disconnect: its Codex adapter's logout with its own account service. */
async function hostLogout(f: ReturnType<typeof fixture>) {
  f.enter();
  await createHostAuthWithAccounts(f.codexHome, f.systemAuth, createHostAccounts(h.userDataDir)).logout();
}
