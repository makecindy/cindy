/**
 * mirrorCacheBarrier —— 镜像缓存的**跨进程作废屏障**(持久计数器)。
 * ---------------------------------------------------------------------------
 * 跨进程锁只保证「清理」与「提交」不重叠,挡不住这一种:B 的写入**在清理之前**就取到了内容,
 * 却在清理结束、锁释放之后才提交 —— 那份内容是被撤销设备 / 上一个账号的旧正文,照写等于把它
 * 重建出来(review: codex P1)。
 *
 * 机制:写入侧在**发起时**读一次计数,提交前(锁内)再读一次;变了就丢弃这次写。用计数而不是
 * 时间戳 —— 毫秒精度下"清理在同一毫秒内跑完"时时间戳挡不住,计数没有精度问题。
 *
 * 为什么单独成模块:`mirrorCacheStore`(清理与写入)与 `mirrorCachePurgeQueue`(失败重试的
 * 消化)都要动这些计数器 —— 队列在补删掉残留之后必须**顺手把屏障修好**,否则「自增失败 →
 * 只登记了文件 → 队列删掉文件、扔掉记录、计数原样」的组合会让一笔迟到的、仍握着旧计数的写入
 * 在消化之后通过比对,把已清掉的正文重建回来(review: codex P1)。两个模块共用同一份实现,
 * 也保证"落位方式 / 三态语义"不会各写一遍走偏。
 *
 * 位置:计数器住在缓存根的**兄弟**目录 `<cache-root>.control/cleared/` —— `clearAll()` 会
 * 递归删掉整棵缓存根,放在里面等于把自己的屏障一起删掉(缺失会被读成初始值 0,与发起时读到的
 * 一样 → 屏障失效)。仍在 owner 命名空间内,切账号照样隔离。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** 控制面目录后缀(与缓存根同级,clearAll 不会删它)。 */
export const CACHE_CONTROL_SUFFIX = '.control';
const CLEARED_DIR = 'cleared';
/** 列表快照是整份写,任何设备被清都可能让它变陈旧 → 用一个共享计数器。 */
export const CLEARED_ANY = '_any';
/** 账号级(登出 / 切账号 / clearAll)计数器:它删的是整棵缓存根,而计数器在根之外。 */
export const CLEARED_ACCOUNT = '_account';

/**
 * 作废计数的三态读取结果:
 *  - number:计数(缺文件 = 0,从未清过);
 *  - `'denied'`:文件在那儿但**没权限**读(EACCES / EPERM)—— 屏障可能是真的,fail-closed;
 *  - `'unknown'`:资源类失败(EMFILE / EBUSY…)或内容不是数字 —— **无法比对**,写入侧一律
 *    按"可能清过"处理(fail-closed)。取舍很不对称:少写一次缓存只是少一次首屏加速,而放行
 *    一笔可能取自清理之前的内容,等于把被撤销设备 / 上个账号的正文重建到盘上(review: codex
 *    P1)。计数文件是原子落位的,所以"内容不是数字"只会来自外部损坏,那时更不该信它。
 */
export type ClearCounter = number | 'denied' | 'unknown';

export function controlDir(root: string): string {
  return `${root}${CACHE_CONTROL_SUFFIX}`;
}

/** 镜像缓存的跨进程锁文件(store 的写入 / 清理与 purge 队列的补删都用它互斥)。 */
export function cacheLockPath(root: string): string {
  return path.join(controlDir(root), 'lock');
}

export function clearedMarkPath(root: string, key: string): string {
  return path.join(controlDir(root), CLEARED_DIR, key);
}

/** 对外暴露的计数值:非数字(denied / unknown)一律用 -1 表示"不可比对"。 */
export function numericCounter(value: ClearCounter): number {
  return typeof value === 'number' ? value : -1;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export async function readClearCounter(root: string, key: string): Promise<ClearCounter> {
  try {
    const raw = await fsp.readFile(clearedMarkPath(root, key), 'utf8');
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : 'unknown';
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
    if (code === 'EACCES' || code === 'EPERM') return 'denied';
    return 'unknown';
  }
}

/**
 * 自增作废计数。**失败会抛** —— 这是跨进程唯一的持久屏障:另一个实例可能已经读到旧计数
 * 并在锁上等着,自增落不下去却报"清干净了"的话,它会在清理之后把被撤销设备 / 上一个账号的
 * 正文重建出来。落不下去就让调用方把这次清理当成"没清完",登记重试。
 */
export async function bumpClearedCounter(root: string, key: string): Promise<void> {
  const file = clearedMarkPath(root, key);
  const read = await readClearCounter(root, key);
  // 旧值读不出来时**不能**当 0 重来:曾经读到合法值 1 的写入,会在"清理后又被写成 1"的计数上
  // 比对成功,把刚删掉的正文重建出来。既然这是唯一的持久屏障,读不出旧值就让自增失败 ——
  // 调用方会把这次清理登记成"没清完"(purge 队列),而 purge 记录挂着期间缓存读一律被挡掉,
  // 于是失效方向是"缓存关掉",不是"旧明文回来"(review: codex P1)。
  if (typeof read !== 'number') {
    throw new Error(`mirror cache: clear counter unreadable (${read}) for ${key}`);
  }
  await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  // 原子落位:直接 writeFile 会有"截断了、新内容还没写完"的窗口,那一刻读出来是空串 →
  // `'unknown'`,而 unknown 是 fail-closed,撕裂一次就会把这个 key 的缓存写入长期挡住。
  // 计数文件里只有一个数字,tmp 残留不含正文,清理失败可忽略。
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, String(read + 1), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
