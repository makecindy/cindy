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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@cindy/maker-core';
// Load the adapter graph (and the real session module it wraps) before this file installs
// its owner context below, as codexAuthInvalidation.test.ts does.
import { DesktopCodexAuthAdapter } from '../auth-adapters.js';
import { readInvalidatedSystemCodexAuthMarker } from '../codex-auth-invalidation.js';
import { currentCodexCredentialGeneration } from '../codexCredentialRead.js';
import { bindNativeProviderAuth, isNativeProviderAuthBound, isNativeProviderAuthRevoked } from '../nativeProviderAuthBinding.js';

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
    codexHome: string; reason: string; failedAccessToken?: string; credentialGeneration?: string | null;
    credentialAttribution?: 'unproven'; loginInProgress?: () => boolean;
    onInvalidated?: (credentialScope: string) => void;
  }): Promise<string>;
};
type HostCodexAuth = { getState(opts?: Record<string, unknown>): Promise<AuthState> };
let host: HostInvalidation;
let createHostCodexAuth: (codexHome: string) => HostCodexAuth;

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
      codexHome: byHost.codexHome, reason: 'token_revoked', failedAccessToken: 'fixture-token-1',
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
    await host.invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked', failedAccessToken: 'fixture-token-1' });
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
