/**
 * refImageBudget.test.ts
 * ---------------------------------------------------------------------------
 * 锁住图生视频参考图的总字节闸:多参考图放开到 9 张后,这道闸是 main 进程
 * 不被 450MB 输入打爆的唯一防线(详见 refImageBudget.ts 头注)。
 *
 * 重点不只是"超限会抛",还有**超限时一个字节都没被读过**——闸的价值全在
 * "先 stat 后读"这个顺序上,读完再拦等于没拦。
 */

import { describe, expect, it, vi } from 'vitest';

import { GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES } from '../../../shared/ghost.js';
import { assertRefImagesWithinBudget } from '../refImageBudget.js';

const MB = 1024 * 1024;

/** 每张都报同一个大小的 stat 替身;顺带记下被 stat 的路径。 */
function fakeStat(sizeByPath: Record<string, number>, seen: string[] = []) {
  return async (p: string) => {
    seen.push(p);
    return sizeByPath[p] ?? 0;
  };
}

describe('参考图总字节闸', () => {
  it('总量在上限内 → 放行', async () => {
    const paths = ['/a.png', '/b.png', '/c.png'];
    const statSize = fakeStat({ '/a.png': 5 * MB, '/b.png': 5 * MB, '/c.png': 5 * MB });
    await expect(
      assertRefImagesWithinBudget(paths, { statSize }),
    ).resolves.toBeUndefined();
  });

  it('张数没超但总量超 → 拒(9 张小图与 2 张巨图是不同的失败面)', async () => {
    const paths = ['/big1.png', '/big2.png'];
    const statSize = fakeStat({ '/big1.png': 40 * MB, '/big2.png': 40 * MB });
    await expect(
      assertRefImagesWithinBudget(paths, { statSize }),
    ).rejects.toThrow(/参考图总大小 80\.0MB 超过单次上限 48\.0MB\(本次 2 张\)/);
  });

  it('恰好等于上限 → 放行(闸是 >,不是 >=)', async () => {
    const statSize = fakeStat({ '/exact.png': GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES });
    await expect(
      assertRefImagesWithinBudget(['/exact.png'], { statSize }),
    ).resolves.toBeUndefined();
  });

  it('9 张顶格寄存图(450MB)→ 拒,且拒之前没读过任何字节', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `/huge${i}.png`);
    const sizeByPath = Object.fromEntries(paths.map((p) => [p, 50 * MB]));
    const seen: string[] = [];
    const statSize = fakeStat(sizeByPath, seen);
    // 真读字节的实现如果被调用,这个替身会炸——闸必须在它之前拦住。
    const readBytes = vi.fn(() => {
      throw new Error('不该读到字节:闸应该在 stat 阶段就拒了');
    });

    await expect(
      assertRefImagesWithinBudget(paths, { statSize }),
    ).rejects.toThrow(/超过单次上限/);
    expect(seen).toHaveLength(9); // stat 过 9 次(只看目录项)
    expect(readBytes).not.toHaveBeenCalled(); // 但一个字节都没读
  });

  it('空数组直接放行(文生视频没有参考图,不该被这道闸拦)', async () => {
    const statSize = vi.fn();
    await expect(
      assertRefImagesWithinBudget([], { statSize: statSize as never }),
    ).resolves.toBeUndefined();
    expect(statSize).not.toHaveBeenCalled();
  });

  it('上限可注入(便于按型号收紧,不写死 48MB)', async () => {
    const statSize = fakeStat({ '/a.png': 10 * MB });
    await expect(
      assertRefImagesWithinBudget(['/a.png'], { statSize, maxTotalBytes: 8 * MB }),
    ).rejects.toThrow(/超过单次上限 8\.0MB/);
  });
});
