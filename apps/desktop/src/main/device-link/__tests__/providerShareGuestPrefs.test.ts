import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../shared/ipc-errors.js';
import { setProviderShareCredentialConsentFromIpc } from '../providerShareGuestPrefsIpc.js';
import * as crossProcessLock from '../crossProcessLock.js';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

import {
  configureProviderShareGuestPrefs,
  flushProviderShareGuestPrefs,
  forgetProviderShareGuestPrefs,
  invalidateProviderShareGuestPrefsCache,
  isProviderShareCredentialConsentSkipped,
  pruneProviderShareGuestPrefs,
  resetProviderShareGuestPrefsForTests,
  setProviderShareCredentialConsent,
} from '../providerShareGuestPrefs';

let root: string;
let owner: string;
const otherInstances: typeof import('../providerShareGuestPrefs')[] = [];
const file = () => path.join(root, 'owners', owner, 'provider-share-guest-prefs.json');
const stored = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as { version: number; shares: Record<string, unknown> };
/** 模拟重启：丢掉内存里的缓存，重新从文件读。 */
const restart = () => {
  resetProviderShareGuestPrefsForTests();
  configureProviderShareGuestPrefs({ resolvePath: file });
};

/** 独立模块状态模拟另一个进程；两者只通过真实偏好文件和跨进程锁协调。 */
async function anotherInstance() {
  vi.resetModules();
  const instance = await import('../providerShareGuestPrefs');
  instance.configureProviderShareGuestPrefs({ resolvePath: file });
  otherInstances.push(instance);
  return instance;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-prefs-'));
  owner = 'account-a';
  configureProviderShareGuestPrefs({ resolvePath: file });
});

afterEach(async () => {
  await flushProviderShareGuestPrefs();
  for (const instance of otherInstances.splice(0)) {
    await instance.flushProviderShareGuestPrefs();
    instance.resetProviderShareGuestPrefsForTests();
  }
  vi.restoreAllMocks();
  resetProviderShareGuestPrefsForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('provider share guest prefs', () => {
  it.each(['mkdir', 'writeFile', 'rename'] as const)('does not publish or retry a failed trust update when %s fails', async (operation) => {
    await setProviderShareCredentialConsent('kept', 'global', true);
    vi.spyOn(fsp, operation).mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(setProviderShareCredentialConsent('failed', 'global', true)).rejects.toThrow('disk unavailable');
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    await setProviderShareCredentialConsent('saved', 'cn', true);
    expect(stored().shares).toEqual({
      kept: { region: 'global', skipCredentialConsent: true },
      saved: { region: 'cn', skipCredentialConsent: true },
    });
    restart();
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
  });

  it('keeps the saved trust state when disabling it cannot be persisted', async () => {
    await setProviderShareCredentialConsent('share-1', 'global', true);
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(setProviderShareCredentialConsent('share-1', 'global', false)).rejects.toThrow('disk unavailable');
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
  });

  it('publishes trust only after the atomic write succeeds', async () => {
    const rename = fsp.rename;
    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementationOnce(async (source, target) => {
      await pendingWrite;
      await rename(source, target);
    });
    const saving = setProviderShareCredentialConsent('share-1', 'global', true);
    try {
      await vi.waitFor(() => expect(renameSpy).toHaveBeenCalled());
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    } finally {
      finishWrite();
      await saving;
    }
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
  });

  it('preserves independent concurrent updates and later removals', async () => {
    await Promise.all([
      setProviderShareCredentialConsent('share-1', 'global', true),
      setProviderShareCredentialConsent('share-2', 'cn', true),
    ]);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('share-2')).toBe(true);

    const saving = setProviderShareCredentialConsent('share-3', 'global', true);
    const forgetting = forgetProviderShareGuestPrefs('share-3');
    const pruning = pruneProviderShareGuestPrefs(new Set(['share-1']), ['global']);
    await Promise.all([saving, forgetting, pruning]);
    await flushProviderShareGuestPrefs();
    expect(stored().shares).toEqual({
      'share-1': { region: 'global', skipCredentialConsent: true },
      'share-2': { region: 'cn', skipCredentialConsent: true },
    });
  });

  it('defaults to confirming, stores only the override per account, and survives a restart', async () => {
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);

    await setProviderShareCredentialConsent('share-1', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    expect(stored()).toEqual({ version: 1, shares: { 'share-1': { region: 'global', skipCredentialConsent: true } } });

    // 另一个账号看不到这份偏好；切回来仍在。
    owner = 'account-b';
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    owner = 'account-a';
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    // 关掉就是删掉记录(只存 override)。
    await setProviderShareCredentialConsent('share-1', 'global', false);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    expect(stored()).toEqual({ version: 1, shares: {} });
  });

  it('forgets a share on leave and prunes only shares missing from a confirmed region', async () => {
    await setProviderShareCredentialConsent('same-region', 'global', true);
    await setProviderShareCredentialConsent('cross-region', 'cn', true);
    await setProviderShareCredentialConsent('kept', 'global', true);

    // 本区域名单权威、对方区域还没加载：只清本区域里消失的那条。
    await pruneProviderShareGuestPrefs(new Set(['kept']), ['global']);
    expect(isProviderShareCredentialConsentSkipped('same-region')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    // 没有任何已确认区域(刚启动 / 读失败)：什么都不清。
    await pruneProviderShareGuestPrefs(new Set(), []);
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    await forgetProviderShareGuestPrefs('cross-region');
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(false);

    await flushProviderShareGuestPrefs();
    expect(stored().shares).toEqual({ kept: { region: 'global', skipCredentialConsent: true } });
    restart();
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('same-region')).toBe(false);
  });

  it('ignores foreign or unreadable records and keeps working in memory without a file', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({
      version: 1,
      shares: {
        ok: { region: 'cn', skipCredentialConsent: true },
        'bad region': { region: 'mars', skipCredentialConsent: true },
        off: { region: 'cn', skipCredentialConsent: false },
      },
    }));
    expect(isProviderShareCredentialConsentSkipped('ok')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('bad region')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('off')).toBe(false);

    fs.writeFileSync(file(), '{not json');
    restart();
    expect(isProviderShareCredentialConsentSkipped('ok')).toBe(false);

    configureProviderShareGuestPrefs({ resolvePath: null });
    await setProviderShareCredentialConsent('memory-only', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('memory-only')).toBe(true);
    await expect(setProviderShareCredentialConsent('not a share id', 'global', true)).rejects.toThrow();
  });

  it('reloads the shared file after another Desktop instance changes it', async () => {
    await setProviderShareCredentialConsent('share-1', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    // 模拟另一持有者完成原子替换；同一账号的文件路径保持不变。
    fs.writeFileSync(file(), JSON.stringify({ version: 1, shares: {} }));
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    invalidateProviderShareGuestPrefsCache();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });

  it('rejects queued writes after ownership changes without publishing trust', async () => {
    const first = setProviderShareCredentialConsent('share-1', 'global', true);
    const second = setProviderShareCredentialConsent('share-2', 'cn', true);
    invalidateProviderShareGuestPrefsCache();

    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(fs.existsSync(file())).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('share-2')).toBe(false);

    await setProviderShareCredentialConsent('current', 'global', true);
    expect(Object.keys(stored().shares)).toEqual(['current']);
  });

  it.each(['writeFile', 'rename'] as const)('preserves revocation by the next owner after handoff during %s', async (operation) => {
    await setProviderShareCredentialConsent('share-1', 'global', true);
    const next = await anotherInstance();
    await next.setProviderShareCredentialConsent('share-1', 'global', true);

    let reachedWrite!: () => void;
    const writing = new Promise<void>((resolve) => { reachedWrite = resolve; });
    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    if (operation === 'writeFile') {
      const writeFile = fsp.writeFile;
      vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
        reachedWrite();
        await pendingWrite;
        await writeFile(...args);
      });
    } else {
      const rename = fsp.rename;
      vi.spyOn(fsp, 'rename').mockImplementationOnce(async (...args) => {
        reachedWrite();
        await pendingWrite;
        await rename(...args);
      });
    }
    const saving = setProviderShareCredentialConsent('share-2', 'global', true).catch((error: unknown) => error);
    const queued = setProviderShareCredentialConsent('queued', 'global', true).catch((error: unknown) => error);
    let revoking: Promise<void> | undefined;
    try {
      await writing;
      invalidateProviderShareGuestPrefsCache();
      next.invalidateProviderShareGuestPrefsCache();
      const linkSpy = vi.spyOn(fsp, 'link');
      let revoked = false;
      revoking = next.setProviderShareCredentialConsent('share-1', 'global', false).then(() => { revoked = true; });
      // 新持有者已经尝试拿写锁，但旧 rename 完成前不能确认已保存。
      await vi.waitFor(() => expect(linkSpy).toHaveBeenCalledWith(expect.anything(), `${file()}.lock`));
      expect(revoked).toBe(false);
      expect(Object.keys(stored().shares)).toEqual(['share-1']);
    } finally {
      finishWrite();
      await Promise.all([saving, queued, revoking]);
    }
    expect(await saving).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    // 已提交给 OS 的 rename 可以完成，但必须在新实例重读和撤销之前完成。
    expect(Object.keys(stored().shares)).toEqual(operation === 'rename' ? ['share-2'] : []);
    expect(next.isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    expect(fs.readdirSync(path.dirname(file()))).toEqual(['provider-share-guest-prefs.json']);
  });

  it.each(['set', 'forget', 'prune'] as const)('reads the current file under the lock before %s instead of restoring stale trust', async (operation) => {
    await setProviderShareCredentialConsent('share-1', 'global', true);
    await setProviderShareCredentialConsent('share-2', 'global', true);
    const next = await anotherInstance();
    await next.setProviderShareCredentialConsent('share-1', 'global', false);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    if (operation === 'set') await setProviderShareCredentialConsent('share-3', 'global', true);
    else if (operation === 'forget') await forgetProviderShareGuestPrefs('share-2');
    else await pruneProviderShareGuestPrefs(new Set(['share-1']), ['global']);
    expect(Object.keys(stored().shares)).toEqual(operation === 'set' ? ['share-2', 'share-3'] : []);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });

  it.each(['busy', 'unavailable'] as const)('fails closed when the cross-process lock is %s', async (reason) => {
    await setProviderShareCredentialConsent('kept', 'global', true);
    vi.spyOn(crossProcessLock, 'withSecurityBoundaryLock').mockImplementationOnce(async (_file, _options, run) => run({ held: false, reason }));
    const writeSpy = vi.spyOn(fsp, 'writeFile');

    await expect(setProviderShareCredentialConsentFromIpc('share-1', 'global', true)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(Object.keys(stored().shares)).toEqual(['kept']);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });
  it('does not enable trust in memory when the durable write fails', async () => {
    fs.mkdirSync(file(), { recursive: true });

    await expect(setProviderShareCredentialConsent('write-fails', 'global', true)).rejects.toThrow();
    expect(isProviderShareCredentialConsentSkipped('write-fails')).toBe(false);

    fs.rmdirSync(file());
    await setProviderShareCredentialConsent('write-fails', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('write-fails')).toBe(true);
  });

  it('serializes concurrent settings without losing another share or retaining a failed enable', async () => {
    await Promise.all([
      setProviderShareCredentialConsent('first', 'global', true),
      setProviderShareCredentialConsent('second', 'cn', true),
    ]);
    expect(Object.keys(stored().shares).sort()).toEqual(['first', 'second']);

    // 真正的 rename 失败，随后排队的写入仍应成功，不能把失败的启用一起保存。
    const rename = fsp.rename;
    const blocker = path.join(root, 'rename-blocker');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'not a preferences file');
    vi.spyOn(fsp, 'rename').mockImplementationOnce((source) => rename(source, blocker));
    const [failed, saved] = await Promise.allSettled([
      setProviderShareCredentialConsent('failed', 'global', true),
      setProviderShareCredentialConsent('third', 'global', true),
    ]);
    expect(failed.status).toBe('rejected');
    expect(saved.status).toBe('fulfilled');
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
    expect(Object.keys(stored().shares).sort()).toEqual(['first', 'second', 'third']);
    restart();
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('third')).toBe(true);
  });

  it.each(['leave', 'prune', 'prune-other'] as const)('does not revive removed trust when %s runs during an in-flight save', async (cleanup) => {
    await setProviderShareCredentialConsent('already-trusted', 'global', true);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const rename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return rename(...args);
    });
    const save = setProviderShareCredentialConsent('pending', 'global', true);
    try {
      await started;
      expect(isProviderShareCredentialConsentSkipped('pending')).toBe(false);
      if (cleanup === 'leave') {
        forgetProviderShareGuestPrefs('pending');
        forgetProviderShareGuestPrefs('already-trusted');
      } else {
        pruneProviderShareGuestPrefs(new Set(cleanup === 'prune-other' ? ['pending'] : []), ['global']);
      }
      expect(isProviderShareCredentialConsentSkipped('already-trusted')).toBe(false);
      expect(isProviderShareCredentialConsentSkipped('pending')).toBe(false);
    } finally {
      release();
      await save;
      await flushProviderShareGuestPrefs();
    }
    expect(stored().shares).toEqual(cleanup === 'prune-other'
      ? { pending: { region: 'global', skipCredentialConsent: true } }
      : {});
    restart();
    expect(isProviderShareCredentialConsentSkipped('pending')).toBe(cleanup === 'prune-other');
    expect(isProviderShareCredentialConsentSkipped('already-trusted')).toBe(false);
  });

  it('keeps concurrent account writes isolated even when switching back before they finish', async () => {
    const accountA = setProviderShareCredentialConsent('only-a', 'global', true);
    owner = 'account-b';
    const accountB = setProviderShareCredentialConsent('only-b', 'global', true);
    owner = 'account-a';
    const accountAAgain = setProviderShareCredentialConsent('also-a', 'cn', true);
    await Promise.all([accountA, accountB, accountAAgain]);
    expect(Object.keys(stored().shares).sort()).toEqual(['also-a', 'only-a']);
    expect(isProviderShareCredentialConsentSkipped('only-a')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('also-a')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('only-b')).toBe(false);
    owner = 'account-b';
    expect(Object.keys(stored().shares)).toEqual(['only-b']);
    expect(isProviderShareCredentialConsentSkipped('only-b')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('only-a')).toBe(false);
  });

  it.each(['leave', 'prune'] as const)('keeps revoked trust disabled when %s cleanup cannot be saved', async (cleanup) => {
    await setProviderShareCredentialConsent('removed', 'global', true);
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
    if (cleanup === 'leave') {
      await expect(forgetProviderShareGuestPrefs('removed')).rejects.toThrow('disk unavailable');
    } else {
      await pruneProviderShareGuestPrefs(new Set(), ['global']);
    }
    expect(isProviderShareCredentialConsentSkipped('removed')).toBe(false);

    // 缓存重读及别的分享保存都不能把已退出分享的旧磁盘授权重新发布。
    invalidateProviderShareGuestPrefsCache();
    await setProviderShareCredentialConsent('other', 'cn', true);
    expect(isProviderShareCredentialConsentSkipped('removed')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('other')).toBe(true);

    // 只有新的显式信任操作成功后才可以恢复。
    await setProviderShareCredentialConsent('removed', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('removed')).toBe(true);
  });

  it('retains the previous setting when disabling trust fails to save', async () => {
    await setProviderShareCredentialConsent('trusted', 'global', true);
    const rename = fsp.rename;
    const blocker = path.join(root, 'disable-blocker');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'not a preferences file');
    vi.spyOn(fsp, 'rename').mockImplementationOnce((source) => rename(source, blocker));
    await expect(setProviderShareCredentialConsent('trusted', 'global', false)).rejects.toThrow();
    expect(isProviderShareCredentialConsentSkipped('trusted')).toBe(true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('trusted')).toBe(true);
  });
});

describe('provider share guest prefs IPC boundary', () => {
  it('saves and revokes trust through the IPC write path', async () => {
    await setProviderShareCredentialConsentFromIpc('share-1', 'global', true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    await setProviderShareCredentialConsentFromIpc('share-1', 'global', false);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });

  it.each(['mkdir', 'writeFile', 'rename'] as const)('hides filesystem paths when %s fails', async (operation) => {
    const leakedPath = path.join(root, 'owners', owner, 'provider-share-guest-prefs.json.123.tmp');
    const original = Object.assign(new Error(`EACCES: permission denied, ${operation} '${leakedPath}'`), { code: 'EACCES' });
    vi.spyOn(fsp, operation).mockRejectedValueOnce(original);

    const failure = await setProviderShareCredentialConsentFromIpc('share-1', 'global', true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] Failed to save provider share credential consent',
    });
    expect(String(failure)).not.toContain(leakedPath);
    expect(String(failure)).not.toContain('EACCES');
    expect(failure).not.toHaveProperty('cause');
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);

    // IPC 失败不能毒化串行写队列；用户下一次保存仍可成功。
    await setProviderShareCredentialConsentFromIpc('share-1', 'global', true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
  });

  it('preserves an existing IPC error', async () => {
    const original = createIpcError('PRECONDITION_FAILED', 'Provider sharing is not ready');
    vi.spyOn(fsp, 'mkdir').mockRejectedValueOnce(original);

    await expect(setProviderShareCredentialConsentFromIpc('share-1', 'global', true)).rejects.toBe(original);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });
});
