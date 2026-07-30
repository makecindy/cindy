/**
 * fileThumbnail.test.ts
 * ---------------------------------------------------------------------------
 * 附件卡缩略图入口(file:thumbnail 背后的 readFileThumbnail)的授权边界与兜底。
 *
 * 这是一条新开的「renderer 递绝对路径 → main 读本地文件」通道,所以这里钉住
 * 的是 fail-closed 行为(docs/dev-rules/electron-security-and-process-boundaries.md
 * §5):敏感目录、相对路径、越界尺寸、目录、不存在的文件一律拿不到图,且任何
 * 失败都回 null 而不是抛异常/漏路径。系统缩略图服务本身用 stub 替身。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createThumbnailFromPath = vi.fn();

vi.mock('electron', () => ({
  nativeImage: {
    createThumbnailFromPath: (...args: unknown[]) => createThumbnailFromPath(...args),
  },
}));

const stat = vi.fn();
const realpath = vi.fn();
vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => stat(...args),
  realpath: (...args: unknown[]) => realpath(...args),
}));

const isPathAllowedAgainst = vi.fn();
vi.mock('../filePathPolicy', () => ({
  isPathAllowedAgainst: (...args: unknown[]) => isPathAllowedAgainst(...args),
  getSensitiveMediaBlocklist: () => ['/Users/x/Library/Keychains'],
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { readFileThumbnail, __clearFileThumbnailCacheForTest } from '../fileThumbnail';

/** 与 fileThumbnail.ts 的 TIMEOUT_MS 对齐(那里是模块私有常量)。 */
const TIMEOUT_MS = 4000;

function okImage(dataUrl = 'data:image/png;base64,AAA') {
  return { isEmpty: () => false, toDataURL: () => dataUrl };
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearFileThumbnailCacheForTest();
  isPathAllowedAgainst.mockReturnValue(true);
  realpath.mockImplementation(async (p: string) => p);
  stat.mockResolvedValue({ isFile: () => true, mtimeMs: 1, size: 10, ino: 1, dev: 1 });
  createThumbnailFromPath.mockResolvedValue(okImage());
});

describe('readFileThumbnail — 授权边界', () => {
  it('命中敏感目录 blocklist 时不出图,也不去碰系统服务', async () => {
    isPathAllowedAgainst.mockReturnValue(false);
    await expect(readFileThumbnail({ path: '/Users/x/Library/Keychains/a.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('相对路径 / 空路径直接拒绝', async () => {
    await expect(readFileThumbnail({ path: 'a.pdf', size: 80 })).resolves.toBeNull();
    await expect(readFileThumbnail({ path: '', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('尺寸越界或非数字一律拒绝(不让 renderer 用尺寸放大资源占用)', async () => {
    for (const size of [0, 8, 129, 512, 4096, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readFileThumbnail({ path: '/tmp/a.pdf', size })).resolves.toBeNull();
    }
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('软链指向敏感目录时,按真实目标拒绝(词法路径看着无害也不放行)', async () => {
    // 允许目录里的一条软链完全可以指向 ~/Library/Keychains:只看词法路径会放行。
    realpath.mockResolvedValue('/Users/x/Library/Keychains/login.keychain');
    isPathAllowedAgainst.mockImplementation((p: string) => !p.includes('Keychains'));
    await expect(readFileThumbnail({ path: '/tmp/harmless-link.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('realpath 失败(断链 / 软链环 / EACCES)时不出图', async () => {
    realpath.mockRejectedValue(new Error('ELOOP'));
    await expect(readFileThumbnail({ path: '/tmp/loop.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('stat 与取图都用 realpath 后的真实路径(关掉 check→open 的 TOCTOU 窗口)', async () => {
    realpath.mockResolvedValue('/tmp/real-target.pdf');
    await readFileThumbnail({ path: '/tmp/link.pdf', size: 80 });
    expect(stat).toHaveBeenCalledWith('/tmp/real-target.pdf');
    expect(createThumbnailFromPath).toHaveBeenCalledWith('/tmp/real-target.pdf', expect.anything());
  });

  it('目录与不存在的文件不出图', async () => {
    stat.mockResolvedValueOnce({ isFile: () => false, mtimeMs: 1, size: 0, ino: 1, dev: 1 });
    await expect(readFileThumbnail({ path: '/tmp/dir', size: 80 })).resolves.toBeNull();
    stat.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(readFileThumbnail({ path: '/tmp/missing.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });
});

describe('readFileThumbnail — 兜底与缓存', () => {
  it('系统服务抛错时 dataUrl 为 null,不把异常抛给 renderer', async () => {
    createThumbnailFromPath.mockRejectedValue(new Error('unsupported'));
    await expect(readFileThumbnail({ path: '/tmp/a.zzz', size: 80 })).resolves.toEqual({
      dataUrl: null,
      byteSize: 10,
    });
  });

  it('空图当作拿不到', async () => {
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => true, toDataURL: () => '' });
    await expect(readFileThumbnail({ path: '/tmp/a.pdf', size: 80 })).resolves.toEqual({
      dataUrl: null,
      byteSize: 10,
    });
  });

  it('回传复核那一刻的当前字节数(卡片据此刷新「类型 · 大小」)', async () => {
    stat.mockResolvedValue({ isFile: () => true, mtimeMs: 7, size: 4242, ino: 1, dev: 1 });
    await expect(readFileThumbnail({ path: '/tmp/a.pdf', size: 80 })).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AAA',
      byteSize: 4242,
    });
  });

  it('同一文件重复请求只问一次系统服务', async () => {
    const first = await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 });
    const second = await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 });
    expect(first?.dataUrl).toBe('data:image/png;base64,AAA');
    expect(second?.dataUrl).toBe(first?.dataUrl);
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('出不了图的文件进负缓存,不必每次重挂载都再撞一次昂贵的原生调用', async () => {
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => true, toDataURL: () => '' });
    expect((await readFileThumbnail({ path: '/tmp/a.zzz', size: 80 }))?.dataUrl).toBeNull();
    expect((await readFileThumbnail({ path: '/tmp/a.zzz', size: 80 }))?.dataUrl).toBeNull();
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('负结果只短期缓存,瞬时失败之后还能重试', async () => {
    // QuickLook / Shell 偶发失败不该把预览永久钉死:超过负结果 TTL 后要重新尝试。
    createThumbnailFromPath.mockRejectedValueOnce(new Error('transient'));
    expect((await readFileThumbnail({ path: '/tmp/t.pdf', size: 80 }))?.dataUrl).toBeNull();
    expect((await readFileThumbnail({ path: '/tmp/t.pdf', size: 80 }))?.dataUrl).toBeNull();
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
    // 把时间推过负结果 TTL(60s)。
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0 + 61_000;
      createThumbnailFromPath.mockResolvedValue(okImage());
      expect((await readFileThumbnail({ path: '/tmp/t.pdf', size: 80 }))?.dataUrl).toBe(
        'data:image/png;base64,AAA',
      );
    } finally {
      Date.now = realNow;
    }
  });

  it('正结果也有软过期(粗时间戳文件系统上同尺寸改写撞 key 时能自愈)', async () => {
    expect((await readFileThumbnail({ path: '/tmp/p.pdf', size: 80 }))?.dataUrl).toBe(
      'data:image/png;base64,AAA',
    );
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0 + 11 * 60_000;
      await readFileThumbnail({ path: '/tmp/p.pdf', size: 80 });
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('缓存 key 含 dev/ino:同路径换成另一个 inode 不会吃旧图', async () => {
    await readFileThumbnail({ path: '/tmp/id.pdf', size: 80 });
    stat.mockResolvedValue({ isFile: () => true, mtimeMs: 1, size: 10, ino: 2, dev: 1 });
    await readFileThumbnail({ path: '/tmp/id.pdf', size: 80 });
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(2);
  });

  it('revalidate 跳过正缓存重新生成,但仍尊重负缓存', async () => {
    // 粗时间戳文件系统上「改完切回来就发送」算不出新 key,靠 TTL 要等十分钟。
    await readFileThumbnail({ path: '/tmp/rv.pdf', size: 80 });
    await readFileThumbnail({ path: '/tmp/rv.pdf', size: 80 });
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
    await readFileThumbnail({ path: '/tmp/rv.pdf', size: 80, revalidate: true });
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(2);

    // 负缓存不跳过:否则每次焦点复核都要再撞一次同一堵墙。
    __clearFileThumbnailCacheForTest();
    vi.clearAllMocks();
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => true, toDataURL: () => '' });
    await readFileThumbnail({ path: '/tmp/neg.zzz', size: 80 });
    await readFileThumbnail({ path: '/tmp/neg.zzz', size: 80, revalidate: true });
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('缓存按字节预算限界,不只按条数(尺寸进 key,同路径换 size 就是新条目)', async () => {
    // 单条约 4MB 的 dataURL:条数远没到 512,字节预算(24MB)先到顶。
    const big = 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024);
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => false, toDataURL: () => big });
    for (let px = 16; px <= 26; px++) {
      await readFileThumbnail({ path: '/tmp/big.pdf', size: px });
    }
    // 11 次请求 × 4MB = 44MB,若不按字节淘汰就会全留下。
    vi.clearAllMocks();
    createThumbnailFromPath.mockResolvedValue(okImage());
    // 最早那几档已被淘汰 → 会重新生成。
    await readFileThumbnail({ path: '/tmp/big.pdf', size: 16 });
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('取图后目标被掉包(dev/ino/mtime/size 变了)则丢弃结果,不交给 renderer', async () => {
    // createThumbnailFromPath 只吃路径、拿不到 fd,校验用的 stat 和它内部那次 open
    // 绑不到同一文件对象;结果出锅后复验一次身份,变了就不返回也不入缓存。
    stat
      .mockResolvedValueOnce({ isFile: () => true, mtimeMs: 1, size: 10, ino: 1, dev: 1 })
      .mockResolvedValue({ isFile: () => true, mtimeMs: 1, size: 10, ino: 999, dev: 1 });
    expect((await readFileThumbnail({ path: '/tmp/swap.pdf', size: 80 }))?.dataUrl).toBeNull();
  });

  it('复验也比 size:mtime 没动但尺寸变了同样算被掉包', async () => {
    __clearFileThumbnailCacheForTest();
    stat
      .mockResolvedValueOnce({ isFile: () => true, mtimeMs: 1, size: 10, ino: 1, dev: 1 })
      .mockResolvedValue({ isFile: () => true, mtimeMs: 1, size: 4242, ino: 1, dev: 1 });
    expect((await readFileThumbnail({ path: '/tmp/resize.pdf', size: 80 }))?.dataUrl).toBeNull();
  });

  it('系统 API 同步抛(Linux 没有这个 API)时释放名额,不把闸门占死', async () => {
    // 本仓有 deb 打包目标,而 createThumbnailFromPath 只在 macOS / Windows 实现:
    // 同步异常若发生在 native.finally 装上之前,名额和 inFlight 会永久泄漏。
    createThumbnailFromPath.mockImplementation(() => {
      throw new TypeError('createThumbnailFromPath is not a function');
    });
    for (let i = 0; i < 6; i++) {
      expect((await readFileThumbnail({ path: `/tmp/lin${i}.pdf`, size: 80 }))?.dataUrl).toBeNull();
    }
    // 6 次全部真正跑到了系统调用,说明前 4 次没把名额占死。
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(6);
  });

  it('一张图只编码一次 dataURL(race 与迟到回调共用结果)', async () => {
    const toDataURL = vi.fn(() => 'data:image/png;base64,AAA');
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => false, toDataURL });
    await readFileThumbnail({ path: '/tmp/once.pdf', size: 80 });
    await Promise.resolve();
    await Promise.resolve();
    expect(toDataURL).toHaveBeenCalledTimes(1);
  });

  it('超时后名额不放行,直到原生任务真正 settle(否则闸门形同虚设)', async () => {
    // 超时只让 IPC 早返回,QuickLook/Shell 那边取消不了 —— 若此刻就放名额,
    // 系统卡住时每过一个超时周期就会再放一批新任务进去。
    const gates: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    createThumbnailFromPath.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          gates.push(() => {
            active -= 1;
            resolve(okImage());
          });
        }),
    );
    vi.useFakeTimers();
    try {
      // 5 个不同文件:前 4 个占满名额,第 5 个排队。
      const calls = Array.from({ length: 5 }, (_, i) =>
        readFileThumbnail({ path: `/tmp/hang${i}.pdf`, size: 80 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(peak).toBe(4);
      // 让前 4 个全部超时:IPC 各自回 null,但原生任务仍挂着。
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect((await Promise.all(calls.slice(0, 4))).map((r) => r?.dataUrl)).toEqual([
        null, null, null, null,
      ]);
      // 关键断言:名额没被超时释放,排队的第 5 个自始至终没能点火。
      expect(peak).toBe(4);
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(4);
      // 而它也不会永远挂着——排队这一段同样受超时约束,直接回落。
      expect((await calls[4])?.dataUrl).toBeNull();
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(4);
      while (gates.length) {
        gates.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('名额被挂死任务占满时,排队请求超时回落而不是无限挂起', async () => {
    const gates: (() => void)[] = [];
    createThumbnailFromPath.mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve(okImage()))),
    );
    vi.useFakeTimers();
    try {
      // 先用 4 个挂死任务占满名额。
      const hung = Array.from({ length: 4 }, (_, i) =>
        readFileThumbnail({ path: `/tmp/block${i}.pdf`, size: 80 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(4);
      // 第 5 个只能排队:它必须在超时后自己回落,而不是等到天荒地老。
      const queued = readFileThumbnail({ path: '/tmp/queued.pdf', size: 80 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect((await queued)?.dataUrl).toBeNull();
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(4);
      while (gates.length) {
        gates.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all(hung);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时后迟到的原生结果仍写进缓存,下次挂载直接命中', async () => {
    let resolveNative: ((v: unknown) => void) | undefined;
    createThumbnailFromPath.mockReturnValue(
      new Promise((resolve) => {
        resolveNative = resolve;
      }),
    );
    vi.useFakeTimers();
    let first: ReturnType<typeof readFileThumbnail>;
    try {
      first = readFileThumbnail({ path: '/tmp/late.pdf', size: 80 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect((await first)?.dataUrl).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    // 原生任务姗姗来迟：结果不该被丢掉。
    resolveNative?.(okImage());
    await Promise.resolve();
    await Promise.resolve();
    expect((await readFileThumbnail({ path: '/tmp/late.pdf', size: 80 }))?.dataUrl).toBe(
      'data:image/png;base64,AAA',
    );
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('原生任务卡住期间不重复点火;它真失败后才落负缓存', async () => {
    let rejectNative: ((e: unknown) => void) | undefined;
    createThumbnailFromPath.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectNative = reject;
      }),
    );
    vi.useFakeTimers();
    let first: ReturnType<typeof readFileThumbnail>;
    try {
      first = readFileThumbnail({ path: '/tmp/slow.pdf', size: 80 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect((await first)?.dataUrl).toBeNull();
      // 超时只让 IPC 早返回;原生任务还挂着时,同一文件的重挂载请求复用它,
      // 不会再点一把新火(否则系统卡住时会越积越多)。
      expect((await readFileThumbnail({ path: '/tmp/slow.pdf', size: 80 }))?.dataUrl).toBeNull();
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    // 原生任务最终失败 → 落负缓存,后续请求直接命中,仍不重复调用。
    rejectNative?.(new Error('unsupported'));
    await Promise.resolve();
    await Promise.resolve();
    expect((await readFileThumbnail({ path: '/tmp/slow.pdf', size: 80 }))?.dataUrl).toBeNull();
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('同一文件的并发请求合并成一次原生调用', async () => {
    let resolveImage: ((v: unknown) => void) | undefined;
    createThumbnailFromPath.mockReturnValue(
      new Promise((resolve) => {
        resolveImage = resolve;
      }),
    );
    const all = Promise.all([
      readFileThumbnail({ path: '/tmp/same.pdf', size: 80 }),
      readFileThumbnail({ path: '/tmp/same.pdf', size: 80 }),
      readFileThumbnail({ path: '/tmp/same.pdf', size: 80 }),
    ]);
    await Promise.resolve();
    resolveImage?.(okImage());
    const results = await all;
    expect(results.map((r) => r?.dataUrl)).toEqual(Array(3).fill('data:image/png;base64,AAA'));
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('并发闸限制同时在飞的原生任务数(超时取消不了底层任务,只能限流)', async () => {
    let peak = 0;
    let active = 0;
    const gates: (() => void)[] = [];
    createThumbnailFromPath.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          gates.push(() => {
            active -= 1;
            resolve(okImage());
          });
        }),
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    // 每个路径都不同 → 不会被 in-flight 去重合并,只受并发闸约束。
    const all = Promise.all(
      Array.from({ length: 10 }, (_, i) => readFileThumbnail({ path: `/tmp/f${i}.pdf`, size: 80 })),
    );
    await tick();
    expect(peak).toBeLessThanOrEqual(4);
    // 逐个放行:每释放一个,排队中的下一个才会启动并注册新 gate。
    for (let i = 0; i < 10; i++) {
      await tick();
      gates.shift()?.();
    }
    await all;
    expect(peak).toBeLessThanOrEqual(4);
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(10);
  });

  it('文件被改写(mtime/size 变化)后重新出图,不吃旧缓存', async () => {
    await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 });
    stat.mockResolvedValue({ isFile: () => true, mtimeMs: 999, size: 20, ino: 1, dev: 1 });
    createThumbnailFromPath.mockResolvedValue(okImage('data:image/png;base64,BBB'));
    expect((await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 }))?.dataUrl).toBe(
      'data:image/png;base64,BBB',
    );
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(2);
  });
});
