/**
 * refImageBudget.ts — 图生视频参考图的总字节闸(读文件之前的 OOM 防线)。
 *
 * 为什么需要:多参考图把张数上限放到 9 之后,单次 edit_video 最坏能拖进
 * 9 × 50MB(GHOST_CINDY_DEPOSIT_MAX_BYTES,寄存单张上限)= 450MB 原始字节。
 * 主机侧要把每张读成 base64 data URI 交给上游,这条链上会同时存在:
 *   原始 Buffer(1×)+ base64 字符串(4/3×)+ JSON.stringify 后的请求体(再 4/3×)
 * 峰值约聚合量的 3.7 倍——450MB 的输入足以把 main 进程打到 OOM 或长时间停顿。
 *
 * 所以**先 stat 后读**:stat 只看目录项不碰内容,超限的请求一个字节都不会
 * 被物化。张数闸(GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE + 按型号二次校验)管
 * "几张",这道闸管"多大",两者都要过——9 张小图和 2 张巨图是不同的失败面。
 *
 * 预算取 2 × 寄存单张上限 = 100MB,理由(为何这不会收紧存量路径)见
 * GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES 的注释:该值在首尾帧模式下恒不触发。
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

import { GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES } from '../../shared/ghost.js';

/** stat 注入口(单测替身用);缺省走真实 fs。 */
export type StatSizeFn = (absPath: string) => Promise<number>;

const defaultStatSize: StatSizeFn = async (absPath) =>
  (await fs.promises.stat(absPath)).size;

function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * 参考图总字节校验。超限抛人话错误(调用方折叠成结构化拒绝);未超限时什么
 * 都不做,由调用方继续读字节。
 *
 * 空数组直接放行:文生视频没有参考图,不该在这里被拦。
 */
export async function assertRefImagesWithinBudget(
  absPaths: readonly string[],
  opts: { statSize?: StatSizeFn; maxTotalBytes?: number } = {},
): Promise<void> {
  if (absPaths.length === 0) return;
  const statSize = opts.statSize ?? defaultStatSize;
  const maxTotalBytes = opts.maxTotalBytes ?? GHOST_VIDEO_REF_IMAGE_MAX_TOTAL_BYTES;
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
  opts: { statSize?: StatSizeFn; maxTotalBytes?: number } = {},
): Promise<T[]> {
  await assertRefImagesWithinBudget(absPaths, opts);
  return Promise.all(absPaths.map((p) => readOne(p)));
}
