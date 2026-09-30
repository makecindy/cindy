import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCindyPersonal,
  personalArtifactPath,
  personalBuildEnvironment,
  personalBuildError,
  runPersonalPackageCommand,
  type PersonalArtifact,
} from '../personalBuild';
import { makeSourceCheckoutPath, makeSourceRoot, makeTaskWorktreePath } from '../sourcePaths';
import type { runSourceGit } from '../sourceGit';
import type { runSourcePnpm } from '../sourcePnpm';
import type { PtySpawnFn } from '../../terminal/ptyFactory';
import * as versionStore from '../versionStore';
import { CindyMakeManager } from '../manager';
import { historyBuildRollback } from '../buildRollback';
import { CindyMakeHistoryStore } from '../historyStore';
vi.mock('../localHistory', () => ({
  MAKE_GIT_IDENTITY: [],
  commitPersonalFiles: async (
    git: (args: string[], cwd: string) => Promise<string>,
    cwd: string,
  ) => ({
    commit: await git(['rev-parse', 'HEAD'], cwd),
    tree: await git(['snapshot-files'], cwd),
  }),
  commitLocalFiles: async (git: (args: string[], cwd: string) => Promise<string>, cwd: string) => ({
    commit: 'f'.repeat(40),
    tree: await git(['snapshot-files'], cwd),
  }),
}));

vi.mock('../sourceContent', () => ({
  snapshotContent: async (git: (args: string[], cwd: string) => Promise<string>, cwd: string) =>
    git(['snapshot-files'], cwd),
  contentRef: async () => undefined,
  populateContent: async () => {},
  applyContent: async (
    git: (args: string[], cwd: string) => Promise<string>,
    cwd: string,
    _before: string,
    _after: string,
    threeWay: boolean,
  ) => {
    if (!threeWay) await git(['apply-files'], cwd);
  },
  taskContentRef: (run: string, kind: string) => 'refs/cindy-make/tasks/' + run + '/' + kind,
}));

const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-personal-unit-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const userData = await temp();
  const source = makeSourceCheckoutPath(userData);
  const workingDir = makeTaskWorktreePath(userData, 'run');
  await mkdir(source, { recursive: true });
  await mkdir(workingDir, { recursive: true });
  await writeFile(path.join(workingDir, 'keep.txt'), 'editing work');
  const task = {
    userData,
    workingDir,
    runId: 'run',
    completionId: 'completion',
    commit: 'b'.repeat(40),
    profile: undefined as versionStore.VersionProfile | undefined,
  };
  let baseline = 'a'.repeat(40);
  let sourceTree = baseline;
  let buildDir = '';
  let locked = false;
  let locks = 0;
  const events: string[] = [];
  const abort = new AbortController();
  const git = vi.fn<typeof runSourceGit>(async (_env, args, cwd) => {
    expect(locked).toBe(true);
    if (args[0] === 'merge-base' && args[2] === 'refs/heads/main') return 'd'.repeat(40);
    if (args[0] === 'worktree' && args[1] === 'add') {
      buildDir = args[3];
      events.push('merge');
    }
    if (args[0] === 'snapshot-files') return cwd === buildDir ? 'e'.repeat(40) : sourceTree;
    if (args[0] === 'rev-parse') {
      if (args[1] === '--abbrev-ref') return 'cindy-personal';
      if (args[1] === '--git-path') return path.join(buildDir, 'MERGE_HEAD');
      return cwd === buildDir ? task.commit : baseline;
    }
    if (args[0] === 'merge' && args[1] === '--ff-only') {
      expect(cwd).toBe(source);
      baseline = args[2];
      sourceTree = 'e'.repeat(40);
      events.push('adopt');
    }
    if (args[0] === 'reset' && args[1] === '--keep') {
      baseline = args[2];
      sourceTree = baseline === 'a'.repeat(40) ? baseline : 'e'.repeat(40);
      events.push('rollback');
    }
    return '';
  });
  const pnpm = vi.fn<typeof runSourcePnpm>(async (_env, args, cwd) => {
    expect(locked).toBe(true);
    expect(cwd).toBe(source);
    expect(sourceTree).toBe('e'.repeat(40));
    events.push(args[0]);
  });
  const verify = vi.fn(async () => {});
  const packageCommand = vi.fn<typeof runPersonalPackageCommand>(async (_node, _args, cwd) => {
    expect(locked).toBe(true);
    expect(cwd).toBe(source);
    expect(sourceTree).toBe('e'.repeat(40));
    events.push('package');
    const artifacts = path.join(
      cwd,
      'apps/desktop/release/artifacts/global/unversioned',
      process.platform + '-' + process.arch,
    );
    await mkdir(artifacts, { recursive: true });
    const name = 'Cindy-Setup.exe';
    await writeFile(path.join(artifacts, name), 'installer bytes');
    await writeFile(
      path.join(artifacts, 'build-info.json'),
      JSON.stringify({
        product: 'cindy-desktop',
        versionless: true,
        version: null,
        commitSha: baseline,
        region: 'global',
        platform: process.platform,
        arch: process.arch,
        files: [
          {
            role: 'installer',
            name,
            sha256: createHash('sha256').update('installer bytes').digest('hex'),
          },
        ],
      }),
    );
  });
  const publish = vi.fn(async (_state: { status: string }) => {});
  const run = (
    withProject: <T>(operation: () => Promise<T>) => Promise<T> = async (operation) => operation(),
    personalOnly = false,
    features?: () => Array<{ runId: string; operationId: string }>,
    rollback?: ReturnType<typeof historyBuildRollback>,
  ) =>
    buildCindyPersonal(
      personalOnly ? { mode: 'personal', userData, completionId: 'history-build' } : task,
      process.execPath,
      {},
      'global',
      abort.signal,
      publish,
      () => {},
      async (operation) =>
        withProject(async () => {
          expect(locked).toBe(false);
          locked = true;
          locks++;
          try {
            return await operation();
          } finally {
            locked = false;
          }
        }),
      { git, pnpm, verify, packageCommand, features, ...rollback },
    );
  return {
    userData,
    source,
    task,
    git,
    pnpm,
    verify,
    packageCommand,
    publish,
    run,
    events,
    abort,
    baseline: () => baseline,
    sourceTree: () => sourceTree,
    integrate: () => {
      baseline = 'f'.repeat(40);
      sourceTree = 'e'.repeat(40);
    },
    locked: () => locked,
    locks: () => locks,
    advance: () => {
      baseline = 'c'.repeat(40);
    },
    buildDir: () => buildDir,
  };
}

describe('personal source integration and packaging', () => {
  it('publishes live check and package output under the correct stage and clears it when advancing', async () => {
    const h = await fixture();
    const originalCheck = h.pnpm.getMockImplementation()!;
    h.pnpm.mockImplementation(async (...args) => {
      await originalCheck(...args);
      args[5]?.('Running ' + args[1][0]);
    });
    const originalPackage = h.packageCommand.getMockImplementation()!;
    h.packageCommand.mockImplementation(async (...args) => {
      args[6]?.('Building installer');
      await originalPackage(...args);
    });
    await h.run();
    const states = h.publish.mock.calls.map(([state]) => state);
    expect(states).toEqual(
      expect.arrayContaining([
        { status: 'checking', checkStep: 'dependencies', outputLine: 'Running install' },
        { status: 'checking', checkStep: 'tests', outputLine: 'Running test:unit:related' },
        { status: 'checking', checkStep: 'types', outputLine: 'Running --recursive' },
        { status: 'packaging', outputLine: 'Building installer' },
      ]),
    );
    expect(states.at(-1)).toEqual({ status: 'publishing' });
  });
  it('preserves the specific check error after rolling back a failed build', async () => {
    const h = await fixture();
    h.pnpm.mockRejectedValueOnce(
      Object.assign(new Error('truncated private pnpm tail'), {
        diagnostic: {
          kind: 'process',
          exitCode: 1,
          message: 'ERR_PNPM_FETCH_404: dependency unavailable; token=fake-secret',
        },
      }),
    );
    await expect(h.run()).rejects.toMatchObject({
      code: 'checksFailed',
      diagnostic: {
        kind: 'process',
        exitCode: 1,
        message: 'ERR_PNPM_FETCH_404: dependency unavailable; token=[REDACTED]',
      },
    });
    expect(h.baseline()).toBe('a'.repeat(40));
  });
  it.each(['before-start', 'checks', 'package'] as const)(
    'cleans the runtime integration and its receipt when generation fails at %s',
    async (stage) => {
      const h = await fixture();
      h.integrate();
      const store = new CindyMakeHistoryStore(path.join(h.userData, 'history'));
      store.seed({
        runId: 'run',
        sessionId: 'session',
        title: 'Feature',
        request: 'Feature',
        createdAt: 1,
        updatedAt: 1,
      });
      store.receipt('run', {
        id: 'pending-integration',
        action: 'integrate',
        at: 2,
        baselineCommit: 'a'.repeat(40),
        beforeTree: 'a'.repeat(40),
        commit: 'f'.repeat(40),
        tree: 'e'.repeat(40),
        taskTree: 'e'.repeat(40),
      });
      if (stage === 'before-start') h.abort.abort();
      if (stage === 'checks') h.pnpm.mockRejectedValueOnce(new Error('checks failed'));
      if (stage === 'package')
        h.packageCommand.mockRejectedValueOnce(personalBuildError('buildFailed'));
      await expect(
        h.run(undefined, true, undefined, historyBuildRollback(store, h.source)),
      ).rejects.toBeDefined();
      expect(h.baseline()).toBe('a'.repeat(40));
      expect(h.sourceTree()).toBe('a'.repeat(40));
      expect(store.read('run')?.receipts).toEqual([]);
      expect(store.readBuildRollback()).toEqual([]);
      expect(await readFile(path.join(h.task.workingDir, 'keep.txt'), 'utf8')).toBe('editing work');
    },
  );
  it('pins migration checks to inherited official history, even when origin/main is newer', async () => {
    const h = await fixture();
    await h.run();
    expect(h.packageCommand.mock.calls[0][3].XDT_MIGRATION_BASE_REF).toBe('d'.repeat(40));
    expect(h.packageCommand.mock.calls[0][3].XDT_MIGRATION_BASE_REF).not.toBe(h.baseline());
    const original = h.git.getMockImplementation()!;
    h.git.mockImplementation(async (...args) =>
      args[1][0] === 'merge-base' && args[1][2] === 'refs/heads/main' ? '' : original(...args),
    );
    h.packageCommand.mockClear();
    await expect(h.run()).rejects.toMatchObject({ code: 'changed' });
    expect(h.packageCommand).not.toHaveBeenCalled();
  });
  it('builds a tag checkout without local main using only inherited origin history', async () => {
    const h = await fixture();
    const original = h.git.getMockImplementation()!;
    h.git.mockImplementation(async (...args) => {
      if (args[1][0] === 'show-ref')
        throw Object.assign(new Error('local main is absent'), { exitCode: 1 });
      if (args[1][0] === 'merge-base' && args[1][2] === 'refs/remotes/origin/main')
        return 'd'.repeat(40);
      return original(...args);
    });
    await h.run();
    expect(h.packageCommand.mock.calls[0][3].XDT_MIGRATION_BASE_REF).toBe('d'.repeat(40));
    expect(h.packageCommand.mock.calls[0][3].XDT_MIGRATION_BASE_REF).not.toBe(h.baseline());
  });
  it('does not treat an unreadable local reference as a missing branch', async () => {
    const h = await fixture();
    const original = h.git.getMockImplementation()!;
    h.git.mockImplementation(async (...args) => {
      if (args[1][0] === 'show-ref')
        throw Object.assign(new Error('reference database unavailable'), { exitCode: 128 });
      return original(...args);
    });
    await expect(h.run()).rejects.toMatchObject({ exitCode: 128 });
    expect(h.packageCommand).not.toHaveBeenCalled();
    expect(h.baseline()).toBe('a'.repeat(40));
  });
  it('reports each checking step before starting its command and stops at a failed test', async () => {
    const h = await fixture();
    const observed: unknown[] = [];
    h.pnpm.mockImplementation(async (_env, args) => {
      observed.push(h.publish.mock.calls.at(-1)?.[0]);
      if (args[0] === 'test:unit:related') throw new Error('private test failure output');
    });
    await expect(h.run()).rejects.toMatchObject({ code: 'checksFailed' });
    expect(observed).toEqual([
      expect.objectContaining({ status: 'checking', checkStep: 'dependencies' }),
      expect.objectContaining({ status: 'checking', checkStep: 'tests' }),
    ]);
    expect(h.packageCommand).not.toHaveBeenCalled();
    observed.length = 0;
    h.pnpm.mockImplementation(async () => {
      observed.push(h.publish.mock.calls.at(-1)?.[0]);
    });
    await h.run();
    expect(observed).toEqual([
      expect.objectContaining({ status: 'checking', checkStep: 'dependencies' }),
      expect.objectContaining({ status: 'checking', checkStep: 'tests' }),
      expect.objectContaining({ status: 'checking', checkStep: 'types' }),
    ]);
  });
  it('packages already integrated source after its editing directory is gone, without another merge or a synthetic task', async () => {
    const h = await fixture();
    const first = await h.run();
    await rm(h.task.workingDir, { recursive: true, force: true });
    h.verify.mockClear();
    h.git.mockClear();
    h.events.length = 0;
    const features = vi.fn(() => {
      expect(h.locked()).toBe(true);
      return [{ runId: 'run', operationId: 'integrated' }];
    });
    const built = await h.run(undefined, true, features);
    expect(built.commit).toBe(first.commit);
    expect(built.includedFeatures).toEqual([{ runId: 'run', operationId: 'integrated' }]);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.events).toEqual(['install', 'test:unit:related', '--recursive', 'package']);
    expect(
      h.git.mock.calls.some(
        ([, args]) => args[0] === 'merge' || (args[0] === 'worktree' && args[1] === 'add'),
      ),
    ).toBe(false);
    expect(features).toHaveBeenCalledOnce();
  });
  it('adopts first, then checks and packages in personal under one lock, keeping both checkouts', async () => {
    const h = await fixture();
    const artifact = await h.run();
    expect(h.events).toEqual([
      'merge',
      'adopt',
      'install',
      'test:unit:related',
      '--recursive',
      'package',
    ]);
    expect(h.pnpm.mock.calls[2][1]).toEqual([
      '--recursive',
      '--workspace-concurrency=1',
      '--if-present',
      'typecheck',
    ]);
    expect(h.verify).toHaveBeenCalledTimes(3);
    expect(h.locks()).toBe(1);
    expect(h.locked()).toBe(false);
    const args = h.packageCommand.mock.calls[0][1];
    expect(args).toEqual([
      path.join(h.source, 'apps/desktop/scripts/package-desktop.mjs'),
      '--platform',
      process.platform,
      '--arch',
      process.arch,
      '--region',
      'global',
      '--no-sign',
    ]);
    expect(h.baseline()).toBe('f'.repeat(40));
    expect(
      await readFile(await personalArtifactPath(h.userData, 'completion', artifact), 'utf8'),
    ).toBe('installer bytes');
    expect(await readFile(path.join(h.task.workingDir, 'keep.txt'), 'utf8')).toBe('editing work');
    await expect(access(h.buildDir())).rejects.toThrow();
    await expect(
      access(
        path.join(
          h.source,
          'apps/desktop/release/artifacts/global/unversioned',
          process.platform + '-' + process.arch,
        ),
      ),
    ).rejects.toThrow();
    await expect(access(h.source)).resolves.toBeUndefined();
    expect(
      h.git.mock.calls.some(
        ([, args]) =>
          (args.includes(h.task.workingDir) || args.includes(h.source)) && args.includes('remove'),
      ),
    ).toBe(false);
  });

  it.each([
    'checks',
    'package',
    'checksum',
    'baseline',
    'task',
    'cancel',
    'publishCancel',
  ] as const)(
    'restores unpublished integrations, preserves task files and publishes no artifact on %s failure',
    async (failure) => {
      const h = await fixture();
      const original = h.packageCommand.getMockImplementation()!;
      if (failure === 'checks') h.pnpm.mockRejectedValueOnce(new Error('test failed'));
      if (failure === 'package')
        h.packageCommand.mockRejectedValueOnce(personalBuildError('buildFailed'));
      if (failure === 'task')
        h.verify
          .mockResolvedValueOnce()
          .mockResolvedValueOnce()
          .mockRejectedValueOnce(personalBuildError('changed'));
      if (failure === 'publishCancel')
        h.publish.mockImplementation(async (state) => {
          if (state.status === 'publishing') h.abort.abort();
        });
      if (['checksum', 'baseline', 'cancel'].includes(failure))
        h.packageCommand.mockImplementation(async (...args) => {
          await original(...args);
          if (failure === 'checksum') {
            const installer = path.join(
              args[2],
              'apps/desktop/release/artifacts/global/unversioned',
              process.platform + '-' + process.arch,
              'Cindy-Setup.exe',
            );
            await writeFile(installer, 'modified after packaging');
          }
          if (failure === 'baseline') h.advance();
          if (failure === 'cancel') h.abort.abort();
        });
      await expect(h.run()).rejects.toBeDefined();
      expect(h.events).toContain('adopt');
      expect(h.sourceTree()).toBe((failure === 'baseline' ? 'e' : 'a').repeat(40));
      expect(h.baseline()).toBe((failure === 'baseline' ? 'c' : 'a').repeat(40));
      expect(h.events.includes('rollback')).toBe(failure !== 'baseline');
      expect(await readFile(path.join(h.task.workingDir, 'keep.txt'), 'utf8')).toBe('editing work');
      await expect(access(h.buildDir())).rejects.toThrow();
      await expect(access(h.source)).resolves.toBeUndefined();
      expect(h.locked()).toBe(false);
      expect(
        await readdir(path.join(makeSourceRoot(h.userData), 'packages')).catch(() => []),
      ).toEqual([]);
    },
  );

  it('rolls back an adoption cancelled mid-flight before checks or packaging', async () => {
    const h = await fixture();
    const original = h.git.getMockImplementation()!;
    h.git.mockImplementation(async (...args) => {
      if (args[1][0] === 'merge' && args[1][1] === '--ff-only') {
        h.abort.abort();
        expect(args[3].aborted).toBe(false);
      }
      return original(...args);
    });
    await expect(h.run()).rejects.toBeDefined();
    expect(h.baseline()).toBe('a'.repeat(40));
    expect(h.sourceTree()).toBe('a'.repeat(40));
    expect(
      h.git.mock.calls.some(
        ([, args]) => args[0] === 'update-ref' && args[1].endsWith('/integrated'),
      ),
    ).toBe(true);
    expect(h.pnpm).not.toHaveBeenCalled();
    expect(h.packageCommand).not.toHaveBeenCalled();
    await expect(access(h.source)).resolves.toBeUndefined();
    await expect(access(h.task.workingDir)).resolves.toBeUndefined();
    await expect(access(h.buildDir())).rejects.toThrow();
  });

  it('does not reuse an old manifest when a later package command produces nothing', async () => {
    const h = await fixture();
    const previous = await h.run();
    h.packageCommand.mockResolvedValueOnce();
    await expect(h.run()).rejects.toThrow();
    expect(await readdir(path.join(makeSourceRoot(h.userData), 'packages'))).toEqual([
      previous.artifactDirectory,
    ]);
    await expect(personalArtifactPath(h.userData, 'completion', previous)).resolves.toBeDefined();
  });

  it.each([false, true])(
    'retains the app from personal and cleans unpublished copies (cancel: %s)',
    async (cancel) => {
      const h = await fixture();
      h.task.profile = { userData: h.userData, appName: 'Cindy', region: 'global', passive: false };
      const id = '11111111-1111-4111-8111-111111111111';
      const retainedDirectory = versionStore.versionDirectory(h.userData, id);
      const packaged = path.join(
        h.source,
        'apps',
        'desktop',
        'out',
        'Cindy-' + process.platform + '-' + process.arch,
      );
      vi.spyOn(versionStore, 'retainPersonalVersion').mockImplementation(async (input) => {
        expect(h.locked()).toBe(true);
        expect(input.sourceDirectory).toBe(
          process.platform === 'darwin' ? path.join(packaged, 'Cindy.app') : packaged,
        );
        await mkdir(retainedDirectory, { recursive: true });
        await writeFile(path.join(retainedDirectory, 'pending.txt'), 'retained app');
        if (cancel) h.abort.abort();
        return id;
      });
      const publishVersion = vi
        .spyOn(versionStore, 'publishPersonalVersion')
        .mockImplementation(() => {
          expect(h.locked()).toBe(true);
        });
      if (cancel) {
        await expect(h.run()).rejects.toBeDefined();
        expect(publishVersion).not.toHaveBeenCalled();
        await expect(access(retainedDirectory)).rejects.toThrow();
        expect(await readdir(path.join(makeSourceRoot(h.userData), 'packages'))).toEqual([]);
      } else {
        await expect(h.run()).resolves.toMatchObject({ versionId: id });
        expect(publishVersion).toHaveBeenCalledWith(h.userData, id);
        await expect(access(retainedDirectory)).resolves.toBeUndefined();
      }
      expect(h.sourceTree()).toBe((cancel ? 'a' : 'e').repeat(40));
      await expect(access(h.source)).resolves.toBeUndefined();
      await expect(access(h.task.workingDir)).resolves.toBeUndefined();
    },
  );

  it('queues other source operations until packaging and artifact retention have finished', async () => {
    const h = await fixture();
    const manager = new CindyMakeManager();
    const root = makeSourceRoot(h.userData);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let packaging!: () => void;
    const entered = new Promise<void>((resolve) => {
      packaging = resolve;
    });
    const original = h.packageCommand.getMockImplementation()!;
    h.packageCommand.mockImplementation(async (...args) => {
      packaging();
      await gate;
      await original(...args);
    });
    const run = h.run((operation) => manager.withProject(root, operation));
    await entered;
    const update = vi.fn(async () => {
      expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'publishing' }));
      expect(h.locked()).toBe(false);
      await expect(access(h.buildDir())).rejects.toThrow();
    });
    const pending = manager.withProject(root, update);
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    release();
    await run;
    await pending;
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not apply files when the task or personal baseline changes during merge preparation', async () => {
    for (const changed of ['task', 'personal']) {
      const h = await fixture();
      if (changed === 'task')
        h.verify.mockResolvedValueOnce().mockRejectedValueOnce(personalBuildError('changed'));
      else {
        const original = h.git.getMockImplementation()!;
        h.git.mockImplementation(async (...args) => {
          const result = await original(...args);
          if (args[1][0] === 'worktree' && args[1][1] === 'add') h.advance();
          return result;
        });
      }
      await expect(h.run()).rejects.toMatchObject({
        code: changed === 'task' ? 'changed' : 'baselineChanged',
      });
      expect(h.events).not.toContain('adopt');
      expect(h.pnpm).not.toHaveBeenCalled();
      expect(h.packageCommand).not.toHaveBeenCalled();
      await expect(access(h.source)).resolves.toBeUndefined();
      await expect(access(h.task.workingDir)).resolves.toBeUndefined();
    }
  });
});

describe('recorded installer access', () => {
  it('rejects other completions, traversal, changed content and redirected parent directories', async () => {
    const h = await fixture();
    const artifact = await h.run();
    await expect(personalArtifactPath(h.userData, 'other', artifact)).rejects.toThrow();
    await expect(
      personalArtifactPath(h.userData, 'completion', {
        ...artifact,
        artifactName: '../outside.exe',
      }),
    ).rejects.toThrow();
    await expect(
      personalArtifactPath(h.userData, 'completion', {
        ...artifact,
        artifactDirectory: 'completion-/../elsewhere',
      }),
    ).rejects.toThrow();
    const file = await personalArtifactPath(h.userData, 'completion', artifact);
    await writeFile(file, 'changed');
    await expect(personalArtifactPath(h.userData, 'completion', artifact)).rejects.toThrow();
    const outside = path.join(h.userData, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, artifact.artifactName), 'installer bytes');
    const linked: PersonalArtifact = { ...artifact, artifactDirectory: 'completion-linked' };
    await symlink(
      outside,
      path.join(makeSourceRoot(h.userData), 'packages', linked.artifactDirectory),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(personalArtifactPath(h.userData, 'completion', linked)).rejects.toThrow();
    expect(await readFile(path.join(outside, artifact.artifactName), 'utf8')).toBe(
      'installer bytes',
    );
  });
});

describe('packaging process', () => {
  function processFixture() {
    let onExit!: (event: { exitCode: number }) => void;
    const child = {
      onData: vi.fn(),
      onExit: vi.fn((callback) => {
        onExit = callback;
      }),
      kill: vi.fn(() => onExit({ exitCode: 1 })),
    };
    const spawn = vi.fn(() => child) as unknown as PtySpawnFn;
    const abort = new AbortController();
    const run = (extraEnv: NodeJS.ProcessEnv = {}, onOutput?: (line: string) => void) =>
      runPersonalPackageCommand(
        process.execPath,
        ['package.js'],
        os.tmpdir(),
        {
          PATH: path.dirname(process.execPath),
          CINDY_SANDBOX: 'host',
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: '--require private-hook',
          OPENAI_API_KEY: 'secret',
          SystemDrive: 'C:',
          ...extraEnv,
        },
        abort.signal,
        spawn,
        onOutput,
      );
    return { child, spawn, abort, run, exit: (exitCode: number) => onExit({ exitCode }) };
  }
  it('uses a clean environment and only accepts a successful process exit', async () => {
    const h = processFixture();
    const run = h.run();
    expect(vi.mocked(h.spawn).mock.calls[0][2].env).not.toHaveProperty('OPENAI_API_KEY');
    expect(vi.mocked(h.spawn).mock.calls[0][2].env).not.toHaveProperty('NODE_OPTIONS');
    expect(vi.mocked(h.spawn).mock.calls[0][2].env).not.toHaveProperty('CINDY_SANDBOX');
    expect(vi.mocked(h.spawn).mock.calls[0][2].env?.SystemDrive).toBe('C:');
    h.exit(0);
    await expect(run).resolves.toBeUndefined();
  });
  it('streams scrubbed packaging output and flushes the final line on exit', async () => {
    const h = processFixture();
    const output = vi.fn();
    const run = h.run({}, output);
    const emit = h.child.onData.mock.calls[0][0];
    emit('\u001b[32mBuilding installer\u001b[0m\r\n');
    emit('Signing token=not-a-');
    emit('real-secret\r\nFinished');
    h.exit(0);
    await run;
    expect(output.mock.calls.flat()).toEqual([
      'Building installer',
      'Signing token=[REDACTED]',
      'Finished',
    ]);
  });
  it('forwards only a pinned migration commit through the clean package environment', async () => {
    const h = processFixture();
    const run = h.run({ XDT_MIGRATION_BASE_REF: 'd'.repeat(40) });
    expect(vi.mocked(h.spawn).mock.calls[0][2].env?.XDT_MIGRATION_BASE_REF).toBe('d'.repeat(40));
    h.exit(0);
    await run;
    const invalid = processFixture();
    expect(() => invalid.run({ XDT_MIGRATION_BASE_REF: 'HEAD' })).toThrow('changed');
    expect(invalid.spawn).not.toHaveBeenCalled();
  });
  it('returns the captured fatal error instead of dropping package output', async () => {
    const h = processFixture();
    const result = expect(h.run()).rejects.toMatchObject({
      code: 'buildFailed',
      diagnostic: {
        kind: 'outOfMemory',
        exitCode: 134,
        message: 'FATAL ERROR: Allocation failed - JavaScript heap out of memory',
      },
    });
    h.child.onData.mock.calls[0][0](
      'FATAL ERROR: Allocation failed - JavaScript heap out of memory\r\n',
    );
    h.exit(134);
    await result;
  });
  it('keeps launch failures readable without exposing the command path', async () => {
    const h = processFixture();
    vi.mocked(h.spawn).mockImplementation(() => {
      throw new Error('ENOENT: missing C:/private/node.exe');
    });
    await expect(h.run()).rejects.toMatchObject({
      code: 'buildFailed',
      diagnostic: { kind: 'process', message: 'ENOENT: missing <path>' },
    });
  });
  it('cancels the owned process and bounds a hung package build', async () => {
    vi.useFakeTimers();
    const h = processFixture();
    const result = expect(h.run()).rejects.toMatchObject({ code: 'interrupted' });
    h.abort.abort();
    await result;
    expect(h.child.kill).toHaveBeenCalledOnce();
    const hung = processFixture();
    const timeout = expect(hung.run()).rejects.toMatchObject({
      code: 'buildFailed',
      diagnostic: { kind: 'timeout' },
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await timeout;
    expect(hung.child.kill).toHaveBeenCalledOnce();
  });
  it('finds Git Bash before Windows shell aliases and retains the selected build tools', async () => {
    const root = await temp();
    const bin = path.join(root, 'Git', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'bash.exe'), 'fixture');
    const env = await personalBuildEnvironment(
      { PATH: bin, PYTHON: '/selected/python', NODE_OPTIONS: 'private' },
      path.join(root, 'Git/cmd/git.exe'),
    );
    expect(env.PYTHON).toBe('/selected/python');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    if (process.platform === 'win32')
      expect(env.PATH?.split(path.delimiter)[0]).toBe(bin.replace(/\\/g, '/'));
  });
});
