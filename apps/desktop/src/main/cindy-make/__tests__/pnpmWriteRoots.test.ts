import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { create as tarCreate } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertPnpmConfigContained, assertPnpmInstallContained } from '../pnpmWriteRoots';

let fixture: string;
let worktree: string;

beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-local-git-'));
  worktree = path.join(fixture, 'worktree');
  await mkdir(worktree);
  await writeFile(
    path.join(worktree, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0' }),
  );
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe.each([
  { label: 'installation', check: assertPnpmInstallContained },
  { label: 'cache warming', check: assertPnpmConfigContained },
])('$label local Git dependency containment', ({ check }) => {
  it.each([
    'manifest dependency',
    'override',
    'workspace catalog',
    'lockfile specifier',
    'lockfile version',
    'transitive dependency',
    'Git resolution',
  ] as const)('refuses a repository outside the worktree in a %s', async (source) => {
    // A file URL is a stable protocol representation; the path it names comes
    // from this test's own temporary directory, never from a real user account.
    const repo = pathToFileURL(path.join(fixture, 'private repo')).href;
    const spec = `git+${repo}#main`;
    if (source === 'manifest dependency' || source === 'override') {
      await writeFile(
        path.join(worktree, 'package.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          ...(source === 'manifest dependency'
            ? { dependencies: { local: spec } }
            : { pnpm: { overrides: { local: spec } } }),
        }),
      );
    } else if (source === 'workspace catalog') {
      await writeFile(
        path.join(worktree, 'pnpm-workspace.yaml'),
        JSON.stringify({
          catalog: { local: spec },
        }),
      );
    } else {
      const graph =
        source === 'Git resolution'
          ? {
              packages: {
                'local@1.0.0': { resolution: { type: 'git', repo, commit: 'a'.repeat(40) } },
              },
            }
          : source === 'transitive dependency'
            ? { snapshots: { 'parent@1.0.0': { dependencies: { local: spec } } } }
            : {
                importers: {
                  '.': {
                    dependencies: {
                      local: {
                        specifier: source === 'lockfile specifier' ? spec : '*',
                        version: source === 'lockfile version' ? spec : '1.0.0',
                      },
                    },
                  },
                },
              };
      await writeFile(
        path.join(worktree, 'pnpm-lock.yaml'),
        JSON.stringify({
          lockfileVersion: '9.0',
          ...graph,
        }),
      );
    }
    await expect(check(worktree)).rejects.toMatchObject({ code: 'gitFailed' });
  });

  it('refuses encoded parent traversal in a local Git URL', async () => {
    const rootUrl = pathToFileURL(worktree + path.sep).href;
    await writeFile(
      path.join(worktree, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { local: `git+${rootUrl}%2e%2e/private#main` },
      }),
    );
    await expect(check(worktree)).rejects.toMatchObject({ code: 'gitFailed' });
  });

  it('refuses an undecodable local Git URL without leaking the URL in its error', async () => {
    const spec = 'git+file:///invalid%2Frepository#main';
    await writeFile(
      path.join(worktree, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { local: spec },
      }),
    );
    const error = await check(worktree).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ code: 'gitFailed' });
    expect(String(error)).not.toContain(spec);
  });

  it.each(['contained Git URL', 'remote Git URL', 'registry version'] as const)(
    'keeps a normal dependency available: %s',
    async (source) => {
      const repo = pathToFileURL(path.join(worktree, 'local repo')).href;
      const spec =
        source === 'contained Git URL'
          ? `git+${repo}#main`
          : source === 'remote Git URL'
            ? 'git+https://example.invalid/local.git#main'
            : '1.0.0';
      await writeFile(
        path.join(worktree, 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: { local: spec },
        }),
      );
      if (source === 'contained Git URL') {
        await writeFile(
          path.join(worktree, 'pnpm-lock.yaml'),
          JSON.stringify({
            lockfileVersion: '9.0',
            packages: {
              'local@1.0.0': { resolution: { type: 'git', repo, commit: 'a'.repeat(40) } },
            },
          }),
        );
      }
      await expect(check(worktree)).resolves.toBeUndefined();
    },
  );
});

it('refuses a local Git dependency hidden inside an installed archive', async () => {
  const stage = path.join(fixture, 'archive');
  await mkdir(path.join(stage, 'package'), { recursive: true });
  await writeFile(
    path.join(stage, 'package', 'package.json'),
    JSON.stringify({
      name: 'local',
      version: '1.0.0',
      dependencies: { local: `git+${pathToFileURL(path.join(fixture, 'private repo')).href}#main` },
    }),
  );
  await tarCreate({ file: path.join(worktree, 'local.tar'), cwd: stage }, ['package']);
  await writeFile(
    path.join(worktree, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { local: 'file:./local.tar' },
    }),
  );
  await expect(assertPnpmInstallContained(worktree)).rejects.toMatchObject({ code: 'gitFailed' });
});
