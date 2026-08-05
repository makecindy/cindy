import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearRemotePathVerdictCache,
  peekRemotePathVerdict,
  verifyRemotePathCached,
} from '@/session/remotePathVerdict';
import type { RemotePathStatResult } from '@/device-link/mobileMakerTransport';

const statOf = (kind: RemotePathStatResult['kind']) =>
  vi.fn(async (absPath: string): Promise<RemotePathStatResult> => ({ kind, resolvedPath: absPath }));

describe('remotePathVerdict', () => {
  beforeEach(() => {
    _clearRemotePathVerdictCache();
  });

  it('dir/file/missing → directory/file/nonfile,并落缓存供 peek 同步读', async () => {
    expect(await verifyRemotePathCached('dev', '/w', '/w/dir', statOf('dir'))).toBe('directory');
    expect(await verifyRemotePathCached('dev', '/w', '/w/a.ts', statOf('file'))).toBe('file');
    expect(await verifyRemotePathCached('dev', '/w', '/w/x', statOf('missing'))).toBe('nonfile');
    expect(peekRemotePathVerdict('dev', '/w', '/w/a.ts')).toBe('file');
    expect(peekRemotePathVerdict('dev', '/w', '/w/x')).toBe('nonfile');
  });

  it('stat 异常(断链等)→ unknown,不 throw', async () => {
    const stat = vi.fn(async () => {
      throw new Error('link down');
    });
    await expect(verifyRemotePathCached('dev', '/w', '/w/a.ts', stat)).resolves.toBe('unknown');
  });

  it('unknown 落短 TTL 负缓存:TTL 内重挂不再发 stat,过期后自愈重验', async () => {
    vi.useFakeTimers();
    try {
      const failing = vi.fn(async (): Promise<RemotePathStatResult> => {
        throw new Error('link down');
      });
      await expect(verifyRemotePathCached('dev', '/w', '/w/x.ts', failing)).resolves.toBe('unknown');
      expect(failing).toHaveBeenCalledTimes(1);
      // 负缓存不进 peek:重挂的 chip 仍走异步验证路径,乐观点亮语义不变。
      expect(peekRemotePathVerdict('dev', '/w', '/w/x.ts')).toBeUndefined();
      // TTL 内重验:同步拿 unknown,不再打 stat(防断续链路下的重验风暴)。
      await expect(verifyRemotePathCached('dev', '/w', '/w/x.ts', failing)).resolves.toBe('unknown');
      expect(failing).toHaveBeenCalledTimes(1);
      // TTL 过期 + 链路恢复:重验拿到确定态并落缓存,自愈不受负缓存影响。
      vi.advanceTimersByTime(30_000 + 1);
      expect(await verifyRemotePathCached('dev', '/w', '/w/x.ts', statOf('missing'))).toBe('nonfile');
      expect(peekRemotePathVerdict('dev', '/w', '/w/x.ts')).toBe('nonfile');
    } finally {
      vi.useRealTimers();
    }
  });

  it('不同 key 的 stat 全局限流:最多 3 条在飞,完成一条补位一条', async () => {
    const resolvers: Array<(v: RemotePathStatResult) => void> = [];
    const stat = vi.fn(
      (absPath: string) =>
        new Promise<RemotePathStatResult>((resolve) => {
          resolvers.push((v) => resolve({ ...v, resolvedPath: absPath }));
        }),
    );
    const promises = Array.from({ length: 5 }, (_, i) =>
      verifyRemotePathCached('dev', '/w', `/w/f${i}.ts`, stat),
    );
    await Promise.resolve();
    expect(stat).toHaveBeenCalledTimes(3);
    resolvers[0]({ kind: 'file', resolvedPath: '' });
    await promises[0];
    expect(stat).toHaveBeenCalledTimes(4);
    resolvers[1]({ kind: 'file', resolvedPath: '' });
    await promises[1];
    expect(stat).toHaveBeenCalledTimes(5);
    resolvers[2]({ kind: 'file', resolvedPath: '' });
    resolvers[3]({ kind: 'file', resolvedPath: '' });
    resolvers[4]({ kind: 'file', resolvedPath: '' });
    await expect(Promise.all(promises)).resolves.toEqual(Array(5).fill('file'));
  });

  it('缓存命中不再发 stat', async () => {
    const stat = statOf('file');
    await verifyRemotePathCached('dev', '/w', '/w/a.ts', stat);
    await verifyRemotePathCached('dev', '/w', '/w/a.ts', stat);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('并发同 key 去重为一次 stat', async () => {
    let release!: (v: RemotePathStatResult) => void;
    const gate = new Promise<RemotePathStatResult>((resolve) => {
      release = resolve;
    });
    const stat = vi.fn(() => gate);
    const p1 = verifyRemotePathCached('dev', '/w', '/w/a.ts', stat);
    const p2 = verifyRemotePathCached('dev', '/w', '/w/a.ts', stat);
    release({ kind: 'file', resolvedPath: '/w/a.ts' });
    expect(await p1).toBe('file');
    expect(await p2).toBe('file');
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('不同 deviceId / workdir 互不串缓存', async () => {
    await verifyRemotePathCached('dev1', '/w', '/w/a.ts', statOf('file'));
    expect(peekRemotePathVerdict('dev2', '/w', '/w/a.ts')).toBeUndefined();
    expect(peekRemotePathVerdict('dev1', '/w2', '/w/a.ts')).toBeUndefined();
  });
});
