import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const context = vi.hoisted(() => ({ root: '', owner: null as string | null }));
vi.mock('electron', () => ({ app: { getPath: () => context.root } }));
vi.mock('../userDataPath.js', () => ({ userDataPath: (...parts: string[]) => path.join(context.root, ...parts) }));
vi.mock('../ownerContext.js', () => ({
  activeDataOwnerId: () => context.owner,
  isOwnerBoundaryPending: () => false,
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withSecurityBoundaryLock: async (_path: string, _options: unknown, run: (lock: { held: true }) => unknown) => run({ held: true }),
}));

import * as profile from '../localProfileDataMigration.js';
import * as native from '../maker-host/nativeProviderAuthBinding.js';
import { __testing, withGhostSkillProjectionOwnerCommit } from '../authBoundaryQuarantine.js';

// Unit: run the production cloud-commit transaction with real temporary ownership
// records and credential/adoption guards. Prior tests tested each namespace alone;
// the historical A/B split failed only when authManager combined them at login.
// No real credentials, login requests, Electron runtime or user profile is used.
const source = fs.readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
const parsed = createSourceFile('authManager.ts', source, ScriptTarget.ES2022, true);
const functions = [
  'recoverCloudOwnerDataReservations', 'resolveProfileReservationOwnerId',
  'reserveCloudOwnerData', 'withCloudOwnerCommit',
  'repairStableCloudOwnerDataReservationsWhileLocked',
].map((name) => {
  const node = parsed.statements.find((node) => isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw new Error(`Missing production function ${name}`);
  return node.getText(parsed);
});
const compiled = transpileModule(`${functions.join('\n')}\nreturn { withCloudOwnerCommit, reserveCloudOwnerData, repairStableCloudOwnerDataReservationsWhileLocked };`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    ...profile, ...native,
    app: { getPath: () => context.root },
    BRAND_IDENTITY: { dbFilePrefix: 'cindy' },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    isPassiveSharedUserDataInstance: () => false,
    withGhostSkillProjectionOwnerCommit,
    notifyRendererAuthBoundaryPending() {}, enterOwnerChangeShellPending() {},
    leaveOwnerChangeShellPending() {}, notifyRenderer() {}, requestStableOwnerPostCommit() {},
    beginAppSessionBoundary: () => () => {},
    ...overrides,
  };
  return new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as {
    withCloudOwnerCommit(options: { previousOwnerId: string | null; nextOwnerId: string; prepareTransition(): Promise<void>; commit(): void }): Promise<void>;
    repairStableCloudOwnerDataReservationsWhileLocked(owner: string): boolean;
  };
}

const profileFile = () => path.join(context.root, 'cindy-local-v1.local-profile-migration.json');
const nativeFile = () => path.join(context.root, 'native-provider-auth.json');
function seed(profileOwner: string, nativeOwner: string) {
  fs.writeFileSync(profileFile(), JSON.stringify({ ownerId: profileOwner, claimedAt: 1 }));
  fs.writeFileSync(nativeFile(), JSON.stringify({ legacyClaimOwner: nativeOwner, openai: nativeOwner }));
}
beforeEach(() => {
  context.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cloud-owner-reservations-'));
  context.owner = null;
  __testing.resetProcessQuarantine();
});
afterEach(() => fs.rmSync(context.root, { recursive: true, force: true }));

describe('cloud login with independent legacy asset owners', () => {
  it.each(['owner-a', 'owner-b', 'owner-c'])('commits %s without moving either legacy namespace', async (owner) => {
    seed('owner-a', 'owner-b');
    const before = [fs.readFileSync(profileFile(), 'utf8'), fs.readFileSync(nativeFile(), 'utf8')];
    const auth = setup();
    await auth.withCloudOwnerCommit({
      previousOwnerId: null, nextOwnerId: owner,
      prepareTransition: async () => {}, commit: () => { context.owner = owner; },
    });
    expect(context.owner).toBe(owner);
    expect([fs.readFileSync(profileFile(), 'utf8'), fs.readFileSync(nativeFile(), 'utf8')]).toEqual(before);
    expect(native.isNativeProviderAuthBound('openai')).toBe(owner === 'owner-b');
    // A repair must not make another namespace available to the current owner.
    expect(auth.repairStableCloudOwnerDataReservationsWhileLocked(owner)).toBe(owner === 'owner-b');
    native.migrateLocalNativeProviderAuthBindings(owner);
    expect([fs.readFileSync(profileFile(), 'utf8'), fs.readFileSync(nativeFile(), 'utf8')]).toEqual(before);
    const migration = profile.createProductionLocalProfileDataMigrationDeps(context.root, 'cindy');
    fs.writeFileSync(path.join(context.root, 'cindy-local-v1.db'), 'test-only-local-content');
    const result = await profile.adoptLocalProfileDatabase(owner, {
      ...migration, fs: { ...migration.fs, backupDatabase: async (src, dst) => fs.promises.copyFile(src, dst) },
    });
    expect(result.status).toBe(owner === 'owner-a' ? 'adopted' : 'claimed-by-other-owner');
    expect(fs.existsSync(path.join(context.root, `cindy-${owner}.db`))).toBe(owner === 'owner-a');
  });

  it.each([
    { data: null, credential: null, expected: 'owner-a' },
    { data: 'owner-a', credential: 'owner-a', expected: 'owner-a' },
    { data: 'owner-a', credential: null, expected: 'owner-a' },
    { data: null, credential: 'owner-b', expected: 'owner-b' },
  ])('preserves first-owner reservation policy for $data / $credential', async ({ data, credential, expected }) => {
    if (data) fs.writeFileSync(profileFile(), JSON.stringify({ ownerId: data, claimedAt: 1 }));
    if (credential) fs.writeFileSync(nativeFile(), JSON.stringify({ legacyClaimOwner: credential }));
    await setup().withCloudOwnerCommit({
      previousOwnerId: null, nextOwnerId: 'owner-a', prepareTransition: async () => {},
      commit: () => { context.owner = 'owner-a'; },
    });
    expect(context.owner).toBe('owner-a');
    expect(JSON.parse(fs.readFileSync(profileFile(), 'utf8'))).toMatchObject({ ownerId: expected });
    expect(JSON.parse(fs.readFileSync(profileFile(), 'utf8'))).not.toHaveProperty('claimToken');
    expect(native.readLegacyNativeProviderAuthOwner()).toEqual({ status: 'owned', ownerId: expected });
  });

  it.each(['empty', 'profile-only', 'native-only', 'split'])('rolls back only new reservations after a failed commit (%s)', async (initial) => {
    if (initial === 'split') seed('owner-a', 'owner-b');
    if (initial === 'profile-only') fs.writeFileSync(profileFile(), JSON.stringify({ ownerId: 'owner-a', claimedAt: 1 }));
    if (initial === 'native-only') fs.writeFileSync(nativeFile(), JSON.stringify({ legacyClaimOwner: 'owner-b', openai: 'owner-b' }));
    const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const before = [read(profileFile()), read(nativeFile())];
    await expect(setup().withCloudOwnerCommit({
      previousOwnerId: null, nextOwnerId: 'owner-c', prepareTransition: async () => {},
      commit: () => { throw new Error('test-only commit rejected'); },
    })).rejects.toThrow('test-only commit rejected');
    expect(context.owner).toBeNull();
    expect(read(profileFile())).toBe(before[0]);
    // An absent binding may become an empty object after provisional rollback;
    // it must not retain authority or a reservation token.
    if (before[1] !== null) expect(read(nativeFile())).toBe(before[1]);
    else expect(native.readLegacyNativeProviderAuthOwner()).toEqual({ status: 'none' });
  });

  it('releases a new profile claim when native reservation fails', async () => {
    const auth = setup({ reserveLegacyNativeProviderAuthOwnerDetailed: () => ({ status: 'failed' }) });
    await expect(auth.withCloudOwnerCommit({
      previousOwnerId: null, nextOwnerId: 'owner-a', prepareTransition: async () => {},
      commit: () => { context.owner = 'owner-a'; },
    })).rejects.toThrow('native provider ownership reservation failed');
    expect(context.owner).toBeNull();
    expect(fs.existsSync(profileFile())).toBe(false);
    expect(native.readLegacyNativeProviderAuthOwner()).toEqual({ status: 'none' });
  });

  it('recovers interrupted claims before reserving for a different login', async () => {
    profile.reserveLocalProfileDataOwnerDetailed('abandoned', context.root, 'cindy');
    native.reserveLegacyNativeProviderAuthOwnerDetailed('abandoned');
    await setup().withCloudOwnerCommit({
      previousOwnerId: null, nextOwnerId: 'owner-a', prepareTransition: async () => {},
      commit: () => { context.owner = 'owner-a'; },
    });
    expect(JSON.parse(fs.readFileSync(profileFile(), 'utf8'))).toMatchObject({ ownerId: 'owner-a' });
    expect(native.readLegacyNativeProviderAuthOwner()).toEqual({ status: 'owned', ownerId: 'owner-a' });
  });

  it('allows only the native namespace owner to finish its local binding migration', async () => {
    seed('owner-a', 'owner-b');
    fs.writeFileSync(nativeFile(), JSON.stringify({ legacyClaimOwner: 'owner-b', openai: 'local-v1' }));
    const auth = setup();
    for (const owner of ['owner-a', 'owner-c', 'owner-b']) {
      context.owner = owner;
      const permitted = auth.repairStableCloudOwnerDataReservationsWhileLocked(owner);
      expect(permitted).toBe(owner === 'owner-b');
      if (permitted) native.migrateLocalNativeProviderAuthBindings(owner);
      expect(native.isNativeProviderAuthBound('openai')).toBe(owner === 'owner-b');
    }
    expect(JSON.parse(fs.readFileSync(profileFile(), 'utf8'))).toEqual({ ownerId: 'owner-a', claimedAt: 1 });
    expect(JSON.parse(fs.readFileSync(nativeFile(), 'utf8'))).toMatchObject({ legacyClaimOwner: 'owner-b', openai: 'owner-b' });
  });

  it.each(['profile', 'native'])('does not authenticate through unreadable %s ownership', async (broken) => {
    seed('owner-a', 'owner-b');
    fs.writeFileSync(broken === 'profile' ? profileFile() : nativeFile(), '{');
    await expect(setup().withCloudOwnerCommit({
      previousOwnerId: null, nextOwnerId: 'owner-a', prepareTransition: async () => {},
      commit: () => { context.owner = 'owner-a'; },
    })).rejects.toThrow();
    expect(context.owner).toBeNull();
  });
});
