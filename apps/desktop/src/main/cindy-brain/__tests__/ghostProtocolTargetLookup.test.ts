/**
 * cindy-ghost:// 请求的目标复核（#5983）：每个面板资源请求前后各复核一次目标，
 * /wake 也要查一次。用生产里接到协议 handler 的回调 + 真实 GhostManager，
 * 装多个插件，断言稳定注册后的目标请求只读目标实例，不因其他插件做全量扫描；
 * 同时守住实例隔离和失效语义。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { ghostPartition, ghostWebviewEntryPaths, type InstalledGhost } from '../../../shared/ghost.js';
import { installedGhostMutationTargetToken } from '../../../shared/pluginIdentity.js';
import { GhostManager, type GhostManagerOptions } from '../GhostManager.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import { ownerScopedGhostPartitionForInstalledGhost, resolveGhostWebviewPartitionClaim } from '../ghostWebviewPartition.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

type TargetStore = {
  captureTarget(ghostId: string): string | null;
  isTargetCurrent(ghostId: string, expectedTarget: string | null): boolean;
};
type WakeHandler = (ghostId: string) => Promise<{ state: string }>;
type AttachResolver = (partitionClaim: unknown, src: unknown) => { ghost: InstalledGhost } | null;

const TARGET = '_ns__acme__canvas';
const OTHER_PLUGINS = 12;

const mutateSnapshot: NonNullable<GhostManagerOptions['mutateSnapshot']> = async ({ parentDir, ...request }) => {
  await runGhostSnapshotWorkerRequest(request, parentDir);
};

/** Each setup owns its async continuation and drains it before deleting its files (#8991). */
function createProtocolFixture() {
  const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-protocol-target-')));
  const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts'), mutateSnapshot });
  async function packageFor(id: string, withPanel = false): Promise<string> {
    return writeTestCindyPackage(path.join(workDir, `${id}-${Date.now()}-${Math.random()}.cindy`), {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: withPanel ? ['tool', 'panel'] : ['tool'],
      tools: [{ name: 'do_thing', description: 'do' }],
      ...(withPanel ? { panel: { html: 'panel.html' } } : {}),
    }, { 'main.js': '// ok\n', ...(withPanel ? { 'panel.html': '<!doctype html>' } : {}) });
  }

  async function installTarget(): Promise<void> {
    await expect(manager.install(await packageFor('canvas', true), {
      namespace: 'acme', registrySource: 'market', pluginId: 'plugin-canvas',
    })).resolves.toMatchObject({ ghost: { instanceKey: TARGET } });
  }

  const ready = (async () => {
    for (let index = 0; index < OTHER_PLUGINS; index += 1) {
      const id = `other-${index}`;
      await manager.install(await packageFor(id), index % 2 === 0
        ? {}
        : { namespace: 'acme', registrySource: 'market', pluginId: `plugin-${id}` });
    }
    await manager.install(await packageFor('canvas'));
    await installTarget();
    manager.list();
  })();
  // A timed-out beforeEach is still running. Teardown owns this promise even
  // if Vitest has already moved on; a failed setup must still release its files.
  async function cleanup(): Promise<void> {
    await ready.catch(() => {});
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
  return { workDir, manager, ready, cleanup, installTarget, owner: 'owner-a' };
}

type ProtocolFixture = ReturnType<typeof createProtocolFixture>;

const session = { mode: 'cloud' as const, dataOwnerId: 'owner-a', generation: 1 };

function productionCallbacks(
  fixture: ProtocolFixture,
  spawn = vi.fn(async () => ({ ok: true, state: 'running' })),
  libraryRestartRequiredReason: (id: string) => string | null = () => null,
) {
  const callbacks = createGhostProductionCallbacks<{
    store: TargetStore;
    wake: WakeHandler;
    resolveGhostWebviewAttach: AttachResolver;
  }>({
    functions: ['availableGhosts', 'findGhostForInstanceId', 'ghostInstallMutationTargetFor', 'resolveGhostWebviewAttach'],
    callbacks: { store: ['setGhostKvStore'], wake: ['setGhostWakeHandler'] },
  })({
    getGhostManager: () => fixture.manager,
    isAppSessionBoundaryPending: () => false,
    getAppCapabilities: () => ({ canUseCindyAccountServices: true }),
    isGhostAvailableForActiveSession: () => true,
    activeOwnerScopeKey: () => fixture.owner,
    installedGhostMutationTargetToken,
    runtime: { stateOf: () => 'off', spawn },
    getActiveAppSession: () => session,
    resolveGhostWebviewPartitionClaim,
    ownerScopedGhostPartitionForInstalledGhost,
    ghostWebviewEntryPaths,
    GHOST_SCHEME: 'cindy-ghost',
    ensureGhostProtocolRegistered: vi.fn(),
    libraryRestartRequiredReason,
  });
  return { ...callbacks, spawn };
}

describe('cindy-ghost:// target lookup', () => {
  const fixtures = new WeakMap<TestContext, ProtocolFixture>();
  beforeEach(async (context) => {
    const fixture = createProtocolFixture();
    fixtures.set(context, fixture);
    await fixture.ready;
  });

  afterEach(async (context) => {
    const fixture = fixtures.get(context);
    fixtures.delete(context);
    vi.restoreAllMocks();
    await fixture?.cleanup();
  });

  it('rechecks a registered panel target without rescanning the other installed plugins', async (context) => {
    const fixture = fixtures.get(context)!;
    const { manager } = fixture;
    const { store, wake, spawn } = productionCallbacks(fixture);
    const expected = store.captureTarget(TARGET);
    expect(expected).not.toBeNull();
    const list = vi.spyOn(manager, 'list');
    const readdir = vi.spyOn(fs, 'readdirSync');
    // A panel open loads dozens of static files; each request checks its
    // target before it runs and again before it answers.
    for (let request = 0; request < 40; request += 1) {
      expect(store.isTargetCurrent(TARGET, expected)).toBe(true);
      expect(store.isTargetCurrent(TARGET, expected)).toBe(true);
    }
    expect(store.captureTarget(TARGET)).toBe(expected);
    await expect(wake(TARGET)).resolves.toEqual({ state: 'running' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ instanceKey: TARGET }));
    expect(list).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it('rechecks a panel on every click and key press without rescanning the other installed plugins', (context) => {
    const fixture = fixtures.get(context)!;
    const { manager } = fixture;
    const { resolveGhostWebviewAttach } = productionCallbacks(fixture);
    const claim = ghostPartition(TARGET);
    expect(resolveGhostWebviewAttach(claim, 'cindy-ghost://canvas/panel.html')?.ghost.instanceKey).toBe(TARGET);
    const list = vi.spyOn(manager, 'list');
    for (let gesture = 0; gesture < 40; gesture += 1) {
      expect(resolveGhostWebviewAttach(claim, 'cindy-ghost://canvas/panel.html')).not.toBeNull();
    }
    expect(resolveGhostWebviewAttach(claim, 'cindy-ghost://canvas/other.html')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('does not attach a panel the host holds stopped until restart', (context) => {
    const fixture = fixtures.get(context)!;
    const { resolveGhostWebviewAttach } = productionCallbacks(fixture, undefined, (id) => (id === TARGET ? 'restart' : null));
    expect(resolveGhostWebviewAttach(ghostPartition(TARGET), 'cindy-ghost://canvas/panel.html')).toBeNull();
  });

  it('keeps the root and organization instances of the same plugin apart', (context) => {
    const fixture = fixtures.get(context)!;
    const { manager } = fixture;
    const { store } = productionCallbacks(fixture);
    const rootKey = manager.list().find((ghost) => ghost.manifest.id === 'canvas' && ghost.instanceKey !== TARGET)?.instanceKey;
    expect(rootKey).toBeDefined();
    const organization = store.captureTarget(TARGET);
    const root = store.captureTarget(rootKey!);
    expect(root).not.toBeNull();
    expect(root).not.toBe(organization);
    expect(store.isTargetCurrent(rootKey!, organization)).toBe(false);
    expect(store.isTargetCurrent(TARGET, root)).toBe(false);
    // The bare plugin id names two installs, so it opens neither.
    expect(store.captureTarget('canvas')).toBeNull();
  });

  it('rejects an old target after uninstall, reinstall or an account switch, and accepts the current one', async (context) => {
    const fixture = fixtures.get(context)!;
    const { manager, installTarget } = fixture;
    const { store, wake } = productionCallbacks(fixture);
    const before = store.captureTarget(TARGET);
    fixture.owner = 'owner-b';
    expect(store.isTargetCurrent(TARGET, before)).toBe(false);
    fixture.owner = 'owner-a';
    expect(store.isTargetCurrent(TARGET, before)).toBe(true);

    await expect(manager.uninstall('_ns/acme/canvas', { notify: false })).resolves.toEqual({ ok: true });
    expect(store.captureTarget(TARGET)).toBeNull();
    expect(store.isTargetCurrent(TARGET, before)).toBe(false);
    await expect(wake(TARGET)).resolves.toEqual({ state: 'off' });

    await installTarget();
    const after = store.captureTarget(TARGET);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(store.isTargetCurrent(TARGET, before)).toBe(false);
    expect(store.isTargetCurrent(TARGET, after)).toBe(true);
  });

  it('still resolves a bare plugin id through the full list', (context) => {
    const fixture = fixtures.get(context)!;
    const { manager } = fixture;
    const { store } = productionCallbacks(fixture);
    const list = vi.spyOn(manager, 'list');
    expect(store.captureTarget('other-0')).not.toBeNull();
    expect(list).toHaveBeenCalled();
  });
});

// #8991: the original six cases only exercise sequential hooks. This unit
// regression uses real GhostManager installs and controls just one completion.
describe('protocol fixture lifecycle regression (#8991)', () => {
  it('drains an abandoned setup without writing into the next fixture', async () => {
    const install = GhostManager.prototype.install;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const spy = vi.spyOn(GhostManager.prototype, 'install').mockImplementation(async function (this: GhostManager, ...args) {
      const result = await install.apply(this, args);
      if (first) {
        first = false;
        started();
        await held;
      }
      return result;
    });
    const abandoned = createProtocolFixture();
    // Observe a rejection immediately, including when an assertion below fails.
    const abandonedResult = abandoned.ready.then(() => null, (error: unknown) => error);
    let next: ReturnType<typeof createProtocolFixture> | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      // Packaging or the first install can reject before the held completion
      // signal. Propagate that setup error instead of waiting until timeout.
      await Promise.race([pending, abandoned.ready]);
      const abandonedDirectory = abandoned.workDir;
      cleanup = abandoned.cleanup();
      void cleanup.catch(() => {});
      next = createProtocolFixture();
      await next.ready;
      const nextManager = next.manager;
      const nextDirectory = next.workDir;
      expect(nextDirectory).not.toBe(abandonedDirectory);
      expect(fs.existsSync(abandonedDirectory)).toBe(true);
      release();
      expect(await abandonedResult).toBeNull();
      await cleanup;
      expect(fs.existsSync(abandonedDirectory)).toBe(false);
      expect(next.manager).toBe(nextManager);
      expect(next.workDir).toBe(nextDirectory);
      expect(next.manager.findInstalledInstance(TARGET)?.instanceKey).toBe(TARGET);
      expect(next.manager.list()).toHaveLength(OTHER_PLUGINS + 2);
    } finally {
      release();
      try {
        await abandonedResult;
        // Observe an already-started cleanup without awaiting its rejection
        // before attempting the next fixture. Retain every deletion error.
        const results = await Promise.allSettled([
          cleanup ?? abandoned.cleanup(),
          next?.cleanup(),
        ]);
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Protocol fixture cleanup failed');
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('cleans a partially installed fixture after setup rejects', async () => {
    const install = GhostManager.prototype.install;
    const failure = new Error('fixture setup failed after an install');
    const spy = vi.spyOn(GhostManager.prototype, 'install').mockImplementationOnce(async function (this: GhostManager, ...args) {
      await install.apply(this, args);
      throw failure;
    });
    const fixture = createProtocolFixture();
    let cleanup: Promise<void> | undefined;
    try {
      await expect(fixture.ready).rejects.toBe(failure);
      expect(fixture.manager.list()).toHaveLength(1);
      cleanup = fixture.cleanup();
      await cleanup;
      expect(fs.existsSync(fixture.workDir)).toBe(false);
    } finally {
      try {
        await (cleanup ?? fixture.cleanup());
      } finally {
        spy.mockRestore();
      }
    }
  });
});
