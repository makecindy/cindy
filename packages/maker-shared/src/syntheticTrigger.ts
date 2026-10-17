/**
 * 合成 UI 指令行(隐藏续跑 / Mivo 图片按钮等)的跨端共享判定 —— **唯一定义点**。
 *
 * 桌面 `apps/desktop/src/shared/interruptedTurn.ts` re-export 本模块常量;手机版
 * messageNormalize / 排队区 / 会话预览直接引用。带此前缀的 user 行经 coordinator
 * enqueue 正常落库参与时序,但对一切「面向用户的文本消费」不可见:消息流渲染
 * 隐藏、会话列表预览排除、排队区显示替代标签。漏一处就会把隐藏英文指令暴露给
 * 用户(桌面 review P2 口径,手机端 2026-07 实踩:续跑 prompt 直接显示在会话里)。
 */
export const UI_ACTION_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

/**
 * 旧版桌面启动扫尾给中断会话补写的 role='error' 行的 content.reason 值(现行桌面
 * 已不再产生,仅历史行遗留;详见桌面 interruptedTurn.ts 文件头)。两端 error-tail
 * 判定共用:命中它 → 中断语义(「继续任务」),否则普通失败语义(「重试」)。
 */
export const APP_EXIT_INTERRUPTED_REASON = 'app-exit-interrupted';

/** 已解析出的 user 文本是否是合成 UI 指令(所有面向用户的文本消费的统一判定)。 */
export function isSyntheticTriggerText(text: string): boolean {
  return text.startsWith(UI_ACTION_TRIGGER_PREFIX);
}

/**
 * 规范化续跑指令(2026-07-05 产品决策,原定义在桌面 interruptedTurn.ts,随
 * UI_ACTION_TRIGGER_PREFIX 一起上移):英文、代码固定 —— 它是系统 prompt 而非
 * 用户话术,不随 UI locale 变化,行为可预测(设计实现规范规则 9)。
 *
 * 两条变体只差第一句的中断原因描述:
 *  - APP EXIT:中断 banner 的「继续任务」按钮(应用退出导致中断);
 *  - ERROR:ErrorBanner 的「重试」在失败 turn 已有产出时的续跑替代
 *    (agent-input-coordinator.retryLastError)。
 */
const CONTINUE_COMMON =
  ' Review the conversation above to determine how far the task progressed,' +
  ' then continue from where it left off.' +
  ' Do not repeat steps that already completed and had external effects' +
  ' (messages or comments already sent, commits already pushed, files already written).';

export const CONTINUE_AFTER_APP_EXIT_PROMPT =
  `${UI_ACTION_TRIGGER_PREFIX} The previous turn was interrupted because the app exited mid-run.` +
  CONTINUE_COMMON;

export const CONTINUE_AFTER_ERROR_PROMPT =
  `${UI_ACTION_TRIGGER_PREFIX} The previous turn errored partway through.` +
  CONTINUE_COMMON;

/**
 * 合成指令的遮蔽标签语义(对齐桌面 pendingQueueRowPresentation 的 review P2:
 * 不能把「续跑」文案套到所有合成触发上——Mivo 图片按钮的合成消息语义是图片操作):
 *  - 'continue':error-tail / app-exit 续跑指令(包括有界 recovery checkpoint);
 *  - 'generic' :其它合成触发 → 中性「系统指令」标签;
 *  - null      :不是合成指令。
 */
export function syntheticTriggerKind(text: string): 'continue' | 'generic' | null {
  if (!isSyntheticTriggerText(text)) return null;
  const isCheckpointContinuation =
    text.startsWith(`${CONTINUE_AFTER_APP_EXIT_PROMPT}\n\n[CINDY_RECOVERY_CHECKPOINT v1]`) ||
    text.startsWith(`${CONTINUE_AFTER_ERROR_PROMPT}\n\n[CINDY_RECOVERY_CHECKPOINT v1]`);
  return text === CONTINUE_AFTER_APP_EXIT_PROMPT ||
    text === CONTINUE_AFTER_ERROR_PROMPT ||
    isCheckpointContinuation
    ? 'continue'
    : 'generic';
}

/** Raw history and desktop projections identify the same recovery boundary. */
export function isContinuationMessage(message: {
  role?: string | null;
  content?: unknown;
  agentMeta?: object | null;
  systemCardType?: string;
  isContinuationTrigger?: boolean;
}): boolean {
  if (message.role !== 'user') return false;
  if (message.isContinuationTrigger === true
    || (message.agentMeta as { autoResume?: unknown } | null)?.autoResume === true
    || message.systemCardType === 'auto-resume') return true;
  // Mobile persists user text as a JSON envelope; live/desktop rows may already
  // contain the decoded object or plain text. Only unwrap the outer envelope.
  let content = message.content;
  if (typeof content === 'string' && content.trimStart().startsWith('{')) {
    try { content = JSON.parse(content) as unknown; }
    catch { return false; }
  }
  const text = typeof content === 'string' ? content
    : (content as { text?: unknown } | null)?.text;
  return typeof text === 'string' && syntheticTriggerKind(text) === 'continue';
}

/**
 * 代输入结束时给 Agent 的隐藏续接(桌面 input-handoff/service.ts 产出)。它只有
 * 事实没有主人输入的值;两端从同一行派生任务记录里那条可见留痕
 * 「主人在 iPhone 完成了 3 步输入 · <域名> · 时间」。
 */
export const INPUT_HANDOFF_ENDED_PREFIX = '[Input handoff ended]';

export interface InputHandoffEndRecord {
  status: 'succeeded' | 'cancelled' | 'failed' | 'expired';
  /** The screen had nothing for the owner to type; the agent carried on by itself. */
  nothingToFill: boolean;
  steps: number;
  origin?: string;
  app?: string;
  /** Answering device: a display name, or this computer / an unnamed phone or device. */
  answeredOn?: { kind: 'this_computer' | 'phone' | 'another_device' } | { kind: 'named'; name: string };
}

const END_STATUSES = new Set(['succeeded', 'cancelled', 'failed', 'expired']);
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';

function readQuoted(text: string, key: string): string | undefined {
  const match = new RegExp(`(?:^| )${key}=(${QUOTED})`).exec(text);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the persisted continuation row (with or without the UI trigger prefix). */
export function parseInputHandoffEndRecord(content: string): InputHandoffEndRecord | null {
  const text = content.startsWith(UI_ACTION_TRIGGER_PREFIX) ? content.slice(UI_ACTION_TRIGGER_PREFIX.length) : content;
  if (!text.startsWith(INPUT_HANDOFF_ENDED_PREFIX)) return null;
  const facts = text.slice(INPUT_HANDOFF_ENDED_PREFIX.length);
  const status = / status=(\w+)/.exec(facts)?.[1];
  const steps = Number(/ steps=(\d+)/.exec(facts)?.[1]);
  if (!status || !END_STATUSES.has(status) || !Number.isSafeInteger(steps)) return null;
  // The facts end with ". " before the instruction sentence; drop that period.
  const origin = / origin=([^\s"]+)/.exec(facts)?.[1]?.replace(/\.$/, '');
  const app = readQuoted(facts, 'app');
  const answered = / answered_on=(this_computer|phone|another_device)\b/.exec(facts)?.[1];
  const answeredName = answered ? undefined : readQuoted(facts, 'answered_on');
  return {
    status: status as InputHandoffEndRecord['status'],
    nothingToFill: / failure=nothing_to_fill\b/.test(facts),
    steps,
    ...(origin ? { origin: origin.slice(0, 300) } : {}),
    ...(app ? { app } : {}),
    ...(answered
      ? { answeredOn: { kind: answered as 'this_computer' | 'phone' | 'another_device' } }
      : answeredName
        ? { answeredOn: { kind: 'named' as const, name: answeredName } }
        : {}),
  };
}

export type InputHandoffRecordKey =
  | 'nothingToFill' | 'cancelled' | 'expired' | 'failed' | 'done'
  | 'doneOn' | 'doneHost' | 'donePhone' | 'doneElsewhere';

/** Locale key + params for the record line; both clients translate under their own `…record.<key>`. */
export function inputHandoffRecordMessage(record: InputHandoffEndRecord): {
  key: InputHandoffRecordKey;
  params?: { count: number; device?: string };
} {
  if (record.nothingToFill) return { key: 'nothingToFill' };
  if (record.status !== 'succeeded') return { key: record.status };
  const count = record.steps;
  const on = record.answeredOn;
  if (count < 1 || !on) return { key: 'done' };
  if (on.kind === 'named') return { key: 'doneOn', params: { count, device: on.name } };
  if (on.kind === 'this_computer') return { key: 'doneHost', params: { count } };
  if (on.kind === 'phone') return { key: 'donePhone', params: { count } };
  return { key: 'doneElsewhere', params: { count } };
}

/** Host part of the final origin for display; never the path or query. */
export function inputHandoffRecordHost(origin?: string): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).host || undefined;
  } catch {
    return undefined;
  }
}
