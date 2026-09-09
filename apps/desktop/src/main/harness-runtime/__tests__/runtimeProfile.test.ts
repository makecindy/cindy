import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  ownerId: 'owner-a',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (kind: string) => (kind === 'temp' ? path.join(mocks.root, 'temp') : mocks.root),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `cloud:${mocks.ownerId}:1`,
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(mocks.root, 'owners', mocks.ownerId, ...parts),
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  __testing,
  clearHarnessRuntimeCapabilities,
  getHarnessRuntimeProfile,
  reconcileHarnessRuntimeIdentity,
  resetHarnessRuntimeProfile,
} from '../runtime-profile-store';
import { inspectTencentHarnessLaunchPlan } from '../runtime-profile-probe';
import {
  approveTencentHarnessRuntimeLaunchPlan,
  createHarnessRuntimeLaunchResolver,
} from '../runtime-launch-resolver';
import type { ApprovedExecutableIdentity, HarnessLaunchPlan, LaunchPlanProbeDeps } from '../types';

const settingsFile = (): string =>
  path.join(mocks.root, 'owners', mocks.ownerId, 'harness-runtime-profiles.json');

function launchPlan(executable = '/opt/tencent/tclaude'): HarnessLaunchPlan {
  return { executable, argsPrefix: [] };
}

function identity(overrides: Partial<ApprovedExecutableIdentity> = {}): ApprovedExecutableIdentity {
  return {
    launcherRealpath: '/opt/tencent/tclaude',
    launcherSize: 100,
    launcherMtimeMs: 10,
    realpath: '/opt/tencent/tclaude',
    size: 100,
    mtimeMs: 10,
    wrapperKind: 'tclaude',
    wrapperVersion: '0.1.6',
    upstreamVersion: '2.1.251',
    ...overrides,
  };
}

function fakeProbeDeps(
  files: Record<
    string,
    { realpath?: string; size?: number; mtimeMs?: number; executable?: boolean }
  >,
  output: string,
): LaunchPlanProbeDeps {
  return {
    async realpath(file) {
      const entry = files[file];
      if (!entry) throw new Error(`missing ${file}`);
      return entry.realpath ?? file;
    },
    async stat(file) {
      const entry = files[file];
      if (!entry) throw new Error(`missing ${file}`);
      return {
        isFile: () => true,
        size: entry.size ?? 100,
        mtimeMs: entry.mtimeMs ?? 10,
      };
    },
    async access(file, mode) {
      const entry = files[file];
      if (!entry || (mode !== fs.constants.R_OK && entry.executable === false)) {
        throw new Error(`not accessible ${file}`);
      }
    },
    async runVersion(_command, args) {
      if (args.length === 0 && /@tencent\/tcodex/.test(output)) {
        return { stdout: 'v22.23.2\n', stderr: '' };
      }
      return { stdout: output, stderr: '' };
    },
  };
}

describe('Tencent Harness runtime profiles', () => {
  beforeEach(() => {
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-harness-runtime-profile-'));
    mocks.ownerId = 'owner-a';
  });

  afterEach(() => {
    fs.rmSync(mocks.root, { recursive: true, force: true });
  });

  it('follows the Cindy-managed default when no user override exists', () => {
    expect(getHarnessRuntimeProfile('claude-code')).toEqual({
      agentKind: 'claude-code',
      distribution: 'cindy-managed',
      authOwner: 'cindy',
      routeOwner: 'cindy',
      configHomePolicy: 'cindy-isolated',
    });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('persists only an explicit Tencent runtime override and resets to the managed default', () => {
    __testing.persistInspectedTencentHarnessRuntimeProfile('claude-code', {
      launchPlan: launchPlan(),
      identity: identity(),
      capabilityProfile: { streamJson: true },
    });

    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({
      runtimes: {
        'claude-code': {
          launchPlan: launchPlan(),
          identity: identity(),
          capabilityProfile: { streamJson: true },
        },
      },
    });
    expect(getHarnessRuntimeProfile('claude-code')).toMatchObject({
      agentKind: 'claude-code',
      distribution: 'tencent-local',
      launchPlan: launchPlan(),
      capabilityProfile: { streamJson: true },
    });

    resetHarnessRuntimeProfile('claude-code');

    expect(getHarnessRuntimeProfile('claude-code')).toEqual({
      agentKind: 'claude-code',
      distribution: 'cindy-managed',
      authOwner: 'cindy',
      routeOwner: 'cindy',
      configHomePolicy: 'cindy-isolated',
    });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('keeps runtime overrides isolated by data owner', () => {
    __testing.persistInspectedTencentHarnessRuntimeProfile('codex', {
      launchPlan: { executable: '/opt/node', argsPrefix: ['/opt/tencent/tcodex'] },
      identity: identity({
        launcherRealpath: '/opt/node',
        realpath: '/opt/tencent/tcodex',
        wrapperKind: 'tcodex',
        wrapperVersion: '0.0.16',
        upstreamVersion: '0.144.5',
      }),
    });

    mocks.ownerId = 'owner-b';
    expect(getHarnessRuntimeProfile('codex')).toEqual({
      agentKind: 'codex',
      distribution: 'cindy-managed',
      authOwner: 'cindy',
      routeOwner: 'cindy',
      configHomePolicy: 'cindy-isolated',
    });

    mocks.ownerId = 'owner-a';
    expect(getHarnessRuntimeProfile('codex')).toMatchObject({
      distribution: 'tencent-local',
      identity: { wrapperKind: 'tcodex' },
    });
  });

  it('invalidates cached capabilities when the observed executable identity changes', () => {
    __testing.persistInspectedTencentHarnessRuntimeProfile('claude-code', {
      launchPlan: launchPlan(),
      identity: identity(),
      capabilityProfile: { streamJson: true, nativeResume: true },
    });

    expect(
      reconcileHarnessRuntimeIdentity('claude-code', identity({ size: 101, mtimeMs: 11 })),
    ).toEqual({ identityChanged: true, capabilityProfile: {} });
    expect(getHarnessRuntimeProfile('claude-code')).toMatchObject({
      distribution: 'tencent-local',
      identity: identity({ size: 101, mtimeMs: 11 }),
      capabilityProfile: {},
    });
  });

  it('can clear an approved capability profile without deleting the explicit runtime selection', () => {
    __testing.persistInspectedTencentHarnessRuntimeProfile('claude-code', {
      launchPlan: launchPlan(),
      identity: identity(),
      capabilityProfile: { streamJson: true },
    });

    clearHarnessRuntimeCapabilities('claude-code');

    expect(getHarnessRuntimeProfile('claude-code')).toMatchObject({
      distribution: 'tencent-local',
      launchPlan: launchPlan(),
      identity: identity(),
      capabilityProfile: {},
    });
  });

  it('accepts a native tclaude launch plan only when version output identifies both wrapper and upstream', async () => {
    const result = await inspectTencentHarnessLaunchPlan(
      'claude-code',
      launchPlan(),
      fakeProbeDeps(
        { '/opt/tencent/tclaude': {} },
        '@tencent/tclaude 0.1.6\n@anthropic-ai/claude-code 2.1.251\n',
      ),
    );

    expect(result).toEqual({
      launchPlan: launchPlan(),
      identity: identity(),
    });
  });

  it('canonicalizes an approved Node-wrapper plan before persisting it', async () => {
    const result = await approveTencentHarnessRuntimeLaunchPlan(
      'codex',
      { executable: '/opt/node-link', argsPrefix: ['/opt/tencent/tcodex-link'] },
      fakeProbeDeps(
        {
          '/opt/node-link': { realpath: '/opt/node', size: 80, mtimeMs: 8 },
          '/opt/node': { size: 80, mtimeMs: 8 },
          '/opt/tencent/tcodex-link': {
            realpath: '/opt/tencent/tcodex',
            size: 120,
            mtimeMs: 12,
          },
          '/opt/tencent/tcodex': { size: 120, mtimeMs: 12 },
        },
        '@tencent/tcodex 0.0.16\n@openai/codex 0.144.5\n',
      ),
    );

    expect(result).toEqual({
      agentKind: 'codex',
      distribution: 'tencent-local',
      authOwner: 'harness',
      routeOwner: 'harness',
      configHomePolicy: 'harness-default',
      launchPlan: { executable: '/opt/node', argsPrefix: ['/opt/tencent/tcodex'] },
      capabilityProfile: {},
      identityChanged: false,
    });
    expect(getHarnessRuntimeProfile('codex')).toMatchObject({
      distribution: 'tencent-local',
      launchPlan: { executable: '/opt/node', argsPrefix: ['/opt/tencent/tcodex'] },
      identity: {
        launcherRealpath: '/opt/node',
        launcherSize: 80,
        launcherMtimeMs: 8,
        realpath: '/opt/tencent/tcodex',
        size: 120,
        mtimeMs: 12,
      },
    });
  });

  it('resolves only Main-supplied managed plans and rechecks saved Tencent identities', async () => {
    const resolver = createHarnessRuntimeLaunchResolver({
      getManagedLaunchPlan: () => ({ executable: '/managed/codex', argsPrefix: [] }),
    });
    const managedPlan = { executable: '/managed/codex', argsPrefix: [] };
    expect(await resolver.resolve('codex')).toEqual({
      agentKind: 'codex',
      distribution: 'cindy-managed',
      authOwner: 'cindy',
      routeOwner: 'cindy',
      configHomePolicy: 'cindy-isolated',
      launchPlan: managedPlan,
    });

    __testing.persistInspectedTencentHarnessRuntimeProfile('codex', {
      launchPlan: { executable: '/opt/node', argsPrefix: ['/opt/tencent/tcodex'] },
      identity: identity({
        launcherRealpath: '/opt/node',
        launcherSize: 100,
        launcherMtimeMs: 10,
        realpath: '/opt/tencent/tcodex',
        wrapperKind: 'tcodex',
        wrapperVersion: '0.0.16',
        upstreamVersion: '0.144.5',
      }),
      capabilityProfile: { skillsList: true },
    });

    const resolved = await resolver.resolve(
      'codex',
      fakeProbeDeps(
        { '/opt/node': {}, '/opt/tencent/tcodex': {} },
        '@tencent/tcodex 0.0.16\n@openai/codex 0.144.5\n',
      ),
    );
    expect(resolved).toEqual({
      agentKind: 'codex',
      distribution: 'tencent-local',
      authOwner: 'harness',
      routeOwner: 'harness',
      configHomePolicy: 'harness-default',
      launchPlan: { executable: '/opt/node', argsPrefix: ['/opt/tencent/tcodex'] },
      capabilityProfile: { skillsList: true },
      identityChanged: false,
    });
  });

  it('clears cached capabilities through the factory resolver when a saved executable changes', async () => {
    __testing.persistInspectedTencentHarnessRuntimeProfile('claude-code', {
      launchPlan: launchPlan(),
      identity: identity(),
      capabilityProfile: { streamJson: true },
    });
    const resolver = createHarnessRuntimeLaunchResolver({
      getManagedLaunchPlan: () => ({ executable: '/managed/tclaude', argsPrefix: [] }),
    });

    await expect(
      resolver.resolve(
        'claude-code',
        fakeProbeDeps(
          { '/opt/tencent/tclaude': { size: 101, mtimeMs: 11 } },
          '@tencent/tclaude 0.1.6\n@anthropic-ai/claude-code 2.1.251\n',
        ),
      ),
    ).resolves.toEqual({
      agentKind: 'claude-code',
      distribution: 'tencent-local',
      authOwner: 'harness',
      routeOwner: 'harness',
      configHomePolicy: 'harness-default',
      launchPlan: launchPlan(),
      capabilityProfile: {},
      identityChanged: true,
    });
  });

  it('requires a Node-wrapper entry script for tcodex and rejects an arbitrary extra argument', async () => {
    await expect(
      inspectTencentHarnessLaunchPlan(
        'codex',
        { executable: '/opt/node', argsPrefix: ['/opt/tencent/tcodex', '--unsafe'] },
        fakeProbeDeps(
          { '/opt/node': {}, '/opt/tencent/tcodex': {} },
          '@tencent/tcodex 0.0.16\n@openai/codex 0.144.5\n',
        ),
      ),
    ).rejects.toThrow(/one wrapper entry script/i);
  });

  it('rejects a tcodex wrapper when its launcher cannot prove it is Node', async () => {
    const deps = fakeProbeDeps(
      { '/opt/not-node': {}, '/opt/tencent/tcodex': {} },
      '@tencent/tcodex 0.0.16\n@openai/codex 0.144.5\n',
    );
    deps.runVersion = async (_command, args) =>
      args.length === 0
        ? { stdout: 'not-node 1.0.0\n', stderr: '' }
        : { stdout: '@tencent/tcodex 0.0.16\n@openai/codex 0.144.5\n', stderr: '' };

    await expect(
      inspectTencentHarnessLaunchPlan(
        'codex',
        { executable: '/opt/not-node', argsPrefix: ['/opt/tencent/tcodex'] },
        deps,
      ),
    ).rejects.toThrow(/explicit Node executable/i);
  });

  it('rejects a wrapper whose version output does not prove the expected runtime identity', async () => {
    await expect(
      inspectTencentHarnessLaunchPlan(
        'claude-code',
        launchPlan(),
        fakeProbeDeps({ '/opt/tencent/tclaude': {} }, '@tencent/tclaude 0.1.6\n'),
      ),
    ).rejects.toThrow(/upstream/i);
  });
});
