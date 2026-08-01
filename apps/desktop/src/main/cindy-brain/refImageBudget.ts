/**
 * refImageBudget.ts — 图生视频参考图的总字节闸(读文件之前的 OOM 防线)。
 *
 * 为什么需要:`reference_image` 把张数上限放到 9 之后,单次 edit_video 最坏
 * 能拖进 9 张源图,而单张并不小 —— 源图取自 ledger.ghostCanRead 放行的账目,
 * 除寄存(单张 50MB)还包括 ghost-gallery(network as:'media' 落仓,硬顶
 * GHOST_FETCH_MEDIA_MAX_BYTES = 256MB)与 ghost-grant。主机侧要把每张读成
 * base64 data URI 交给上游,这条链上会同时存在:
 *   原始 Buffer(1×)+ base64 字符串(4/3×)+ JSON.stringify 后的请求体(再 4/3×)
 * 峰值约聚合量的 3.7 倍 —— 几百 MB 的输入足以把 main 进程打到 OOM 或长时间停顿。
 *
 * 所以**先 stat 后读**:stat 只看目录项不碰内容,超限的请求一个字节都不会
 * 被物化。张数闸(GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE + 按型号二次校验)管
 * "几张",这道闸管"多大",两者都要过——9 张小图和 2 张巨图是不同的失败面。
 *
 * **预算按 refMode 分档**(见 GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES_BY_REF_MODE):
 * 存量的 first_and_last_frame 不设闸(它本来就没有,且单张源图可达 256MB,
 * 任何有限预算都可能拒掉一单改之前跑得通的活);只有新开的 reference_image
 * 有预算。不设闸的模式连 stat 都不做,不给存量路径添 IO。
 *
 * 顺序即防线,所以读取也收在本模块里(readRefImagesWithinBudget):把"先 stat
 * 后读"做成模块内的结构保证,而不是调用点的约定——约定没人守得住,顺序被换
 * 掉时也没有测试会红。
 *
 * 与 cindySlot 的分工:那边是协议/资格审层(拿指纹、不碰文件系统),这道闸
 * 需要真实文件大小,只能落在已经握有磁盘路径的主机侧(cindy-brain/index.ts
 * 的 editVideo 注入实现)。
 */

import fs from 'node:fs';

import {
  GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES_BY_REF_MODE,
  type GhostVideoRefMode,
} from '../../shared/ghost.js';

/** stat 注入口(单测替身用);缺省走真实 fs。 */
export type StatSizeFn = (absPath: string) => Promise<number>;

/** 预算注入口(单测用):number = 闸值,null = 不设闸。 */
export type RefImageBudgetOptions = {
  statSize?: StatSizeFn;
  maxTotalBytes?: number | null;
};

const defaultStatSize: StatSizeFn = async (absPath) =>
  (await fs.promises.stat(absPath)).size;

function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** 该模式的预算;opts 显式给了就用 opts(含显式 null = 不设闸)。 */
function resolveBudget(
  refMode: GhostVideoRefMode,
  opts: RefImageBudgetOptions,
): number | null {
  return opts.maxTotalBytes !== undefined
    ? opts.maxTotalBytes
    : GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES_BY_REF_MODE[refMode];
}

/**
 * 参考图总字节校验。超限抛人话错误(调用方折叠成结构化拒绝);未超限时什么
 * 都不做,由调用方继续读字节。
 *
 * 两种情况直接放行、连 stat 都不做:
 *   - 空数组:文生视频没有参考图,不该在这里被拦;
 *   - 该 refMode 不设闸(预算为 null):存量路径原样,不添 IO。
 */
export async function assertRefImagesWithinBudget(
  absPaths: readonly string[],
  refMode: GhostVideoRefMode,
  opts: RefImageBudgetOptions = {},
): Promise<void> {
  if (absPaths.length === 0) return;
  const maxTotalBytes = resolveBudget(refMode, opts);
  if (maxTotalBytes === null) return;
  const statSize = opts.statSize ?? defaultStatSize;
  const sizes = await Promise.all(absPaths.map((p) => statSize(p)));
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total > maxTotalBytes) {
    throw new Error(
      `参考图总大小 ${toMb(total)}MB 超过单次上限 ${toMb(maxTotalBytes)}MB` +
        `(本次 ${absPaths.length} 张),请换更小的图或减少张数`,
    );
  }
}

/**
 * 过闸 → 读取。调用方只该用这个入口:闸与读取绑在一起,顺序就不再是调用点
 * 的自觉,超限时 readOne 一次都不会被调到(单测直接锁这一点)。
 *
 * 结果保序(Promise.all 语义):参考图的顺序有语义——首尾帧模式下是首/尾,
 * 多参考图模式下是提示词里 `[Image 1]`… 的序号,不能乱。
 */
export async function readRefImagesWithinBudget<T>(
  absPaths: readonly string[],
  readOne: (absPath: string) => Promise<T>,
  refMode: GhostVideoRefMode,
  opts: RefImageBudgetOptions = {},
): Promise<T[]> {
  await assertRefImagesWithinBudget(absPaths, refMode, opts);
  return Promise.all(absPaths.map((p) => readOne(p)));
}
