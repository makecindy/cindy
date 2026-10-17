/**
 * ghostWorkdirPrefs.test.ts — 目录级禁用偏好的纯函数单测(normalize +
 * 目录键归一化)。写路径 roundtrip 与生效链路(花名册/清单过滤、ghost_call
 * 兜底)见 mcp-integrations/__tests__/ghostWorkdirGate.test.ts。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as locks from '../../device-link/crossProcessLock.js';

const scope = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(scope.dir, ...parts),
  activeOwnerScopeKey: () => scope.dir,
  isAppSessionBoundaryPending: () => false,
}));

const {
  __testing, setGhostDisabledForWorkdir, listDisabledGhostIdsForWorkdir,
  relocateGhostWorkdirPrefs,
} = await import('../ghostWorkdirPrefs');

describe('relocateGhostWorkdirPrefs', () => {
  beforeEach(() => {
    scope.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ghost-prefs-relocate-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(scope.dir, { recursive: true, force: true });
  });

  it('moves disabled projects to the namespaced identity without disabling a new root plugin', async () => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    setGhostDisabledForWorkdir('/project/b', 'helper', true);
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper']);
    expect(listDisabledGhostIdsForWorkdir('/project/b')).toEqual(['_ns__acme__helper']);
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper']);
  });

  it('refuses existing destination disables without merging plugin preferences', async () => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    setGhostDisabledForWorkdir('/project/a', 'another', true);
    setGhostDisabledForWorkdir('/project/a', '_ns__acme__helper', true);
    setGhostDisabledForWorkdir('/project/b', '_ns__acme__helper', true);
    await expect(relocateGhostWorkdirPrefs('helper', '_ns__acme__helper')).rejects.toThrow(/collision/);
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper', 'another', 'helper']);
    expect(listDisabledGhostIdsForWorkdir('/project/b')).toEqual(['_ns__acme__helper']);
  });

  it('replays the inverse without relying on an in-memory rollback closure', async () => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    setGhostDisabledForWorkdir('/project/b', 'helper', true);
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    await relocateGhostWorkdirPrefs('_ns__acme__helper', 'helper');
    await relocateGhostWorkdirPrefs('_ns__acme__helper', 'helper');
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['helper']);
    expect(listDisabledGhostIdsForWorkdir('/project/b')).toEqual(['helper']);
  });

  it('does not overwrite unreadable preferences; retry succeeds once repaired', async () => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    const file = path.join(scope.dir, 'ghost-workdir-prefs.json');
    fs.writeFileSync(file, '{bad json');
    await expect(relocateGhostWorkdirPrefs('helper', '_ns__acme__helper')).rejects.toThrow(/unreadable/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad json');
    fs.writeFileSync(file, JSON.stringify({ disabledByWorkdir: { '/project/a': ['helper'] } }));
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper']);
  });

  it.each(['helper', 'another-plugin'])('blocks %s writes during lock release with unchanged mtime', async (id) => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    const file = path.join(scope.dir, 'ghost-workdir-prefs.json');
    const time = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(file, time, time);
    listDisabledGhostIdsForWorkdir('/project/a');
    const rename = fs.promises.rename;
    let attempted = false;
    let failure: unknown;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(source) === file + '.lock' && String(destination).startsWith(file + '.lock.release-')) {
        attempted = true;
        fs.utimesSync(file, time, time);
        try { setGhostDisabledForWorkdir('/project/a', id, true); } catch (error) { failure = error; }
      }
      await rename(source, destination);
    });
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    expect(attempted).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/relocating/);
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper']);
    setGhostDisabledForWorkdir('/project/a', 'another-plugin', true);
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper', 'another-plugin']);
  });

  it.each(['write', 'release'])('recovers after %s failure without restoring stale cache', async (stage) => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    const file = path.join(scope.dir, 'ghost-workdir-prefs.json');
    const time = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(file, time, time);
    listDisabledGhostIdsForWorkdir('/project/a');
    if (stage === 'write') {
      const rename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === file) throw new Error('simulated write failure');
        rename(source, destination);
      });
    } else {
      const withLock = locks.withCrossProcessLock;
      vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (target, options, task, signal) => {
        await withLock(target, options, task, signal);
        fs.utimesSync(file, time, time);
        throw new Error('simulated release failure');
      });
    }
    await expect(relocateGhostWorkdirPrefs('helper', '_ns__acme__helper'))
      .rejects.toThrow('simulated ' + stage + ' failure');
    vi.restoreAllMocks();
    setGhostDisabledForWorkdir('/project/a', 'another-plugin', true);
    if (stage === 'release') {
      expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper', 'another-plugin']);
    }
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper', 'another-plugin']);
  });

  it('allows another owner to write while this owner releases its lock', async () => {
    setGhostDisabledForWorkdir('/project/a', 'helper', true);
    const originalDir = scope.dir;
    const withLock = locks.withCrossProcessLock;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (target, options, task, signal) => {
      const result = await withLock(target, options, task, signal);
      scope.dir = path.join(originalDir, 'owner-b');
      try {
        expect(setGhostDisabledForWorkdir('/project/b', 'helper', true)).toEqual(['helper']);
      } finally {
        scope.dir = originalDir;
      }
      return result;
    });
    await relocateGhostWorkdirPrefs('helper', '_ns__acme__helper');
    expect(listDisabledGhostIdsForWorkdir('/project/a')).toEqual(['_ns__acme__helper']);
    expect(JSON.parse(fs.readFileSync(path.join(originalDir, 'owner-b', 'ghost-workdir-prefs.json'), 'utf8')))
      .toEqual({ disabledByWorkdir: { '/project/b': ['helper'] } });
  });
});

describe('normalizeWorkdirKey(纯字符串归一化,不碰 fs)', () => {
  it('Windows 形态:统一反斜杠、去尾分隔符、小写折叠', () => {
    expect(__testing.normalizeWorkdirKey('E:\\Cindy\\Cindy-Moved\\')).toBe('e:\\cindy\\cindy-moved');
    expect(__testing.normalizeWorkdirKey('E:/Cindy/Cindy-Moved')).toBe('e:\\cindy\\cindy-moved');
    expect(__testing.normalizeWorkdirKey('C:\\')).toBe('c:\\');
  });

  it('POSIX 形态(含远程 SSH 工作区):保留大小写,仅去尾 /', () => {
    expect(__testing.normalizeWorkdirKey('/home/User/Repo/')).toBe('/home/User/Repo');
    expect(__testing.normalizeWorkdirKey('/home/User/Repo')).toBe('/home/User/Repo');
    expect(__testing.normalizeWorkdirKey('/')).toBe('/');
  });

  it('空白输入 → 空键(调用方视为无语境)', () => {
    expect(__testing.normalizeWorkdirKey('  ')).toBe('');
  });
});

describe('normalize(坏形态清洗)', () => {
  it('preserves existing literal keys and keeps whitespace-distinct project policies separate', () => {
    const prefs = { disabledByWorkdir: { '/repo': ['old-plugin'], '/repo ': ['other-plugin'] } };
    expect(__testing.normalize(prefs)).toEqual(prefs);
    expect(__testing.normalizeWorkdirKey('/repo ')).toBe('/repo ');
  });
  it('合法条目保留(id 去重排序);空数组、非数组、空目录键全部清掉', () => {
    expect(
      __testing.normalize({
        disabledByWorkdir: {
          '/a': ['b-ghost', 'a-ghost', 'b-ghost', '', 42],
          '/empty': [],
          '/bad': 'not-an-array',
          '   ': ['x'],
        },
      }),
    ).toEqual({ disabledByWorkdir: { '/a': ['a-ghost', 'b-ghost'] } });
  });

  it('同一目录不同写法归一后撞键 → 并集(手改文件容错)', () => {
    expect(
      __testing.normalize({
        disabledByWorkdir: {
          'E:\\Repo': ['g1'],
          'e:/repo/': ['g2'],
        },
      }),
    ).toEqual({ disabledByWorkdir: { 'e:\\repo': ['g1', 'g2'] } });
  });

  it('整体不是对象 / 缺 disabledByWorkdir → 空表', () => {
    expect(__testing.normalize(null)).toEqual({ disabledByWorkdir: {} });
    expect(__testing.normalize({ disabledByWorkdir: [] })).toEqual({ disabledByWorkdir: {} });
  });
});
