/**
 * `main-<date>.log` 的读侧：字节窗口 → 结构化记录。
 *
 * 三件事：
 *  1. **记录边界识别**（`MAIN_LOG_RECORD_HEAD_RE`）—— 与写侧的续行转义是同一条安全
 *     不变量的两半，见 `shared/mainLogRecordFormat.ts`；
 *  2. **未转义的存量文件整份丢弃** —— 转义引入之前写下的日志没有转义，其中可能含伪造的
 *     记录头。判据是「文件第 0 字节就是格式哨兵」，见 `startsWithFormatSentinel`；
 *  3. **定位读取**（`findOffsetAtOrBefore`）—— 单文件超过字节预算时不能简单读尾部，
 *     崩溃后堆积的新日志会把崩溃现场挤出窗口。main 日志按天单文件内时间严格递增且每条
 *     记录首行自带可解析时间戳，因此可以二分查找到崩溃锚点附近的字节偏移。
 *
 * 纯逻辑：不 import electron、不 import logger，文件访问由调用方注入。
 */

import {
  MAIN_LOG_RECORD_HEAD_RE,
  RECORD_FORMAT_SENTINEL_MSG,
  RECORD_FORMAT_SENTINEL_SCOPE,
} from '../../shared/mainLogRecordFormat';
import { MAX_MSG_CHARS } from './limits';
import { redact } from './redact';
import { isAllowedScope } from './sourceAllowlist';
import type { ParsedRecord } from './types';

/** 注入的随机读能力。只暴露「大小」与「按 offset 读」，读不到别的东西。 */
export interface RandomAccessFile {
  size(): Promise<number>;
  /** 读 [offset, offset + length) ；越界时返回实际读到的字节。 */
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ParseMainLogOptions {
  /**
   * 本次窗口是否从文件起始处开始。false 表示窗口是从中间某个偏移切进来的，
   * 第一行可能是半行，必须丢弃。
   */
  fromFileStart: boolean;
  /**
   * 本文件是否**整份**由带续行转义的版本写成（= 第 0 字节就是格式哨兵）。
   * 由调用方用 `startsWithFormatSentinel()` 判定后传入。
   *
   * false 表示文件里含（或可能含）未转义的存量内容 —— 一条也不产出。不做「哨兵之后
   * 才信」的细分：哨兵行的形状由正文可以逐字构造，未转义正文里嵌一行伪造哨兵就能开闸
   * （2026-08-04 review P1）。文件级 all-or-nothing 才是能自证的判据。
   */
  escapedFormat: boolean;
  /**
   * 本次读取窗口是否读到了**文件末尾**。默认 `true`（整份读或读到 EOF）。
   *
   * 为 `false`（超预算文件从中间切一个窗口、没读到结尾）时，窗口的**最后一行**可能是被字节
   * 预算从中间截断的半行 —— 它既不是完整记录头、也不以空格开头。若不特判，读侧的记录边界
   * 校验会把这条合法的半行误判成「未转义污染」而丢弃、并让该文件覆盖不到崩溃锚点，标记清不掉、
   * 下次启动重复上传同一崩溃窗口（2026-08-04 review P1）。所以窗口未达 EOF 时，末行按半行丢弃，
   * 不计违规。
   */
  windowEndsAtEof?: boolean;
  /** 用于抹掉真实用户名（见 redact）。 */
  homeDir?: string;
}

export interface ParseMainLogResult {
  records: ParsedRecord[];
  linesScanned: number;
  droppedBySource: number;
  /**
   * 解析是否因命中「未转义续行」而提前停止（见解析循环里的记录边界读侧校验）。供采集端观察
   * 回滚污染。true 时本文件从该点起的内容一律未被信任。
   */
  stoppedAtFormatViolation: boolean;
}

interface PendingRecord {
  tsStr: string;
  tsMs: number;
  level: string;
  scope: string;
  lines: string[];
}

function isSentinel(scope: string, msg: string): boolean {
  return scope === RECORD_FORMAT_SENTINEL_SCOPE && msg.trim() === RECORD_FORMAT_SENTINEL_MSG;
}

/** 第四层的截断：超长正文截断并标注原长度，避免把大 blob 灌进上报。 */
export function truncateMsg(msg: string): string {
  if (msg.length <= MAX_MSG_CHARS) return msg;
  return `${msg.slice(0, MAX_MSG_CHARS)}…(truncated, ${msg.length} chars)`;
}

/**
 * 解析一段 main 日志文本。
 *
 * 一条记录 = 一个命中 head 正则的行 + 其后所有**未命中**的行（续行）。写侧保证续行
 * 永远以空格开头，因此续行不可能命中 head 正则——这正是「被封禁来源的多行内容里嵌入
 * 伪造记录头」这条逃逸路径被堵死的地方。
 */
export function parseMainLogText(
  text: string,
  options: ParseMainLogOptions,
): ParseMainLogResult {
  // 未转义的存量文件:一条也不产出。调用方本应连窗口都不读(见 collect.ts),这里是同一条
  // 判据的第二道 —— 参数忘了传对时失败方向必须是「少传」。
  if (!options.escapedFormat) {
    return { records: [], linesScanned: 0, droppedBySource: 0, stoppedAtFormatViolation: false };
  }

  const records: ParsedRecord[] = [];
  let linesScanned = 0;
  let droppedBySource = 0;
  let pending: PendingRecord | null = null;

  const flush = (): void => {
    if (!pending) return;
    const current = pending;
    pending = null;
    const rawMsg = current.lines.join('\n');
    // 哨兵记录本身不上报(它不是信任凭据,只是一行标记 —— 信任来自 escapedFormat)。
    if (isSentinel(current.scope, rawMsg)) return;
    // 第二层:来源白名单。deny-by-default,未知来源直接丢。
    if (!isAllowedScope(current.scope)) {
      droppedBySource += 1;
      return;
    }
    // 第三层 + 第四层:红线脱敏 → 截断。顺序不能换 —— 先截断会把一个刚好跨越截断点的
    // 凭证切成两半,后半段留在正文里逃过脱敏。
    records.push({
      ts: current.tsStr,
      tsMs: current.tsMs,
      level: current.level.trim(),
      src: 'main',
      scope: current.scope,
      msg: truncateMsg(redact(rawMsg, options.homeDir)),
    });
  };

  let stoppedAtFormatViolation = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // 窗口从中间切进来时,第一行可能是半行 —— 丢掉,避免把半行当完整记录或续行。
    if (i === 0 && !options.fromFileStart) continue;
    const line = lines[i].replace(/\r$/, '');
    linesScanned += 1;
    const head = MAIN_LOG_RECORD_HEAD_RE.exec(line);
    if (head) {
      flush();
      const tsMs = Date.parse(head[1]);
      pending = {
        tsStr: head[1],
        // 时间戳解析不出来的记录无法参与锚点打分与排序,按 0 处理会把它排到最前面并
        // 挤掉真实记录 —— 直接标成 NaN,由下游过滤掉。
        tsMs: Number.isFinite(tsMs) ? tsMs : Number.NaN,
        level: head[2],
        scope: head[3],
        lines: [line.slice(head[0].length)],
      };
      continue;
    }
    // ── 记录边界不变量的读侧校验（2026-08-04 review：回滚场景）────────────────────
    // 转义格式下,续行**永远以空格开头**(escapeMainLogContinuationLines)。所以在一份可信
    // (第 0 字节是哨兵)的文件里,除记录首行外每一行要么命中 head、要么以空格开头。
    // 出现「既不是 head、又不以空格开头」的行 = 未转义的存量内容 —— 典型来路:新版本当天建了
    // 文件(写下哨兵),用户同一天回滚到旧版本,旧 writer 往同一个文件**追加**了没有续行转义的
    // 内容。仅凭第 0 字节的哨兵会误信整份文件,让旧多行正文里那些恰好像放行记录头的行被当成
    // 独立基础设施记录送走。命中即**就地停止**:此前那段(哨兵之后、污染之前)是真·转义内容,
    // 保留;之后一律不信(fail closed)。
    if (line.startsWith(' ')) {
      // 合法续行:并入当前记录。没有当前记录(窗口第一行就是续行)则丢弃。
      if (pending) pending.lines.push(line);
      continue;
    }
    // 窗口的**最后一行**在两种情况下不是违规,只是半行 / 分隔产物,丢弃即可,不能停止解析:
    //   - split 的行尾空串(文件以 '\n' 结尾);
    //   - 窗口没读到 EOF 时,末行被字节预算从中间截断(可能正好停在记录头中间,既不命中 head
    //     又不以空格开头)。若把它当违规,合法的超大崩溃日志会覆盖不到锚点、标记清不掉、
    //     下次重复上传(2026-08-04 review P1)。
    const isLastLine = i === lines.length - 1;
    const windowEndsAtEof = options.windowEndsAtEof ?? true;
    if (isLastLine && (line === '' || !windowEndsAtEof)) continue;
    // 违规:先 flush 当前 pending 再停止。pending 是「head + 若干合法空格续行」的完整记录,
    // 违规行是**另起**的一行、不属于它,所以它本身没被污染,该保留;之后一律不信(fail closed)。
    flush();
    stoppedAtFormatViolation = true;
    break;
  }
  flush();

  return {
    records: records.filter((r) => Number.isFinite(r.tsMs)),
    linesScanned,
    droppedBySource,
    stoppedAtFormatViolation,
  };
}

/**
 * 从一整行里解出 epoch ms 时间戳；解不出返回 null。
 *
 * 定位读取对 main（纯文本）与 agent（NDJSON）两种流用不同的解析器 —— 早先只有一个写死的
 * main-header 版本，被用到 NDJSON 上会**一条都解不出**，二分于是恒收敛到文件开头，把超大
 * `agent-*.ndjson` 的读窗口错定在最旧的记录、彻底错过崩溃现场（2026-08-04 review P2）。
 */
export type LineTimestampParser = (line: string) => number | null;

/** main 流：`[<ISO>] [LEVEL] [scope] ` 记录头里的时间戳。 */
export const parseMainHeadTimestamp: LineTimestampParser = (line) => {
  const head = MAIN_LOG_RECORD_HEAD_RE.exec(line);
  if (!head) return null;
  const tsMs = Date.parse(head[1]);
  return Number.isFinite(tsMs) ? tsMs : null;
};

/**
 * 二分查找：返回一个**不晚于 `targetMs` 的读取起点**（字节偏移）。
 *
 * 精确到 `probeBytes`：循环收敛到 `hi - lo <= probeBytes` 就返回 `lo`，所以结果通常落在
 * 目标时刻**之前**最多 `probeBytes` 字节处，而不是「第一条 ≥ targetMs 的记录行首」。这是
 * 有意的——多读一点只是多几条早于锚点的记录，少读会把锚点本身切掉。
 *
 * `parseTimestamp` 决定按哪种行格式解时间戳（main 记录头 / NDJSON）。**必须**与被读文件的
 * 格式匹配：用错解析器会让每次探测都返回 null，二分恒收敛到 0（见 `parseTimestamp` 上的注释）。
 *
 * 全文都早于 targetMs 时返回文件末尾附近；文件为空返回 0。
 *
 * 前提：单个日志文件内记录时间**单调不减**（logger 按天 rotate + 追加写，同一进程内 emit
 * 顺序即时间顺序；多实例并发追加可能出现极小的乱序，对定位无实质影响）。
 */
export async function findOffsetAtOrBefore(
  file: RandomAccessFile,
  targetMs: number,
  parseTimestamp: LineTimestampParser = parseMainHeadTimestamp,
  probeBytes = 8 * 1024,
): Promise<number> {
  const size = await file.size();
  if (size <= 0) return 0;
  let lo = 0;
  let hi = size;
  // 循环不变量:[lo, hi) 内包含答案。每轮把区间砍半,probeBytes 的读取只用于定位行首。
  while (hi - lo > probeBytes) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const found = await firstRecordTimestampAt(file, mid, probeBytes, parseTimestamp);
    if (found === null) {
      // 该探测点附近读不到完整记录(超长行等),保守往左收,宁可多读。
      hi = mid;
      continue;
    }
    if (found >= targetMs) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** 从 offset 起找到第一个完整行,用 `parseTimestamp` 解其时间戳。找不到返回 null。 */
async function firstRecordTimestampAt(
  file: RandomAccessFile,
  offset: number,
  probeBytes: number,
  parseTimestamp: LineTimestampParser,
): Promise<number | null> {
  const buf = await file.read(offset, probeBytes);
  if (buf.length === 0) return null;
  const text = buf.toString('utf8');
  const nl = text.indexOf('\n');
  // offset 落在行中间:从下一行开始看。offset === 0 时当前行就是完整行。
  const body = offset === 0 ? text : nl >= 0 ? text.slice(nl + 1) : '';
  for (const line of body.split('\n')) {
    const tsMs = parseTimestamp(line.replace(/\r$/, ''));
    if (tsMs !== null) return tsMs;
  }
  return null;
}

/**
 * 文件**第一行**是否就是格式哨兵 —— 即「整份文件都由带续行转义的版本写成」。
 * 这是本文件唯一的信任凭据；false ⇒ 整份文件不上报。
 *
 * ## 为什么判据是「第 0 字节」而不是「文件里出现过哨兵」
 *
 * 哨兵行的形状（记录头 + `[logger]` + 固定串）**完全由日志正文可以逐字构造**。只要判据是
 * 「出现过」，未转义的存量文件里就能嵌一行伪造哨兵、随后跟若干伪造的放行 scope 记录头，
 * 把对话正文当基础设施日志送出去（2026-08-04 review P1；此前按整行精确校验也只是让伪造
 * 变麻烦，没有消除它）。
 *
 * 而第 0 字节不可能是正文：
 *  - 新版本新建当天文件后的第一次写入就是哨兵（`logger.ensureDailySlot`）；
 *  - 旧版本写的文件，第 0 字节是它自己那条真实记录的记录头，旧版本从不写这个串。
 *
 * ## 代价（有意接受）
 *
 * 跨越升级那一刻的当天文件（前半段是旧版本写的、后半段追加在哨兵之后）整份不可上报。
 * 只影响**每台机器升级当天的那一个文件**：更早的纯存量文件本来就一条都不放行，之后的
 * 文件哨兵都在第 0 字节。用一天的可观测性换掉一条无法自证的信任链，值得。
 *
 * ## 实现约束
 *
 * 只认**完整**的第一行（缓冲区内必须出现 `\n`）：读取长度边界可能把行截断，半行不算。
 * 哨兵行长度固定在 ~60 字节，`headBytes` 只需覆盖一行。
 */
export async function startsWithFormatSentinel(
  file: RandomAccessFile,
  headBytes = 512,
): Promise<boolean> {
  const buf = await file.read(0, headBytes);
  if (buf.length === 0) return false;
  const text = buf.toString('utf8');
  const nl = text.indexOf('\n');
  if (nl < 0) return false;
  return isSentinelLine(text.slice(0, nl).replace(/\r$/, ''));
}

/** 整行是否**就是**一条哨兵记录：合法记录头 + scope 为 logger + 正文恰好是哨兵串。 */
function isSentinelLine(line: string): boolean {
  const head = MAIN_LOG_RECORD_HEAD_RE.exec(line);
  if (!head || head[3] !== RECORD_FORMAT_SENTINEL_SCOPE) return false;
  return line.slice(head[0].length).trim() === RECORD_FORMAT_SENTINEL_MSG;
}
