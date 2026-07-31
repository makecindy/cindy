/**
 * refImageBudget.test.ts
 * ---------------------------------------------------------------------------
 * 锁住图生视频参考图的总字节闸,两个方向都要锁:
 *
 * 1. **别放过**:多参考图放开到 9 张后,这道闸是 main 进程不被 450MB 输入
 *    打爆的唯一防线(详见 refImageBudget.ts 头注)。重点不只是"超限会抛",
 *    还有**超限时一个字节都没被读过**——闸的价值全在"先 stat 后读"这个
 *    顺序上,读完再拦等于没拦。
 * 2. **别拦错**:预算低了会把存量首尾帧路径打回归——一张 50MB 的合法寄存图
 *    在多参考图之前是能跑的,不许因为这道新闸就跑不了。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GHOST_CINDY_DEPOSIT_MAX_BYTES,
  GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE,
  GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES,
} from '../../../shared/ghost.js';
import {
  assertRefImagesWithinBudget,
  readRefImagesWithinBudget,
} from '../refImageBudget.js';

const MB = 1024 * 1024;

/** 按路径报大小的 stat 替身;顺带记下被 stat 的路径。 */
function fakeStat(sizeByPath: Record<string, number>, seen: string[] = []) {
  return async (p: string) => {
    seen.push(p);
    return sizeByPath[p] ?? 0;
  };
}

/** 每张都报同一个大小,省得为 9 张图手写字典。 */
function fakeStatUniform(size: number, seen: string[] = []) {
  return async (p: string) => {
    seen.push(p);
    return size;
  };
}

describe('参考图总字节闸', () => {
  it('总量在上限内 → 放行', async () => {
    const paths = ['/a.png', '/b.png', '/c.png'];
    const statSize = fakeStat({ '/a.png': 5 * MB, '/b.png': 5 * MB, '/c.png': 5 * MB });
    await expect(assertRefImagesWithinBudget(paths, { statSize })).resolves.toBeUndefined();
  });

  it('总量超预算 → 拒', async () => {
    const paths = ['/big1.png', '/big2.png', '/big3.png'];
    const statSize = fakeStatUniform(50 * MB);
    await expect(assertRefImagesWithinBudget(paths, { statSize })).rejects.toThrow(
      /参考图总大小 150\.0MB 超过单次上限 100\.0MB\(本次 3 张\)/,
    );
  });

  it('恰好等于上限 → 放行(闸是 >,不是 >=)', async () => {
    const statSize = fakeStat({ '/exact.png': GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES });
    await expect(
      assertRefImagesWithinBudget(['/exact.png'], { statSize }),
    ).resolves.toBeUndefined();
  });

  it('空数组直接放行(文生视频没有参考图,不该被这道闸拦)', async () => {
    const statSize = vi.fn();
    await expect(
      assertRefImagesWithinBudget([], { statSize: statSize as never }),
    ).resolves.toBeUndefined();
    expect(statSize).not.toHaveBeenCalled();
  });

  it('上限可注入(便于按型号收紧,不写死常量)', async () => {
    const statSize = fakeStat({ '/a.png': 10 * MB });
    await expect(
      assertRefImagesWithinBudget(['/a.png'], { statSize, maxTotalBytes: 8 * MB }),
    ).rejects.toThrow(/超过单次上限 8\.0MB/);
  });
});

/**
 * 存量兼容锁。这道闸是随多参考图一起加的,不能顺手把改之前跑得通的单子拒掉
 * ——首尾帧模式的既有最坏值(2 张顶格寄存图)必须仍然放行。
 */
describe('首尾帧存量路径不被这道闸收紧', () => {
  it('预算 ≥ 首尾帧张数上界 × 寄存单张上限(调低预算或调高张数就在这炸)', () => {
    expect(GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES).toBeGreaterThanOrEqual(
      GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE.first_and_last_frame * GHOST_CINDY_DEPOSIT_MAX_BYTES,
    );
  });

  it('单张顶格寄存图(50MB)→ 放行(改之前能跑,现在也得能跑)', async () => {
    const statSize = fakeStat({ '/deposit.png': GHOST_CINDY_DEPOSIT_MAX_BYTES });
    await expect(
      assertRefImagesWithinBudget(['/deposit.png'], { statSize }),
    ).resolves.toBeUndefined();
  });

  it('首尾帧两张都顶格(2 × 50MB)→ 放行(该模式下这道闸恒不触发)', async () => {
    const paths = ['/first.png', '/last.png'];
    const statSize = fakeStatUniform(GHOST_CINDY_DEPOSIT_MAX_BYTES);
    await expect(assertRefImagesWithinBudget(paths, { statSize })).resolves.toBeUndefined();
  });
});

/**
 * 顺序即防线:readRefImagesWithinBudget 把闸和读取绑在一起,所以"超限时没读
 * 过字节"这件事能在这里真断言——读取替身就是它的入参,被调到就会现形。
 */
describe('过闸→读取一体入口', () => {
  it('9 张顶格寄存图(450MB)→ 拒,且 readOne 一次都没被调用', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `/huge${i}.png`);
    const seen: string[] = [];
    const statSize = fakeStatUniform(50 * MB, seen);
    // 真读字节的实现如果被调用,这个替身会炸——闸必须在它之前拦住。
    const readOne = vi.fn(async (p: string) => `bytes:${p}`);

    await expect(
      readRefImagesWithinBudget(paths, readOne, { statSize }),
    ).rejects.toThrow(/超过单次上限/);
    expect(seen).toHaveLength(9); // stat 过 9 次(只看目录项)
    expect(readOne).not.toHaveBeenCalled(); // 但一个字节都没读
  });

  it('未超限 → 按入参顺序返回读取结果(顺序有语义:首/尾帧、[Image N])', async () => {
    const paths = ['/one.png', '/two.png', '/three.png'];
    const statSize = fakeStatUniform(1 * MB);
    // 故意让先发起的解析得更慢,乱序聚合会在这里露馅。
    const delays: Record<string, number> = { '/one.png': 6, '/two.png': 3, '/three.png': 0 };
    const readOne = async (p: string) => {
      await new Promise((r) => setTimeout(r, delays[p]));
      return `bytes:${p}`;
    };

    await expect(readRefImagesWithinBudget(paths, readOne, { statSize })).resolves.toEqual([
      'bytes:/one.png',
      'bytes:/two.png',
      'bytes:/three.png',
    ]);
  });
});
