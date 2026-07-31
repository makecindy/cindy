/**
 * remotePathVerdictCache.test.ts
 * ---------------------------------------------------------------------------
 * 钉住 remoteFileOpen 的 verdict 缓存不变量 A:
 *
 *   **`unknown` 不是结论,只是「这一次没问到」——不得与 file/directory/nonfile
 *   同层缓存,必须能自愈重验。**
 *
 * 它没有类型保护:把 unknown 写回 verdictCache 一行就能改回去,编译照过、用例若只
 * 断言「verify 返回 unknown」也照过,但线上表现是**一次断链把该路径永久钉死成纯
 * 文本**(peek 有值 → 调用方跳过重验;叠上歧义形状不吃乐观点亮那道门槛,链路恢复
 * 后 `src/components` 再也不会点亮)。PR #1144 review 实捉。
 *
 * 用例刻意覆盖三种**错误修法**,让它们各自挂在不同断言上:
 *   ① 把 unknown 当结论缓存        → 「TTL 过后自愈重验」失败
 *   ② 干脆完全不缓存 unknown        → 「TTL 内不重复打 IPC」失败(那会招回
 *                                      2026-07 的重验风暴事故)
 *   ③ 把确定态也改成 TTL           → 「确定态永久缓存」失败
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearRemotePathVerdictCache,
  peekRemotePathVerdict,
  verifyRemotePathCached,
  type RemoteFileOrigin,
} from '../lib/remoteFileOpen';

const ORIGIN: RemoteFileOrigin = { kind: 'device', deviceId: 'dev-1' };
const WORKDIR = '/remote/proj';
const ABS = '/remote/proj/src/components';

/** stub window.electronAPI.fileBrowser.chatStat,返回 spy。 */
function stubChatStat(impl: () => Promise<{ verdict: string }>) {
  const chatStat = vi.fn(impl);
  vi.stubGlobal('window', { electronAPI: { fileBrowser: { chatStat } } });
  return chatStat;
}

const verify = () => verifyRemotePathCached(ORIGIN, WORKDIR, ABS);
const peek = () => peekRemotePathVerdict(ORIGIN, WORKDIR, ABS);

beforeEach(() => {
  _clearRemotePathVerdictCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('unknown 的生命周期(不变量 A)', () => {
  it('IPC 异常 → unknown,且**不进 peek**(peek 有值 ⇔ 有确定结论)', async () => {
    stubChatStat(() => Promise.reject(new Error('link down')));
    await expect(verify()).resolves.toBe('unknown');
    expect(peek(), 'unknown 被当成已验证结论写进了 verdictCache').toBeUndefined();
  });

  it('TTL 内不重复打 IPC(限流仍在 —— 防重验风暴)', async () => {
    const chatStat = stubChatStat(() => Promise.reject(new Error('link down')));
    await verify();
    expect(chatStat).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-07-31T00:00:20Z')); // +20s,仍在 30s TTL 内
    await expect(verify()).resolves.toBe('unknown');
    expect(chatStat, 'TTL 内又发了一次 stat').toHaveBeenCalledTimes(1);
  });

  it('TTL 过后自愈重验:链路恢复即拿到真实结论并点亮', async () => {
    let down = true;
    const chatStat = stubChatStat(() =>
      down ? Promise.reject(new Error('link down')) : Promise.resolve({ verdict: 'directory' }),
    );
    await expect(verify()).resolves.toBe('unknown');

    down = false;
    vi.setSystemTime(new Date('2026-07-31T00:00:31Z')); // +31s,TTL 已过
    await expect(verify(), '一次断链把该路径永久钉死了').resolves.toBe('directory');
    expect(chatStat).toHaveBeenCalledTimes(2);
    expect(peek()).toBe('directory');
  });
});

describe('确定态仍是无 TTL 永久缓存(切走再回来不闪烁)', () => {
  it('file / directory / nonfile 都进 peek,且远超 TTL 后也不再打 IPC', async () => {
    for (const [wire, expected] of [
      ['file', 'file'],
      ['directory', 'directory'],
      ['nonfile', 'nonfile'],
    ] as const) {
      _clearRemotePathVerdictCache();
      const chatStat = stubChatStat(() => Promise.resolve({ verdict: wire }));
      await expect(verify()).resolves.toBe(expected);
      expect(peek(), `${wire} 未进确定态缓存`).toBe(expected);

      vi.setSystemTime(new Date('2026-07-31T01:00:00Z')); // +1h,远超 unknown 的 TTL
      await expect(verify()).resolves.toBe(expected);
      expect(chatStat, `${wire} 被当成短 TTL 缓存、过期后重发了 stat`).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-07-31T00:00:00Z'));
    }
  });
});

describe('并发去重', () => {
  it('同一路径同屏多处出现时只发一次 stat(unknown 分支也不例外)', async () => {
    const chatStat = stubChatStat(() => Promise.reject(new Error('link down')));
    const [a, b, c] = await Promise.all([verify(), verify(), verify()]);
    expect([a, b, c]).toEqual(['unknown', 'unknown', 'unknown']);
    expect(chatStat).toHaveBeenCalledTimes(1);
  });
});
