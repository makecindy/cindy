import type { RemoteMessage, RemoteMessageRole } from '@/session/types';
import type { MobileSystemCardType } from '@/session/systemCard';
import { contentToPreview } from '@/utils/contentPreview';
import { describeAgentAuthError } from '@/device-link/remoteStatus';
import {
  buildMessageToolResultPairing,
  messageNormalizeKey,
  parseMessageToolUse,
  sortMessagesByCreatedAt,
  type MessageNormalizeToolUse,
  type MessageToolResultPairing,
} from '@cindy/maker-shared/message-normalize';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import {
  buildPayloadToolDiff,
  extractPayloadToolResultMedia,
  formatPayloadToolUseSummary,
} from '@/session/messagePayload';
import {
  buildOrcaDispatchCard,
  parseOrcaWorkerReport,
  type OrcaCollabCard,
} from '@/session/orcaCollab';
import {
  parseMobilePersistedSessionReferenceMetadata,
  type MobilePersistedSessionReferenceMetadata,
} from '@/session/sessionReferences';
import {
  readSentPastedTextRanges,
  readSentSlashCommandRanges,
} from '@/session/sentMessageAtoms';
import {
  readAgentInputReferences,
  type AgentInputReference,
} from '@cindy/maker-shared/agent-input-projection';
import {
  normalizeRemoteMoney,
  type RemoteMoney,
} from '@/session/remoteMoney';

export type NormalizedRemoteMessageKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'thinking'
  | 'ask_user'
  | 'plan_review'
  | 'system';

export interface NormalizedRemoteMessage {
  key: string;
  source: RemoteMessage;
  kind: NormalizedRemoteMessageKind;
  role: RemoteMessageRole;
  label: string;
  body: string;
  /** user 消息正文包含产品引用编码；驱动跨端 marker/legacy 解析。 */
  quotesEncoded?: boolean;
  /** user 长文本粘贴原子的精确 wire ranges；正文仍保留完整 Agent payload。 */
  pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
  /** user Composer 确认过的 Slash ranges；空数组用于关闭历史启发式。 */
  slashCommandRanges?: Array<{ start: number; end: number }>;
  /** user Composer 的结构化语义引用；用于 fork / rewind 恢复同款 chip。 */
  agentReferences?: AgentInputReference[];
  secondaryBody?: string;
  systemCardData?: Record<string, unknown>;
  systemCardType?: MobileSystemCardType;
  attachments?: NormalizedAttachment[];
  /** user 专用：目标桌面落库的引用范围摘要，不含被引用消息正文。 */
  sessionReferences?: MobilePersistedSessionReferenceMetadata[];
  media?: NormalizedToolMedia[];
  diff?: NormalizedToolDiff;
  align: 'user' | 'agent';
  createdAt: string;
  isStreaming?: boolean;
  /** Host 在 SDK done 边界写入；后台自动续跑时每个 sealed assistant 都是正式回复。 */
  turnCompleted?: boolean;
  turnMoney?: RemoteMoney;
  /** 旧 Desktop 消息兼容字段。 */
  turnCostUsd?: number;
  turnCostIsEstimate?: boolean;
  /** assistant 专用:本轮模型降级标记(agentMeta.modelMismatch,桌面 main 在 turn 结束检测命中时落库)。 */
  modelMismatch?: { selected: string; actual: string };
  /** Orca 协同卡片(Lead 派活 / worker 回报);存在时由 MessageRenderer 渲染成专属卡片而非普通气泡。 */
  orcaCard?: OrcaCollabCard;
  /** tool 消息专用:tool_result 是否已到达(含被隐藏的 orca 空结果),驱动工具行 running/done 状态。 */
  toolSettled?: boolean;
  /** assistant 专用:是否本轮收尾正文(操作行只挂在收尾正文上,对齐桌面 #456);由 messageRenderModel 标注。 */
  isTurnFinalAssistant?: boolean;
  /** user 专用:scheduler 注入的消息来源(agentMeta.origin);驱动更紧的收起阈值与来源标签。 */
  automationOrigin?: NormalizedAutomationOrigin;
  /** 共享 Cindy relay 派发的来源；用于移动端还原 Slack / Telegram 任务卡。 */
  hookSource?: NormalizedHookSource;
  /**
   * user 专用:合成 UI 指令行(桌面「失败后继续 / 中断续跑」等隐藏 prompt,
   * `[UI_ACTION_TRIGGER]` 前缀,对齐桌面 makerChatStore 同名标记)。保留在
   * normalized 列表里参与 turn 边界判定(markTurnFinalAssistants /
   * scopeUnsettledToolsToActiveTail 需要它作为新一轮的 user 边界),但
   * messageRenderModel 会把它从 render items 里剔除,用户不可见。
   */
  isSyntheticTrigger?: boolean;
}

/** scheduler 注入消息的来源标记(对齐桌面 MessageAutomationOrigin)。 */
export interface NormalizedAutomationOrigin {
  scheduleId: string;
  scheduleName?: string;
}

export interface NormalizedHookSource {
  im: 'slack' | 'telegram';
  channelName?: string;
  userText: string;
  threadContext?: Array<{ author: string; text: string; isBot?: boolean }>;
}

export interface NormalizedAttachment {
  kind: 'image' | 'file';
  name: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  previewable: boolean;
}

export interface NormalizedToolMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title?: string;
  previewable: boolean;
  actions?: NormalizedToolMediaActions;
}

export interface NormalizedToolMediaActionButton {
  customId: string;
  label?: string;
  emoji?: string;
}

export interface NormalizedToolMediaActions {
  provider: 'mivo';
  jobId: string;
  buttons: NormalizedToolMediaActionButton[];
}

export interface NormalizedToolDiff {
  filePath: string;
  segments: Array<{ key: string; oldString: string; newString: string; label?: string }>;
  insertions: number;
  deletions: number;
}

interface ToolUsePayload extends MessageNormalizeToolUse {
  summary: string;
  diff?: NormalizedToolDiff;
}

export function normalizeRemoteMessages(messages: readonly RemoteMessage[]): NormalizedRemoteMessage[] {
  const sorted = sortMessagesByCreatedAt(messages);
  const toolResultPairing = buildMessageToolResultPairing(sorted);

  const result: NormalizedRemoteMessage[] = [];
  for (const message of sorted) {
    if (message.role === 'tool_result') continue;

    if (message.role === 'tool_use') {
      const tool = parseToolUse(message);
      if (tool.toolName === 'AskUserQuestion' || tool.toolName === 'ExitPlanMode') continue;
      // Lead 派活(create_worker / send_to_worker)→ 渲染成 dispatch 卡片(kind:'system' 使其成为
      // 独立卡片而非折叠进 tool_group),其余 tool 照常走下面的 tool 渲染。
      const dispatchCard = buildOrcaDispatchCard(tool.toolName, tool.input);
      if (dispatchCard) {
        result.push({
          key: messageNormalizeKey(message),
          source: message,
          kind: 'system',
          role: message.role,
          label: dispatchCard.title,
          body: dispatchCard.body,
          orcaCard: dispatchCard,
          align: 'agent',
          createdAt: message.createdAt,
        });
        continue;
      }
      const secondaryBody = toolResultContentFor(message, tool, toolResultPairing);
      result.push({
        key: messageNormalizeKey(message),
        source: message,
        kind: 'tool',
        role: message.role,
        label: tool.toolName || 'tool_use',
        body: tool.summary,
        secondaryBody,
        media: extractToolResultMedia(secondaryBody ?? ''),
        diff: tool.diff,
        align: 'agent',
        createdAt: message.createdAt,
        toolSettled: toolResultPairing.hasResultFor(message, tool),
      });
      continue;
    }

    if (message.role === 'ask_user') {
      const ask = normalizeAskUser(message);
      if (ask) result.push(ask);
      continue;
    }

    if (message.role === 'plan_review') {
      result.push(normalizePlanReview(message));
      continue;
    }

    if (message.role === 'thinking') {
      const thinking = normalizeThinking(message);
      if (thinking) result.push(thinking);
      continue;
    }

    // turn 失败终态的持久化行(desktop main 落库):content = { message, reason? },
    // 提取 message 文案按 system 样式展示 —— 不加分支会 fall through 到通用兜底,
    // body 变成整段生 JSON。agent 未鉴权错误换成带引导的中文提示(describeAgentAuthError),
    // 其余 reason 的本地化 / 红色错误卡样式留待手机版专项跟进。
    if (message.role === 'error') {
      const c = parseMaybeJsonObject(message.content);
      const rawText = typeof c?.message === 'string' ? c.message : contentToPreview(message.content);
      const errText = describeAgentAuthError(rawText) ?? rawText;
      result.push({
        key: messageNormalizeKey(message),
        source: message,
        kind: 'system',
        role: message.role,
        label: 'error',
        body: errText,
        align: 'agent',
        createdAt: message.createdAt,
      });
      continue;
    }

    // /goal 持久记录(桌面 goal-host 落库:role 'assistant' + 空 content + agentMeta 标记)
    // → goal 系统卡。不加分支会 fall through 到通用 assistant 处理,渲染成空白气泡。
    if (message.role === 'assistant') {
      const goalCard = normalizeGoalCard(message);
      if (goalCard) {
        result.push(goalCard);
        continue;
      }
    }

    // session-agent-switch 边界行(desktop 落库 role='agent_switch') → 'agent-switch'
    // 系统卡。不加分支会 fall through 到末尾通用处理,渲染成生 JSON 的 system 气泡。
    if (message.role === 'agent_switch') {
      const c = readRecord(message.content) ?? {};
      result.push({
        key: messageNormalizeKey(message),
        source: message,
        kind: 'system',
        role: message.role,
        label: 'system:agent-switch',
        body: '',
        systemCardType: 'agent-switch',
        systemCardData: c,
        align: 'agent',
        createdAt: message.createdAt,
      });
      continue;
    }

    const systemCardType = normalizeSystemCardType(message.systemCardType);
    if (systemCardType) {
      result.push({
        key: messageNormalizeKey(message),
        source: message,
        kind: 'system',
        role: message.role,
        label: `system:${systemCardType}`,
        body: '',
        systemCardType,
        systemCardData: readRecord(message.systemCardData) ?? {},
        align: 'agent',
        createdAt: message.createdAt,
      });
      continue;
    }

    // worker 回报:user 消息 content = {orcaSource:'worker',content} → report 卡片;非该格式回退普通文本。
    if (message.role === 'user') {
      const reportCard = parseOrcaWorkerReport(message.content);
      if (reportCard) {
        result.push({
          key: messageNormalizeKey(message),
          source: message,
          kind: 'user',
          role: message.role,
          label: 'orca:report',
          body: reportCard.body,
          orcaCard: reportCard,
          align: 'agent',
          createdAt: message.createdAt,
        });
        continue;
      }
    }

    // silent-stop 自动续跑注入的「继续」(agentMeta.autoResume,桌面 main 守卫落库):
    // 不渲染用户气泡,渲染「连接中断,已自动继续」分隔卡(对齐桌面);kind/label 保持
    // user 以保留 turn 边界(上一段被截断 turn 的工具行按历史收敛),align 'agent'
    // 让卡片走系统卡的左侧版式而不是右侧用户气泡。
    if (message.role === 'user' && message.agentMeta?.autoResume === true) {
      result.push({
        key: messageNormalizeKey(message),
        source: message,
        kind: 'user',
        role: message.role,
        label: 'user',
        body: '',
        systemCardType: 'auto-resume',
        systemCardData: {},
        align: 'agent',
        createdAt: message.createdAt,
      });
      continue;
    }
    const userContent = message.role === 'user' ? parseUserContent(message.content) : null;
    // 合成 UI 指令行(隐藏续跑 prompt 等):打标 + body 置空,不渲染但保留 turn 边界。
    if (userContent && isSyntheticTriggerText(userContent.text)) {
      result.push({
        key: messageNormalizeKey(message),
        source: message,
        kind: 'user',
        role: message.role,
        label: 'user',
        body: '',
        isSyntheticTrigger: true,
        align: 'user',
        createdAt: message.createdAt,
      });
      continue;
    }
    const rawBody = userContent ? userContent.text : contentToPreview(message.content);
    const hookSource = message.role === 'user' ? readHookSource(message, rawBody) : undefined;
    const body = hookSource?.userText ?? rawBody;
    const turnCost = readTurnCost(message);
    result.push({
      key: messageNormalizeKey(message),
      source: message,
      kind: message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system',
      role: message.role,
      label: message.role,
      body,
      attachments: userContent?.attachments,
      ...(userContent?.quotesEncoded === true ? { quotesEncoded: true } : {}),
      sessionReferences: userContent?.sessionReferences,
      ...(userContent?.pastedTextRanges?.length
        ? { pastedTextRanges: userContent.pastedTextRanges }
        : {}),
      ...(userContent?.slashCommandRanges !== undefined
        ? { slashCommandRanges: userContent.slashCommandRanges }
        : {}),
      ...(userContent?.agentReferences?.length
        ? { agentReferences: userContent.agentReferences }
        : {}),
      align: message.role === 'user' && hookSource === undefined ? 'user' : 'agent',
      createdAt: message.createdAt,
      isStreaming: readMessageStreaming(message) || undefined,
      ...(message.role === 'assistant' && (
        message.agentMeta?.turnCompleted === true ||
        (turnCost.turnMoney?.amount ?? 0) > 0
      )
        ? { turnCompleted: true }
        : {}),
      ...turnCost,
      ...readModelMismatch(message),
      ...(message.role === 'user' ? readAutomationOrigin(message) : {}),
      ...(hookSource ? { hookSource } : {}),
    });
  }

  return result;
}

function toolResultContentFor(
  message: RemoteMessage,
  tool: ToolUsePayload,
  pairing: MessageToolResultPairing<RemoteMessage>,
): string | undefined {
  return pairing.resultContentFor(message, tool);
}

function parseToolUse(message: RemoteMessage): ToolUsePayload {
  const sharedTool = parseMessageToolUse(message);
  const { toolName, input } = sharedTool;
  const summary = toolName ? formatToolUseSummary(toolName, input) : contentToPreview(message.content);
  const diff = buildToolDiff(toolName, input);
  return { ...sharedTool, summary, diff };
}

function parseUserContent(content: unknown): {
  text: string;
  attachments: NormalizedAttachment[];
  quotesEncoded: boolean;
  sessionReferences: MobilePersistedSessionReferenceMetadata[];
  pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges?: Array<{ start: number; end: number }>;
  agentReferences?: AgentInputReference[];
} {
  const parsed = parseMaybeJsonObject(content);
  if (!parsed) {
    return {
      text: contentToPreview(content),
      attachments: [],
      quotesEncoded: false,
      sessionReferences: [],
    };
  }
  const text = typeof parsed.text === 'string' ? parsed.text : contentToPreview(content);
  const pastedTextRanges = readSentPastedTextRanges(parsed.pastedTextRanges, text);
  const slashCommandRanges = readSentSlashCommandRanges(parsed.slashCommandRanges, text);
  const agentReferences = readAgentInputReferences(parsed.agentReferences, text);
  return {
    text,
    quotesEncoded: parsed.quotesEncoded === true,
    ...(pastedTextRanges ? { pastedTextRanges } : {}),
    ...(slashCommandRanges !== undefined ? { slashCommandRanges } : {}),
    ...(agentReferences.length > 0 ? { agentReferences } : {}),
    attachments: [
      ...readImageAttachments(parsed.images),
      ...readFileAttachments(parsed.files),
    ],
    sessionReferences: parseMobilePersistedSessionReferenceMetadata(parsed.sessionReferences),
  };
}

function readImageAttachments(value: unknown): NormalizedAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = readRecord(item);
    if (!record) return [];
    const url = readString(record.url);
    const base64 = readString(record.base64);
    const mimeType = readString(record.mimeType) ?? readString(record.type) ?? 'image/png';
    const name = readString(record.originalName) ?? readString(record.name) ?? `image-${index + 1}`;
    const uri = url ?? (base64 ? `data:${mimeType};base64,${base64}` : undefined);
    if (!uri) return [];
    return [{
      kind: 'image' as const,
      name,
      uri,
      mimeType,
      previewable: isPreviewableUri(uri),
    }];
  });
}

function readFileAttachments(value: unknown): NormalizedAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = readRecord(item);
    if (!record) return [];
    const path = readString(record.path) ?? readString(record.url);
    const name = readString(record.name) ?? readString(record.originalName) ?? path?.split(/[\\/]/).pop() ?? `file-${index + 1}`;
    if (!path && !name) return [];
    return [{
      kind: 'file' as const,
      name,
      path: path ?? undefined,
      mimeType: readString(record.mimeType) ?? undefined,
      previewable: false,
    }];
  });
}

/**
 * /goal 持久记录 → goal 系统卡(对齐桌面 makerChatStore 从 agentMeta.goalCompletion /
 * goalNotice 派生 'goal-complete' / 'goal-resumed' system card 的逻辑)。非 goal 记录
 * 返回 null,走通用 assistant 处理。
 */
function normalizeGoalCard(message: RemoteMessage): NormalizedRemoteMessage | null {
  const meta = message.agentMeta;
  if (!meta) return null;
  const completion = readRecord(meta.goalCompletion);
  const notice = typeof meta.goalNotice === 'string' ? meta.goalNotice : null;
  if (!completion && !notice) return null;
  const systemCardType = completion ? ('goal-complete' as const) : ('goal-resumed' as const);
  return {
    key: messageNormalizeKey(message),
    source: message,
    kind: 'system',
    role: message.role,
    label: `system:${systemCardType}`,
    body: '',
    systemCardType,
    systemCardData: completion ?? { kind: notice },
    align: 'agent',
    createdAt: message.createdAt,
  };
}

function normalizeAskUser(message: RemoteMessage): NormalizedRemoteMessage | null {
  const content = readRecord(message.content);
  if (!content) return null;
  if (content.status !== 'answered') return null;

  const questions = readQuestionTexts(content.questions);
  const answers = readStringRecord(content.answers);
  const pairs = questions.length > 0
    ? questions.map((question) => ({ question, answer: answers?.[question] ?? '' }))
    : [{
        question: readString(content.question) ?? contentToPreview(message.content),
        answer: readString(content.reply) ?? '',
      }];

  const body = pairs
    .filter((pair) => pair.question || pair.answer)
    .map((pair) => `Q: ${pair.question}\nA: ${pair.answer || '(skipped)'}`)
    .join('\n\n');

  if (!body) return null;
  return {
    key: messageNormalizeKey(message),
    source: message,
    kind: 'ask_user',
    role: message.role,
    label: 'ask_user',
    body,
    align: 'agent',
    createdAt: message.createdAt,
  };
}

function normalizePlanReview(message: RemoteMessage): NormalizedRemoteMessage {
  const content = readRecord(message.content);
  const rawStatus = readString(content?.status);
  // 'cancelled' 是桌面写侧的一等状态(用户主动取消审阅);漏枚举会被静默降级成
  // 'expired'(系统过期),语义错标。
  const status = rawStatus === 'approved' || rawStatus === 'revised' || rawStatus === 'pending' || rawStatus === 'cancelled'
    ? rawStatus
    : 'expired';
  const plan = readString(content?.plan) ?? '';
  const feedback = readString(content?.feedback) ?? '';
  const summary = summarizePlan(plan);
  const body = status === 'revised'
    ? (feedback || summary)
    : summary;

  return {
    key: messageNormalizeKey(message),
    source: message,
    kind: 'plan_review',
    role: message.role,
    label: `plan_review:${status}`,
    body,
    secondaryBody: status === 'revised' && feedback && summary ? summary : undefined,
    align: 'agent',
    createdAt: message.createdAt,
  };
}

function normalizeThinking(message: RemoteMessage): NormalizedRemoteMessage | null {
  const content = readRecord(message.content);
  const text = readString(content?.text) ?? '';
  const durationMs = readNumber(content?.durationMs) ?? 0;
  const redacted = content?.isRedacted === true;
  // Opus 4.8+ / Fable 5 的 omitted thinking 占位块(空文本 + 零时长):上游只回带
  // 签名的空块,渲染出来就是满屏"思考 1s"噪音,直接不进渲染流(对齐桌面 #467 的
  // isOmittedThinkingPlaceholder 判定;redacted 块与真实流过增量的空块不受影响)。
  if (!redacted && text === '' && durationMs === 0) return null;
  return {
    key: messageNormalizeKey(message),
    source: message,
    kind: 'thinking',
    role: message.role,
    label: durationMs > 0 ? `thinking ${formatDuration(durationMs)}` : 'thinking',
    body: redacted ? 'Thinking hidden' : text,
    align: 'agent',
    createdAt: normalizeThinkingCreatedAt(message.createdAt, content, durationMs),
    // 流式标记必须随 thinking 透传:ThinkingCard 的「思考中 Xs」实时计时以
    // message.isStreaming 为运行判定,丢掉它计时器永远不启动(review #643 实锤)。
    isStreaming: readMessageStreaming(message) || undefined,
  };
}

function formatToolUseSummary(toolName: string, input: unknown): string {
  return formatPayloadToolUseSummary(toolName, input);
}

function normalizeThinkingCreatedAt(
  createdAt: string,
  content: Record<string, unknown> | null,
  durationMs: number,
): string {
  const finishedAt = readTimestamp(content?.finishedAt) ?? readTimestamp(createdAt);
  if (finishedAt === null || durationMs <= 0) return createdAt;
  return new Date(finishedAt - durationMs).toISOString();
}

function buildToolDiff(toolName: string, input: unknown): NormalizedToolDiff | undefined {
  return buildPayloadToolDiff(toolName, input);
}

export function extractToolResultMedia(toolResult: string): NormalizedToolMedia[] {
  return extractPayloadToolResultMedia(toolResult);
}

function readQuestionTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readString(readRecord(item)?.question))
    .filter((item): item is string => !!item);
}

function readStringRecord(value: unknown): Record<string, string> | null {
  const record = readRecord(value);
  if (!record) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    out[key] = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  }
  return out;
}

function summarizePlan(plan: string, maxLines = 3): string {
  const lines = plan.split('\n').map((line) => line.trim()).filter(Boolean);
  const head = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? `${head}\n...` : head;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') return parseJsonObject(value);
  return readRecord(value);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeSystemCardType(value: unknown): MobileSystemCardType | null {
  return value === 'help'
    || value === 'context'
    || value === 'cost'
    || value === 'pwd'
    || value === 'status'
    || value === 'compact'
    || value === 'cmd'
    || value === 'learn'
    ? value
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readTurnCost(
  message: RemoteMessage,
): Pick<NormalizedRemoteMessage, 'turnMoney' | 'turnCostUsd' | 'turnCostIsEstimate'> {
  if (message.role !== 'assistant') return {};
  const money = normalizeRemoteMoney(message.agentMeta?.turnCost);
  if (money && money.amount > 0) {
    return {
      turnMoney: money,
      ...(money.currency === 'USD' ? { turnCostUsd: money.amount } : {}),
      turnCostIsEstimate: money.kind === 'value-estimate',
    };
  }
  const cost = readNumber(message.agentMeta?.turnCostUsd);
  if (cost === null || cost <= 0) return {};
  const isEstimate = message.agentMeta?.turnCostIsEstimate === true;
  return {
    turnMoney: {
      amount: cost,
      currency: 'USD',
      approximate: isEstimate,
      kind: isEstimate ? 'value-estimate' : 'actual-cost',
    },
    turnCostUsd: cost,
    turnCostIsEstimate: isEstimate,
  };
}

// 桌面 main 在 turn 结束检测到模型被上游降级时写 agentMeta.modelMismatch =
// { selected, actual }(modelMismatchBroadcaster);字段不全的一律忽略。
function readModelMismatch(message: RemoteMessage): Pick<NormalizedRemoteMessage, 'modelMismatch'> {
  if (message.role !== 'assistant') return {};
  const mm = readRecord(message.agentMeta?.modelMismatch);
  if (!mm) return {};
  const selected = readString(mm.selected);
  const actual = readString(mm.actual);
  if (!selected || !actual) return {};
  return { modelMismatch: { selected, actual } };
}

// scheduler runner 落库时在 agentMeta.origin 写 { kind:'scheduler', scheduleId, scheduleName? }
// (见桌面 MessageAutomationOrigin);其它 kind 或缺 scheduleId 的一律忽略。
function readAutomationOrigin(message: RemoteMessage): Pick<NormalizedRemoteMessage, 'automationOrigin'> {
  const origin = readRecord(message.agentMeta?.origin);
  if (!origin || origin.kind !== 'scheduler') return {};
  const scheduleId = readString(origin.scheduleId);
  if (!scheduleId) return {};
  const scheduleName = readString(origin.scheduleName);
  return {
    automationOrigin: {
      scheduleId,
      ...(scheduleName ? { scheduleName } : {}),
    },
  };
}

/** Fail closed on unknown providers and bound all server-controlled display fields. */
function readHookSource(message: RemoteMessage, fallbackBody: string): NormalizedHookSource | undefined {
  const source = readRecord(message.agentMeta?.hookSource);
  if (!source || (source.im !== 'slack' && source.im !== 'telegram')) return undefined;
  const userText = (
    typeof source.userText === 'string' ? source.userText : fallbackBody
  ).slice(0, 20_000);
  const channelName = readString(source.channelName)?.slice(0, 160);
  const rawContext = Array.isArray(source.threadContext) ? source.threadContext.slice(0, 20) : [];
  const threadContext = rawContext.flatMap((value) => {
    const entry = readRecord(value);
    const author = readString(entry?.author)?.slice(0, 128);
    const text = readString(entry?.text)?.slice(0, 4_000);
    if (!author || text == null) return [];
    return [{ author, text, ...(entry?.isBot === true ? { isBot: true } : {}) }];
  });
  return {
    im: source.im,
    userText,
    ...(channelName ? { channelName } : {}),
    ...(threadContext.length > 0 ? { threadContext } : {}),
  };
}

function readMessageStreaming(message: RemoteMessage): boolean {
  if (message.agentMeta?.isStreaming === true || message.agentMeta?.streaming === true) return true;
  const content = readRecord(message.content);
  return content?.isStreaming === true || content?.streaming === true;
}

function isPreviewableUri(uri: string): boolean {
  return uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:image/');
}
