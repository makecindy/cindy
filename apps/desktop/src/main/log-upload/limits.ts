/**
 * 单次上报的体量上限（需求 §4.6：回溯天数、每文件字节、合并后条数、单条正文长度四个
 * 维度都要设限，避免一次把 30 天全量日志灌上去）。
 *
 * 全部集中在这里，方便上线后按实际体量分布调整；改动时记得同步方案文档 §3.2。
 */

import { LOG_RETENTION_DAYS } from '../../shared/logRetention';

/** 默认只回溯最近两天（手动上报的典型场景：用户刚遇到问题就来报）。 */
export const MAX_LOOKBACK_DAYS_DEFAULT = 2;

/**
 * 回溯天数的硬上限 = 本地日志保留天数。
 *
 * 直接复用 logger 的常量而不是再写一个 30：两个数字一旦漂移，补传窗口会去读已经被
 * 清理掉的天，白跑一趟还可能把「采到 0 条」误当成崩溃现场丢失。
 */
export const MAX_LOOKBACK_DAYS_CAP = LOG_RETENTION_DAYS;

/** 单个文件最多读多少字节。 */
export const MAX_BYTES_PER_FILE = 8 * 1024 * 1024;

/**
 * 单次上报**所有文件合计**最多读多少字节。
 *
 * 必须有这道总闸：崩溃补传的窗口按最早一次未传崩溃放宽，最坏情况是 30 天 × 每天一个
 * 文件，只有 per-file 闸的话总量会到几百 MB。文件按「与崩溃锚点的接近程度」排序后
 * 依次读，预算耗尽即停，所以被砍掉的一定是离崩溃最远的那些天。
 */
export const MAX_BYTES_TOTAL = 24 * 1024 * 1024;

/** 合并后最多上报多少条记录（超出按锚点距离裁剪，见 collect.ts）。 */
export const MAX_RECORDS = 4000;

/** 单条正文最大字符数，超出截断并标注原长度。 */
export const MAX_MSG_CHARS = 2000;

/**
 * 定位读取的「预卷」：从崩溃锚点往前多读这么久，保证崩溃前的上下文也在窗口里。
 * 崩溃现场光有崩溃那一刻的记录没用，前几分钟的链路才是线索。
 */
export const ANCHOR_PRE_ROLL_MS = 2 * 60 * 1000;

/** 每扫多少行让出一次事件循环，避免长时间霸占 main 线程。 */
export const YIELD_EVERY_LINES = 2000;

/** 单批最多多少条记录。 */
export const MAX_LOGS_PER_BATCH = 500;

/** 单批最大字节数（服务端上限 3MB，这里留足余量）。 */
export const MAX_BATCH_BYTES = 1024 * 1024;

/** 单批请求超时。 */
export const BATCH_TIMEOUT_MS = 20_000;

/**
 * 自动路径（崩溃即时 / 启动补传）的最小间隔。
 * 崩溃-重启-崩溃的循环下，没有这道闸会把上报刷爆（需求 §4.5）。
 */
export const AUTO_UPLOAD_MIN_INTERVAL_MS = 5 * 60 * 1000;
