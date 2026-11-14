/**
 * Host vs desktop: server-side invalidation of the profile's own OpenAI login.
 *
 *   The Host (apps/host/src/agent/codex-invalidation.ts) writes the same marker, in the
 *   same place, as DesktopCodexAuthAdapter.invalidate's instance-isolated branch. Both
 *   directions are checked on real profile files:
 *   - after the Host invalidates, a desktop adapter opening that profile reads the same
 *     state as after the desktop invalidated it itself;
 *   - after the desktop invalidates and then logs in again, the Host reads the
 *     invalidation and then the new login.
 *   HOME is an empty directory (no system Codex login) and must stay empty. Tokens are
 *   synthetic; no CLI or network is used.
 */
import { configureOwnerContext } from '../../ownerContext.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@cindy/maker-core';
// Load the adapter graph (and the real session module it wraps) before this file installs
// its owner context below, as codexAuthInvalidation.test.ts does.
import { DesktopCodexAuthAdapter } from '../auth-adapters.js';
import { getActiveCatalog, setActiveCatalog } from '../active-catalog.js';
import { readInvalidatedSystemCodexAuthMarker } from '../codex-auth-invalidation.js';
import { currentCodexCredentialGeneration } from '../codexCredentialRead.js';
import { bindNativeProviderAuth, isNativeProviderAuthBound, isNativeProviderAuthRevoked } from '../nativeProviderAuthBinding.js';

// Real temporary profiles, auth files and markers, for both sides.
// An explicit bound instead of the 5 s / 10 s defaults, wide enough for the loaded full desktop pool.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({ userDataDir: '', dataOwnerId: null as string | null }));

vi.mock('../../userDataPath.js', () => ({ getUserDataDir: () => h.userDataDir, userDataPath: (...parts: string[]) => path.join(h.userDataDir, ...parts) }));
configureOwnerContext({
  read: () => ({ dataOwnerId: h.dataOwnerId, generation: 1, boundaryPending: false }),
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
    getActiveAppSession: () => ({ mode: h.dataOwnerId ? ('cloud' as const) : ('signed-out' as const), dataOwnerId: h.dataOwnerId, generation: 1 }),
    activeOwnerScopeKey: () => `${h.dataOwnerId ? 'cloud' : 'signed-out'}:${h.dataOwnerId ?? 'none'}:1`,
    isAppSessionBoundaryPending: () => false,
  };
});

type HostInvalidation = {
  invalidateHostCodexLogin(input: {
    codexHome: string; reason: string; credentialGeneration?: string | null;
    credentialAttribution?: 'unproven'; loginInProgress?: () => boolean; hostBound?: boolean;
    providerId?: string; isCodexAccountProvider?: (providerId: string) => boolean;
    isCurrent?: () => boolean; disposeLocalHost?: () => Promise<void>;
    onInvalidated?: (credentialScope: string) => void;
  }): Promise<string>;
};
type HostCodexAuth = { getState(opts?: Record<string, unknown>): Promise<AuthState> };
type HostCodexAuthWithAccounts = HostCodexAuth & { logout(): Promise<void>; triggerLogin(): Promise<AuthState> };
let host: HostInvalidation;
let createHostCodexAuth: (codexHome: string) => HostCodexAuth;
/** The Host's Codex adapter with its own account service (provider-config.ts), as Host main builds it. */
let createHostCodexAuthWithAccounts: (codexHome: string, codexBinary?: string) => HostCodexAuthWithAccounts;

beforeAll(async () => {
  // A non-literal specifier keeps the Host sources out of the desktop typecheck;
  // the Host checks them in its own typecheck job.
  const hostInvalidation = '../../../../../host/src/agent/codex-invalidation.ts';
  const hostRuntime = '../../../../../host/src/agent/runtime.ts';
  host = (await import(/* @vite-ignore */ hostInvalidation)) as HostInvalidation;
  const runtime = (await import(/* @vite-ignore */ hostRuntime)) as {
    createCodexLocalCliAuth(gateway: null, route: undefined, codexHome: string): HostCodexAuth;
  };
  createHostCodexAuth = codexHome => runtime.createCodexLocalCliAuth(null, undefined, codexHome);
  const providerConfigModule = '../../../../../host/src/agent/provider-config.ts';
  const { createHostCodexAccounts } = (await import(/* @vite-ignore */ providerConfigModule)) as {
    createHostCodexAccounts(options: { profileDir: string; getCodexBinary?(): string | null }, scope: { owner: string; check(): void; closed(): boolean }): unknown;
  };
  createHostCodexAuthWithAccounts = (codexHome, codexBinary) => (runtime.createCodexLocalCliAuth as unknown as (
    gateway: null, route: undefined, codexHome: string, accounts: unknown) => HostCodexAuthWithAccounts)(null, undefined, codexHome,
    createHostCodexAccounts({ profileDir: path.dirname(codexHome), getCodexBinary: () => codexBinary ?? null },
      { owner: '', check: () => {}, closed: () => false }));
}, 120_000);

const roots: string[] = [];
const homes: string[] = [];

/** A profile whose explicit Cindy login lives only in its codex-home. */
function profile(token = 'fixture-token-1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-invalidation-parity-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  homes.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  h.userDataDir = path.join(root, 'user-data');
  h.dataOwnerId = 'owner-a';
  const codexHome = path.join(h.userDataDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  const write = (value: string) => fs.writeFileSync(authPath, JSON.stringify({
    account: { email: 'fixture@example.test' },
    tokens: { access_token: value, account_id: 'fixture-workspace' },
  }), { mode: 0o600 });
  write(token);
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}');
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  return { root, home, codexHome, authPath, write };
}

/** What a desktop instance opening the profile sees, minus per-file fingerprint values. */
async function desktopView(p: ReturnType<typeof profile>) {
  const adapter = new DesktopCodexAuthAdapter();
  const marker = readInvalidatedSystemCodexAuthMarker(p.codexHome);
  return {
    oauthBearer: await adapter.getState({ credentialMode: 'oauth-bearer' }),
    implicit: await adapter.getState(),
    accessToken: await adapter.getAccessToken(),
    marker: marker && {
      reason: marker.reason,
      credentialScope: marker.credentialScope,
      keys: Object.keys(marker).sort(),
      // Zero for an isolated marker; the suppressed file's own values for an unattributed one.
      system: [marker.dev, marker.ino, marker.size, marker.mtimeMs].map(value => (value === 0 ? 0 : 'set')),
      unproven: marker.unprovenCredentialAttribution === true,
    },
    authFile: fs.existsSync(p.authPath),
    modelsCache: fs.existsSync(path.join(p.codexHome, 'models_cache.json')),
    bound: isNativeProviderAuthBound('openai'),
    revoked: isNativeProviderAuthRevoked('openai'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) expect(fs.readdirSync(home)).toEqual([]);
  h.dataOwnerId = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Host and desktop invalidate the profile login the same way', () => {
  it('a desktop opening a Host-invalidated profile sees what its own invalidation leaves', async () => {
    const byDesktop = profile();
      const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true, credentialScope: 'instance-isolated',
    });
    const desktopRejected = currentCodexCredentialGeneration(byDesktop.authPath);
    await adapter.invalidate('token_revoked', { credentialGeneration: JSON.stringify(desktopRejected) });
    const desktopMarker = readInvalidatedSystemCodexAuthMarker(byDesktop.codexHome);
    const afterDesktop = await desktopView(byDesktop);

    const byHost = profile();
    const hostRejected = currentCodexCredentialGeneration(byHost.authPath);
    const announced: string[] = [];
    await expect(host.invalidateHostCodexLogin({
      codexHome: byHost.codexHome, reason: 'token_revoked',
      credentialGeneration: JSON.stringify(hostRejected), onInvalidated: scope => announced.push(scope),
    })).resolves.toBe('invalidated');
    expect(announced).toEqual(['instance-isolated']);
    const hostMarker = readInvalidatedSystemCodexAuthMarker(byHost.codexHome);
    const afterHost = await desktopView(byHost);

    expect(afterHost).toEqual(afterDesktop);
    expect(afterHost).toMatchObject({
      oauthBearer: { authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated' },
      accessToken: null,
      marker: { reason: 'token_revoked', credentialScope: 'instance-isolated', system: [0, 0, 0, 0] },
      authFile: false, modelsCache: false, bound: false, revoked: false,
    });
    // Each marker records the credential its own server rejected.
    expect(desktopMarker?.localSha256).toBe(desktopRejected?.sha256);
    expect(hostMarker?.localSha256).toBe(hostRejected?.sha256);
  });

  it('an unattributed failure leaves the same state on both', async () => {
    const byDesktop = profile();
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
    const desktopAuth = fs.readFileSync(byDesktop.authPath, 'utf8');
    await adapter.invalidate('token_revoked', { credentialAttribution: 'unproven' });
    expect(fs.readFileSync(byDesktop.authPath, 'utf8')).toBe(desktopAuth);
    const afterDesktop = await desktopView(byDesktop);

    const byHost = profile();
    const hostAuth = fs.readFileSync(byHost.authPath, 'utf8');
    await expect(host.invalidateHostCodexLogin({
      codexHome: byHost.codexHome, reason: 'token_revoked', credentialAttribution: 'unproven', loginInProgress: () => false,
    })).resolves.toBe('unproven');
    expect(fs.readFileSync(byHost.authPath, 'utf8')).toBe(hostAuth);
    const afterHost = await desktopView(byHost);

    expect(afterHost).toEqual(afterDesktop);
    expect(afterHost).toMatchObject({
      oauthBearer: { authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated' },
      accessToken: null,
      marker: { reason: 'token_revoked', credentialScope: 'instance-isolated', system: ['set', 'set', 'set', 'set'], unproven: true },
      authFile: true, modelsCache: true, bound: true, revoked: false,
    });
  });

  it('the Host reads a desktop invalidation, then the desktop login that replaces it', async () => {
    const p = profile();
    const hostAuth = createHostCodexAuth(p.codexHome);
    await expect(hostAuth.getState({ providerId: 'openai' })).resolves.toMatchObject({ authenticated: true, authSource: 'oauth' });
      const adapter = new DesktopCodexAuthAdapter();
    await adapter.invalidate('token_revoked', {
      credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(p.authPath)),
    });
    await expect(hostAuth.getState({ providerId: 'openai' })).resolves.toEqual({
      authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated',
    });

    p.write('fixture-token-2');
    const finishSuccessfulCodexLogin = (adapter as unknown as {
      finishSuccessfulCodexLogin(): Promise<AuthState>;
    }).finishSuccessfulCodexLogin.bind(adapter);
    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({ authenticated: true });
    await expect(hostAuth.getState({ providerId: 'openai' })).resolves.toMatchObject({ authenticated: true, authSource: 'oauth' });

    // The desktop's account check then settles its recovery prompt; the Host still reads the login.
    await adapter.verifyRecoveryWithAccountRpc(async () => undefined);
    await expect(hostAuth.getState({ providerId: 'openai' })).resolves.toMatchObject({ authenticated: true, authSource: 'oauth' });
  });

  it('the desktop reads a Host invalidation, then its own login that replaces it', async () => {
    const p = profile();
    await host.invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked' });
      const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false, errorReason: 'token_revoked',
    });
    p.write('fixture-token-2');
    const finishSuccessfulCodexLogin = (adapter as unknown as {
      finishSuccessfulCodexLogin(): Promise<AuthState>;
    }).finishSuccessfulCodexLogin.bind(adapter);
    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({ authenticated: true });
    await expect(createHostCodexAuth(p.codexHome).getState({ providerId: 'openai' }))
      .resolves.toMatchObject({ authenticated: true, authSource: 'oauth' });
  });
});

/**
 * The desktop's checks on the generation the engine captured (auth-adapters.ts invalidate):
 * a different file identity is an outside atomic replacement and an open login cancellation
 * window a login still finalizing its replacement, so the current file is left alone; a rewrite
 * in place is ambiguous and suppresses the current file without the rejected fingerprint. The
 * Host's counterpart of the open window is a login of the native connection in progress
 * (loginInProgress, the account service's isCodexAccountLoginActive).
 */
describe('a failure reported for a generation the profile login no longer has', () => {
  const token2 = () => JSON.stringify({ account: { email: 'fixture@example.test' }, tokens: { access_token: 'fixture-token-2', account_id: 'fixture-workspace' } });
  const changes = {
    /** The same file rewritten (a refresh written in place): same inode, new content. */
    inPlace(p: ReturnType<typeof profile>) {
      const before = fs.statSync(p.authPath).ino;
      p.write('fixture-token-2');
      expect(fs.statSync(p.authPath).ino).toBe(before);
    },
    /** A new file renamed over it (another login): new inode, new content. */
    replaced(p: ReturnType<typeof profile>) {
      const before = fs.statSync(p.authPath).ino;
      const next = `${p.authPath}.next`;
      fs.writeFileSync(next, token2(), { mode: 0o600 });
      fs.renameSync(next, p.authPath);
      expect(fs.statSync(p.authPath).ino).not.toBe(before);
    },
  };

  /** Runs the scenario once per side, each on its own profile, and compares what each leaves. */
  async function bothSides(change: keyof typeof changes, loginOpen: boolean) {
    const sides: Record<string, unknown> = {};
    const hostResults: string[] = [];
    for (const side of ['desktop', 'host'] as const) {
      const p = profile();
      const adapter = new DesktopCodexAuthAdapter();
      if (side === 'desktop') await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
      const generation = JSON.stringify(currentCodexCredentialGeneration(p.authPath));
      changes[change](p);
      const current = currentCodexCredentialGeneration(p.authPath)!;
      const announced: string[] = [];
      if (side === 'desktop') {
        adapter.setOnInvalidatedBroadcast((_reason, scope) => { announced.push(scope); });
        if (loginOpen) (adapter as unknown as { loginCancellationOpen: boolean }).loginCancellationOpen = true;
        await adapter.invalidate('token_revoked', { credentialGeneration: generation });
      } else {
        hostResults.push(await host.invalidateHostCodexLogin({
          codexHome: p.codexHome, reason: 'token_revoked', credentialGeneration: generation, hostBound: true,
          loginInProgress: () => loginOpen, onInvalidated: scope => announced.push(scope),
        }));
      }
      const marker = readInvalidatedSystemCodexAuthMarker(p.codexHome);
      sides[side] = {
        view: await desktopView(p), announced,
        // The marker's own record of the credential it suppresses.
        suppresses: marker ? (marker.localSha256 === current.sha256 ? 'current' : 'other') : null,
        token: fs.existsSync(p.authPath) ? JSON.parse(fs.readFileSync(p.authPath, 'utf8')).tokens.access_token : null,
      };
    }
    expect(sides.host).toEqual(sides.desktop);
    return { outcome: sides.desktop, hostResult: hostResults[0] };
  }

  const untouched = {
    view: {
      oauthBearer: { authenticated: true, credentialScope: 'instance-isolated' },
      marker: null, authFile: true, modelsCache: true, bound: true, revoked: false,
    },
    announced: [], suppresses: null, token: 'fixture-token-2',
  };

  it('a rewrite in place: a marker without the rejected fingerprint suppresses the current file', async () => {
    const { outcome, hostResult } = await bothSides('inPlace', false);
    expect(hostResult).toBe('invalidated');
    expect(outcome).toMatchObject({
      view: {
        oauthBearer: { authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated' },
        accessToken: null,
        marker: { reason: 'token_revoked', credentialScope: 'instance-isolated', system: [0, 0, 0, 0] },
        authFile: false, modelsCache: false, bound: false, revoked: false,
      },
      announced: ['instance-isolated'], suppresses: 'current', token: null,
    });
  });

  it('a replacement with a new inode is an older generation: nothing changes', async () => {
    const { outcome, hostResult } = await bothSides('replaced', false);
    expect(hostResult).toBe('stale');
    expect(outcome).toMatchObject(untouched);
  });

  it('a rewrite in place while a login is in progress: nothing changes', async () => {
    const { outcome, hostResult } = await bothSides('inPlace', true);
    expect(hostResult).toBe('stale');
    expect(outcome).toMatchObject(untouched);
  });
});

/**
 * The desktop's entry check (auth-adapters.ts invalidate): only an independent Codex account is
 * left alone; the gateway or a custom provider reporting a ChatGPT login failure invalidates the
 * native login. The Host's predicate is its account service's (provider-config.ts isProvider,
 * without the native connection, as codex-runtime.ts passes it).
 */
describe('a failure reported with the provider of the task', () => {
  const ACCOUNT = 'fixture-codex-account';
  const hostIsCodexAccountProvider = (id: string) => id !== 'openai' && getActiveCatalog().providers.some(
    (provider) => provider.id === id && provider.source === 'user' && provider.auth.native === 'codex');
  let restoreCatalog: (() => void) | null = null;
  beforeAll(() => {
    const previous = getActiveCatalog();
    const openai = previous.providers.find((provider) => provider.id === 'openai');
    if (!openai) throw new Error('fixture catalog has no openai provider');
    setActiveCatalog({ ...previous, providers: [...previous.providers,
      { ...openai, id: ACCOUNT, source: 'user', auth: { method: 'oauth', native: 'codex' } }] });
    restoreCatalog = () => setActiveCatalog(previous);
  });
  afterAll(() => restoreCatalog?.());

  for (const [providerId, expectInvalidated] of [['xd', true], ['cprov-fixture', true], [ACCOUNT, false]] as const) {
    it(`${providerId}: ${expectInvalidated ? 'the native login is invalidated' : 'nothing changes'} on both`, async () => {
      const byDesktop = profile();
      const adapter = new DesktopCodexAuthAdapter();
      await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
      await adapter.invalidate('token_revoked', { providerId, credentialAttribution: 'unproven' });
      const afterDesktop = await desktopView(byDesktop);

      const byHost = profile();
      await host.invalidateHostCodexLogin({ codexHome: byHost.codexHome, reason: 'token_revoked', providerId,
        credentialAttribution: 'unproven', loginInProgress: () => false, isCodexAccountProvider: hostIsCodexAccountProvider });
      const afterHost = await desktopView(byHost);

      expect(afterHost).toEqual(afterDesktop);
      expect(afterHost.marker !== null).toBe(expectInvalidated);
    });
  }
});


/**
 * The desktop's logout cleanup stops once the owner that started it is no longer current
 * (isCodexDisconnectCurrent): what is left belongs to the next owner. Here the owner changes while
 * the local Codex host is retired, and the next owner claims the native login right away; its
 * binding must survive, and the models cache stays for it.
 */
describe('an owner change during the invalidation cleanup', () => {
  it('stops the cleanup at the same step on both, keeping the next owner binding', async () => {
    const { activeOwnerScopeKey } = await import('../../appSessionState.js');
    const switchOwner = () => {
      h.dataOwnerId = 'owner-b';
      bindNativeProviderAuth('openai', { instanceIsolated: true });
    };
    const outcome = (p: ReturnType<typeof profile>) => ({
      authFile: fs.existsSync(p.authPath),
      modelsCache: fs.existsSync(path.join(p.codexHome, 'models_cache.json')),
      nextOwnerBound: isNativeProviderAuthBound('openai'),
      marker: readInvalidatedSystemCodexAuthMarker(p.codexHome)?.reason ?? null,
    });

    const byDesktop = profile();
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
    adapter.setOnLogoutSuccess(async () => { switchOwner(); });
    await adapter.invalidate('token_revoked', { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byDesktop.authPath)) });
    const afterDesktop = outcome(byDesktop);

    const byHost = profile();
    const owner = activeOwnerScopeKey();
    await host.invalidateHostCodexLogin({ codexHome: byHost.codexHome, reason: 'token_revoked',
      credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byHost.authPath)),
      isCurrent: () => activeOwnerScopeKey() === owner, disposeLocalHost: async () => { switchOwner(); } });
    const afterHost = outcome(byHost);

    expect(afterHost).toEqual(afterDesktop);
    expect(afterHost).toEqual({ authFile: false, modelsCache: true, nextOwnerBound: true, marker: 'token_revoked' });
  });
});

/**
 * The desktop announces an invalidation only if it is still the current one when its cleanup
 * ends (oauthInvalidatedReason and scope unchanged). Here a login replaces the rejected
 * credential while the local Codex host is retired: neither side announces the old failure.
 * Without that, both announce once, with the credential's scope.
 */
describe('an invalidation superseded during its cleanup', () => {
  for (const loginDuringCleanup of [false, true]) {
    it(loginDuringCleanup ? 'is not announced on either side' : 'is announced once on both sides', async () => {
      const byDesktop = profile();
      const adapter = new DesktopCodexAuthAdapter();
      await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
      const desktopAnnounced: string[] = [];
      adapter.setOnInvalidatedBroadcast((_reason, scope) => { desktopAnnounced.push(scope); });
      const finishSuccessfulCodexLogin = (adapter as unknown as { finishSuccessfulCodexLogin(): Promise<AuthState> })
        .finishSuccessfulCodexLogin.bind(adapter);
      adapter.setOnLogoutSuccess(async () => {
        if (!loginDuringCleanup) return;
        byDesktop.write('fixture-token-2');
        await finishSuccessfulCodexLogin();
      });
      await adapter.invalidate('token_revoked', { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byDesktop.authPath)) });

      const byHost = profile();
      const hostAnnounced: string[] = [];
      await host.invalidateHostCodexLogin({ codexHome: byHost.codexHome, reason: 'token_revoked',
        credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byHost.authPath)),
        onInvalidated: scope => { hostAnnounced.push(scope); },
        disposeLocalHost: async () => {
          if (!loginDuringCleanup) return;
          // The Host's login commit (codex-account-auth.ts): a new auth.json renamed into place.
          const next = `${byHost.authPath}.next`;
          fs.writeFileSync(next, JSON.stringify({ account: { email: 'fixture@example.test' },
            tokens: { access_token: 'fixture-token-2', account_id: 'fixture-workspace' } }), { mode: 0o600 });
          fs.renameSync(next, byHost.authPath);
          bindNativeProviderAuth('openai', { instanceIsolated: true });
        } });

      expect(hostAnnounced).toEqual(desktopAnnounced);
      expect(hostAnnounced).toEqual(loginDuringCleanup ? [] : ['instance-isolated']);
    });
  }
});

/**
 * The explicit disconnect (DesktopCodexAuthAdapter.logout; the Host's own adapter logout with its
 * own account service): the durable disconnect marker, auth.json kept, no prompt left behind.
 */
describe('an explicit disconnect', () => {
  const settled = (view: Awaited<ReturnType<typeof desktopView>>) => ({
    authenticated: view.oauthBearer.authenticated, errorReason: view.oauthBearer.errorReason ?? null,
    marker: view.marker && { reason: view.marker.reason, keys: view.marker.keys }, bound: view.bound, revoked: view.revoked,
  });

  it('after an invalidation: both read as not connected, without the old reason', async () => {
    const byDesktop = profile();
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
    await adapter.invalidate('token_revoked', { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byDesktop.authPath)) });
    await adapter.logout();
    const afterDesktop = await desktopView(byDesktop);

    const byHost = profile();
    await host.invalidateHostCodexLogin({ codexHome: byHost.codexHome, reason: 'token_revoked',
      credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byHost.authPath)) });
    await createHostCodexAuthWithAccounts(byHost.codexHome).logout();
    const afterHost = await desktopView(byHost);

    expect(afterHost).toEqual(afterDesktop);
    expect(settled(afterHost)).toMatchObject({ authenticated: false, marker: { reason: 'user_disconnected' }, bound: false, revoked: true });
    expect(afterHost.oauthBearer.errorReason).not.toBe('token_revoked');
  });

  it('keeps auth.json and drops the models cache on both', async () => {
    const byDesktop = profile();
    await new DesktopCodexAuthAdapter().logout();
    const afterDesktop = await desktopView(byDesktop);
    const byHost = profile();
    await createHostCodexAuthWithAccounts(byHost.codexHome).logout();
    const afterHost = await desktopView(byHost);
    expect(afterHost).toEqual(afterDesktop);
    expect(afterHost).toMatchObject({ authFile: true, modelsCache: false, bound: false, revoked: true });
  });

  it('during an invalidation cleanup: the logout wins and nothing is announced on either side', async () => {
    const byDesktop = profile();
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
    const desktopAnnounced: string[] = [];
    adapter.setOnInvalidatedBroadcast((_reason, scope) => { desktopAnnounced.push(scope); });
    let desktopLogout: Promise<void> | null = null;
    adapter.setOnLogoutSuccess(async () => { desktopLogout ??= adapter.logout(); });
    await adapter.invalidate('token_revoked', { credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byDesktop.authPath)) });
    await desktopLogout;
    const afterDesktop = await desktopView(byDesktop);

    const byHost = profile();
    const hostAuth = createHostCodexAuthWithAccounts(byHost.codexHome);
    const hostAnnounced: string[] = [];
    let hostLogout: Promise<void> | null = null;
    await host.invalidateHostCodexLogin({ codexHome: byHost.codexHome, reason: 'token_revoked',
      credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(byHost.authPath)),
      onInvalidated: scope => { hostAnnounced.push(scope); },
      disposeLocalHost: async () => { hostLogout ??= hostAuth.logout(); } });
    await hostLogout;
    const afterHost = await desktopView(byHost);

    expect(hostAnnounced).toEqual(desktopAnnounced);
    expect(hostAnnounced).toEqual([]);
    expect(settled(afterHost)).toEqual(settled(afterDesktop));
    expect(settled(afterHost)).toMatchObject({ authenticated: false, marker: { reason: 'user_disconnected' }, revoked: true });
  });

  // The Host side logs in through a fake Codex CLI that is a sh script; the account service starts
  // it without a shell, which Windows cannot do for a script. The desktop half needs no CLI.
  it.skipIf(process.platform === 'win32')('then a new login in Cindy: both read the new login, the disconnect marker stays as the suppression sentinel', async () => {
    const byDesktop = profile();
    const adapter = new DesktopCodexAuthAdapter();
    await adapter.logout();
    byDesktop.write('fixture-token-2');
    const finishSuccessfulCodexLogin = (adapter as unknown as { finishSuccessfulCodexLogin(): Promise<AuthState> })
      .finishSuccessfulCodexLogin.bind(adapter);
    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({ authenticated: true });
    const afterDesktop = await desktopView(byDesktop);

    // The Host logs in through its account service, with a fake Codex CLI that writes a
    // synthetic ChatGPT login into the staging CODEX_HOME it is given (no network).
    const byHost = profile();
    const claims = Buffer.from(JSON.stringify({ sub: 'fixture-subject', email: 'fixture@example.test' })).toString('base64url');
    const login = JSON.stringify({ tokens: { access_token: 'fixture-token-2', id_token: `e30.${claims}.sig`, account_id: 'fixture-workspace' } });
    const cli = path.join(byHost.root, 'fake-codex');
    fs.writeFileSync(cli, `#!/bin/sh\ncat > "$CODEX_HOME/auth.json" <<'EOF'\n${login}\nEOF\nexit 0\n`, { mode: 0o755 });
    const hostAuth = createHostCodexAuthWithAccounts(byHost.codexHome, cli);
    await hostAuth.logout();
    await expect(hostAuth.triggerLogin()).resolves.toMatchObject({ authenticated: true });
    const afterHost = await desktopView(byHost);

    expect(settled(afterHost)).toEqual(settled(afterDesktop));
    expect(settled(afterHost)).toMatchObject({ authenticated: true, marker: { reason: 'user_disconnected' }, bound: true, revoked: false });
  });
});


/**
 * The profile's auth.json already gone (an earlier invalidation removed it): the desktop does not
 * skip a late failure, it re-asserts the invalidation with the new reason and announces it, unless
 * a login in progress owns that gap (loginCleanupOwnsMissingCredential).
 */
describe('a late failure after the profile login is gone', () => {
  for (const loginOpen of [false, true]) {
    it(loginOpen ? 'during a login: nothing changes on either side' : 're-asserts the invalidation on both sides', async () => {
      const runs: Record<string, unknown> = {};
      for (const side of ['desktop', 'host'] as const) {
        const p = profile();
        const announced: string[] = [];
        const generation = JSON.stringify(currentCodexCredentialGeneration(p.authPath));
        if (side === 'desktop') {
          const adapter = new DesktopCodexAuthAdapter();
          await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({ authenticated: true });
          await adapter.invalidate('token_revoked', { credentialGeneration: generation });
          adapter.setOnInvalidatedBroadcast((_reason, scope) => { announced.push(scope); });
          if (loginOpen) Object.assign(adapter as unknown as Record<string, unknown>, { pendingLogin: { cancelled: false }, loginCancellationOpen: true });
          await adapter.invalidate('refresh_token_reused', { credentialGeneration: generation });
        } else {
          await host.invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked', credentialGeneration: generation, hostBound: true });
          await host.invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'refresh_token_reused', credentialGeneration: generation,
            hostBound: true, loginInProgress: () => loginOpen, onInvalidated: scope => { announced.push(scope); } });
        }
        const marker = readInvalidatedSystemCodexAuthMarker(p.codexHome);
        runs[side] = { announced, reason: marker?.reason ?? null, scope: marker?.credentialScope ?? null, authFile: fs.existsSync(p.authPath) };
      }
      expect(runs.host).toEqual(runs.desktop);
      expect(runs.desktop).toEqual(loginOpen
        ? { announced: [], reason: 'token_revoked', scope: 'instance-isolated', authFile: false }
        : { announced: ['instance-isolated'], reason: 'refresh_token_reused', scope: 'instance-isolated', authFile: false });
    });
  }
});
