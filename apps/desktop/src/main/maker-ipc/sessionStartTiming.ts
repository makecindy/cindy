/**
 * 任务启动(bootstrapSession)分段计时，用来查「手机/电脑新建任务要等很久」到底卡在哪一步。
 *
 * 这条记录会随用户主动上传的日志离开本机(log-upload/sourceAllowlist.ts 精确放行
 * `session-start-timing`)，所以只写固定的阶段名、Agent 种类、启动方式、结果与毫秒数：
 * 不带任务 id、路径、模型名、供应商或任何错误原文。
 */
import { createLogger } from '../logger';

export const SESSION_START_TIMING_SCOPE = 'session-start-timing';

/** 按 bootstrapSession 里的先后顺序排列；没走到的阶段不出现在记录里。 */
export const SESSION_START_STAGES = [
  /** 读任务标记、协同远端 Worker 判定、补任务所在电脑。 */
  'prepare',
  /** 供应商组选电脑(可能要问组里另一台电脑)。 */
  'providerGroup',
  /** 工作目录恢复与云实例个性化。 */
  'workdir',
  /** 等本账号的供应商模型目录就绪。 */
  'accountModels',
  /** 审阅模式、协同说明与项目上下文注入。 */
  'instructions',
  /** 目录授权准备。 */
  'directoryGrants',
  /** 补齐供应商与订阅池来源。 */
  'providerSource',
  /** 本机启动准入。 */
  'admit',
  /** Agent 真正起来(含启动失败后换组里下一台的重试)。 */
  'agentStart',
  /** 写回供应商、会话态与 worktree 快照。 */
  'finalize',
] as const;

export type SessionStartStage = (typeof SESSION_START_STAGES)[number];
export type SessionStartOutcome = 'started' | 'failed';

export interface SessionStartTimingRecord {
  agentKind: string;
  /** 新建、续接原生会话，还是供应商组换电脑重连。 */
  start: 'new' | 'resume' | 'reconnect';
  outcome: SessionStartOutcome;
  /** Agent 启动尝试次数(供应商组启动失败换电脑会大于 1)。 */
  attempts: number;
  totalMs: number;
  stagesMs: Partial<Record<SessionStartStage, number>>;
  /** 最后一个已记阶段之后到结束的时间：失败时就是卡在失败那一步的时长。 */
  restMs: number;
}

const KNOWN_AGENT_KINDS = new Set(['claude-code', 'codex', 'pi', 'acp']);

export interface SessionStartTimer {
  /** 记下从上一个点到现在花在 `stage` 上的时间(同一阶段多次累加)。 */
  lap(stage: SessionStartStage): void;
  /** 记一次 Agent 启动尝试。 */
  attempt(): void;
  finish(outcome: SessionStartOutcome): SessionStartTimingRecord;
}

export function createSessionStartTimer(input: {
  agentKind: string;
  start: SessionStartTimingRecord['start'];
  now?: () => number;
}): SessionStartTimer {
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  let markAt = startedAt;
  let attempts = 0;
  const stagesMs: SessionStartTimingRecord['stagesMs'] = {};
  return {
    lap(stage) {
      const at = now();
      stagesMs[stage] = (stagesMs[stage] ?? 0) + Math.max(0, Math.round(at - markAt));
      markAt = at;
    },
    attempt() {
      attempts += 1;
    },
    finish(outcome) {
      const at = now();
      const ordered: SessionStartTimingRecord['stagesMs'] = {};
      for (const stage of SESSION_START_STAGES) {
        if (stagesMs[stage] !== undefined) ordered[stage] = stagesMs[stage];
      }
      return {
        agentKind: KNOWN_AGENT_KINDS.has(input.agentKind) ? input.agentKind : 'other',
        start: input.start,
        outcome,
        attempts,
        totalMs: Math.max(0, Math.round(at - startedAt)),
        stagesMs: ordered,
        restMs: Math.max(0, Math.round(at - markAt)),
      };
    },
  };
}

/** 单行 JSON，方便上传后用 SQL 直接解析；不会产生续行。 */
export function formatSessionStartTiming(record: SessionStartTimingRecord): string {
  return `session start timing ${JSON.stringify(record)}`;
}

const timingLog = createLogger(SESSION_START_TIMING_SCOPE);

export function logSessionStartTiming(record: SessionStartTimingRecord): void {
  try {
    timingLog.info(formatSessionStartTiming(record));
  } catch {
    // 诊断不能影响任务启动。
  }
}
