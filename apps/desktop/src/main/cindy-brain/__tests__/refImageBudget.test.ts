/**
 * refImageBudget.test.ts
 * ---------------------------------------------------------------------------
 * 锁住图生视频参考图的总字节闸,两个方向都要锁:
 *
 * 1. **别放过**:`reference_image` 放开到 9 张后,这道闸是 main 进程不被几百
 *    MB 输入打爆的唯一防线(详见 refImageBudget.ts 头注)。重点不只是"超限
 *    会抛",还有**超限时一个字节都没被读过**——闸的价值全在"先 stat 后读"
 *    这个顺序上,读完再拦等于没拦。
 * 2. **别拦错**:存量的 `first_and_last_frame` 本来没有任何字节闸,源图单张
 *    可达 256MB(ghost-gallery),所以那条路径**不设闸**。给它加任何有限预算
 *    都会把改之前跑得通的单子拒掉。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GHOST_FETCH_MEDIA_MAX_BYTES,
  GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES_BY_REF_MODE,
} from '../../../shared/ghost.js';
import {
  assertRefImagesWithinBudget,
  readRefImagesWithinBudget,
} from '../refImageBudget.js';

const MB = 1024 * 1024;

/** 每张都报同一个大小的 stat 替身;顺带记下被 stat 的路径。 */
function fakeStat(size: number, seen: string[] = []) {
  return async (p: string) => {
    seen.push(p);
    return size;
  };
}

describe('reference_image:总字节闸生效', () => {
  it('总量在预算内 → 放行', async () => {
    const paths = ['/a.png', '/b.png', '/c.png'];
    await expect(
      assertRefImagesWithinBudget(paths, 'reference_image', { statSize: fakeStat(5 * MB) }),
    ).resolves.toBeUndefined();
  });

  it('张数没超但总量超 → 拒(9 张小图与 2 张巨图是不同的失败面)', async () => {
    const paths = ['/big1.png', '/big2.png'];
    await expect(
      assertRefImagesWithinBudget(paths, 'reference_image', { statSize: fakeStat(80 * MB) }),
    ).rejects.toThrow(/参考图总大小 160\.0MB 超过单次上限 100\.0MB\(本次 2 张\)/);
  });

  it('恰好等于上限 → 放行(闸是 >,不是 >=)', async () => {
    const budget = GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES_BY_REF_MODE.reference_image;
    expect(budget).not.toBeNull();
    await expect(
      assertRefImagesWithinBudget(['/exact.png'], 'reference_image', {
        statSize: fakeStat(budget as number),
      }),
    ).resolves.toBeUndefined();
  });

  it('空数组直接放行(文生视频没有参考图,不该被这道闸拦)', async () => {
    const statSize = vi.fn();
    await expect(
      assertRefImagesWithinBudget([], 'reference_image', { statSize: statSize as never }),
    ).resolves.toBeUndefined();
    expect(statSize).not.toHaveBeenCalled();
  });

  it('预算可注入(便于按型号收紧,不写死常量)', async () => {
    await expect(
      assertRefImagesWithinBudget(['/a.png'], 'reference_image', {
        statSize: fakeStat(10 * MB),
        maxTotalBytes: 8 * MB,
      }),
    ).rejects.toThrow(/超过单次上限 8\.0MB/);
  });
});

/**
 * 存量兼容锁。这道闸是随多参考图一起加的,不能顺手把改之前跑得通的单子拒掉。
 *
 * 关键事实(别再想当然):源图不止来自寄存(单张 50MB)——resolveOwnedMedia 走
 * ledger.ghostCanRead,ghost-gallery(network as:'media' 落仓,硬顶 256MB)和
 * ghost-grant 一样放行。所以首尾帧模式**不设闸**是唯一不收紧存量的选择。
 */
describe('first_and_last_frame:不设闸,存量行为原样', () => {
  it('该模式预算为 null(给它加任何有限预算都会收紧存量,改这里就在这炸)', () => {
    expect(GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES_BY_REF_MODE.first_and_last_frame).toBeNull();
  });

  it('两张顶格画廊图(2 × 256MB)→ 放行(改之前能跑,现在也得能跑)', async () => {
    const paths = ['/first.png', '/last.png'];
    await expect(
      assertRefImagesWithinBudget(paths, 'first_and_last_frame', {
        statSize: fakeStat(GHOST_FETCH_MEDIA_MAX_BYTES),
      }),
    ).resolves.toBeUndefined();
  });

  it('不设闸时连 stat 都不做(不给存量路径添 IO)', async () => {
    const statSize = vi.fn();
    await expect(
      assertRefImagesWithinBudget(['/a.png', '/b.png'], 'first_and_last_frame', {
        statSize: statSize as never,
      }),
    ).resolves.toBeUndefined();
    expect(statSize).not.toHaveBeenCalled();
  });

  it('显式注入预算仍然生效(不设闸是表里的缺省,不是硬编码短路)', async () => {
    await expect(
      assertRefImagesWithinBudget(['/a.png'], 'first_and_last_frame', {
        statSize: fakeStat(10 * MB),
        maxTotalBytes: 8 * MB,
      }),
    ).rejects.toThrow(/超过单次上限 8\.0MB/);
  });
});

/**
 * 顺序即防线:readRefImagesWithinBudget 把闸和读取绑在一起,所以"超限时没读
 * 过字节"这件事能在这里真断言——读取替身就是它的入参,被调到就会现形。
 */
describe('过闸→读取一体入口', () => {
  it('9 张 50MB 参考图 → 拒,且 readOne 一次都没被调用', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `/huge${i}.png`);
    const seen: string[] = [];
    const readOne = vi.fn(async (p: string) => `bytes:${p}`);

    await expect(
      readRefImagesWithinBudget(paths, readOne, 'reference_image', {
        statSize: fakeStat(50 * MB, seen),
      }),
    ).rejects.toThrow(/超过单次上限/);
    expect(seen).toHaveLength(9); // stat 过 9 次(只看目录项)
    expect(readOne).not.toHaveBeenCalled(); // 但一个字节都没读
  });

  it('未超限 → 按入参顺序返回读取结果(顺序有语义:首/尾帧、[Image N])', async () => {
    const paths = ['/one.png', '/two.png', '/three.png'];
    // 故意让先发起的解析得更慢,乱序聚合会在这里露馅。
    const delays: Record<string, number> = { '/one.png': 6, '/two.png': 3, '/three.png': 0 };
    const readOne = async (p: string) => {
      await new Promise((r) => setTimeout(r, delays[p]));
      return `bytes:${p}`;
    };

    await expect(
      readRefImagesWithinBudget(paths, readOne, 'reference_image', {
        statSize: fakeStat(1 * MB),
      }),
    ).resolves.toEqual(['bytes:/one.png', 'bytes:/two.png', 'bytes:/three.png']);
  });

  it('首尾帧模式:直接读,不 stat(存量路径一字节 IO 都不多加)', async () => {
    const statSize = vi.fn();
    const readOne = vi.fn(async (p: string) => `bytes:${p}`);

    await expect(
      readRefImagesWithinBudget(['/first.png', '/last.png'], readOne, 'first_and_last_frame', {
        statSize: statSize as never,
      }),
    ).resolves.toEqual(['bytes:/first.png', 'bytes:/last.png']);
    expect(statSize).not.toHaveBeenCalled();
    expect(readOne).toHaveBeenCalledTimes(2);
  });
});
