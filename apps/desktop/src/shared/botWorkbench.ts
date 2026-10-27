/**
 * 伙伴工作台:主进程与渲染层共用的数据形状与纯推导。
 *
 * 2026-10-17 起放弃「项目」思路:伙伴不再按目录接手项目,也不再写候选任务的判断。工作台只剩
 * 它负责的任务(自己开的 + 明确接手的)与宿主观察层给出的「一眼」投影(见 `botAutonomy.ts`)。
 * `workbench.json` 的 directories 用于伙伴设置中的关联项目,不作为任务责任来源;旧判断
 * 只作为 Todo 的兼容来源由主进程读取(`botWorkbenchLegacy.ts`)。
 *
 * 任务状态只从宿主已有的真实信号推导——运行中、等待交互、上一轮出错或被打断、后台任务状态、
 * 自动化的启停与运行——不经过模型,也不另存一份状态。
 */

export interface BotWorkbench {
  /** Verified creation plus explicit take/release. Older hosts omit it. */
  responsibleSessionIds?: string[];
}

/** Project references provide context, never task responsibility or execution permission. */
export interface BotLinkedProject {
  path: string;
  addedAt: string;
  /** Missing means this computer; a foreign path must never be opened locally. */
  deviceId?: string;
}

export interface BotProjectOption {
  id: string;
  name: string;
  path: string;
  deviceId?: string;
  linked: boolean;
  available: boolean;
}

/** 一件任务最近内容的只读摘录(工具与详情视图共用)。 */
export interface WorkbenchTranscriptItem {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface WorkbenchTranscript {
  items: WorkbenchTranscriptItem[];
  truncated: boolean;
}

function shortenUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    const host = url.host.replace(/^www\./, '');
    if (segments.length === 0) return host;
    if (segments.length <= 2) return `${host}/${segments.join('/')}`;
    return `${host}/…/${segments.slice(-2).join('/')}`;
  } catch {
    return raw;
  }
}

/** 去掉尖括号指令块(如 `<system-reminder>…</system-reminder>`)与残留标签。 */
export function stripInstructionBlocks(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(/<([A-Za-z][\w-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1>/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, ' ');
}

export const WORKBENCH_TITLE_MAX = 60;

/**
 * 把一件任务的原始标题(常常是第一条消息原文)整理成能读的一行:去掉指令块、
 * Markdown 标记与多余空白,URL 只留域名与路径末段,取第一行截到 60 字。
 * 清洗后为空时返回 `fallback`。
 */
export function cleanWorkbenchTitle(raw: string | null | undefined, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  let text = stripInstructionBlocks(raw);
  text = text.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_all, label: string, url: string) => label.trim() || url);
  text = text.replace(/https?:\/\/[^\s<>()\]]+/g, (url) => shortenUrl(url));
  const line = text
    .split(/\r?\n/)
    .map((row) =>
      row
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/`+|\*\*|__|~~/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find(Boolean);
  if (!line) return fallback;
  return line.length > WORKBENCH_TITLE_MAX ? `${line.slice(0, WORKBENCH_TITLE_MAX - 1)}…` : line;
}

/** 一格任务的状态。`automation` 表示一条正常待命的自动化(下次运行 / 上次结果)。 */
export type WorkbenchTaskState = 'running' | 'waiting' | 'queued' | 'stopped' | 'automation' | 'done';

/** 一格任务从哪里来:原有任务、伙伴替主人开的后台任务、本机其他工具 / 其它 Cindy 里的会话。 */
export type WorkbenchTaskOrigin = 'existing' | 'delegated' | 'claude-code' | 'codex' | 'pi';

export type WorkbenchDelegationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

/**
 * 推导一件普通任务状态所需的信号。全部来自宿主已有状态:
 * - `activityPhase`:与侧栏、灵动岛同源的活动快照 phase(running / needs-interaction /
 *   completed / error / idle),没有快照时为 null;
 * - `interrupted`:上一轮开始后没有结束记录(应用退出等打断),见
 *   `hasPendingSessionInterruption`;
 * - `errored`:上一轮以错误结束且主人还没处理(侧栏的红点、主进程的终态错误行);
 * - `delegationStatus`:这件任务是伙伴开的后台任务时,后台任务自己的状态。
 */
export interface WorkbenchSessionSignals {
  activityPhase?: string | null;
  interrupted?: boolean;
  errored?: boolean;
  delegationStatus?: WorkbenchDelegationStatus | null;
}

/**
 * 普通任务的状态。优先级:排队 > 等你 > 在做 > 停着 > 做完。
 *
 * 「停着」只在有可靠信号时给:上一轮被打断、上一轮出错未处理,或伙伴开的后台任务
 * 以失败 / 超时 / 取消收尾。其余没有在跑、也没有在等的任务一律算「做完」——宿主
 * 无法可靠判断一件空闲的任务是否"还差一点",不猜。
 */
export function deriveWorkbenchSessionState(signals: WorkbenchSessionSignals): WorkbenchTaskState {
  const delegation = signals.delegationStatus ?? null;
  const phase = signals.activityPhase ?? null;
  if (delegation === 'queued') return 'queued';
  if (delegation === 'waiting' || phase === 'needs-interaction') return 'waiting';
  if (delegation === 'running' || phase === 'running') return 'running';
  if (
    signals.interrupted === true ||
    signals.errored === true ||
    phase === 'error' ||
    delegation === 'failed' ||
    delegation === 'timed-out' ||
    delegation === 'cancelled'
  ) {
    return 'stopped';
  }
  return 'done';
}

export interface WorkbenchAutomationSignals {
  /** 自动化是否启用(伙伴例行任务的 enabled / 普通自动化的 status === 'active')。 */
  enabled: boolean;
  running?: boolean;
  queued?: boolean;
}

/** 自动化的状态:正在跑 > 排队 > 停用(停着) > 正常待命。 */
export function deriveWorkbenchAutomationState(signals: WorkbenchAutomationSignals): WorkbenchTaskState {
  if (signals.running) return 'running';
  if (signals.queued) return 'queued';
  if (!signals.enabled) return 'stopped';
  return 'automation';
}

/**
 * 能作为工作台任务的会话来源。只认主人自己在项目里开的任务(含插件为项目建的任务、
 * 从本机工具导入的任务,它们都以 desktop 落库)。自动化的每次运行由自动化那一格代表,
 * IM 渠道、学习、评审、伙伴自身等来源都不是"项目里的任务"。缺失按 desktop 兼容旧行。
 */
export function isWorkbenchTaskSource(source: string | null | undefined): boolean {
  return source == null || source === 'desktop' || source === 'plugin';
}

/** 一句摘要的长度上限:格子底部一行、工具返回给伙伴的摘要都用它。 */
export const WORKBENCH_SUMMARY_MAX_CHARS = 160;

export function boundWorkbenchSummary(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > WORKBENCH_SUMMARY_MAX_CHARS
    ? `${flat.slice(0, WORKBENCH_SUMMARY_MAX_CHARS - 1)}…`
    : flat;
}
