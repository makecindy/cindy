/**
 * 伙伴群聊的纯展示判定，Desktop 与手机共用（docs/product-rules/bot-group-chat.md）：
 * 排序、成员名单、轮次标记与分工（安排、下一步、交接文件）的判定，以及提示 / 报错
 * 该用哪一句文案（各端按自己的 i18n 命名空间拼 key）。只依赖群聊契约，不碰 React 与 IPC。
 */
import { RichAnswerStream, splitRichAnswer, richMarkdown, richString, richLabel, richResolvedValues, richChart, richOptions, richCalculationUnavailable } from './richAnswer.js';
import {
  isBotGroupPlanOpen,
  type BotGroupDetail,
  type BotGroupErrorCode,
  type BotGroupExecutionFailureView,
  type BotGroupMemberView,
  type BotGroupMessageView,
  type BotGroupNoticeCode,
  type BotGroupPlanStepView,
  type BotGroupPlanView,
  type BotGroupReplyMode,
  type BotGroupSummary,
} from './botGroupChat.js';

interface ChatGroupNamedMember {
  id: string; kind: string; state: string; name: string; ownerActorId?: string; ownerName?: string;
}

/** The server's member.name already includes that room's nickname override. Display only; never infer ownership from names. */
export function chatGroupOwnerName(member: ChatGroupNamedMember, members: readonly ChatGroupNamedMember[]): string {
  const owner = member.kind === 'bot' && member.ownerActorId
    ? members.find(candidate => candidate.id === member.ownerActorId && candidate.kind === 'human' && candidate.state === 'joined')
    : undefined;
  return owner?.name.trim() || member.ownerName?.trim() || '';
}

/**
 * Group-scoped labels shared by Desktop and the direct phone client; raw member records stay unchanged.
 * The 「 (主人昵称)」 suffix only disambiguates companions brought by different people, so it is dropped
 * when the bot's owner is the only joined human in the room (a self-built group). Direct rooms pass no
 * members and keep the account owner label.
 */
export function chatGroupMemberName(member: ChatGroupNamedMember, members: readonly ChatGroupNamedMember[]): string {
  const owner = chatGroupOwnerName(member, members);
  if (member.kind !== 'bot' || !owner) return member.name;
  const humans = members.filter(candidate => candidate.kind === 'human' && candidate.state === 'joined');
  if (member.ownerActorId && humans.length === 1 && humans[0]!.id === member.ownerActorId) return member.name;
  return `${member.name} (${owner})`;
}

/** The member's own name without the 「 (主人昵称)」 suffix `chatGroupMemberName` may have added. */
export function botGroupMemberBaseName(member: Pick<BotGroupMemberView, 'name' | 'ownerName'>): string {
  const name = member.name.trim();
  const owner = member.ownerName?.trim();
  const suffix = owner ? ` (${owner})` : '';
  return suffix && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length) : name;
}

/** Only active members can be mentioned, speak, or keep a group sendable. */
export function isActiveBotGroupMember(member: Pick<BotGroupMemberView, 'status'>): boolean {
  return member.status === 'active';
}

/** UI affordances only; the server must authorize every mutation against current membership. */
export function chatGroupMembership(group: Pick<BotGroupSummary, 'serverBacked' | 'members'>) {
  const self = group.members.find(member => member.isSelf === true);
  const owned = (member: BotGroupMemberView) => member.isOwned === true || member.isSelf === true;
  const owner = group.serverBacked === true && group.members.some(member => owned(member) && member.role === 'owner');
  const manager = owner || (group.serverBacked === true && group.members.some(member => owned(member) && member.role === 'admin'));
  // Leaving also removes this account's companions. Another owner from this same account
  // therefore cannot satisfy LAST_OWNER, even when the human is only an ordinary member.
  const otherOwner = group.members.some(member => member.isOwned === false && !member.isSelf && member.role === 'owner');
  const canLeave = group.serverBacked === true && !!self?.actorId && (!owner || otherOwner);
  return { self, owner, manager, canLeave };
}

/** Group activity includes topic replies and system notices, but never deleted messages. */
export function latestBotGroupMessage<T extends { seq: string; deleted?: boolean }>(messages: readonly T[]): T | undefined {
  let latest: T | undefined;
  for (const message of messages) {
    if (!message.deleted && (!latest || BigInt(message.seq) > BigInt(latest.seq))) latest = message;
  }
  return latest;
}

/** Creation gives empty groups a position; profile/settings edits are not chat activity. */
export function botGroupActivityAt(group: { createdAt: number; lastMessage?: { createdAt: number } | null }): number {
  const lastAt = group.lastMessage?.createdAt ?? 0;
  return Math.max(Number.isFinite(lastAt) ? lastAt : 0, Number.isFinite(group.createdAt) ? group.createdAt : 0);
}

export function botGroupMemberNames(
  members: readonly Pick<BotGroupMemberView, 'name'>[],
  separator: string,
): string {
  return members
    .map((member) => member.name.trim())
    .filter(Boolean)
    .join(separator);
}

/** Collapse whitespace so a multi-line message fits a one-line preview. */
export function botGroupPreviewLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** New arrivals below a reader's viewport, excluding history pages and repeat snapshots. */
export function botGroupNewMessageCount(messages: readonly BotGroupMessageView[], seenThrough: number | string | null, threadRootId?: string): number {
  if (seenThrough === null) return 0;
  const incoming = new Set<string>();
  for (const message of messages) {
    if (BigInt(message.serverSequence ?? message.sequence) <= BigInt(seenThrough) || message.deleted || (message.threadRootId ?? undefined) !== threadRootId || message.isSelf === true
      || (message.kind !== 'message' && message.kind !== 'plan')
      || (message.authorKind !== 'bot' && message.isSelf !== false) || message.authorKind === 'system') continue;
    incoming.add(message.id);
  }
  return incoming.size;
}

/**
 * The only round-end that may offer 「继续讨论」: the newest one, and only while
 * the host says the round can be continued.
 */
export function continuableRoundEndId(
  messages: readonly Pick<BotGroupMessageView, 'id' | 'kind'>[],
  round: { status: 'idle' | 'running'; canContinue: boolean },
): string | null {
  if (round.status !== 'idle' || !round.canContinue) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'round-end') return message.id;
  }
  return null;
}

/** Merge real message pages; current execution state never enters the page cache. */
export function mergeBotGroupMessages(
  older: readonly BotGroupMessageView[],
  latest: readonly BotGroupMessageView[],
): BotGroupMessageView[] {
  const bySequence = new Map<number, BotGroupMessageView>();
  for (const message of [...older, ...latest]) bySequence.set(message.sequence, message);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Bound each HTTP reconciliation request to 100 displayed sources, without truncating loaded history. */
export function botGroupExecutionFailureBatches(sourceIds: readonly string[]): string[][] {
  const unique = [...new Set(sourceIds)];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 100) batches.push(unique.slice(offset, offset + 100));
  return batches;
}

/** Derive notices once, after pagination, from the latest authorized execution snapshot. */
export function projectBotGroupExecutionFailures(
  messages: readonly BotGroupMessageView[],
  failures: readonly BotGroupExecutionFailureView[] = [],
): BotGroupMessageView[] {
  const bySource = new Map<string, BotGroupExecutionFailureView[]>();
  for (const failure of failures) {
    const entries = bySource.get(failure.sourceMessageId) ?? [];
    entries.push(failure);
    bySource.set(failure.sourceMessageId, entries);
  }
  return messages.flatMap(source => [source, ...(source.deleted ? [] : bySource.get(source.id) ?? []).map((failure): BotGroupMessageView => ({
    id: `execution-failure:${failure.executionId}:${failure.epoch}`, sequence: source.sequence,
    kind: 'notice', authorKind: 'system', authorBotId: failure.botId, authorName: failure.botName,
    content: '', noticeCode: failure.code === 'RUNTIME_TIMEOUT' ? 'member-timeout' : 'member-failed',
    runtimeFailureCode: failure.code, mentions: { all: false, botIds: [] }, planId: failure.planId,
    threadRootId: source.threadRootId ?? null, files: [], attachments: [], createdAt: failure.updatedAt ?? source.createdAt,
  }))]);
}

/** Copy variant for a refused group action; null keeps the caller's own fallback. */
export type BotGroupErrorVariant =
  | 'invalidAttachment'
  | 'attachmentUnavailable'
  | 'attachmentTooLarge'
  | 'mediaUploadFailed'
  | 'authRequired'
  | 'chatUnavailable'
  | 'importPending'
  | 'requestTimeout'
  | 'permissionDenied'
  | 'serviceError'
  | 'groupArchived'
  | 'groupDissolved'
  | 'lifecycleUnavailable'
  | 'lastOwner'
  | 'memberLimit'
  | 'memberUnavailable'
  | 'mentionUnavailable'
  | 'allBotsMentionDisabled'
  | 'notFound'
  | 'hostNotReady'
  | 'planOpen'
  | 'planClosed'
  | 'quoteUnavailable';

const ERROR_VARIANTS: ReadonlyMap<string, BotGroupErrorVariant> = new Map<BotGroupErrorCode, BotGroupErrorVariant>([
  ['INVALID_ATTACHMENT', 'invalidAttachment'],
  ['ATTACHMENT_UNAVAILABLE', 'attachmentUnavailable'],
  ['ATTACHMENT_TOO_LARGE', 'attachmentTooLarge'],
  ['MEDIA_UPLOAD_FAILED', 'mediaUploadFailed'],
  ['AUTH_REQUIRED', 'authRequired'],
  ['CHAT_UNAVAILABLE', 'chatUnavailable'],
  ['IMPORT_PENDING', 'importPending'],
  ['REQUEST_TIMEOUT', 'requestTimeout'],
  ['PERMISSION_DENIED', 'permissionDenied'],
  ['SERVICE_ERROR', 'serviceError'],
  ['GROUP_ARCHIVED', 'groupArchived'],
  ['GROUP_DISSOLVED', 'groupDissolved'],
  ['LIFECYCLE_UNAVAILABLE', 'lifecycleUnavailable'],
  ['LAST_OWNER', 'lastOwner'],
  ['MEMBER_LIMIT', 'memberLimit'],
  ['MEMBER_UNAVAILABLE', 'memberUnavailable'],
  ['MENTION_UNAVAILABLE', 'mentionUnavailable'],
  ['ALL_BOTS_MENTION_DISABLED', 'allBotsMentionDisabled'],
  ['NOT_FOUND', 'notFound'],
  ['HOST_NOT_READY', 'hostNotReady'],
  ['PLAN_OPEN', 'planOpen'],
  ['PLAN_CLOSED', 'planClosed'],
  ['QUOTE_UNAVAILABLE', 'quoteUnavailable'],
]);

/** Specific error copy when the host names a cause the user can act on. */
export function botGroupErrorVariant(errorCode: BotGroupErrorCode | null | undefined): BotGroupErrorVariant | null {
  return (errorCode && ERROR_VARIANTS.get(errorCode)) || null;
}

// ---- 分工 (docs/product-rules/bot-group-chat.md §7) --------------------------

/** Merge plan snapshots from an older page under the latest read; the latest wins. */
export function mergeBotGroupPlans(
  older: readonly BotGroupPlanView[],
  latest: readonly BotGroupPlanView[],
): BotGroupPlanView[] {
  const byId = new Map<string, BotGroupPlanView>();
  for (const plan of older) byId.set(plan.id, plan);
  for (const plan of latest) byId.set(plan.id, plan);
  return [...byId.values()];
}

/** The group's open plan with its steps, when the host sent it along with the detail. */
export function openBotGroupPlan(
  group: Pick<BotGroupDetail, 'openPlan' | 'plans'>,
): BotGroupPlanView | null {
  const openId = group.openPlan?.id;
  if (!openId) return null;
  const plan = group.plans.find((candidate) => candidate.id === openId);
  return plan && isBotGroupPlanOpen(plan.status) ? plan : null;
}

/** The step the host reports as current (running, being redone, or last finished / failed). */
export function currentBotGroupPlanStep(plan: BotGroupPlanView): BotGroupPlanStepView | null {
  if (plan.currentStep === null) return null;
  return plan.steps.find((step) => step.position === plan.currentStep) ?? null;
}

export type BotGroupPlanFollowUp =
  | { kind: 'continue'; next: BotGroupPlanStepView }
  | { kind: 'retry'; failed: BotGroupPlanStepView };

/**
 * What the timeline offers under a plan that stopped after a step: 「下一步 · 继续」
 * when the step finished and another one waits, 「没做完 · 重试」 when it failed.
 */
export function botGroupPlanFollowUp(plan: BotGroupPlanView | null): BotGroupPlanFollowUp | null {
  if (!plan || plan.status !== 'waiting') return null;
  const current = currentBotGroupPlanStep(plan);
  if (!current) return null;
  if (current.status === 'failed') return { kind: 'retry', failed: current };
  if (current.status !== 'done') return null;
  const index = plan.steps.indexOf(current);
  const next = plan.steps.slice(index + 1).find((step) => step.status === 'pending');
  return next ? { kind: 'continue', next } : null;
}

/** Composer copy that follows the open plan (placeholder and the 「安排分工」 gate). */
export type BotGroupComposerPlanState =
  | { kind: 'proposed' }
  | { kind: 'running'; botName: string; talk?: boolean }
  | { kind: 'waiting'; botName: string; stepDone: boolean };

export function botGroupComposerPlanState(plan: BotGroupPlanView | null, replyMode: BotGroupReplyMode = 'all'): BotGroupComposerPlanState | null {
  if (!plan) return null;
  if (plan.status === 'proposed') return { kind: 'proposed' };
  const current = currentBotGroupPlanStep(plan);
  // Keep the work-plan state for the division gate, but name a recipient only when
  // ordinary text is actually forwarded to that worker (including legacy plans).
  const botName = replyMode === 'mentioned' ? '' : current?.botName.trim() ?? '';
  // Only promise additions when unmentioned words actually reach the speaking teammate.
  if (plan.status === 'running' && plan.kind === 'talk') return plan.canAdd === false || replyMode === 'mentioned' ? null : { kind: 'running', botName, talk: true };
  if (plan.status === 'running') return { kind: 'running', botName };
  // A queue waiting for 继续 takes a new request, not changes to the last answer (bot-group-chat.md §4.0).
  if (plan.status === 'waiting' && plan.kind === 'talk') return null;
  if (plan.status === 'waiting') return { kind: 'waiting', botName, stepDone: current?.status === 'done' };
  return null;
}

/** A plan that is running or waiting blocks a new 「安排分工」 (the host answers PLAN_OPEN). */
export function isBotGroupDivisionBlocked(state: BotGroupComposerPlanState | null): boolean {
  return state?.kind === 'running' || state?.kind === 'waiting';
}

/** Copy variant for a timeline notice; plan-scoped member notices speak about a step. */
export type BotGroupNoticeVariant =
  | 'memberJoined'
  | 'memberFailed'
  | 'memberTimeout'
  | 'memberUnavailable'
  | 'planFailed'
  | 'planStopped'
  | 'workdirUnavailable'
  | 'stepFailed'
  | 'stepTimeout'
  | 'stepUnavailable';

const NOTICE_VARIANTS: ReadonlyMap<string, BotGroupNoticeVariant> = new Map<BotGroupNoticeCode, BotGroupNoticeVariant>([
  ['member-joined', 'memberJoined'],
  ['member-failed', 'memberFailed'],
  ['member-timeout', 'memberTimeout'],
  ['member-unavailable', 'memberUnavailable'],
  ['plan-failed', 'planFailed'],
  ['plan-stopped', 'planStopped'],
  ['workdir-unavailable', 'workdirUnavailable'],
]);

/** Member notices inside a plan are about a step, not a chat reply. */
const STEP_NOTICE_VARIANTS: ReadonlyMap<string, BotGroupNoticeVariant> = new Map<BotGroupNoticeCode, BotGroupNoticeVariant>([
  ['member-failed', 'stepFailed'],
  ['member-timeout', 'stepTimeout'],
  ['member-unavailable', 'stepUnavailable'],
]);

export function botGroupNoticeVariant(
  code: BotGroupNoticeCode | null,
  planScoped: boolean,
): BotGroupNoticeVariant | null {
  if (!code) return null;
  return (planScoped ? STEP_NOTICE_VARIANTS.get(code) : undefined) ?? NOTICE_VARIANTS.get(code) ?? null;
}

/**
 * Absolute path of a hand-off file, or null when the entry could leave the plan's
 * work directory. The host lists files relative to `workDir` with POSIX separators;
 * the join follows the work directory's own separator so Windows paths stay native.
 */
export function botGroupPlanFilePath(workDir: string | null, file: string): string | null {
  if (!workDir || !file) return null;
  if (file.startsWith('/') || file.includes('\\') || /^[A-Za-z]:/.test(file)) return null;
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(workDir) || workDir.startsWith('\\\\');
  const separator = windows ? '\\' : '/';
  const base = workDir.replace(/[\\/]+$/, '');
  return `${base}${separator}${segments.join(separator)}`;
}

export type BotGroupSidebarPlanPreview =
  /** Running treatment: the organizer is working out a plan. */
  | { kind: 'planning'; botName: string }
  /** Running treatment: a step is in progress. `step` is 1-based. */
  | { kind: 'running'; botName: string; step: number | null; total: number }
  | { kind: 'proposed'; organizerName: string }
  | { kind: 'step-done'; botName: string }
  | { kind: 'step-failed'; botName: string }
  /** Waiting, but the host did not name the step (older host or a removed step). */
  | { kind: 'waiting' };

/** Running previews take the speaking row's place (orange sparkles). */
export function isRunningBotGroupSidebarPreview(
  preview: BotGroupSidebarPlanPreview | null,
): preview is Extract<BotGroupSidebarPlanPreview, { kind: 'planning' | 'running' }> {
  return preview?.kind === 'planning' || preview?.kind === 'running';
}

/**
 * Sidebar line for the group's plan: the organizer working out a plan, a step in
 * progress, a plan waiting for 开始, or a step waiting for 继续 / 重试. Null falls back
 * to the speaking row or the latest message.
 */
export function botGroupSidebarPlanPreview(group: BotGroupSummary): BotGroupSidebarPlanPreview | null {
  const memberName = (botId: string | null) =>
    group.members.find((member) => member.botId === botId)?.name.trim() ?? '';
  if (group.planningBotId) return { kind: 'planning', botName: memberName(group.planningBotId) };
  const plan = group.openPlan;
  if (!plan) return null;
  const botName = plan.currentBotName?.trim() ?? '';
  if (plan.status === 'running' && plan.currentStepStatus === 'running') {
    return {
      kind: 'running',
      botName,
      step: plan.currentStep === null ? null : plan.currentStep + 1,
      total: plan.stepCount,
    };
  }
  if (plan.status === 'proposed') return { kind: 'proposed', organizerName: memberName(group.organizerBotId) };
  if (plan.status === 'waiting' || plan.status === 'running') {
    if (botName && plan.currentStepStatus === 'done') return { kind: 'step-done', botName };
    if (botName && plan.currentStepStatus === 'failed') return { kind: 'step-failed', botName };
    if (plan.status === 'waiting') return { kind: 'waiting' };
  }
  return null;
}

/** Last path segment for compact labels (project folder, file chips). */
export function botGroupPathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Public media stay accessible without granting group bodies local media authority. */
function publicMediaLink(src: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Keep the URL inside one autolink; descriptions continue through literal text.
    return `<${url.href.replace(/[<>\\]/g, char => encodeURIComponent(char))}>`;
  } catch {
    return null;
  }
}

/** Display-only body fragments. Literal component text never becomes Markdown syntax. */
export function botGroupBodyParts(content: string, authorKind?: BotGroupMessageView['authorKind']): Array<{ kind: 'text' | 'markdown'; content: string }> {
  if (authorKind !== 'bot') return [{ kind: 'markdown', content }];
  const parts = splitRichAnswer(content);
  return parts.flatMap((part, index) => {
    const source = content.slice(part.key, parts[index + 1]?.key ?? content.length);
    if (part.kind === 'markdown') return [{ kind: 'markdown' as const, content: source }];
    const doc = new RichAnswerStream().update(part.source, true);
    // Preserve malformed or empty answers rather than silently dropping source content.
    if (doc.issues) return [{ kind: 'markdown' as const, content: source }];
    const values = richResolvedValues(doc);
    let unavailableChart = false;
    const result: Array<{ kind: 'text' | 'markdown'; content: string }> = [];
    const add = (text: string, kind: 'text' | 'markdown' = 'text') => {
      if (text.trim()) result.push({ kind, content: text });
    };
    const visit = (id: string) => {
      const node = doc.nodes.get(id);
      if (!node) return;
      const label = richString(node, 'label');
      if (['image', 'video', 'audio', 'svg'].includes(node.kind)) {
        // Group body has no task-local media authority. Keep its description readable.
        const description = [label, richString(node, 'alt'), richString(node, 'caption')].filter(text => text.trim()).join('\n');
        // A neutral type marker is not a promise that an attachment was delivered.
        const placeholder = node.kind === 'image' ? '🖼' : node.kind === 'video' ? '🎞' : node.kind === 'audio' ? '♪' : '◇';
        add(description || placeholder);
        const link = publicMediaLink(richString(node, 'src'));
        if (link) add(link, 'markdown');
      } else {
        const markdown = richMarkdown(node);
        if (markdown !== null) {
          add(markdown, 'markdown');
          add(richString(node, 'caption'));
        }
        else if (['text', 'heading'].includes(node.kind)) add(richLabel(node, values));
        else if (node.kind === 'stat') add([label, richLabel(node, values)].filter(Boolean).join(': '));
        else if (node.kind === 'chart') {
          unavailableChart ||= richCalculationUnavailable(node, values);
          add([label, ...richChart(node, values).map(item => `${item.label}: ${item.value}`)].filter(Boolean).join('\n'));
        }
        else if (node.kind === 'icon') add([label, richString(node, 'text')].filter(Boolean).join('\n'));
        else if (node.kind === 'divider') add('---', 'markdown');
        else {
          // Show authored defaults only; an untouched control is not a user answer.
          const current = node.props.default;
          const selected = node.kind === 'select' ? richOptions(node).find(option => option.value === current)?.label : undefined;
          const display = selected ?? (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' ? String(current) : '');
          add([label, display && display + richString(node, 'suffix')].filter(Boolean).join(': '));
        }
      }
      node.children.forEach(visit);
    };
    doc.roots.forEach(visit);
    // Do not present a partial chart as complete data; preserve its source block.
    return result.length && !unavailableChart ? result : [{ kind: 'markdown' as const, content: source }];
  });
}
