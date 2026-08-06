/**
 * 采集编排的隐私锁与可靠性锁。
 *
 * 最重要的一条是第一个 describe：**会话目录与调试原文即使存在也不被读取**（需求 §6 隐私性
 * 第 1 条）。断言方式是「注入的 openFile 从未收到那些路径」，而不是「结果里没有对话内容」——
 * 后者在实现改成「读了但过滤掉」时照样会通过，而那已经是隐私事故（内容进过进程内存、也可能
 * 被别的日志带出去）。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  escapeMainLogContinuationLines,
  RECORD_FORMAT_SENTINEL_MSG,
} from '../../../shared/mainLogRecordFormat';
import {
  collectLogs,
  computeCoveredAnchors,
  earliestAnchorOnDay,
  resolveLookbackDays,
  trimByAnchors,
  type CollectDeps,
  type FileCoverageMap,
} from '../collect';
import { MAX_LOOKBACK_DAYS_CAP, MAX_RECORDS } from '../limits';
import type { ParsedRecord } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定「现在」：2026-08-04 12:00 本地时间。测试不依赖真实时钟。 */
const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();

function isoLocal(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function mainLine(tsMs: number, level: string, scope: string, msg: string): string {
  return `[${isoLocal(tsMs)}] [${level}] [${scope}] ${escapeMainLogContinuationLines(msg)}`;
}

function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 内存文件系统 harness：记录所有被打开的路径。 */
function harness(files: Record<string, string>): {
  deps: CollectDeps;
  openedPaths: string[];
} {
  const openedPaths: string[] = [];
  const logDir = path.join('/tmp', 'cindy-logs');
  const deps: CollectDeps = {
    logDir,
    listDir: async (dir) => {
      if (dir !== logDir) throw new Error(`unexpected listDir ${dir}`);
      // 只返回 logs 根的**文件名**,与真实 readdir 一致(子目录名也会出现,这里刻意包含
      // 'sessions' 来验证采集端不会顺着它往下走)。
      return Object.keys(files)
        .map((p) => p.slice(logDir.length + 1))
        .filter((rel) => !rel.includes(path.sep))
        .concat(['sessions']);
    },
    openFile: async (filePath) => {
      openedPaths.push(filePath);
      const content = files[filePath];
      if (content === undefined) return null;
      const buf = Buffer.from(content, 'utf8');
      return {
        size: async () => buf.length,
        read: async (offset: number, length: number) =>
          buf.subarray(offset, Math.min(offset + length, buf.length)),
        close: async () => undefined,
      };
    },
    now: () => NOW,
    homeDir: '/Users/tester',
    yieldToEventLoop: async () => undefined,
    joinPath: (...parts) => path.join(...parts),
  };
  return { deps, openedPaths };
}

const SENTINEL = mainLine(NOW - 60_000, 'INFO ', 'logger', RECORD_FORMAT_SENTINEL_MSG);

describe('第一层源白名单：会话目录与调试原文永不被打开', () => {
  it('诱饵文件存在也不被读取，且内容不出现在结果里', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const files: Record<string, string> = {
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'before-quit received'),
      ].join('\n'),
      // ↓ 全是诱饵:采集端一旦构造这些路径,openedPaths 断言就会红。
      [path.join(logDir, 'sessions', 'abc', `${today}.ndjson`)]: JSON.stringify({
        ts: NOW,
        level: 'info',
        source: 'maker',
        scope: 'maker/s:abc',
        msg: '用户的完整对话正文',
      }),
      [path.join(logDir, 'sessions', 'abc', 'cc-debug.raw.log')]: '请求与响应原文',
      [path.join(logDir, 'cc-debug.raw.log')]: '全局请求响应原文',
    };
    const { deps, openedPaths } = harness(files);

    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [NOW - 30_000] });

    for (const opened of openedPaths) {
      expect(opened).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(opened).not.toContain('cc-debug');
    }
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('对话正文');
    expect(serialized).not.toContain('原文');
    expect(result.records).toHaveLength(1);
  });

  it('手动上报不读 agent 流（只在崩溃路径作上下文）', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const files: Record<string, string> = {
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'ok'),
      ].join('\n'),
      [path.join(logDir, `agent-${today}.ndjson`)]: JSON.stringify({
        ts: NOW - 20_000,
        level: 'info',
        source: 'proxy',
        scope: 'cc-proxy/req',
        msg: 'POST /v1/messages 200 812ms',
      }),
    };
    const { deps, openedPaths } = harness(files);

    await collectLogs(deps, { reason: 'manual', anchors: [] });

    expect(openedPaths.some((p) => p.includes('agent-'))).toBe(false);
  });

  it('崩溃路径读 agent 流，但只取 proxy 源', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const files: Record<string, string> = {
      [path.join(logDir, `main-${today}.log`)]: SENTINEL,
      [path.join(logDir, `agent-${today}.ndjson`)]: [
        JSON.stringify({
          ts: NOW - 20_000,
          level: 'info',
          source: 'proxy',
          scope: 'cc-proxy/req',
          msg: 'POST /v1/messages 200 812ms',
        }),
        // maker 源:可能带 agent 提示词与用户内容,必须丢。
        JSON.stringify({
          ts: NOW - 19_000,
          level: 'debug',
          source: 'maker',
          scope: 'maker/s:abc',
          msg: '用户提示词正文',
        }),
        // source 被写成 proxy 但 scope 不在 proxy 根下:双闸拦下。
        JSON.stringify({
          ts: NOW - 18_000,
          level: 'debug',
          source: 'proxy',
          scope: 'maker/s:abc',
          msg: '伪装成 proxy 的用户内容',
        }),
      ].join('\n'),
    };
    const { deps } = harness(files);

    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [NOW - 20_000] });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].src).toBe('proxy');
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('提示词');
    expect(serialized).not.toContain('伪装');
  });
});

/**
 * 「整份文件的格式信任」这条判据的锁（2026-08-04 review）。判据 = 第 0 字节就是格式哨兵。
 * 两个方向都要锁住：不满足时一条都不产出，满足时不受文件大小与读窗口位置影响。
 */
describe('格式信任：只信第 0 字节就是哨兵的 main 文件', () => {
  const logDir = path.join('/tmp', 'cindy-logs');

  it('没有哨兵的存量文件整份跳过，并单独计数', async () => {
    const today = dayKey(NOW);
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: [
        mainLine(NOW - 40_000, 'INFO ', 'lifecycle', 'legacy infra record'),
        mainLine(NOW - 30_000, 'FATAL', 'process', 'legacy crash record'),
      ].join('\n'),
    });

    const result = await collectLogs(deps, { reason: 'manual', anchors: [] });

    expect(result.records).toHaveLength(0);
    expect(result.stats.filesSkippedLegacyFormat).toBe(1);
  });

  it('哨兵在第 0 字节、但被封禁来源在中段伪造了一行哨兵 ⇒ 正常按转义格式解析', async () => {
    const today = dayKey(NOW);
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        // 被封禁来源的多行正文,续行已转义 ⇒ 伪造哨兵只是续行,不影响任何判定。
        mainLine(
          NOW - 40_000,
          'DEBUG',
          'voice-input:recorder',
          `draft: 私密内容\n${SENTINEL}\n${mainLine(NOW - 39_000, 'INFO ', 'lifecycle', '伪造记录')}`,
        ),
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'real infra record'),
      ].join('\n'),
    });

    const result = await collectLogs(deps, { reason: 'manual', anchors: [] });

    expect(result.records.map((r) => r.msg)).toEqual(['real infra record']);
    expect(JSON.stringify(result.records)).not.toContain('私密内容');
    expect(result.stats.filesSkippedLegacyFormat).toBe(0);
  });

  /**
   * 旧实现只扫文件开头 64KB 找哨兵：`logger` 是追加写，升级当天的哨兵会落在文件中段，
   * 于是「窗口从中间切进来」的定位读取判不出哨兵、把整段窗口丢掉，崩溃补传恒采到 0 条
   * （2026-08-04 review copilot）。判据改成第 0 字节后与文件大小、窗口位置都无关。
   */
  it('文件远大于 64KB 且读窗口从中段切入时仍能采到崩溃现场', async () => {
    const crashAt = NOW - 3 * 60 * 60 * 1000;
    const today = dayKey(NOW);
    const filler = (tsMs: number): string =>
      mainLine(tsMs, 'INFO ', 'lifecycle', `noise ${'x'.repeat(300)}`);
    const lines = [SENTINEL];
    // 崩溃之前先堆 ~120KB,把崩溃记录推到远离文件头的位置。
    for (let i = 400; i > 0; i -= 1) lines.push(filler(crashAt - i * 1000));
    lines.push(mainLine(crashAt, 'FATAL', 'process', 'uncaughtException: boom'));
    for (let i = 1; i <= 400; i += 1) lines.push(filler(crashAt + i * 1000));
    const content = lines.join('\n');
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(64 * 1024);

    const { deps } = harness({ [path.join(logDir, `main-${today}.log`)]: content });
    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [crashAt] });

    expect(result.stats.filesSkippedLegacyFormat).toBe(0);
    expect(result.records.some((r) => r.msg.includes('uncaughtException'))).toBe(true);
  });
});

/**
 * 2026-08-04 review P1：coveredAnchors 告诉上报侧「哪些崩溃锚点的窗口确被读到」，只有覆盖到的
 * 标记才该在上报成功后清除。这里锁「读到就覆盖 / 没文件也算覆盖(没东西可补) / 命中未转义污染
 * 而停止则不算整份覆盖」。
 */
describe('崩溃锚点覆盖 coveredAnchors', () => {
  const logDir = path.join('/tmp', 'cindy-logs');

  it('小文件整份读到 ⇒ 当天锚点被覆盖', async () => {
    const crashAt = NOW - 30_000;
    const today = dayKey(NOW);
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(crashAt, 'FATAL', 'process', 'uncaughtException: boom'),
      ].join('\n'),
    });
    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [crashAt] });
    expect(result.coveredAnchors).toContain(crashAt);
  });

  it('锚点那天根本没有日志文件 ⇒ 算覆盖（没东西可补，重试无益）', async () => {
    const today = dayKey(NOW);
    const goneCrash = NOW - 5 * DAY_MS; // 那天没有 main/agent 文件
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'ok'),
      ].join('\n'),
    });
    const result = await collectLogs(deps, {
      reason: 'crash-backfill',
      anchors: [goneCrash],
    });
    expect(result.coveredAnchors).toContain(goneCrash);
  });

  it('⚠️ 命中未转义污染而提前停止 ⇒ 计数;whole 不置位', async () => {
    const crashAt = NOW - 30_000;
    const today = dayKey(NOW);
    // 哨兵 + 一条真记录 + 回滚追加的未转义多行(续行无空格)。
    const content = [
      SENTINEL,
      mainLine(NOW - 60_000, 'INFO ', 'lifecycle', 'legit'),
      `[${isoLocal(crashAt)}] [DEBUG] [voice-input:recorder] draft: x`,
      'plain continuation without leading space',
    ].join('\n');
    const { deps } = harness({ [path.join(logDir, `main-${today}.log`)]: content });
    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [crashAt] });

    expect(result.stats.mainFilesStoppedAtViolation).toBe(1);
    // 命中污染而停止 ⇒ 该文件不算整份读到(whole 不置位),这条由 mainFilesStoppedAtViolation 计数
    // 与后续覆盖判定共同保证。覆盖判定本身走「最近锚点归属」:停止前留下的 lifecycle 记录归属这次
    // 崩溃(单锚点),⇒ 覆盖。这是**有意**的——污染段(未转义)永不解析、其中的记录永远补不出来,
    // 重试无益;既然崩溃邻域已有记录进上报,就清掉标记,避免每次启动对同一份不可读文件无限重传。
    expect(result.coveredAnchors).toContain(crashAt);
  });

  it('⚠️ 同日两次崩溃：A1 附近日志风暴占满 MAX_RECORDS 挤掉 A2 的记录 ⇒ A2 不算覆盖', async () => {
    // 2026-08-06 review P1：coveredAnchors 必须按**裁剪后真正上报的记录**判定，不能按读到的全部。
    // 否则 A2 的记录被 cap 全裁掉、其崩溃现场没进上报，标记却被误清、永久丢失。
    const today = dayKey(NOW);
    const a1 = NOW - 3_000; // 近端崩溃：一大片日志风暴围着它
    const a2 = NOW - 6 * 60 * 60 * 1000; // 同日更早一次崩溃(06:00)
    const lines = [SENTINEL];
    // A1 风暴：MAX_RECORDS+1 条都压在 A1 时刻(距离 0),稳定挤占所有名额。
    for (let i = 0; i < MAX_RECORDS + 1; i += 1) {
      lines.push(mainLine(a1, 'ERROR', 'lifecycle', `storm ${i}`));
    }
    // A2 的唯一一条现场记录：离 A2 有 5s(距离 > A1 风暴的 0),排序时排在风暴之后 ⇒ 必被裁掉。
    lines.push(mainLine(a2 + 5_000, 'FATAL', 'process', 'uncaughtException: earlier crash'));
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: lines.join('\n'),
    });

    const result = await collectLogs(deps, {
      reason: 'crash-backfill',
      anchors: [a1, a2],
    });

    expect(result.stats.droppedByCap).toBeGreaterThan(0);
    // A1 的现场进了上报 ⇒ 覆盖;A2 的现场被整段裁掉 ⇒ **不**覆盖(修复前会因整份读到冒充成已覆盖)。
    expect(result.coveredAnchors).toContain(a1);
    expect(result.coveredAnchors).not.toContain(a2);
    // A2 的记录确实没进上报(否则这条断言失去意义)。
    expect(result.records.some((r) => r.msg.includes('earlier crash'))).toBe(false);
  });
});

/**
 * 2026-08-04 review P1：覆盖判定必须**按文件**（天+流类型），不能按天合并。崩溃现场主体在
 * main 流,agent 只是补充上下文 —— 一个整份读到的小 agent 文件不能替一个只读了靠前窗口的
 * 超大 main 文件背书,否则同日靠后那次崩溃会被误判已覆盖、标记被误清。
 */
describe('computeCoveredAnchors：以 main 为准，agent 不得冒充覆盖', () => {
  const DAY = '2026-08-04';
  const A_EARLY = new Date(2026, 7, 4, 2, 0, 0).getTime();
  const A_LATE = new Date(2026, 7, 4, 22, 0, 0).getTime();
  const both = { hasMain: () => true, hasAgent: () => true };

  it('⚠️ main 只覆盖靠前窗口、agent 整份读到：靠后的崩溃仍判未覆盖', () => {
    // main 只有 A_EARLY 附近的记录留下,没够到 A_LATE;agent 整份(whole)覆盖全天。
    const coverage: FileCoverageMap = new Map([
      [`${DAY}|main`, { whole: false, survivorTs: [A_EARLY] }],
      [`${DAY}|agent`, { whole: true, survivorTs: [] }],
    ]);
    const covered = computeCoveredAnchors([A_EARLY, A_LATE], { coverage, ...both });
    expect(covered).toContain(A_EARLY);
    expect(covered).not.toContain(A_LATE); // ← 修复前会被 agent 的 whole 冒充成已覆盖
  });

  it('⚠️ 同日早/晚崩溃都留下记录、中间那次被裁光：中间锚点不算覆盖（不被两端架桥）', () => {
    // 2026-08-06 review P1：min/max 跨度会把 A_MID 判成已覆盖(它落在 early~late 之间),
    // 但 A_MID 附近一条记录都没留下 —— 逐条按邻域判就不会误清它的标记。
    const A_MID = new Date(2026, 7, 4, 12, 0, 0).getTime();
    const coverage: FileCoverageMap = new Map([
      [`${DAY}|main`, { whole: false, survivorTs: [A_EARLY, A_LATE] }],
    ]);
    const covered = computeCoveredAnchors([A_EARLY, A_MID, A_LATE], { coverage, ...both });
    expect(covered).toContain(A_EARLY);
    expect(covered).toContain(A_LATE);
    expect(covered).not.toContain(A_MID); // ← 修复前 A_MID 落在 [min,max] 内被冒充成已覆盖
  });

  it('⚠️ greptile P1:留下的记录都早于锚点(锚点由 Date.now 后生成)仍算覆盖', () => {
    // beginShutdown 先写日志、随后才 Date.now() 生成崩溃锚点 ⇒ 锚点必然略晚于最后一条 surviving
    // record。旧的 `a ≤ max` 端点判定会对**真崩溃**误判未覆盖 → 标记清不掉、每次启动重复上传。
    // 最近锚点归属只看「这条记录离谁最近」,单锚点时留下的记录必归它 ⇒ 覆盖。
    const crash = new Date(2026, 7, 4, 12, 0, 5).getTime();
    const coverage: FileCoverageMap = new Map([
      // 全部记录都早于 crash(锚点在 max 之后),旧逻辑 a≤max 直接判未覆盖。
      [`${DAY}|main`, { whole: false, survivorTs: [crash - 3_000, crash - 1_000] }],
    ]);
    expect(computeCoveredAnchors([crash], { coverage, ...both })).toEqual([crash]);
  });

  it('⚠️ 两次崩溃相隔 90s、A 的风暴挤掉 B 的记录：B 的最近记录其实归 A ⇒ B 不算覆盖', () => {
    // 固定邻域窗(±2min)会因 B 的最近 surviving record 落在 90s < 窗内而误判 B 覆盖 → B 现场丢失。
    // 最近锚点归属:那条记录离 A(0)比离 B(90s)近 ⇒ 归 A、不归 B ⇒ B 未覆盖。
    const a = new Date(2026, 7, 4, 12, 0, 0).getTime();
    const b = a + 90_000;
    const coverage: FileCoverageMap = new Map([
      [`${DAY}|main`, { whole: false, survivorTs: [a, a + 10, a + 20] }], // 都是 A 的风暴,离 A 更近
    ]);
    const covered = computeCoveredAnchors([a, b], { coverage, ...both });
    expect(covered).toContain(a);
    expect(covered).not.toContain(b);
  });

  it('main 整份读到 ⇒ 当天锚点都覆盖', () => {
    const coverage: FileCoverageMap = new Map([
      [`${DAY}|main`, { whole: true, survivorTs: [] }],
    ]);
    expect(computeCoveredAnchors([A_EARLY, A_LATE], { coverage, ...both })).toEqual([
      A_EARLY,
      A_LATE,
    ]);
  });

  it('main 在但没读到（预算耗尽/跳过/污染停止）⇒ 未覆盖', () => {
    expect(
      computeCoveredAnchors([A_EARLY], { coverage: new Map(), ...both }),
    ).toEqual([]);
  });

  it('那天既没 main 也没 agent ⇒ 覆盖（没东西可补）', () => {
    const covered = computeCoveredAnchors([A_EARLY], {
      coverage: new Map(),
      hasMain: () => false,
      hasAgent: () => false,
    });
    expect(covered).toEqual([A_EARLY]);
  });

  it('agent-only（没有 main）时退回用 agent 覆盖判定', () => {
    const coverage: FileCoverageMap = new Map([
      [`${DAY}|agent`, { whole: true, survivorTs: [] }],
    ]);
    const covered = computeCoveredAnchors([A_EARLY], {
      coverage,
      hasMain: () => false,
      hasAgent: () => true,
    });
    expect(covered).toEqual([A_EARLY]);
  });
});

describe('第四层：上报记录只有五个白名单字段', () => {
  it('产出的对象没有 tsMs 等内部字段', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'ok'),
      ].join('\n'),
    });

    const result = await collectLogs(deps, { reason: 'manual', anchors: [] });

    expect(Object.keys(result.records[0]).sort()).toEqual(['level', 'msg', 'scope', 'src', 'ts']);
  });
});

/**
 * 2026-08-04 review P1 的回归锁：超大崩溃日志按**本文件这一天**的锚点定位,不能用全局最早
 * 锚点。跨天多崩溃时全局 min 对晚一天的文件落在文件头之前,二分收敛到 0,读到那天最旧的一段、
 * 错过当天靠后的崩溃,而所有认领标记又会被一起清掉 → 漏掉的崩溃现场永久丢失。
 */
describe('earliestAnchorOnDay：按天取定位锚点', () => {
  const day = (y: number, m: number, d: number, h = 0, min = 0): number =>
    new Date(y, m - 1, d, h, min, 0).getTime();

  it('锚点落在当天 ⇒ 返回它', () => {
    expect(earliestAnchorOnDay('2026-08-04', [day(2026, 8, 4, 10)])).toBe(day(2026, 8, 4, 10));
  });

  it('当天有多个崩溃 ⇒ 返回最早的（从最早那次的预卷开始才能覆盖全部）', () => {
    const early = day(2026, 8, 4, 2);
    const late = day(2026, 8, 4, 20);
    expect(earliestAnchorOnDay('2026-08-04', [late, early])).toBe(early);
  });

  it('⚠️ 锚点在别的天 ⇒ null（不会用别天的崩溃去定位本文件）', () => {
    // 崩溃在 08-06,查 08-04 那天的文件:早先用全局 min 会把 08-06 之前的目标算到 08-04
    // 文件头之前 → 收敛到 0；现在按天取,08-04 没有崩溃 ⇒ null ⇒ 调用方读尾部。
    expect(earliestAnchorOnDay('2026-08-04', [day(2026, 8, 6, 9)])).toBeNull();
    expect(earliestAnchorOnDay('2026-08-04', [day(2026, 8, 2, 9)])).toBeNull();
  });

  it('多天崩溃：各天只认自己那天的锚点', () => {
    const anchors = [day(2026, 8, 4, 3), day(2026, 8, 6, 21)];
    expect(earliestAnchorOnDay('2026-08-04', anchors)).toBe(day(2026, 8, 4, 3));
    expect(earliestAnchorOnDay('2026-08-06', anchors)).toBe(day(2026, 8, 6, 21));
    expect(earliestAnchorOnDay('2026-08-05', anchors)).toBeNull();
  });

  it('日界:次日 00:00 归次日、不算前一天', () => {
    const midnight = day(2026, 8, 5, 0, 0);
    expect(earliestAnchorOnDay('2026-08-05', [midnight])).toBe(midnight);
    expect(earliestAnchorOnDay('2026-08-04', [midnight])).toBeNull();
  });

  it('dateKey 非法 / 无有限锚点 ⇒ null', () => {
    expect(earliestAnchorOnDay('not-a-date', [day(2026, 8, 4, 10)])).toBeNull();
    expect(earliestAnchorOnDay('2026-08-04', [Number.NaN])).toBeNull();
    expect(earliestAnchorOnDay('2026-08-04', [])).toBeNull();
  });
});

describe('回溯窗口', () => {
  it('默认两天', () => {
    expect(resolveLookbackDays(NOW, [])).toBe(2);
  });

  it('崩溃在 5 天前 → 窗口覆盖到崩溃当天', () => {
    // +1 是为了覆盖锚点当天本身,所以 5 天前 → 6。
    expect(resolveLookbackDays(NOW, [NOW - 5 * DAY_MS])).toBe(6);
  });

  it('多次未传崩溃：按最早那次放宽', () => {
    expect(resolveLookbackDays(NOW, [NOW - DAY_MS, NOW - 7 * DAY_MS, NOW - 3 * DAY_MS])).toBe(8);
  });

  it('超出本地保留期时被 clamp（更远的日志已被清理，读它没意义）', () => {
    expect(resolveLookbackDays(NOW, [NOW - 400 * DAY_MS])).toBe(MAX_LOOKBACK_DAYS_CAP);
  });

  it('隔几天才重开应用时能采到崩溃当天的记录（固定窄窗口会采到 0 条）', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const crashAt = NOW - 5 * DAY_MS;
    const crashDay = dayKey(crashAt);
    const { deps } = harness({
      [path.join(logDir, `main-${crashDay}.log`)]: [
        mainLine(crashAt - 120_000, 'INFO ', 'logger', RECORD_FORMAT_SENTINEL_MSG),
        mainLine(crashAt, 'FATAL', 'process', 'uncaughtException: boom'),
      ].join('\n'),
    });

    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [crashAt] });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toContain('uncaughtException');
    expect(result.stats.lookbackDays).toBe(6);
  });
});

describe('锚点裁剪', () => {
  function record(tsMs: number, msg: string): ParsedRecord {
    return { ts: isoLocal(tsMs), tsMs, level: 'info', src: 'main', scope: 'lifecycle', msg };
  }

  it('未超上限时原样返回（按时间升序）', () => {
    const records = [record(NOW, 'b'), record(NOW - 1000, 'a')];
    expect(trimByAnchors(records, [NOW]).map((r) => r.msg)).toEqual(['a', 'b']);
  });

  it('崩溃后堆积大量新日志时，崩溃时刻的记录仍然被保留', () => {
    const crashAt = NOW - 3 * 60 * 60 * 1000;
    const records: ParsedRecord[] = [record(crashAt, 'CRASH-MOMENT')];
    // 崩溃之后堆 2× 上限的新日志:取「最新 N 条」会把崩溃现场整段挤掉。
    for (let i = 0; i < MAX_RECORDS * 2; i += 1) {
      records.push(record(NOW - i * 1000, `noise-${i}`));
    }

    const kept = trimByAnchors(records, [crashAt]);

    expect(kept).toHaveLength(MAX_RECORDS);
    expect(kept.some((r) => r.msg === 'CRASH-MOMENT')).toBe(true);
  });

  it('多个锚点：每次崩溃附近的记录都被保留', () => {
    const crashA = NOW - 6 * 60 * 60 * 1000;
    const crashB = NOW - 60 * 60 * 1000;
    const records: ParsedRecord[] = [record(crashA, 'CRASH-A'), record(crashB, 'CRASH-B')];
    for (let i = 0; i < MAX_RECORDS * 2; i += 1) {
      records.push(record(NOW - i * 500, `noise-${i}`));
    }

    const kept = trimByAnchors(records, [crashA, crashB]);

    expect(kept.some((r) => r.msg === 'CRASH-A')).toBe(true);
    expect(kept.some((r) => r.msg === 'CRASH-B')).toBe(true);
  });

  it('裁剪后仍按时间升序（时间线不能乱）', () => {
    const records: ParsedRecord[] = [];
    for (let i = 0; i < MAX_RECORDS + 50; i += 1) {
      records.push(record(NOW - i * 1000, `r-${i}`));
    }
    const kept = trimByAnchors(records, [NOW]);
    for (let i = 1; i < kept.length; i += 1) {
      expect(kept[i].tsMs).toBeGreaterThanOrEqual(kept[i - 1].tsMs);
    }
  });
});
