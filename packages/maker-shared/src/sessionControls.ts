import { messageContentToPreview } from './messageNormalize.js';
import type {
  MobileCodexRateLimitResetCredit,
  MobileCodexRateLimitsResult,
} from './deviceLinkContract.js';
import {
  presentationDate,
  presentationText,
  presentationTime,
  type PresentationLocalizer,
} from './presentationLocalization.js';

export interface SessionControlsSessionLike {
  contextTokens?: number;
  contextWindow?: number;
  effort?: string;
  fastMode: boolean;
  model: string;
  permissionMode: string;
  status: 'active' | 'archived' | 'deleted' | string;
  title?: string | null;
  totalCostUsd?: number;
  totalMoney?: SessionControlsMoneyLike | null;
  totalTokenUsage?: number;
  workingDir?: string | null;
}

export interface SessionControlsMoneyLike {
  amount: number;
  currency: 'CNY' | 'USD';
}

export function summarizeSessionSpend(session: Pick<
  SessionControlsSessionLike,
  'contextTokens' | 'contextWindow' | 'totalCostUsd' | 'totalMoney' | 'totalTokenUsage'
> | null, localizer?: PresentationLocalizer): {
  title: string;
  detail: string;
  available: boolean;
} {
  const title = presentationText(localizer, 'session.presentation.controls.spend.title', 'Session spend');
  const unavailable = presentationText(localizer, 'session.presentation.controls.spend.unavailable', '暂无任务用量');
  if (!session) {
    return { title, detail: unavailable, available: false };
  }

  // Structured money is authoritative. In particular, a CNY projection intentionally clears
  // totalCostUsd; falling back to a stale legacy USD field would either hide the amount or leak
  // the wrong currency into Mobile /cost and the session menu.
  const totalMoney = readSessionMoney(session.totalMoney);
  const totalCostUsd = totalMoney ? null : readNumber(session.totalCostUsd);
  const totalTokenUsage = readNumber(session.totalTokenUsage);
  const contextTokens = readNumber(session.contextTokens);
  const contextWindow = readNumber(session.contextWindow);
  const parts: string[] = [];

  if (totalMoney && totalMoney.amount > 0) {
    const cost = formatMoney(totalMoney.amount, totalMoney.currency);
    parts.push(presentationText(localizer, 'session.presentation.controls.spend.taskCost', `本任务 ${cost}`, { cost }));
  } else if (totalCostUsd !== null && totalCostUsd > 0) {
    const cost = formatUsd(totalCostUsd);
    parts.push(presentationText(localizer, 'session.presentation.controls.spend.taskCost', `本任务 ${cost}`, { cost }));
  }
  if (totalTokenUsage !== null && totalTokenUsage > 0) {
    parts.push(`${formatCompactNumber(totalTokenUsage)} tokens`);
  }
  if (contextTokens !== null && contextTokens > 0) {
    if (contextWindow !== null && contextWindow > 0) {
      const percent = Math.min(100, Math.max(0, (contextTokens / contextWindow) * 100));
      const used = formatCompactNumber(contextTokens);
      const total = formatCompactNumber(contextWindow);
      const percentage = formatPercent(percent);
      parts.push(presentationText(localizer, 'session.presentation.controls.spend.contextWithLimit', `上下文 ${used} / ${total} · ${percentage}`, {
        percentage,
        total,
        used,
      }));
    } else {
      const used = formatCompactNumber(contextTokens);
      parts.push(presentationText(localizer, 'session.presentation.controls.spend.context', `上下文 ${used} tokens`, { used }));
    }
  }

  if (parts.length === 0) {
    return { title, detail: unavailable, available: false };
  }
  return { title, detail: parts.join(' · '), available: true };
}

export function summarizeContextUsage(value: unknown, localizer?: PresentationLocalizer): {
  title: string;
  detail: string;
  rows: Array<{ label: string; value: string }>;
} {
  const title = presentationText(localizer, 'session.presentation.controls.context.title', 'Context usage');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      title,
      detail: presentationText(localizer, 'session.presentation.controls.context.unavailable', '暂无上下文数据'),
      rows: [],
    };
  }
  const record = value as Record<string, unknown>;
  const contextTokens = readNumber(record.totalTokens ?? record.contextTokens);
  const maxContextTokens = readNumber(
    record.rawMaxTokens
    ?? record.maxTokens
    ?? record.maxContextTokens
    ?? record.contextWindow,
  );
  const percent = readNumber(record.percent ?? record.percentage ?? record.contextPercent);
  const costUsd = readNumber(record.costUsd ?? record.totalCostUsd);
  const parts: string[] = [];
  if (contextTokens !== null) {
    parts.push(maxContextTokens !== null
      ? `${formatNumber(contextTokens)} / ${formatNumber(maxContextTokens)} tokens`
      : `${formatNumber(contextTokens)} tokens`);
  }
  if (percent !== null) {
    parts.push(`${Math.round(percent > 1 ? percent : percent * 100)}%`);
  } else if (contextTokens !== null && maxContextTokens !== null && maxContextTokens > 0) {
    parts.push(`${Math.round((contextTokens / maxContextTokens) * 100)}%`);
  }
  if (costUsd !== null) {
    parts.push(`$${costUsd.toFixed(4)}`);
  }
  const rows = buildContextUsageRows(record, maxContextTokens);
  if (parts.length > 0) {
    return { title, detail: parts.join(' · '), rows };
  }
  return { title, detail: messageContentToPreview(value), rows };
}

/**
 * 账号级限额窗口摘要(Codex ChatGPT 订阅):把被控端 `maker:usage:account` 返回的
 * RateLimitSnapshot(shape 见 maker-core codex protocol / desktop usageBroadcaster)
 * 整理成「会话信息」面板可直接渲染的行。窗口构成完全以上游接口返回为准,不假设
 * 固定窗口(OpenAI 会调整策略:典型 5h + 周双窗,2026-07 曾一度取消 5h,且可能
 * 随时恢复):窗口名由 windowMinutes 动态派生,缺数据时兜底中性「限额」,与桌面
 * TodaySpendChip 的 formatWindowLabel 同规则。解析不到任何可展示内容 → null
 * (调用方不渲染整个区块,不显示 loading / 空态)。
 */
export function summarizeAccountRateLimits(
  value: unknown,
  nowMs: number,
  localizer?: PresentationLocalizer,
): {
  rows: Array<{ label: string; value: string }>;
} | null {
  const record = readRecord(value);
  if (!record) return null;
  const rows: Array<{ label: string; value: string }> = [];

  const planType = readString(record.planType);
  if (planType) {
    rows.push({
      label: presentationText(localizer, 'session.presentation.controls.rateLimit.plan', '套餐'),
      value: formatPlanTypeLabel(planType),
    });
  }

  for (const window of [readRecord(record.primary), readRecord(record.secondary)]) {
    if (!window) continue;
    const usedPercent = readNumber(window.usedPercent);
    if (usedPercent === null) continue;
    const used = Math.min(100, Math.max(0, usedPercent));
    const parts = [
      presentationText(localizer, 'session.presentation.controls.rateLimit.remaining', `剩余 ${formatRateLimitPercent(100 - used)}`, {
        percent: formatRateLimitPercent(100 - used),
      }),
      presentationText(localizer, 'session.presentation.controls.rateLimit.used', `已用 ${formatRateLimitPercent(used)}`, {
        percent: formatRateLimitPercent(used),
      }),
    ];
    const resetText = formatRateLimitResetAt(readNumber(window.resetsAt), nowMs, localizer);
    if (resetText) {
      parts.push(presentationText(localizer, 'session.presentation.controls.rateLimit.resetsAt', `${resetText} 重置`, {
        time: resetText,
      }));
    }
    rows.push({
      label: rateLimitWindowLabel(readNumber(window.windowMinutes), localizer),
      value: parts.join(' · '),
    });
  }

  // credits_depleted 是「去充值」语义,不属于窗口限流,不在限额区提示。
  const reached = readString(record.rateLimitReachedType);
  if (reached && !reached.includes('credits_depleted')) {
    rows.push({
      label: presentationText(localizer, 'session.presentation.controls.rateLimit.status', '状态'),
      value: presentationText(localizer, 'session.presentation.controls.rateLimit.reached', '已触发账号限额'),
    });
  }

  return rows.length > 0 ? { rows } : null;
}

/** Shared reset-credit summary; `rows` preserves Mobile UI while neutral fields serve other surfaces. */
export interface CodexRateLimitResetSummary {
  rows: Array<{ label: string; value: string }>;
  /** Whether app-server returned reset-credit availability (including an explicit zero). */
  hasResetCreditCount: boolean;
  /** Earliest available reset-credit expiry, as Unix epoch seconds. */
  earliestExpiryAt: number | null;
  availableCount: number;
  canReset: boolean;
  shouldPrompt: boolean;
}

/**
 * Summarize reset credits without guessing provider policy.
 * The action is offered only after a returned bucket is actually exhausted or marked limited.
 */
export function summarizeCodexRateLimitReset(
  value: MobileCodexRateLimitsResult | null,
  nowMs: number,
  localizer?: PresentationLocalizer,
): CodexRateLimitResetSummary | null {
  if (!value) return null;
  const rows: Array<{ label: string; value: string }> = [];
  if (value.account.email) {
    rows.push({
      label: presentationText(localizer, 'session.presentation.controls.rateLimit.account', '账号'),
      value: value.account.email,
    });
  }
  if (value.account.accountId) rows.push({ label: 'Workspace', value: value.account.accountId });

  const hasResetCreditCount = Boolean(value.rateLimitResetCredits);
  const availableCount = Math.max(0, Math.floor(value.rateLimitResetCredits?.availableCount ?? 0));
  if (hasResetCreditCount) {
    rows.push({
      label: presentationText(localizer, 'session.presentation.controls.rateLimit.availableResets', '可用重置'),
      value: presentationText(localizer, 'session.presentation.controls.rateLimit.resetCount', `${availableCount} 次`, {
        count: availableCount,
      }),
    });
  }

  const earliestExpiryAt = value.resetOffer?.expiresAt ?? earliestCreditExpiry(
    value.rateLimitResetCredits?.credits ?? null,
  );
  const expiryText = formatRateLimitResetAt(earliestExpiryAt, nowMs, localizer);
  if (expiryText) {
    rows.push({
      label: presentationText(localizer, 'session.presentation.controls.rateLimit.earliestExpiry', '最早过期'),
      value: expiryText,
    });
  }

  const snapshots = [
    value.rateLimits,
    ...Object.values(value.rateLimitsByLimitId ?? {}),
  ];
  const shouldPrompt = snapshots.some((snapshot) => {
    const reached = readString(snapshot.rateLimitReachedType);
    // Prepaid-credit depletion means “recharge”, not a resettable Codex usage window.
    if (reached?.includes('credits_depleted')) return false;
    if (reached) return true;
    return [snapshot.primary, snapshot.secondary].some((window) => {
      const used = readNumber(window?.usedPercent);
      return used !== null && used >= 100;
    });
  });

  return {
    rows,
    hasResetCreditCount,
    earliestExpiryAt,
    availableCount,
    shouldPrompt,
    canReset: shouldPrompt
      && availableCount > 0
      // Offer TTL belongs to the issuing Desktop clock. Mobile only checks presence;
      // consume returns a typed precondition error when Desktop has actually expired it.
      && Boolean(value.resetOffer),
  };
}

function earliestCreditExpiry(
  credits: MobileCodexRateLimitResetCredit[] | null,
): number | null {
  if (!credits) return null;
  const expiries = credits
    .filter((credit) => credit.status === 'available')
    .map((credit) => credit.expiresAt)
    .filter((expiresAt): expiresAt is number => typeof expiresAt === 'number' && expiresAt > 0);
  return expiries.length > 0 ? Math.min(...expiries) : null;
}

/** 窗口名由服务端下发的时长动态派生(与桌面 formatWindowLabel 同规则);缺数据 → 中性「限额」,不猜具体窗口名。 */
function rateLimitWindowLabel(
  minutes: number | null,
  localizer?: PresentationLocalizer,
): string {
  if (minutes === null || minutes <= 0) {
    return presentationText(localizer, 'session.presentation.controls.rateLimit.window.default', '限额');
  }
  if (minutes % (24 * 60) === 0 && minutes < 7 * 24 * 60) {
    const count = minutes / (24 * 60);
    return presentationText(localizer, 'session.presentation.controls.rateLimit.window.days', `${count}天`, { count });
  }
  if (minutes >= 7 * 24 * 60) {
    return presentationText(localizer, 'session.presentation.controls.rateLimit.window.week', '周');
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

/** 限额百分比:接近整数(±0.05)取整,否则保留 1 位小数 —— 与桌面 TodaySpendChip 同口径;99.5% 不得进位成 100%(会被误读为已打满)。 */
function formatRateLimitPercent(value: number): string {
  if (Math.abs(value - Math.round(value)) < 0.05) return `${Math.round(value)}%`;
  return `${value.toFixed(1).replace(/\.0$/, '')}%`;
}

/** reset 时间点文案:当天只显时分,跨天带月日;缺失 / 非法 → null。 */
function formatRateLimitResetAt(
  epochSeconds: number | null,
  nowMs: number,
  localizer?: PresentationLocalizer,
): string | null {
  if (epochSeconds === null || epochSeconds <= 0) return null;
  const date = new Date(epochSeconds * 1000);
  const now = new Date(nowMs);
  const hhmm = localizer
    ? presentationTime(localizer, date)
    : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay
    ? hhmm
    : localizer
      ? `${presentationDate(localizer, date)} ${hhmm}`
      : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

/** planType 透传字符串('plus' / 'enterprise_cbp_usage_based' 等)→ 展示名(title-case)。 */
function formatPlanTypeLabel(planType: string): string {
  return planType.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readSessionMoney(value: unknown): SessionControlsMoneyLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<SessionControlsMoneyLike>;
  return typeof record.amount === 'number'
    && Number.isFinite(record.amount)
    && record.amount >= 0
    && (record.currency === 'CNY' || record.currency === 'USD')
    ? { amount: record.amount, currency: record.currency }
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = readRecord(item);
    return record ? [record] : [];
  });
}

function buildContextUsageRows(
  record: Record<string, unknown>,
  maxTokens: number | null,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const model = readString(record.model);
  if (model) rows.push({ label: 'model', value: model });

  for (const category of readRecordArray(record.categories)) {
    const tokens = readNumber(category.tokens) ?? 0;
    if (tokens <= 0) continue;
    const suffix = category.isDeferred === true ? ' · deferred' : '';
    rows.push({
      label: categoryLabel(readString(category.name) ?? 'category'),
      value: `${formatNumber(tokens)} tokens${formatTokenPercent(tokens, maxTokens)}${suffix}`,
    });
  }

  appendTokenListSummary(rows, 'MCP tools', readRecordArray(record.mcpTools), (item) => {
    const server = readString(item.serverName);
    const name = readString(item.name);
    const label = [server, name].filter(Boolean).join('/');
    return item.isLoaded === false ? `${label} deferred` : label;
  });
  appendTokenListSummary(rows, 'System tools', readRecordArray(record.systemTools), (item) => readString(item.name));
  appendTokenListSummary(rows, 'Deferred tools', readRecordArray(record.deferredBuiltinTools), (item) => readString(item.name));
  appendTokenListSummary(rows, 'System prompt', readRecordArray(record.systemPromptSections), (item) => readString(item.name));
  appendTokenListSummary(rows, 'Memory files', readRecordArray(record.memoryFiles), (item) => {
    const path = readString(item.path);
    const type = readString(item.type);
    return [path ? lastPathPart(path) : null, type].filter(Boolean).join(' · ');
  });
  appendTokenListSummary(rows, 'Custom agents', readRecordArray(record.agents), (item) =>
    [readString(item.agentType), readString(item.source)].filter(Boolean).join(' · '));

  const skills = readRecord(record.skills);
  if (skills) {
    const included = readNumber(skills.includedSkills) ?? 0;
    const total = readNumber(skills.totalSkills) ?? 0;
    const tokens = readNumber(skills.tokens) ?? 0;
    const topSkills = readRecordArray(skills.skillFrontmatter)
      .slice(0, 3)
      .map((item) => [readString(item.name), readString(item.source)].filter(Boolean).join(' · '))
      .filter(Boolean);
    rows.push({
      label: 'Skills',
      value: [
        `${included} / ${total}`,
        tokens > 0 ? `${formatNumber(tokens)} tokens` : '',
        topSkills.join(', '),
      ].filter(Boolean).join(' · '),
    });
  }

  const slashCommands = readRecord(record.slashCommands);
  if (slashCommands) {
    const included = readNumber(slashCommands.includedCommands) ?? 0;
    const total = readNumber(slashCommands.totalCommands) ?? 0;
    const tokens = readNumber(slashCommands.tokens) ?? 0;
    rows.push({
      label: 'Slash commands',
      value: [
        `${included} / ${total}`,
        tokens > 0 ? `${formatNumber(tokens)} tokens` : '',
      ].filter(Boolean).join(' · '),
    });
  }

  const messageBreakdown = readRecord(record.messageBreakdown);
  if (messageBreakdown) {
    appendMetricRow(rows, 'User messages', messageBreakdown.userMessageTokens);
    appendMetricRow(rows, 'Assistant messages', messageBreakdown.assistantMessageTokens);
    appendMetricRow(rows, 'Tool calls', messageBreakdown.toolCallTokens);
    appendMetricRow(rows, 'Tool results', messageBreakdown.toolResultTokens);
    appendMetricRow(rows, 'Attachments', messageBreakdown.attachmentTokens);
    appendMetricRow(rows, 'Redirected context', messageBreakdown.redirectedContextTokens);
    appendMetricRow(rows, 'Unattributed', messageBreakdown.unattributedTokens);
    appendTokenListSummary(rows, 'Tool types', readRecordArray(messageBreakdown.toolCallsByType), (item) => readString(item.name), [
      'callTokens',
      'resultTokens',
    ]);
    appendTokenListSummary(rows, 'Attachment types', readRecordArray(messageBreakdown.attachmentsByType), (item) => readString(item.name));
  }

  const apiUsage = readRecord(record.apiUsage);
  if (apiUsage) {
    appendMetricRow(rows, 'API input', apiUsage.input_tokens);
    appendMetricRow(rows, 'Cache create', apiUsage.cache_creation_input_tokens);
    appendMetricRow(rows, 'Cache read', apiUsage.cache_read_input_tokens);
    appendMetricRow(rows, 'API output', apiUsage.output_tokens);
  }

  return rows;
}

function appendMetricRow(
  rows: Array<{ label: string; value: string }>,
  label: string,
  value: unknown,
) {
  const tokens = readNumber(value) ?? 0;
  if (tokens <= 0) return;
  rows.push({ label, value: `${formatNumber(tokens)} tokens` });
}

function appendTokenListSummary(
  rows: Array<{ label: string; value: string }>,
  label: string,
  items: Record<string, unknown>[],
  itemLabel: (item: Record<string, unknown>) => string | null,
  tokenKeys: string[] = ['tokens'],
) {
  if (items.length === 0) return;
  const tokens = items.reduce((sum, item) => {
    const itemTokens = tokenKeys.reduce((innerSum, key) => innerSum + (readNumber(item[key]) ?? 0), 0);
    return sum + itemTokens;
  }, 0);
  const topLabels = items.map(itemLabel).filter((item): item is string => !!item).slice(0, 3);
  rows.push({
    label,
    value: [
      tokens > 0 ? `${formatNumber(tokens)} tokens` : '',
      `${items.length} items`,
      topLabels.join(', '),
    ].filter(Boolean).join(' · '),
  });
}

function formatTokenPercent(tokens: number, maxTokens: number | null): string {
  if (!maxTokens || maxTokens <= 0) return '';
  return ` · ${((tokens / maxTokens) * 100).toFixed(1)}%`;
}

function categoryLabel(name: string): string {
  const labels: Record<string, string> = {
    'System prompt': 'System prompt',
    'System tools': 'System tools',
    '[ANT-ONLY] System tools': 'System tools',
    'MCP tools': 'MCP tools',
    'MCP tools (deferred)': 'MCP tools deferred',
    'System tools (deferred)': 'System tools deferred',
    'Custom agents': 'Custom agents',
    'Memory files': 'Memory files',
    Skills: 'Skills',
    Messages: 'Messages',
    'Autocompact buffer': 'Autocompact buffer',
    'Compact buffer': 'Compact buffer',
    'Free space': 'Free space',
  };
  return labels[name] ?? name;
}

function lastPathPart(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatCompactNumber(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return `${formatOneDecimal(rounded, 1_000_000)}M`;
  if (rounded >= 1000) return `${formatOneDecimal(rounded, 1000)}k`;
  return String(rounded);
}

function formatOneDecimal(value: number, divisor: number): string {
  const tenths = Math.round((value * 10) / divisor);
  if (tenths % 10 === 0) return String(tenths / 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function formatPercent(value: number): string {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}%`;
}

function formatUsd(value: number): string {
  return formatMoney(value, 'USD');
}

function formatMoney(value: number, currency: SessionControlsMoneyLike['currency']): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (value >= 10) return `${symbol}${Math.round(value)}`;
  if (value >= 0.01) return `${symbol}${value.toFixed(2)}`;
  if (value >= 0.001) return `${symbol}${value.toFixed(3)}`;
  return `<${symbol}0.001`;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
