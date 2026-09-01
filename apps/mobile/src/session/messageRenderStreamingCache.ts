import {
  findAgentTaskUpdate,
  type AgentTaskUpdate,
} from '@cindy/maker-shared/agent-task';
import type { MessageRenderOptions } from '@cindy/maker-shared/message-render';
import { isPlanUserBoundary } from '@cindy/maker-shared/message-render';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { extractPayloadToolResultMedia } from '@cindy/maker-shared/payload-summary';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import {
  buildMobileMessageRenderItems,
  type MobileMessageRenderItem,
} from '@/session/messageRenderModel';
import { collectMobileMarkdownImages } from '@/session/messageMarkdown';
import type { RemoteMessage } from '@/session/types';
import { contentToPreview } from '@/utils/contentPreview';

export interface MobileStreamingRenderPrefixCache {
  boundaryMessage?: RemoteMessage;
  cacheKey: string;
  items: readonly MobileMessageRenderItem[];
  markdownImageUrls?: ReadonlySet<string>;
  messages: readonly RemoteMessage[];
  mode: 'history' | 'truncated-turn';
  sessionId: string;
  tailToolResults?: readonly RemoteMessage[];
  taskUpdateDependencies?: readonly MobileStreamingTaskUpdateDependency[];
  toolUseIds?: ReadonlySet<string>;
}

interface MobileStreamingTaskUpdateDependency {
  clientId: string;
  toolUseId: string | null;
  update: AgentTaskUpdate | undefined;
}

export interface MobileStreamingRenderPrefixCacheRef {
  current: MobileStreamingRenderPrefixCache | null;
}

interface BuildMobileStreamingRenderWindowInput {
  cacheKey: string;
  messages: readonly RemoteMessage[];
  options: MessageRenderOptions & {
    autoResumePending?: Record<string, unknown> | null;
    sessionId?: string;
  };
  prefixCache?: MobileStreamingRenderPrefixCacheRef;
  previousPrefix?: MobileStreamingRenderPrefixCache | null;
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
}

export interface MobileStreamingRenderWindowResult {
  items: MobileMessageRenderItem[];
  prefix: MobileStreamingRenderPrefixCache | null;
}

/**
 * Rebuild only the active turn while a session streams.
 *
 * The loaded history is immutable during ordinary text deltas. Normalizing and grouping that
 * entire window for every token creates a large allocation stream even though row reconciliation
 * later reuses the resulting React props. Prefer a real root-user boundary. Very large active
 * turns can push that row outside the retained window, so the fallback advances across an already
 * rendered assistant boundary and keeps explicit dependencies for late tool results/task updates.
 */
export function buildMobileStreamingRenderWindow(
  input: BuildMobileStreamingRenderWindowInput,
): MobileStreamingRenderWindowResult {
  const {
    cacheKey,
    messages,
    options,
    prefixCache,
    previousPrefix = prefixCache?.current,
    taskUpdates,
  } = input;
  const sessionId = options.sessionId ?? messages[0]?.sessionId ?? '';
  const activeTurnStart = options.isSessionStreaming === true
    ? findLastRootUserMessageIndex(messages)
    : -1;
  const stableAssistantBoundary = options.isSessionStreaming === true
    ? findLastStableAssistantBoundaryIndex(messages)
    : -1;
  if (
    options.isSessionStreaming === true
    && (activeTurnStart < 0 || stableAssistantBoundary > activeTurnStart)
    && stableAssistantBoundary > 0
    && stableAssistantBoundaryCanSplit(
      messages,
      stableAssistantBoundary,
      previousPrefix?.mode === 'truncated-turn'
        && previousPrefix.messages.length === stableAssistantBoundary + 1
        && previousPrefix.boundaryMessage === messages[stableAssistantBoundary]
        ? previousPrefix.toolUseIds
        : undefined,
      previousPrefix?.mode === 'truncated-turn'
        && previousPrefix.messages.length === stableAssistantBoundary + 1
        && previousPrefix.boundaryMessage === messages[stableAssistantBoundary]
        ? previousPrefix.markdownImageUrls
        : undefined,
    )
  ) {
    return buildTruncatedActiveTurnWindow({
      boundaryIndex: stableAssistantBoundary,
      cacheKey,
      messages,
      options,
      prefixCache,
      previousPrefix,
      sessionId,
      taskUpdates,
    });
  }
  if (activeTurnStart <= 0) {
    const result = {
      items: buildMobileMessageRenderItems(messages, options, taskUpdates),
      prefix: null,
    };
    if (prefixCache) prefixCache.current = null;
    return result;
  }

  const canReusePrefix = previousPrefix?.mode === 'history'
    && previousPrefix.sessionId === sessionId
    && previousPrefix.cacheKey === cacheKey
    && sameTaskUpdateDependencies(previousPrefix.taskUpdateDependencies, taskUpdates)
    && sameMessagePrefixReferences(previousPrefix.messages, messages, activeTurnStart);
  const prefixMessages = canReusePrefix
    ? previousPrefix.messages
    : messages.slice(0, activeTurnStart);
  const prefixTaskUpdateDependencies = canReusePrefix
    ? previousPrefix.taskUpdateDependencies ?? []
    : collectTaskUpdateDependencies(prefixMessages, taskUpdates);
  const prefixItems = canReusePrefix
    ? previousPrefix.items
    : buildMobileMessageRenderItems(prefixMessages, {
      ...options,
      autoResumePending: null,
      isSessionStreaming: false,
      renderOrphanTaskUpdates: false,
    }, taskUpdates);
  const prefix = canReusePrefix
    ? previousPrefix
    : {
        cacheKey,
        items: prefixItems,
        messages: prefixMessages,
        mode: 'history' as const,
        sessionId,
        taskUpdateDependencies: prefixTaskUpdateDependencies,
      };
  const activeItems = buildMobileMessageRenderItems(
    messages.slice(activeTurnStart),
    options,
    omitTaskUpdatesConsumedByPrefix(taskUpdates, prefixTaskUpdateDependencies),
  );
  const result = {
    items: [...prefixItems, ...activeItems],
    prefix,
  };
  // Token updates may interrupt a concurrent render before it commits. Publishing this purely
  // derived prefix only from a layout effect would then make every retry rebuild the full history.
  // A speculative entry is safe: reuse still requires the same session, render options key, and
  // exact message references, so a superseded render can affect performance but never output.
  if (prefixCache) prefixCache.current = prefix;
  return result;
}

function buildTruncatedActiveTurnWindow(
  input: BuildMobileStreamingRenderWindowInput & {
    boundaryIndex: number;
    sessionId: string;
  },
): MobileStreamingRenderWindowResult {
  const {
    boundaryIndex,
    cacheKey,
    messages,
    options,
    prefixCache,
    previousPrefix,
    sessionId,
    taskUpdates,
  } = input;
  let items: MobileMessageRenderItem[] | null = null;
  let reusedPrefix = false;

  if (
    previousPrefix?.mode === 'truncated-turn'
    && previousPrefix.sessionId === sessionId
    && previousPrefix.cacheKey === cacheKey
    && sameTaskUpdateDependencies(previousPrefix.taskUpdateDependencies, taskUpdates)
    && previousPrefix.boundaryMessage
    && previousPrefix.messages.length === boundaryIndex + 1
    && previousPrefix.boundaryMessage === messages[boundaryIndex]
    && sameMessagePrefixReferences(
      previousPrefix.messages,
      messages,
      previousPrefix.messages.length,
    )
    && sameDependentTailToolResults(
      previousPrefix.tailToolResults ?? [],
      messages,
      previousPrefix.messages.length,
      previousPrefix.toolUseIds,
    )
  ) {
    const activeItems = buildMobileMessageRenderItems(
      messages.slice(boundaryIndex),
      options,
      taskUpdates,
    );
    const duplicateBoundaryIndex = findTopLevelMessageItemIndex(
      activeItems,
      previousPrefix.boundaryMessage,
    );
    if (duplicateBoundaryIndex >= 0) {
      items = [
        ...previousPrefix.items,
        ...activeItems.slice(duplicateBoundaryIndex + 1),
      ];
      reusedPrefix = true;
    }
  }

  if (!items) items = buildMobileMessageRenderItems(messages, options, taskUpdates);
  if (reusedPrefix && previousPrefix) {
    if (prefixCache) prefixCache.current = previousPrefix;
    return { items, prefix: previousPrefix };
  }
  const builtPrefix = buildTruncatedTurnPrefix({
    boundaryIndex,
    cacheKey,
    items,
    messages,
    sessionId,
    taskUpdates,
  });
  const prefix = previousPrefix?.mode === 'truncated-turn'
    && builtPrefix !== null
    && builtPrefix.boundaryMessage === previousPrefix.boundaryMessage
    && sameTaskUpdateDependencySnapshots(
      builtPrefix.taskUpdateDependencies,
      previousPrefix.taskUpdateDependencies,
    )
    && sameMessageReferences(builtPrefix.messages, previousPrefix.messages)
    && sameMessageReferences(
      builtPrefix.tailToolResults ?? [],
      previousPrefix.tailToolResults ?? [],
    )
    ? previousPrefix
    : builtPrefix;
  if (prefixCache) prefixCache.current = prefix;
  return { items, prefix };
}

function buildTruncatedTurnPrefix(input: {
  boundaryIndex: number;
  cacheKey: string;
  items: readonly MobileMessageRenderItem[];
  messages: readonly RemoteMessage[];
  sessionId: string;
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
}): MobileStreamingRenderPrefixCache | null {
  const { boundaryIndex } = input;
  if (boundaryIndex <= 0) return null;
  const boundaryMessage = input.messages[boundaryIndex];
  const boundaryItemIndex = findTopLevelMessageItemIndex(input.items, boundaryMessage);
  if (boundaryItemIndex < 0) return null;
  const prefixMessages = input.messages.slice(0, boundaryIndex + 1);
  return {
    boundaryMessage,
    cacheKey: input.cacheKey,
    items: input.items.slice(0, boundaryItemIndex + 1),
    markdownImageUrls: collectAssistantMarkdownImageUrls(prefixMessages, prefixMessages.length),
    messages: prefixMessages,
    mode: 'truncated-turn',
    sessionId: input.sessionId,
    tailToolResults: collectDependentTailToolResults(input.messages, prefixMessages.length),
    taskUpdateDependencies: collectTaskUpdateDependencies(prefixMessages, input.taskUpdates),
    toolUseIds: collectToolUseIds(prefixMessages, prefixMessages.length),
  };
}

function collectTaskUpdateDependencies(
  messages: readonly RemoteMessage[],
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): MobileStreamingTaskUpdateDependency[] {
  const dependencies: MobileStreamingTaskUpdateDependency[] = [];
  for (const message of messages) {
    if (message.role !== 'tool_use') continue;
    const toolUseId = remoteToolUseId(message);
    dependencies.push({
      clientId: message.clientId,
      toolUseId,
      update: findAgentTaskUpdate(taskUpdates, toolUseId, message.clientId),
    });
  }
  return dependencies;
}

function sameTaskUpdateDependencies(
  dependencies: readonly MobileStreamingTaskUpdateDependency[] | undefined,
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): boolean {
  if (!dependencies) return false;
  return dependencies.every((dependency) =>
    findAgentTaskUpdate(taskUpdates, dependency.toolUseId, dependency.clientId)
      === dependency.update);
}

function sameTaskUpdateDependencySnapshots(
  previous: readonly MobileStreamingTaskUpdateDependency[] | undefined,
  next: readonly MobileStreamingTaskUpdateDependency[] | undefined,
): boolean {
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((dependency, index) => {
    const candidate = next[index];
    return dependency.clientId === candidate.clientId
      && dependency.toolUseId === candidate.toolUseId
      && dependency.update === candidate.update;
  });
}

function omitTaskUpdatesConsumedByPrefix(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  dependencies: readonly MobileStreamingTaskUpdateDependency[],
): ReadonlyMap<string, AgentTaskUpdate> | undefined {
  if (!taskUpdates || taskUpdates.size === 0) return taskUpdates;
  const consumedUpdates = new Set(
    dependencies
      .map((dependency) => dependency.update)
      .filter((update): update is AgentTaskUpdate => update !== undefined),
  );
  if (consumedUpdates.size === 0) return taskUpdates;
  return new Map(
    [...taskUpdates].filter(([, update]) => !consumedUpdates.has(update)),
  );
}

function findLastStableAssistantBoundaryIndex(messages: readonly RemoteMessage[]): number {
  for (let index = messages.length - 2; index > 0; index -= 1) {
    const message = messages[index];
    const parentUuid = message.agentMeta?.parentUuid;
    if (
      message.role === 'assistant'
      && !(typeof parentUuid === 'string' && parentUuid.length > 0)
      && message.agentMeta?.isStreaming !== true
      && message.agentMeta?.streaming !== true
      && !contentIsStreaming(message.content)
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Some render transforms intentionally inspect a whole turn. Keep those messages together until
 * a later stable assistant moves the split past them; otherwise an independently rebuilt tail can
 * duplicate a plan/subagent row or miss cross-boundary media/tool-result reconciliation.
 */
function stableAssistantBoundaryCanSplit(
  messages: readonly RemoteMessage[],
  boundaryIndex: number,
  cachedPrefixToolUseIds?: ReadonlySet<string>,
  cachedPrefixMarkdownImageUrls?: ReadonlySet<string>,
): boolean {
  // The boundary assistant is rebuilt with the active tail and then discarded as a duplicate.
  // If it contains an inline image, however, full-turn normalization may use it to remove an
  // earlier tool-media row. Keep that boundary in the full build so cross-boundary image dedupe
  // cannot diverge when the completed assistant and its following delta arrive in one batch.
  if (
    collectMobileMarkdownImages(contentToPreview(messages[boundaryIndex]?.content)).length > 0
  ) {
    return false;
  }

  const prefixToolUseIds = cachedPrefixToolUseIds
    ?? collectToolUseIds(messages, boundaryIndex + 1);
  const prefixMarkdownImageUrls = cachedPrefixMarkdownImageUrls
    ?? collectAssistantMarkdownImageUrls(messages, boundaryIndex + 1);

  for (let index = boundaryIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'user') return false;
    if (typeof message.agentMeta?.parentUuid === 'string' && message.agentMeta.parentUuid) {
      return false;
    }
    if (message.role === 'tool_result') {
      const toolUseId = remoteToolUseId(message);
      if (toolUseId && prefixToolUseIds.has(toolUseId)) return false;
      if (
        prefixMarkdownImageUrls.size > 0
        && extractPayloadToolResultMedia(contentToPreview(message.content)).some(
          (media) => media.kind === 'image' && prefixMarkdownImageUrls.has(media.url),
        )
      ) {
        return false;
      }
    }
    if (message.role === 'tool_use' && isPlanToolName(parseMessageToolUse(message).toolName)) {
      return false;
    }
    if (
      message.role === 'assistant'
      && collectMobileMarkdownImages(contentToPreview(message.content)).length > 0
    ) {
      return false;
    }
  }
  return true;
}

function isPlanToolName(toolName: string): boolean {
  return toolName === 'TodoWrite'
    || toolName === 'update_plan'
    || toolName === 'TaskCreate'
    || toolName === 'TaskUpdate'
    || toolName === 'TaskList'
    || toolName === 'TaskGet';
}

function contentIsStreaming(content: unknown): boolean {
  if (!content || typeof content !== 'object') return false;
  if (Array.isArray(content)) return content.some(contentIsStreaming);
  const record = content as Record<string, unknown>;
  return record.isStreaming === true || record.streaming === true;
}

function findTopLevelMessageItemIndex(
  items: readonly MobileMessageRenderItem[],
  source: RemoteMessage,
): number {
  return items.findIndex(
    (item) => item.type === 'message' && item.message.source === source,
  );
}

function collectDependentTailToolResults(
  messages: readonly RemoteMessage[],
  prefixLength: number,
  prefixToolUseIds = collectToolUseIds(messages, prefixLength),
): RemoteMessage[] {
  if (prefixToolUseIds.size === 0) return [];
  const results: RemoteMessage[] = [];
  for (let index = prefixLength; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'tool_result') continue;
    const toolUseId = remoteToolUseId(message);
    if (toolUseId && prefixToolUseIds.has(toolUseId)) results.push(message);
  }
  return results;
}

function sameDependentTailToolResults(
  expected: readonly RemoteMessage[],
  messages: readonly RemoteMessage[],
  prefixLength: number,
  prefixToolUseIds: ReadonlySet<string> | undefined,
): boolean {
  if (!prefixToolUseIds || prefixToolUseIds.size === 0) return expected.length === 0;
  let expectedIndex = 0;
  for (let index = prefixLength; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'tool_result') continue;
    const toolUseId = remoteToolUseId(message);
    if (!toolUseId || !prefixToolUseIds.has(toolUseId)) continue;
    if (expected[expectedIndex] !== message) return false;
    expectedIndex += 1;
  }
  return expectedIndex === expected.length;
}

function collectToolUseIds(
  messages: readonly RemoteMessage[],
  endExclusive: number,
): Set<string> {
  const toolUseIds = new Set<string>();
  const end = Math.min(messages.length, Math.max(0, endExclusive));
  for (let index = 0; index < end; index += 1) {
    const message = messages[index];
    if (message.role !== 'tool_use') continue;
    const toolUseId = remoteToolUseId(message);
    if (toolUseId) toolUseIds.add(toolUseId);
  }
  return toolUseIds;
}

function collectAssistantMarkdownImageUrls(
  messages: readonly RemoteMessage[],
  endExclusive: number,
): Set<string> {
  const urls = new Set<string>();
  const end = Math.min(messages.length, Math.max(0, endExclusive));
  for (let index = 0; index < end; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    for (const image of collectMobileMarkdownImages(contentToPreview(message.content))) {
      urls.add(image.url);
    }
  }
  return urls;
}

function remoteToolUseId(message: RemoteMessage): string | null {
  if (typeof message.toolUseId === 'string' && message.toolUseId.length > 0) {
    return message.toolUseId;
  }
  if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content)) {
    return null;
  }
  const value = (message.content as Record<string, unknown>).toolUseId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function findLastRootUserMessageIndex(messages: readonly RemoteMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'user'
      && isPlanUserBoundary(message)
      && !isSyntheticTriggerText(contentToPreview(message.content))
    ) {
      return index;
    }
  }
  return -1;
}

function sameMessageReferences(
  previous: readonly RemoteMessage[],
  next: readonly RemoteMessage[],
): boolean {
  return previous.length === next.length
    && previous.every((message, index) => message === next[index]);
}

function sameMessagePrefixReferences(
  previous: readonly RemoteMessage[],
  next: readonly RemoteMessage[],
  prefixLength: number,
): boolean {
  return previous.length === prefixLength
    && prefixLength <= next.length
    && previous.every((message, index) => message === next[index]);
}
