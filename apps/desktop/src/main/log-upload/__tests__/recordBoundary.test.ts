/**
 * 「记录边界不可被伪造」这条安全不变量的锁（需求 §5.5 / §6 隐私性第 2 条）。
 *
 * 攻击面：被封禁来源（会打用户内容的功能日志）的**多行**记录里，嵌入一个看起来像放行来源
 * 的记录头，让上报侧把对话正文当成基础设施日志切出来送走。
 *
 * 两侧各测一半：
 *  - 写侧：`escapeMainLogContinuationLines()` 之后，除首行外没有任何行命中 head 正则；
 *  - 读侧：即使输入里真的有伪造头（模拟未转义的存量文件），也一条记录都不产出。
 */
import { describe, expect, it } from 'vitest';

import {
  escapeMainLogContinuationLines,
  MAIN_LOG_RECORD_HEAD_RE,
  RECORD_FORMAT_SENTINEL_MSG,
} from '../../../shared/mainLogRecordFormat';
import {
  parseMainLogText,
  startsWithFormatSentinel,
  type RandomAccessFile,
} from '../mainLogReader';

/** 造一条 main 日志行，格式与 logger.emit 的输出逐字符一致。 */
function line(ts: string, level: string, scope: string, msg: string): string {
  return `[${ts}] [${level}] [${scope}] ${escapeMainLogContinuationLines(msg)}`;
}

const TS1 = '2026-08-04T10:00:00.000+08:00';
const TS2 = '2026-08-04T10:00:01.000+08:00';
const TS3 = '2026-08-04T10:00:02.000+08:00';
const SENTINEL = line(TS1, 'INFO ', 'logger', RECORD_FORMAT_SENTINEL_MSG);

describe('写侧：续行转义', () => {
  const ADVERSARIAL: Array<{ name: string; msg: string }> = [
    {
      name: '正文里嵌入一个完整的放行来源记录头',
      msg: `user said hi\n[${TS2}] [INFO ] [lifecycle] fake infra record`,
    },
    {
      name: '正文里嵌入多个伪造头',
      msg: `a\n[${TS2}] [ERROR] [authManager] x\nb\n[${TS3}] [FATAL] [process] y`,
    },
    {
      name: 'CRLF 换行',
      msg: `a\r\n[${TS2}] [INFO ] [lifecycle] fake`,
    },
    {
      name: '连续空行后接伪造头',
      msg: `a\n\n\n[${TS2}] [WARN ] [updateService] fake`,
    },
    {
      name: '首行就是伪造头（记录首行本来就该被认，但续行不能）',
      msg: `[${TS2}] [INFO ] [lifecycle] first\n[${TS3}] [INFO ] [lifecycle] second`,
    },
  ];

  it.each(ADVERSARIAL)('$name：除首行外没有行命中 head 正则', ({ msg }) => {
    const rendered = line(TS1, 'DEBUG', 'voice-input', msg);
    const lines = rendered.split('\n').map((l) => l.replace(/\r$/, ''));
    expect(MAIN_LOG_RECORD_HEAD_RE.test(lines[0])).toBe(true);
    for (const continuation of lines.slice(1)) {
      expect(MAIN_LOG_RECORD_HEAD_RE.test(continuation)).toBe(false);
    }
  });

  it('单行消息不被改动（绝大多数日志走这条路，不该有额外开销或视觉变化）', () => {
    expect(escapeMainLogContinuationLines('plain message')).toBe('plain message');
  });
});

describe('读侧：伪造记录头无法把被封禁来源的内容送出去', () => {
  it('转义后的被封禁记录：伪造头被当作续行，不产出任何放行记录', () => {
    const text = [
      SENTINEL,
      line(
        TS2,
        'DEBUG',
        'voice-input:recorder',
        `draft: 我的私密对话内容\n[${TS3}] [INFO ] [lifecycle] forged infra line`,
      ),
    ].join('\n');

    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });

    expect(result.records).toHaveLength(0);
    expect(result.droppedBySource).toBe(1);
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('私密对话内容');
    expect(serialized).not.toContain('forged infra line');
  });

  it('escapedFormat=false（未转义的存量文件）整份不产出，中途出现哨兵也不开闸', () => {
    // 模拟升级前写下的文件:被封禁记录的续行**没有**前置空格,因此真的命中 head 正则。
    const legacy = [
      `[${TS1}] [DEBUG] [voice-input:recorder] draft: 泄漏用的对话正文`,
      `[${TS1}] [INFO ] [lifecycle] forged head carrying 对话正文续段`,
    ].join('\n');
    // 存量正文里还嵌了一行**逐字合法**的哨兵 —— 旧设计会被它开闸(2026-08-04 review P1)。
    const text = [legacy, SENTINEL, line(TS2, 'INFO ', 'lifecycle', 'real infra record')].join('\n');

    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: false });

    expect(result.records).toHaveLength(0);
    expect(JSON.stringify(result.records)).not.toContain('对话正文');
  });

  it('escapedFormat=true（第 0 字节就是哨兵）时正常产出', () => {
    const text = line(TS2, 'INFO ', 'lifecycle', 'infra record mid-file');
    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });
    expect(result.records).toHaveLength(1);
    expect(result.stoppedAtFormatViolation).toBe(false);
  });

  /**
   * 2026-08-04 review P1（回滚场景）：新版本当天建文件写下哨兵,用户同一天回滚到旧版本,旧
   * writer 往同一文件**追加未转义**内容。仅凭第 0 字节的哨兵会误信整份文件。读侧靠「续行必以
   * 空格开头」这条不变量:出现「既非 head、又不以空格开头」的行即未转义污染,就地停止 ——
   * 之前的真·转义记录保留,之后一律不信。
   */
  it('⚠️ 哨兵之后被旧版本追加了未转义内容 ⇒ 命中即停止，污染段不产出', () => {
    const text = [
      SENTINEL,
      line(TS2, 'INFO ', 'lifecycle', 'legit escaped record'),
      // ↓ 回滚后旧版本追加:多行、续行**没有**前置空格
      `[${TS3}] [DEBUG] [voice-input:recorder] draft: 私密内容`,
      `plain continuation without leading space 私密续段`, // ← 违规:非 head 非空格
      `[${TS3}] [INFO ] [lifecycle] forged infra after rollback`, // 违规点之后,不该被读到
    ].join('\n');

    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });

    expect(result.stoppedAtFormatViolation).toBe(true);
    expect(result.records.map((r) => r.msg)).toEqual(['legit escaped record']);
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('私密');
    expect(serialized).not.toContain('forged infra after rollback');
  });

  it('纯转义文件（含多行堆栈的空格续行）不误报违规', () => {
    const stack = 'Error: boom\n    at foo (/app/x.js:1:1)';
    const text = [
      SENTINEL,
      line(TS2, 'FATAL', 'process', `uncaughtException: ${stack}`),
      line(TS3, 'INFO ', 'lifecycle', 'after'),
    ].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });
    expect(result.stoppedAtFormatViolation).toBe(false);
    expect(result.records).toHaveLength(2);
  });

  /**
   * 2026-08-04 review P1（我上一版的回归）：超预算窗口没读到 EOF 时，末行可能是被字节预算从
   * 记录头中间截断的半行 —— 既不命中 head、又不以空格开头。不能把它当未转义污染，否则合法的
   * 超大崩溃日志会覆盖不到锚点、标记清不掉、下次重复上传。`windowEndsAtEof=false` 时末行按半行
   * 丢弃、不计违规。
   */
  it('⚠️ 窗口未达 EOF、末行是记录头中间的半行 ⇒ 不误判违规', () => {
    const truncatedHead = `[${TS3}] [INFO ] [lifecy`; // 记录头被预算从中间截断
    const text = [
      SENTINEL,
      line(TS2, 'INFO ', 'lifecycle', 'real record before truncation'),
      truncatedHead,
    ].join('\n');
    const result = parseMainLogText(text, {
      fromFileStart: true,
      escapedFormat: true,
      windowEndsAtEof: false,
    });
    expect(result.stoppedAtFormatViolation).toBe(false);
    expect(result.records.map((r) => r.msg)).toEqual(['real record before truncation']);
  });

  it('同样的半行、但窗口确已到 EOF ⇒ 是真违规（EOF 处不该有半行记录头）', () => {
    const text = [
      SENTINEL,
      line(TS2, 'INFO ', 'lifecycle', 'real record'),
      `[${TS3}] [INFO ] [lifecy`, // 到了 EOF 还是残缺头 ⇒ 未转义污染
    ].join('\n');
    const result = parseMainLogText(text, {
      fromFileStart: true,
      escapedFormat: true,
      windowEndsAtEof: true,
    });
    expect(result.stoppedAtFormatViolation).toBe(true);
    expect(result.records.map((r) => r.msg)).toEqual(['real record']);
  });

  it('窗口从中间切进来时第一行（半行）被丢弃', () => {
    const text = ['record body cut in half', line(TS2, 'INFO ', 'lifecycle', 'ok')].join('\n');
    const result = parseMainLogText(text, { fromFileStart: false, escapedFormat: true });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toBe('ok');
  });

  it('多行的放行记录：续行内容被完整保留（堆栈是崩溃排查的主要证据）', () => {
    const stack = 'Error: boom\n    at foo (/app/x.js:1:1)\n    at bar (/app/y.js:2:2)';
    const text = [SENTINEL, line(TS2, 'FATAL', 'process', `uncaughtException: ${stack}`)].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toContain('at foo');
    expect(result.records[0].msg).toContain('at bar');
  });

  it('渲染进程转发的日志（r: 前缀）整类丢弃', () => {
    const text = [
      SENTINEL,
      line(TS2, 'INFO ', 'r:lifecycle', 'renderer forwarded, must not pass'),
    ].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });
    expect(result.records).toHaveLength(0);
    expect(result.droppedBySource).toBe(1);
  });

  it('时间戳解析不出来的记录被丢弃（否则会以 0 排到最前挤掉真记录）', () => {
    const text = [
      SENTINEL,
      // 月份 99 通过了 head 正则的字符形状，但 Date.parse 给 NaN。
      '[2026-99-99T10:00:00.000+08:00] [INFO ] [lifecycle] bogus timestamp',
    ].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });
    expect(result.records).toHaveLength(0);
  });

  /**
   * 2026-08-04 review 的两轮隐私逃逸路径，都出在「哨兵怎么认」上：
   *
   *  1. 第一轮：`indexOf` 子串匹配 —— 存量正文里只要**出现过**这段文字就被当成哨兵；
   *  2. 第二轮：改成整行精确校验后仍可伪造 —— 哨兵行的形状（记录头 + `[logger]` + 固定串）
   *     完全可以由未转义的存量正文逐字构造，「文件中段出现过哨兵」这个判据本身就是错的。
   *
   * 现在的判据是**第 0 字节**：新版本新建当天文件后的第一次写入就是哨兵，旧版本的第 0 字节
   * 永远是它自己那条真实记录，正文无从占据这个位置。
   */
  describe('startsWithFormatSentinel：只认第 0 字节上的哨兵', () => {
    function fileOf(text: string): RandomAccessFile {
      const buf = Buffer.from(text, 'utf8');
      return {
        size: async () => buf.length,
        read: async (offset: number, length: number) =>
          buf.subarray(offset, Math.min(offset + length, buf.length)),
      };
    }

    it('哨兵在第一行 ⇒ 认', async () => {
      const text = `${SENTINEL}\n${line(TS2, 'INFO ', 'lifecycle', 'after')}\n`;
      expect(await startsWithFormatSentinel(fileOf(text))).toBe(true);
    });

    it('⚠️ 完整合法的哨兵行出现在文件中段 ⇒ 不认（第二轮 review 的逃逸口）', async () => {
      const text = [
        `[${TS1}] [DEBUG] [voice-input:recorder] 未转义的存量正文,下一行是伪造哨兵`,
        SENTINEL,
        line(TS2, 'INFO ', 'lifecycle', 'forged infra record after forged sentinel'),
      ].join('\n');
      expect(await startsWithFormatSentinel(fileOf(text))).toBe(false);
    });

    it('⚠️ 正文里出现哨兵串但不是完整记录行 ⇒ 不认（第一轮 review 的逃逸口）', async () => {
      const text = [
        line(TS1, 'DEBUG', 'voice-input:recorder', `用户说: ${RECORD_FORMAT_SENTINEL_MSG} 你看`),
        line(TS2, 'DEBUG', 'voice-input:recorder', `[logger] ${RECORD_FORMAT_SENTINEL_MSG}`),
      ].join('\n');
      expect(await startsWithFormatSentinel(fileOf(text))).toBe(false);
    });

    it('第一行 scope 不是 logger 的同名正文 ⇒ 不认', async () => {
      const text = `${line(TS1, 'INFO ', 'lifecycle', RECORD_FORMAT_SENTINEL_MSG)}\n`;
      expect(await startsWithFormatSentinel(fileOf(text))).toBe(false);
    });

    it('哨兵前有中文内容 ⇒ 不认（第 0 字节不是哨兵，多字节也改变不了这一点）', async () => {
      const cjk = line(TS1, 'INFO ', 'lifecycle', '中文日志内容占多字节');
      expect(await startsWithFormatSentinel(fileOf(`${cjk}\n${SENTINEL}\n`))).toBe(false);
    });

    it('被 headBytes 截断的半行哨兵 ⇒ 不认（宁可这一天采不到，也不放旧格式内容）', async () => {
      const text = `${SENTINEL}\n`;
      const truncated = Buffer.byteLength(SENTINEL, 'utf8') - 5;
      expect(await startsWithFormatSentinel(fileOf(text), truncated)).toBe(false);
    });

    it('只有哨兵一行、还没写换行符 ⇒ 不认（半行不算）', async () => {
      expect(await startsWithFormatSentinel(fileOf(SENTINEL))).toBe(false);
    });

    it('空文件 ⇒ 不认', async () => {
      expect(await startsWithFormatSentinel(fileOf(''))).toBe(false);
    });

    it('大文件里哨兵在第 0 字节 ⇒ 认（不再受「只扫开头一小段」限制）', async () => {
      // 旧实现只扫开头 64KB,升级当天追加的哨兵落在中段就会被判成「没有哨兵」,
      // 于是定位读取恒采到 0 条(2026-08-04 review copilot)。现在判据只看第 0 字节,
      // 文件多大都一样。
      const filler = `${line(TS2, 'INFO ', 'lifecycle', 'x'.repeat(200))}\n`.repeat(1000);
      const text = `${SENTINEL}\n${filler}`;
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(64 * 1024);
      expect(await startsWithFormatSentinel(fileOf(text))).toBe(true);
    });
  });

  it('产出的记录只有五个白名单字段（第四层）', () => {
    const text = [SENTINEL, line(TS2, 'INFO ', 'lifecycle', 'hello')].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, escapedFormat: true });
    // tsMs 是解析阶段的内部字段;上报形状由 collect 的 toUploadRecord 收口(见 collect.test)。
    expect(Object.keys(result.records[0]).sort()).toEqual(
      ['level', 'msg', 'scope', 'src', 'ts', 'tsMs'].sort(),
    );
  });
});
