/**
 * repoRoot.test.ts — 意识仓库根解析 + brain → cindy-brain 迁移单测(纯 DI)。
 * 覆盖:全新安装、旧目录迁移、迁移失败回退旧目录、两目录并存走新目录。
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

import {
  resolveCachedGhostRepoRoot,
  resolveGhostRepoRoot,
  type GhostRepoRootDeps,
} from '../repoRoot';

const USER_DATA = path.join(path.sep, 'fake', 'userData');
const ROOT = path.join(USER_DATA, 'cindy-brain');
const LEGACY = path.join(USER_DATA, 'brain');

function makeDeps(existing: string[], overrides: Partial<GhostRepoRootDeps> = {}) {
  const rename = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: GhostRepoRootDeps = {
    userDataDir: USER_DATA,
    exists: (p) => existing.includes(p),
    rename,
    log,
    ...overrides,
  };
  return { deps, rename, log };
}

describe('resolveGhostRepoRoot', () => {
  it('全新安装(两目录都不在):直接返回新目录,不做任何 rename', () => {
    const { deps, rename } = makeDeps([]);
    expect(resolveGhostRepoRoot(deps)).toBe(ROOT);
    expect(rename).not.toHaveBeenCalled();
  });

  it('只有旧目录:rename 迁移到新目录并返回新目录', () => {
    const { deps, rename, log } = makeDeps([LEGACY]);
    expect(resolveGhostRepoRoot(deps)).toBe(ROOT);
    expect(rename).toHaveBeenCalledWith(LEGACY, ROOT);
    expect(log.info).toHaveBeenCalled();
  });

  it('rename 失败:回退返回旧目录(数据不丢,下次启动再试)', () => {
    const { deps, log } = makeDeps([LEGACY], {
      rename: () => {
        throw new Error('EPERM: locked');
      },
    });
    expect(resolveGhostRepoRoot(deps)).toBe(LEGACY);
    expect(log.warn).toHaveBeenCalled();
  });

  it('两目录并存:走新目录、不 rename、留 warn', () => {
    const { deps, rename, log } = makeDeps([LEGACY, ROOT]);
    expect(resolveGhostRepoRoot(deps)).toBe(ROOT);
    expect(rename).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('只有新目录(已迁移过):直接返回新目录', () => {
    const { deps, rename } = makeDeps([ROOT]);
    expect(resolveGhostRepoRoot(deps)).toBe(ROOT);
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('resolveCachedGhostRepoRoot', () => {
  it('reuses the resolved root while the owner scope is unchanged', () => {
    const first = makeDeps([]);
    const cached = resolveCachedGhostRepoRoot(null, 'signed-out:none:0', first.deps);
    const second = makeDeps([], {
      userDataDir: path.join(path.sep, 'unused'),
      exists: vi.fn(() => false),
    });

    const resolved = resolveCachedGhostRepoRoot(
      cached,
      'signed-out:none:0',
      second.deps,
    );

    expect(resolved).toBe(cached);
    expect(second.deps.exists).not.toHaveBeenCalled();
  });

  it('resolves the real owner root after signed-out startup restores an account', () => {
    const signedOut = makeDeps([], {
      userDataDir: path.join(path.sep, 'userData', 'cindy-no-session', '123'),
    });
    const initial = resolveCachedGhostRepoRoot(
      null,
      'signed-out:none:0',
      signedOut.deps,
    );
    const ownerDataDir = path.join(path.sep, 'userData', 'owners', 'user-1');
    const restored = makeDeps([], { userDataDir: ownerDataDir });

    const resolved = resolveCachedGhostRepoRoot(
      initial,
      'cloud:user-1:1',
      restored.deps,
    );

    expect(resolved).not.toBe(initial);
    expect(resolved).toEqual({
      ownerScopeKey: 'cloud:user-1:1',
      rootDir: path.join(ownerDataDir, 'cindy-brain'),
    });
  });

  it('does not reuse one account root for another account', () => {
    const ownerA = path.join(path.sep, 'userData', 'owners', 'user-a');
    const ownerB = path.join(path.sep, 'userData', 'owners', 'user-b');
    const initial = resolveCachedGhostRepoRoot(
      null,
      'cloud:user-a:1',
      makeDeps([], { userDataDir: ownerA }).deps,
    );

    const resolved = resolveCachedGhostRepoRoot(
      initial,
      'cloud:user-b:2',
      makeDeps([], { userDataDir: ownerB }).deps,
    );

    expect(resolved.rootDir).toBe(path.join(ownerB, 'cindy-brain'));
  });
});
