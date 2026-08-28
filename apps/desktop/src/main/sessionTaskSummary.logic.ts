/**
 * sessionTaskSummary.logic — sessionTaskSummary 的**纯逻辑**(无 electron / db / maker-host
 * 依赖),抽出以便 `__tests__` 直接单测「档位选择 / sanitize 截断 / 定时识别 / 素材判定」
 * 等关键路径,不必拉起重运行时依赖(规则:可测逻辑拆纯函数)。
 *
 * 运行时副作用(DB 查询、clearedAt 谓词、oneShot、broadcast、节流/回填巡检)留在
 * sessionTaskSummary.ts;那里直接复用本模块的纯函数,保证单测覆盖的是真实代码路径、
 * 而非平行实现(避免逻辑漂移)。
 */

import { projectPersistedAgentFacingUserText } from '@cindy/maker-shared/agent-input-projection';
import { isSyntheticTriggerText } from '../shared/interruptedTurn.js';

/** 输出硬上限(字符)——与 prompt 长档上限相同(≤26 字)。实测模型(haiku/mini)
 *  经常无视 prompt 字数要求写到 30+,**这里才是真正的保证**,prompt 只是引导。
 *  26 的依据:卡片 clamp 3 行,窄两列(侧栏 ~277px → 摘要区 96px / 11px 字号)
 *  一行 ≈8.7 个汉字,3 行 ≈26 字——超过就会被裁掉看不全(CDP 实测口径)。 */
export const SUMMARY_MAX_CHARS = 26;
/** 短档硬上限(字符)——prompt 要求 ≤12 字,留标点余量。 */
export const SUMMARY_SHORT_MAX_CHARS = 16;
/** 超短档硬上限(字符)——久置(>3天)会话 prompt 要求 ≤8 字,留标点余量;
 *  也是启动回填判断"久置会话的摘要是否还没降级"的阈值(>11 字 = 要重生成)。 */
export const SUMMARY_STALE_MAX_CHARS = 11;

/** 时间衰减——距今时间(最近活动→现在)为档位主轴(用户需求:越久没活动,描述越精简):
 *  ≥24h 未活动 → 短档(≤12字),≥3 天未活动 → 超短档(≤8字),<24h → 按使用强度。距今
 *  基于 userSendAt(最后一次用户发送,与卡片显示同源)——不能用 updatedAt:置顶/归档等
 *  update 会把它刷成 now,刚置顶的久会话会被误判成新鲜。 */
export const STALE_DEMOTE_MS = 24 * 60 * 60 * 1000;
export const STALE_SHORT_MS = 3 * 24 * 60 * 60 * 1000;

/** <24h 近期会话按消息数细分使用强度的两个门槛。 */
export const TIER_SHORT_MAX_MESSAGES = 60;
export const TIER_LONG_MIN_MESSAGES = 200;

export type SummaryTier = 'short' | 'long' | 'auto' | 'stale';

export const TIER_DIRECTIVE: Record<SummaryTier, string> = {
  short: '本任务使用短档:不超过12字。',
  long: '本任务是重度使用的会话,优先使用长档(18~26字);例外:如果会话本质是重复的单次简单操作(如反复生图、批量翻译),仍用短档。',
  auto: '请按上面的档位说明,根据会话内容自行判断用短档还是长档。',
  stale:
    '本任务很久没有活动了:用超短档,不超过8字,几个词点出任务即可(如"生成海报。""术语表方案。")。',
};

/** 档位 → sanitize 硬上限。短档也硬截,保证时间衰减回填的"length > 16 才重生成"条件能收敛。 */
export function maxCharsForTier(tier: SummaryTier): number {
  return tier === 'stale'
    ? SUMMARY_STALE_MAX_CHARS
    : tier === 'short'
      ? SUMMARY_SHORT_MAX_CHARS
      : SUMMARY_MAX_CHARS;
}

export const SUMMARY_PROMPT = (
  title: string,
  userMsg: string,
  assistantMsg: string,
  tier: SummaryTier,
) =>
  `你在为任务卡片生成状态摘要。用与会话内容相同的语言直接输出摘要本身(以句号结尾,不要引号,不要任何前缀)。直接说任务与进展,禁止"根据对话内容""这是一个关于…的任务"这类元描述。

档位说明(摘要长短不一是刻意的,卡片靠它错落排版):
- 短档:不超过12字,一句短话说清在做什么或最近一轮结果。示例:"生成赛博朋克海报。"、"数据源暂无新内容。"
- 长档:18~26字,一句话概括任务目标 + 当前进展,绝对不要超过26字,不要罗列细节。示例:"重构 Prompt 模板,完成 3/5 模块。"

${TIER_DIRECTIVE[tier]}

注意:用户最近的要求可能只是简短确认(如"好了""可以"),此时根据任务标题和助手答复概括任务本身,绝不要复述寒暄或确认语。

任务标题: ${title}
用户最近的要求: ${userMsg.slice(0, 300)}
助手最近的答复: ${assistantMsg.slice(0, 600)}`;

/**
 * messages.content(JSON string)→ 纯文本。与 mapper.extractMessagePreview
 * 同口径但不截 140 字——这里是喂给 LLM 的素材,长度由 prompt 模板截断。
 * 合成 UI 指令行(隐藏续跑等)返回 ''(review P2):它不是用户的真实要求,
 * 喂给摘要 LLM 会把隐藏英文指令当"用户最近的要求"生成误导摘要。
 */
export function extractText(raw: string | null | undefined, role: string): string {
  if (!raw) return '';
  const guard = (text: string): string => (isSyntheticTriggerText(text) ? '' : text);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (role === 'user' && parsed && typeof parsed === 'object' && 'text' in parsed) {
      const projected = projectPersistedAgentFacingUserText(parsed);
      if (projected !== null) return guard(projected);
      const text = (parsed as { text?: unknown }).text;
      return typeof text === 'string' ? guard(text) : '';
    }
    if (typeof parsed === 'string') return guard(parsed);
    return '';
  } catch {
    return typeof raw === 'string' ? guard(raw) : '';
  }
}

/** 去掉模型偶发包裹的引号/前缀噪音,折叠空白,超长时优先在句子边界截断。
 *  maxChars 按档位传入(短档 16 / 其余 26)——短档也硬截,保证时间衰减回填
 *  的"length > 16 才重生成"条件能收敛,不会每次启动都反复重试。 */
export function sanitize(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/^["'「『""]+|["'」』""]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  // 模型超长输出:截到上限内最后一个句末标点,避免"…不同复杂度"这种拦腰断句;
  // 保留量不足上限 3/4 时不值得句末截断,继续走子句兜底
  const minKeep = Math.floor(maxChars * 0.75);
  const head = cleaned.slice(0, maxChars);
  const lastEnd = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('!'),
    head.lastIndexOf('?'),
    head.lastIndexOf('.'),
  );
  if (lastEnd >= minKeep) return head.slice(0, lastEnd + 1);
  // 句内连句末标点都没有(模型一逗到底):退而求其次切到最后一个子句边界,
  // 丢掉残句并补句号——宁可少说半句,不出现"…且多语"这种拦腰断词
  const lastClause = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf('；'),
    head.lastIndexOf(','),
    head.lastIndexOf(';'),
  );
  return lastClause >= minKeep ? `${head.slice(0, lastClause)}。` : head;
}

/** 定时任务识别口径对齐 renderer 的 isAutomationGeneratedSession:
 *  新数据 source='scheduler',旧数据只有标题前缀 '[Schedule] '。 */
export function isScheduledSession(source: string | null | undefined, title: string): boolean {
  return source === 'scheduler' || title.startsWith('[Schedule] ');
}

/**
 * 档位选择——**距今时间为主轴**(越久越精简),近期会话再按使用强度细分:
 *   - 距今 ≥3 天        → stale(超短档 ≤8字,久置卡片自然变薄)
 *   - 距今 24h~3 天     → short(短档 ≤12字)
 *   - 距今 <24h:定时任务 → short;消息数 ≥200(重上下文)→ long;
 *                  消息数 ≤60(轻量)→ short;其余 → auto(交给模型)
 * 纯函数,运行时与单测共用同一份判定。
 */
export function pickTier(args: {
  inactiveMs: number;
  messageCount: number;
  isScheduled: boolean;
}): SummaryTier {
  const { inactiveMs, messageCount, isScheduled } = args;
  if (inactiveMs >= STALE_SHORT_MS) return 'stale';
  if (inactiveMs >= STALE_DEMOTE_MS) return 'short';
  if (isScheduled) return 'short';
  if (messageCount >= TIER_LONG_MIN_MESSAGES) return 'long';
  if (messageCount <= TIER_SHORT_MAX_MESSAGES) return 'short';
  return 'auto';
}

/** 有无可总结素材——空草稿被置顶时 user/assistant 文本皆空,没东西可总结,跳过。 */
export function hasSummarizableMaterial(userMsg: string, assistantMsg: string): boolean {
  return Boolean(userMsg || assistantMsg);
}

/** 摘要只在「置顶 + 置顶段是卡片模式」时生成。列表/文字模式不花 oneShot。 */
export function shouldGeneratePinnedCardSummary(args: {
  status: string;
  pinnedAt: number | string | null | undefined;
  pinnedSectionIsCard: boolean;
}): boolean {
  return args.status === 'active' && args.pinnedAt != null && args.pinnedSectionIsCard;
}

/** 一次生成尝试结算后:没写出新摘要、且已经不在卡片模式 → 必须作废库里的旧句子。
 *  成功写回的本轮摘要留下;失败 / 空结果 / 写回放弃 / 中途抛错都走这条。 */
export function shouldVoidSummaryAfterGenerationAttempt(args: {
  wroteFresh: boolean;
  pinnedSectionIsCard: boolean;
}): boolean {
  return !args.wroteFresh && !args.pinnedSectionIsCard;
}

/** 列表/文字 turn-done:摘要必须清空,同时带上最新消息 preview。
 *  列表不再展示 summary,若只广播 summary:null,侧栏会停在进入本轮前的旧 preview。 */
export function nonCardTurnDisplayPatch(preview: string | null): {
  summary: null;
  preview: string | null;
} {
  return { summary: null, preview };
}

/** 列表预览与置顶卡片摘要解耦:只补最近消息,不动 summary。 */
export function sessionListPreviewPatch(preview: string | null): {
  preview: string | null;
} {
  return { preview };
}

/** clear 若发现已切回卡片,只在该 session 没有生成在飞时才 force 再生成。
 *  generateSummaryOnce.finally → clear → maybeGenerate 会 await 尚未 settle 的同一条 inFlight,死锁。 */
export function shouldForceGenerateOnClear(args: {
  pinnedSectionIsCard: boolean;
  sessionGenerateInFlight: boolean;
}): boolean {
  return args.pinnedSectionIsCard && !args.sessionGenerateInFlight;
}

/** 切回卡片时若同 session 仍在飞:不能 await 自己,但必须在结算后 force 一次。 */
export function shouldScheduleForceGenerateAfterInFlight(args: {
  pinnedSectionIsCard: boolean;
  sessionGenerateInFlight: boolean;
}): boolean {
  return args.pinnedSectionIsCard && args.sessionGenerateInFlight;
}
