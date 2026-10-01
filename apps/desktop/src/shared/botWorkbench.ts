/**
 * 伙伴工作台:主进程与渲染层共用的数据形状与纯推导。
 *
 * 工作台上的每一条都是一件事:Cindy 任务、本机外部会话、PR / issue / 建议或自动化。状态只从
 * 宿主已有的真实信号推导——运行中、等待交互、上一轮出错或被打断、后台任务状态、自动化的启停
 * 与运行——不经过模型,也不另存一份状态。主进程(伙伴读取工作台的工具)和渲染层(右侧栏的
 * 任务列表)共用这里的同一套规则(状态推导、标题清洗、条目 id、参考校验、摘要),两边说法一致。
 */
import { normalizeWorkingDirForGrouping, normalizeWorkingDirForStorage } from './workingDir';

/** 主人最多交给一个伙伴几个项目;与存储层的上限同源。 */
export const BOT_WORKBENCH_MAX_DIRECTORIES = 6;

/** 主人交给伙伴的项目目录。目录本身由宿主记录,`exists` 是读取时现查的事实。 */
export interface BotWorkbenchDirectory {
  path: string;
  name: string;
  addedAt: string;
  exists: boolean;
}

/**
 * 伙伴对一件候选任务的理解:读过之后写下的人话标题、判断与下一步。
 * - unfinished:没做完、可以接着做;
 * - idea:聊过但没下文,建议往下做;
 * - done:做完了,或与项目无关。工作台不显示。
 */
export type WorkbenchVerdict = 'unfinished' | 'idea' | 'done';

export interface WorkbenchTaskJudgment {
  title: string;
  verdict: WorkbenchVerdict;
  /** 一句「下一步」;done 可为空。 */
  next: string | null;
  /** 写判断时这件任务所在的已接手项目目录(移除项目后据此隐藏)。 */
  project: string;
  /** 可选的参考:https 链接,或已接手项目内的文件路径。 */
  ref?: string | null;
  updatedAt: string;
}

export const WORKBENCH_REF_MAX = 2_000;

export interface BotWorkbench {
  directories: BotWorkbenchDirectory[];
  /** 按 task_id 记录的伙伴判断。 */
  tasks: Record<string, WorkbenchTaskJudgment>;
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

/** 一件会话候选的摘要:起始目的 + 最后几条,宿主预先算好,伙伴先凭它判断。 */
export interface WorkbenchDigest {
  /** 第一条用户消息,清洗后 ≤ 200 字。 */
  purpose: string | null;
  /** 最后 2–3 条用户 / 助手文字,各 ≤ 300 字,按时间正序。 */
  recent: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export const WORKBENCH_DIGEST_PURPOSE_MAX = 200;
export const WORKBENCH_DIGEST_RECENT_MAX = 300;
export const WORKBENCH_DIGEST_RECENT_COUNT = 3;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function flatten(text: string): string {
  return stripInstructionBlocks(text).replace(/\s+/g, ' ').trim();
}

/**
 * 由按时间正序的消息算摘要。`head` 是从开头读到的一段(取第一条用户消息),
 * `tail` 是从结尾读到的一段(取最后几条);两段可以重叠或相同。
 */
export function buildWorkbenchDigest(
  head: readonly WorkbenchTranscriptItem[],
  tail: readonly WorkbenchTranscriptItem[],
): WorkbenchDigest {
  const firstUser = head.map((item) => (item.role === 'user' ? flatten(item.text) : '')).find(Boolean) ?? null;
  const recent: WorkbenchDigest['recent'] = [];
  for (let index = tail.length - 1; index >= 0 && recent.length < WORKBENCH_DIGEST_RECENT_COUNT; index -= 1) {
    const text = flatten(tail[index].text);
    if (text) recent.unshift({ role: tail[index].role, text: clip(text, WORKBENCH_DIGEST_RECENT_MAX) });
  }
  return { purpose: firstUser ? clip(firstUser, WORKBENCH_DIGEST_PURPOSE_MAX) : null, recent };
}

/** 只看近期:最近 30 天内活动过的候选才读摘要。 */
export const WORKBENCH_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const WORKBENCH_JUDGMENT_TITLE_MAX = 40;
export const WORKBENCH_JUDGMENT_NEXT_MAX = 120;
export const WORKBENCH_MAX_JUDGMENTS = 200;

/**
 * 工作台任务 id:Cindy 任务就是 session id;还没导入的本机外部会话带来源前缀,
 * `claude:<sdkSessionId>` / `codex:<threadId>`。
 */
export type WorkbenchTaskRef =
  | { kind: 'session'; sessionId: string }
  | { kind: 'external'; source: 'claude' | 'codex' | 'pi'; externalId: string }
  | { kind: 'github'; type: 'pr' | 'issue'; owner: string; repo: string; number: number }
  | { kind: 'idea'; slug: string };

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * 工作台条目 id:`session:<id>`(或直接 session id)、`claude:<id>`、`codex:<id>`、`pi:<id>`、
 * `pr:<owner>/<repo>#<n>`、`issue:<owner>/<repo>#<n>`、`idea:<slug>`(slug 为 3–40 位小写字母、
 * 数字与连字符)。格式不对返回 null。
 */
export function parseWorkbenchTaskId(taskId: string): WorkbenchTaskRef | null {
  const id = taskId.trim();
  if (!id || id.length > 256) return null;
  const external = /^(claude|codex|pi):(.+)$/.exec(id);
  if (external) return { kind: 'external', source: external[1] as 'claude' | 'codex' | 'pi', externalId: external[2] };
  const github = /^(pr|issue):([^/\s]+)\/([^#\s]+)#(\d{1,9})$/.exec(id);
  if (github) {
    if (!GITHUB_NAME.test(github[2]) || !GITHUB_NAME.test(github[3])) return null;
    return { kind: 'github', type: github[1] as 'pr' | 'issue', owner: github[2], repo: github[3], number: Number(github[4]) };
  }
  if (/^(pr|issue):/.test(id)) return null;
  const idea = /^idea:(.*)$/.exec(id);
  if (idea) return /^[a-z0-9-]{3,40}$/.test(idea[1]) ? { kind: 'idea', slug: idea[1] } : null;
  const session = /^session:(.+)$/.exec(id);
  return { kind: 'session', sessionId: session ? session[1] : id };
}

/** 判断存储与界面里用的规范 id:Cindy 任务用裸 session id,其它原样。 */
export function canonicalWorkbenchTaskId(ref: WorkbenchTaskRef): string {
  if (ref.kind === 'session') return ref.sessionId;
  if (ref.kind === 'external') return `${ref.source}:${ref.externalId}`;
  if (ref.kind === 'github') return `${ref.type}:${ref.owner}/${ref.repo}#${ref.number}`;
  return `idea:${ref.slug}`;
}

/**
 * 参考校验:只接受 https 链接,或落在某个已接手项目目录内的绝对路径(不允许 `..` 越界)。
 * 通过时返回规整后的值。
 */
export function validateWorkbenchRef(
  ref: string,
  projectDirs: readonly string[],
  caseInsensitive: boolean,
): { ok: true; ref: string } | { ok: false } {
  const value = ref.trim();
  if (!value || value.length > WORKBENCH_REF_MAX) return { ok: false };
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? { ok: true, ref: url.toString() } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  const normalized = normalizeWorkingDirForStorage(value);
  if (!normalized || !/^(\/|[A-Za-z]:\/)/.test(normalized)) return { ok: false };
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return { ok: false };
  const key = caseInsensitive ? normalized.toLowerCase() : normalized;
  const inside = projectDirs.some((dir) => {
    const root = normalizeWorkingDirForStorage(dir);
    if (!root) return false;
    const rootKey = caseInsensitive ? root.toLowerCase() : root;
    return key === rootKey || key.startsWith(`${rootKey.endsWith('/') ? rootKey.slice(0, -1) : rootKey}/`);
  });
  return inside ? { ok: true, ref: normalized } : { ok: false };
}

export function externalWorkbenchTaskId(source: 'claude' | 'codex' | 'pi', externalId: string): string {
  return `${source}:${externalId}`;
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
 * 项目身份键:与任务列表的项目分组同一套归一(worktree 归到主仓库、去尾斜杠),
 * Windows 本机路径忽略大小写。只用于比较,不用于读写文件。
 */
export function workbenchProjectKey(
  dir: string | null | undefined,
  caseInsensitive: boolean,
): string | null {
  const normalized = normalizeWorkingDirForGrouping(dir);
  if (!normalized) return null;
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * 找出这个工作目录属于哪个已接手的项目:项目目录本身或它下面的任一子目录都算,按目录
 * 边界比较(`/repo` 不包含 `/repo-old`);同时交了嵌套的项目时取最深的那个。
 * 不属于任何一个时返回 null。
 */
export function findWorkbenchProject(
  workingDir: string | null | undefined,
  projectDirs: readonly string[],
  caseInsensitive: boolean,
): string | null {
  const key = workbenchProjectKey(workingDir, caseInsensitive);
  if (!key) return null;
  let best: { dir: string; length: number } | null = null;
  for (const dir of projectDirs) {
    const root = workbenchProjectKey(dir, caseInsensitive);
    if (!root) continue;
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (key !== root && !key.startsWith(prefix)) continue;
    if (!best || root.length > best.length) best = { dir, length: root.length };
  }
  return best?.dir ?? null;
}

/** Windows 本机路径不区分大小写;与 `projectKeyComparisonKey` 的口径一致。 */
export function isCaseInsensitivePlatform(platform: string | null | undefined): boolean {
  return platform === 'win32';
}

/**
 * 从本机 Claude Code / Codex 导入的任务:导入路径给它们固定的 id 前缀,且只会是对应的
 * 引擎。二者同时满足才认,避免把普通任务误标成导入的。
 */
export function importedSessionOrigin(
  sessionId: string,
  agentKind: string | null | undefined,
): 'claude-code' | 'codex' | null {
  if (sessionId.startsWith('claude-') && agentKind === 'cc') return 'claude-code';
  if (sessionId.startsWith('codex-') && agentKind === 'codex') return 'codex';
  return null;
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
