import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as tarCreate } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCindyMakeWorktree,
  installCindyMakeWorktree,
  isCindyMakeWorktreePath,
  prepareCindyMakeWorkspace,
} from '../taskWorkspace';

vi.mock('../sourceContent', () => ({
  contentRef: vi.fn(async () => undefined),
  snapshotContent: vi.fn(async () => 'f'.repeat(40)),
  applyContent: vi.fn(async () => {}),
  taskContentRef: (run: string) => 'refs/cindy-make/tasks/' + run + '/base',
}));

describe('prepareCindyMakeWorkspace', () => {
  let userData: string;
  beforeEach(async () => {
    userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-workspace-'));
    await mkdir(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it('branches a new worktree off the personal baseline and installs dependencies', async () => {
    const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[]) => {
      if (args[0] === 'branch' && args[1] === '--show-current') return 'cindy-personal';
      if (args[0] === 'branch' && args[2] === 'cindy-personal') return '  cindy-personal\n';
      if (args[0] === 'branch') return '';
      if (args[0] === 'rev-parse') return 'abcdef1234567\n';
      if (args[0] === 'worktree' || args[0] === 'update-ref') return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    const phases: string[] = [];
    const workspace = await prepareCindyMakeWorkspace(
      userData,
      'run-1',
      new AbortController().signal,
      { processEnvironment: { PATH: '' }, git, pnpm },
      (phase) => phases.push(phase),
    );
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
    expect(workspace).toEqual({
      path: worktreePath,
      branch: 'cindy-make/run-1',
      baseCommit: 'abcdef1234567',
    });
    expect(git).toHaveBeenCalledWith(
      expect.anything(),
      ['worktree', 'add', '-b', 'cindy-make/run-1', worktreePath, 'cindy-personal'],
      path.join(userData, 'cindy-make', 'source'),
      expect.anything(),
    );
    expect(pnpm).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--frozen-lockfile', '--prefer-offline', '--prod=false'],
      worktreePath,
      expect.anything(),
    );
    expect(phases).toEqual(['checking', 'creating', 'installing']);
  });

  /** Windows without Developer Mode cannot create symlinks; Git stores plain files there. */
  const linkIfPossible = async (target: string, link: string): Promise<boolean> => {
    try {
      await symlink(target, link, 'dir');
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') return false;
      throw error;
    }
  };

  const withManifest = async (runId: string): Promise<string> => {
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', runId);
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, 'package.json'), '{"name":"app","version":"1.0.0"}');
    return worktreePath;
  };

  const installUnverified = (
    runId: string,
    worktreePath: string,
    deps: Parameters<typeof installCindyMakeWorktree>[3],
  ) =>
    installCindyMakeWorktree(
      userData,
      { path: worktreePath, branch: `cindy-make/${runId}`, baseCommit: 'b'.repeat(40) },
      new AbortController().signal,
      deps,
      undefined,
      undefined,
      { ignoreScripts: true },
    );

  it('runs no lifecycle scripts and no pnpm hooks for unverified synced content', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-9');
    await writeFile(
      path.join(worktreePath, '.npmrc'),
      'node-linker=hoisted\nfrozen-lockfile=true\nengine-strict=true\n',
    );
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
    );
    await installUnverified('run-9', worktreePath, {
      processEnvironment: { PATH: '', npm_config_registry: 'http://attacker.invalid' },
      pnpm,
    });
    expect(pnpm).toHaveBeenCalledWith(
      // No `npm_config_*` setting of the content's own can turn the guards back on;
      // pnpm's write roots stay inside the worktree whatever `.npmrc` says; and the
      // user's npm credentials are never loaded for this install.
      {
        PATH: '',
        npm_config_userconfig: os.devNull,
        npm_config_globalconfig: os.devNull,
        COREPACK_ENV_FILE: '0',
        COREPACK_ENABLE_PROJECT_SPEC: '0',
        COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: '0',
      },
      [
        'install',
        '--frozen-lockfile',
        '--prefer-offline',
        '--prod=false',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.modules-dir=node_modules',
        '--config.virtual-store-dir=node_modules/.pnpm',
        '--config.store-dir=node_modules/.cindy-make-store',
        '--config.strict-ssl=true',
      ],
      worktreePath,
      expect.anything(),
    );
  });

  it('keeps inherited secrets out of an unverified install environment', async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const pnpm = vi.fn(async (env: NodeJS.ProcessEnv) => {
      seen = env;
    });
    const worktreePath = await withManifest('run-12');
    await installUnverified('run-12', worktreePath, {
      processEnvironment: {
        PATH: '/tools',
        SystemRoot: 'C:\\Windows',
        HOME: '/home/me',
        npm_config_python: '/tools/python',
        npm_config_manage_package_manager_versions: 'false',
        // How Cindy was launched must not reach a content `.npmrc`: its `${VAR}`
        // expansion would send these to a registry the content chooses.
        NPM_TOKEN: 'gho_secret-token',
        GITHUB_TOKEN: 'ghp_secret-token',
        AWS_SECRET_ACCESS_KEY: 'aws_secret-key',
        HTTP_PROXY: 'http://user:pass@proxy.invalid',
        // Even under an allowlisted prefix, a credential stays out; the harmless
        // Corepack setting next to it is forwarded.
        COREPACK_NPM_TOKEN: 'corepack_secret-token',
        COREPACK_NPM_PASSWORD: 'corepack_secret-password',
        COREPACK_ENABLE: '0',
        // The content must not configure Corepack itself: its project env and
        // `packageManager` spec would run before pnpm's guards. Hostile values
        // from the parent environment lose to the pins.
        COREPACK_ENV_FILE: '/attacker/.corepack.env',
        corepack_enable_project_spec: '1',
        COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: '1',
        // Product secrets under real app prefixes are not generalized in either:
        // `XDT_ELEVENLABS_API_KEY` is a working credential of the app's own.
        XDT_ELEVENLABS_API_KEY: 'eleven_secret-key',
        CINDY_CODEX_API_KEY: 'codex_secret-key',
      },
      pnpm,
    });
    expect(seen).toEqual({
      PATH: '/tools',
      SystemRoot: 'C:\\Windows',
      HOME: '/home/me',
      npm_config_python: '/tools/python',
      npm_config_manage_package_manager_versions: 'false',
      COREPACK_ENABLE: '0',
      npm_config_userconfig: os.devNull,
      npm_config_globalconfig: os.devNull,
      COREPACK_ENV_FILE: '0',
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: '0',
    });
    // No differently-cased twin of a pinned key survives (Windows env is
    // case-insensitive and would keep whichever it met first).
    expect(
      Object.keys(seen!)
        .filter((key) => /^corepack_/i.test(key))
        .sort(),
    ).toEqual([
      'COREPACK_ENABLE',
      'COREPACK_ENABLE_PROJECT_SPEC',
      'COREPACK_ENABLE_UNSAFE_CUSTOM_URLS',
      'COREPACK_ENV_FILE',
    ]);
  });

  it('refuses unverified content whose config file is a symlink', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-13');
    await writeFile(path.join(userData, 'evil-workspace.yaml'), 'configDependencies: {"x": "1"}\n');
    // The link is read by pnpm but skipped by a scan that only checks plain files.
    if (
      !(await linkIfPossible(
        path.join(userData, 'evil-workspace.yaml'),
        path.join(worktreePath, 'pnpm-workspace.yaml'),
      ))
    )
      return;
    await expect(
      installUnverified('run-13', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content with a dependency that escapes the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-14');
    await writeFile(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'private-data': 'link:../private', innocuous: '1.0.0' },
      }),
    );
    // A frozen lockfile can name a path dependency; pnpm would symlink the
    // outside directory into the worktree at install time.
    await expect(
      installUnverified('run-14', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content whose pnpm overrides escape the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-18');
    // `pnpm.overrides` values become installed dependency specs: a frozen
    // lockfile honors them verbatim and links the outside directory in.
    await writeFile(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        pnpm: { overrides: { 'private-data': 'link:../private' } },
      }),
    );
    await expect(
      installUnverified('run-18', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    // The same settings live in `pnpm-workspace.yaml` and nested override
    // selectors; a patch path outside the worktree is refused just the same.
    await writeFile(
      path.join(worktreePath, 'package.json'),
      '{"name":"app","version":"1.0.0"}',
    );
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\noverrides:\n  foo:\n    ".": "file:../../private"\n',
    );
    await expect(
      installUnverified('run-18', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    await writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    await writeFile(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        pnpm: { patchedDependencies: { 'foo@1.0.0': '../outside.patch' } },
      }),
    );
    await expect(
      installUnverified('run-18', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content with a traversal dependency name', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-19');
    // pnpm joins each installed name under `node_modules`: a traversal name
    // reaches outside the worktree whatever the write roots are, letting the
    // install replace an occupied outside directory with a link to the payload.
    await writeFile(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { '../../../../../autostart': 'link:./payload' },
      }),
    );
    await expect(
      installUnverified('run-19', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    // Override keys and package extension names travel the same join.
    await writeFile(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        pnpm: { packageExtensions: { '../escape@1': { dependencies: { safe: '1.0.0' } } } },
      }),
    );
    await expect(
      installUnverified('run-19', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses when an installed link leaves the worktree', async () => {
    const worktreePath = await withManifest('run-20');
    // The pre-install scan cannot see into the write roots the install fills:
    // whatever it linked is checked again before the content is handed on.
    const pnpm = vi.fn(async () => {
      await mkdir(path.join(worktreePath, 'node_modules'), { recursive: true });
      if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, 'node_modules', 'private-data'))))
        throw new Error('symlink unavailable');
    });
    await expect(
      installUnverified('run-20', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).toHaveBeenCalledOnce();
  });

  it('refuses unverified content whose lockfile dependency names traverse out', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-22');
    // The frozen lockfile resolves the whole transitive graph pnpm installs:
    // every dependency name in it is joined under the write roots, whatever
    // manifest check saw the package metadata it came from.
    await writeFile(
      path.join(worktreePath, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      evil:',
        '        specifier: file:./evil.tgz',
        '        version: file:evil.tgz',
        'snapshots:',
        "  'file:evil.tgz':",
        '    dependencies:',
        "      '../../../../../../autostart': 1.0.0",
        '',
      ].join('\n'),
    );
    await expect(
      installUnverified('run-22', worktreePath, { processEnvironment: {}, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content whose file dependency archive names traverse out', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-23');
    // pnpm installs a `file:` dependency as a package out of the archive: the
    // names inside its manifest are joined under the write roots like any other,
    // and no walk of the tree sees into the archive.
    const stage = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-archive-'));
    try {
      await mkdir(path.join(stage, 'package'), { recursive: true });
      await writeFile(
        path.join(stage, 'package', 'package.json'),
        JSON.stringify({
          name: 'evil',
          version: '1.0.0',
          dependencies: { '../../../../../autostart': 'link:./payload' },
        }),
      );
      await tarCreate(
        { gzip: true, file: path.join(worktreePath, 'evil.tgz'), cwd: stage },
        ['package'],
      );
      await writeFile(
        path.join(worktreePath, 'package.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: { evil: 'file:./evil.tgz' },
        }),
      );
      await expect(
        installUnverified('run-23', worktreePath, { processEnvironment: {}, pnpm }),
      ).rejects.toMatchObject({ code: 'gitFailed' });
      expect(pnpm).not.toHaveBeenCalled();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it('installs unverified content whose lockfile and archive metadata are benign', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-25');
    // The monorepo's own frozen lockfile keeps installing: every real importer
    // key, workspace link, override pattern and patched dependency must pass.
    const lockfile = await readFile(
      fileURLToPath(new URL('../../../../../../pnpm-lock.yaml', import.meta.url)),
      'utf8',
    ).catch(() => undefined);
    if (lockfile) await writeFile(path.join(worktreePath, 'pnpm-lock.yaml'), lockfile);
    const stage = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-archive-'));
    try {
      await mkdir(path.join(stage, 'package'), { recursive: true });
      await writeFile(
        path.join(stage, 'package', 'package.json'),
        JSON.stringify({
          name: 'good',
          version: '1.0.0',
          dependencies: { innocuous: '1.0.0' },
        }),
      );
      await tarCreate(
        { gzip: true, file: path.join(worktreePath, 'good.tgz'), cwd: stage },
        ['package'],
      );
      await writeFile(
        path.join(worktreePath, 'package.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: { good: 'file:./good.tgz' },
        }),
      );
      await installUnverified('run-25', worktreePath, { processEnvironment: {}, pnpm });
      expect(pnpm).toHaveBeenCalledOnce();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it('installs unverified content whose overrides and links stay in the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-21');
    await mkdir(path.join(worktreePath, 'local'), { recursive: true });
    await writeFile(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { '@scope/innocuous': '1.0.0', local: 'link:./local' },
        pnpm: {
          overrides: { 'left-pad': '1.3.0', nested: { '.': 'npm:@scope/replacement@1' } },
          catalog: { fast: 'file:./local' },
        },
      }),
    );
    await installUnverified('run-21', worktreePath, { processEnvironment: {}, pnpm });
    expect(pnpm).toHaveBeenCalledOnce();
  });

  it('refuses to install unverified content through a node_modules link', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-10');
    // The link is the write root: pnpm would create `<link>/<dependency name>`
    // wherever it points.
    if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, 'node_modules')))) return;
    await expect(
      installUnverified('run-10', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content whose links leave the worktree under any name', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-11');
    if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, '.m')))) return;
    await expect(
      installUnverified('run-11', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content that redirects the pnpm store from .npmrc', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-12');
    await writeFile(path.join(worktreePath, '.npmrc'), 'store-dir=/attacker/store\n');
    await expect(
      installUnverified('run-12', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content that moves pnpm write roots from workspace settings', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-13');
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\nvirtualStoreDir: .elsewhere\n',
    );
    await expect(
      installUnverified('run-13', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content whose configDependencies name escapes the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-17');
    // pnpm joins each config dependency's package name under
    // `node_modules/.pnpm-config`: a path-like name writes outside the worktree,
    // wherever the write roots point, so unverified content configures none at all.
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\nconfigDependencies:\n  "../../../../../../autostart": "1.0.0"\n',
    );
    await expect(
      installUnverified('run-17', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    await writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    await writeFile(
      path.join(worktreePath, 'package.json'),
      '{"name":"app","version":"1.0.0","pnpm":{"configDependencies":{"../../../../autostart":"1.0.0"}}}',
    );
    await expect(
      installUnverified('run-17', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified workspace globs and manifest settings that leave the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-14');
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "../*"\n',
    );
    await expect(
      installUnverified('run-14', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    await writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    await writeFile(
      path.join(worktreePath, 'package.json'),
      '{"name":"app","version":"1.0.0","pnpm":{"storeDir":"/attacker/store"}}',
    );
    await expect(
      installUnverified('run-14', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses when an existing write root resolves outside the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-15');
    await mkdir(path.join(worktreePath, 'node_modules'), { recursive: true });
    if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, 'node_modules', '.pnpm'))))
      return;
    await expect(
      installUnverified('run-15', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('lets verified content configure the machine\'s own pnpm store', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-16');
    await writeFile(
      path.join(worktreePath, '.npmrc'),
      `store-dir=${path.join(os.tmpdir(), 'own-store')}\n`,
    );
    await installCindyMakeWorktree(
      userData,
      { path: worktreePath, branch: 'cindy-make/run-16', baseCommit: 'b'.repeat(40) },
      new AbortController().signal,
      { processEnvironment: { PATH: '' }, pnpm },
    );
    expect(pnpm).toHaveBeenCalledOnce();
  });

  it('reuses an existing worktree on the task branch and refuses a foreign directory', async () => {
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-2');
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, '.git'), 'gitdir: ../../source/.git/worktrees/run-2\n');
    const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[], cwd: string) => {
      if (args[0] === 'branch')
        return args[2] === 'cindy-personal' ? 'cindy-personal' : 'cindy-make/run-2';
      if (args.includes('--git-common-dir')) return path.join(userData, 'cindy-make/source/.git');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        expect(cwd).toBe(worktreePath);
        return 'cindy-make/run-2';
      }
      if (args[0] === 'rev-parse') return 'abcdef1234567';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      }),
    ).resolves.toMatchObject({ path: worktreePath, branch: 'cindy-make/run-2' });
    expect(git.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(worktreePath, '.git'));
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });

  it('fails before touching Git when the source or personal branch is missing', async () => {
    const git = vi.fn<(env: NodeJS.ProcessEnv, args: string[]) => Promise<string>>(async () => '');
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    expect(git.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    await expect(
      prepareCindyMakeWorkspace(userData, '../escape', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });
});

describe('split Cindy Make workspace preparation', () => {
  it('creates the worktree without pnpm, then installs in a separate step', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-split-'));
    try {
      await mkdir(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
      const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'cindy-personal';
        if (args[0] === 'branch' && args[2] === 'cindy-personal') return 'cindy-personal\n';
        if (args[0] === 'rev-parse') return 'base123\n';
        if (args[0] === 'worktree' || args[0] === 'update-ref') return '';
        return '';
      });
      const pnpm = vi.fn(async () => undefined);
      const workspace = await createCindyMakeWorktree(
        userData,
        'run-split',
        new AbortController().signal,
        { processEnvironment: {}, git, pnpm },
      );
      expect(pnpm).not.toHaveBeenCalled();
      await installCindyMakeWorktree(userData, workspace, new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      });
      expect(pnpm).toHaveBeenCalledOnce();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});

describe('isCindyMakeWorktreePath', () => {
  const userData = path.resolve(os.tmpdir(), 'cindy-userdata');
  const worktrees = path.join(userData, 'cindy-make', 'worktrees');
  it('accepts only a direct child of the worktrees root named like a run id', () => {
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1'))).toBe(true);
    expect(isCindyMakeWorktreePath(userData, worktrees)).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1', 'apps'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, '..', 'source'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(userData, 'cindy-make', 'source'))).toBe(
      false,
    );
  });
});
