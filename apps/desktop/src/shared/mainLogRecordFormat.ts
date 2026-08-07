/**
 * `main-<date>.log` 的**记录边界格式** —— 写侧与读侧共用的唯一事实源。
 *
 * ⚠️ 这不是排版约定，是**安全不变量**。
 *
 * 日志上报（`main/log-upload/`）按行首特征识别一条记录的起点，并据此判断该记录的来源
 * scope 是否在放行名单内。因此写侧必须保证「**除记录首行外，没有任何行以边界特征
 * 开头**」——否则一条被封禁来源（例如带用户输入的功能日志）的多行内容里，可以嵌入一个
 * 伪造的「放行来源」记录头，把对话正文伪装成基础设施日志送出去。
 *
 * 这两侧是同一条不变量的两半：
 *   - 写侧：`logger.ts` 的 `emit()` 在写 main 流之前调用 `escapeMainLogContinuationLines()`；
 *   - 读侧：`log-upload/mainLogReader.ts` 用 `MAIN_LOG_RECORD_HEAD_RE` 切记录。
 * 改任一侧都必须同时确认另一侧，放宽任一侧都是隐私变更。
 *
 * 存量文件的过渡：本模块引入之前写下的日志没有经过转义，仍可能含伪造的记录头。
 * `logger.ts` 因此在每次打开 main 当天文件后写一行 `RECORD_FORMAT_SENTINEL_MSG` 记录，
 * 读侧据此区分「整份文件都由转义版本写成」与「含未转义存量内容」。
 *
 * ⚠️ 哨兵只有落在**文件第 0 字节**时才作为信任凭据（见 `mainLogReader.startsWithFormatSentinel`）。
 * 「文件中段出现过哨兵 ⇒ 后面的内容可信」是**错的**：哨兵行的形状完全由日志正文可以
 * 逐字构造，未转义的存量正文里嵌一行伪造哨兵 + 若干伪造放行记录头，就能把对话正文送出去
 * （2026-08-04 review P1）。而文件第 0 字节不可能是正文——`logger.ts` 新建当天文件后的
 * 第一件事就是写哨兵，旧版本的第 0 字节则永远是它自己那条真实记录。
 */

/**
 * 一条 main 日志记录的行首特征：`[<本地 ISO 时间戳+offset>] [<LEVEL>] [<scope>] `。
 *
 * 与 `logger.ts` 的 `localTimestamp()` + `LEVEL_TAG` 逐字符对应；`LEVEL_TAG` 里
 * `INFO ` / `WARN ` 带补位空格，正则也照抄，不做「宽容匹配」——宽容会让读侧认下写侧
 * 不会产出的形状，等于自己给伪造留门。
 */
export const MAIN_LOG_RECORD_HEAD_RE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})\] \[(TRACE|DEBUG|INFO |WARN |ERROR|FATAL)\] \[([^\]]*)\] /;

/** 写哨兵记录用的 scope（`logger.ts` 自己的 scope）。 */
export const RECORD_FORMAT_SENTINEL_SCOPE = 'logger';

/**
 * 格式哨兵的正文。读侧用「scope === logger 且 msg 恰好等于本串」认它，
 * 因此这里必须是一个不会被正常日志正文命中的字面量。
 */
export const RECORD_FORMAT_SENTINEL_MSG = '#cindy-log-format:2';

/**
 * 续行转义：把 `msg` 里每个换行后的行前置一个空格。
 *
 * 无条件前置（而不是「命中 head 正则时才前置」）是有意的：条件版本会让不变量依赖
 * 两处正则保持同步，而这里只需要一条「续行永远以空格开头 ⇒ 永远不可能以 `[` 开头」
 * 的简单事实。代价是多行消息（堆栈等）的续行多一个前导空格，可读性不受影响。
 *
 * `\r\n` 一并处理：只在 `\n` 后插空格，`\r` 留在上一行末尾，读侧按行切分时会被 trim 掉。
 */
export function escapeMainLogContinuationLines(msg: string): string {
  if (!msg.includes('\n')) return msg;
  return msg.replace(/\n/g, '\n ');
}
