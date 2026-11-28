/**
 * 手机新建任务首条消息的分段计时：查「点发送后要等二三十秒才发出去」卡在哪一步。
 *
 * 只写进本机诊断记录(mobileDebugLog，用户开启诊断录制才落盘)，内容是固定阶段名、枚举与毫秒数，
 * 外加首条消息 clientId 的末 8 位，用来和同一条消息的 `send accepted` 计时对上；不带正文、
 * 路径、模型名、供应商或错误原文。
 */
import { mobileDebugLog } from '../debug/mobileDebugLog';

/** 按管线先后排列；没走到的阶段不出现在记录里。 */
export const NEW_SESSION_CREATION_STAGES = [
  /** 把恢复权从草稿账本交给本次管线。 */
  'claim',
  /** 连接电脑并订阅任务列表(含瞬断重试)。 */
  'link',
  /** 向电脑取最新供应商目录、确认 Agent 已登录。 */
  'modelCheck',
  /** 用最新目录校准模型与来源。 */
  'revalidate',
  /** 直接入队路径按最终 Agent 解析技能调用名。 */
  'skill',
  /** 电脑创建会话(含落账本、重试与探测)。 */
  'create',
  /** 读回电脑上的权威会话行。 */
  'read',
  /** 开启协同。 */
  'team',
  /** 武装计划模式。 */
  'planMode',
  /** 首条消息交给发件箱或直接入队。 */
  'handoff',
] as const;

export type NewSessionCreationStage = (typeof NEW_SESSION_CREATION_STAGES)[number];
export type NewSessionCreationTimingOutcome =
  | 'handed-off'
  | 'create-failed'
  | 'enqueue-failed'
  | 'dismissed';

export interface NewSessionCreationTimingRecord {
  client: string;
  agentKind: string;
  /** durable：首条消息交给发件箱，由发件箱送达电脑；direct：管线直接入队。 */
  path: 'durable' | 'direct';
  worktree: boolean;
  retry: boolean;
  outcome: NewSessionCreationTimingOutcome;
  /** 点发送到管线开始(保存草稿、预建 worktree、目录守卫)；重试时为 0。 */
  prepareMs: number;
  /** 点发送到管线结束。 */
  totalMs: number;
  stagesMs: Partial<Record<NewSessionCreationStage, number>>;
  /** 最后一个已记阶段之后到结束的时间：失败时就是卡在失败那一步的时长。 */
  restMs: number;
}

const KNOWN_AGENT_KINDS = new Set(['claude-code', 'codex', 'pi', 'acp']);

export interface NewSessionCreationTimer {
  /** 记下从上一个点到现在花在 `stage` 上的时间(同一阶段多次累加)。 */
  lap(stage: NewSessionCreationStage): void;
  finish(outcome: NewSessionCreationTimingOutcome): NewSessionCreationTimingRecord;
}

export function startNewSessionCreationTimer(input: {
  /** 用户点发送的时刻(重试时为重试开始时刻)。 */
  startedAt: number;
  clientId: string;
  agentKind: string;
  durable: boolean;
  worktree: boolean;
  retry: boolean;
  now?: () => number;
}): NewSessionCreationTimer {
  const now = input.now ?? Date.now;
  const pipelineStartedAt = now();
  let markAt = pipelineStartedAt;
  const stagesMs: NewSessionCreationTimingRecord['stagesMs'] = {};
  return {
    lap(stage) {
      const at = now();
      stagesMs[stage] = (stagesMs[stage] ?? 0) + Math.max(0, Math.round(at - markAt));
      markAt = at;
    },
    finish(outcome) {
      const at = now();
      const ordered: NewSessionCreationTimingRecord['stagesMs'] = {};
      for (const stage of NEW_SESSION_CREATION_STAGES) {
        if (stagesMs[stage] !== undefined) ordered[stage] = stagesMs[stage];
      }
      return {
        client: input.clientId.slice(-8),
        agentKind: KNOWN_AGENT_KINDS.has(input.agentKind) ? input.agentKind : 'other',
        path: input.durable ? 'durable' : 'direct',
        worktree: input.worktree,
        retry: input.retry,
        outcome,
        prepareMs: Math.max(0, Math.round(pipelineStartedAt - input.startedAt)),
        totalMs: Math.max(0, Math.round(at - input.startedAt)),
        stagesMs: ordered,
        restMs: Math.max(0, Math.round(at - markAt)),
      };
    },
  };
}

export function logNewSessionCreationTiming(record: NewSessionCreationTimingRecord): void {
  mobileDebugLog('info', 'new-session', 'creation timing', record);
}
