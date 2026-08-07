/**
 * 本地日志的保留天数 —— 写侧（`main/logger.ts` 的按天清理）与读侧（日志上报的回溯窗口
 * 上限）共用的唯一事实源。
 *
 * 放在 shared 而不是 logger 里导出：上报侧的采集管道刻意不 import logger（logger 依赖
 * electron，而采集管道要能在纯 Node 单测里直跑）。两处各写一份 30 的话，窗口会悄悄读到
 * 已被清理掉的天——白跑一趟，还可能把「采到 0 条」误当成崩溃现场丢失。
 */

export const LOG_RETENTION_DAYS = 30;
