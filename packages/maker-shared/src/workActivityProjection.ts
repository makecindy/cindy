/**
 * Shared work activity projection for desktop and mobile.
 *
 * One Codex command execution may contain several safe structured actions.
 * This module expands those actions into readable rows, de-duplicates repeated
 * file reads in exploratory runs, and provides the same latest-N projection
 * for every client. It stays framework-agnostic and never executes commands.
 */

import {
  commandIntentsFromActions,
  type CommandIntent,
} from './commandIntent';
import {
  describeToolUse,
  type ToolUseDescriptor,
} from './toolUseDescriptor';

export interface WorkActivityMessageLike {
  clientId: string;
  content: string;
  toolName?: string | null;
  toolInput?: unknown;
  thinkingRedacted?: boolean;
}

export type ExplorationActivityKind = 'read' | 'search' | 'list';

export interface ExplorationActivity {
  kind: ExplorationActivityKind;
  /** Present only for reads that can be safely de-duplicated. */
  readKey?: string;
}

export interface ProjectedToolActivity<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  kind: 'tool';
  key: string;
  message: TMessage;
  toolResult?: string;
  status: 'running' | 'done';
  /** One structured sub-action from the parent Codex command execution. */
  intentOverride?: CommandIntent;
  exploration?: ExplorationActivity;
}

export interface ProjectedThinkingActivity {
  kind: 'thinking';
  key: string;
  /** Original trimmed content, retained for an expanded live-preview row. */
  rawContent: string;
  content: string;
}

export type ProjectedWorkActivity<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> = ProjectedToolActivity<TMessage> | ProjectedThinkingActivity;

export interface WorkActivityProjection<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  /** Full chronological activity list after repeated-read de-duplication. */
  activities: ProjectedWorkActivity<TMessage>[];
  /** Expanded tool rows keyed by the source tool-segment child. */
  toolActivitiesByChildKey: Map<string, ProjectedToolActivity<TMessage>[]>;
  explorationCounts: Record<ExplorationActivityKind, number>;
  /** True only when every tool row in this direct work group is exploration. */
  isPureExploration: boolean;
}

export interface ProjectableWorkChild<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  kind: string;
  key: string;
  toolCalls?: TMessage[];
  resultMap?: Map<string, string>;
  settledIds?: Set<string>;
  message?: TMessage;
}

interface StructuredCommandActions {
  count: number;
  complete: boolean;
}

function inspectStructuredCommandActions(raw: unknown): StructuredCommandActions {
  if (!Array.isArray(raw) || raw.length === 0) return { count: 0, complete: false };
  let count = 0;
  let complete = true;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      complete = false;
      continue;
    }
    const type = (entry as Record<string, unknown>).type;
    if (type !== 'read' && type !== 'search' && type !== 'listFiles') {
      complete = false;
      continue;
    }
    count += 1;
  }
  return { count, complete };
}

function normalizeReadPath(path: string | undefined, cwd: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  const normalizedPath = trimmed.replace(/\\/g, '/');
  const rawCwd = cwd?.trim().replace(/\\/g, '/');
  const normalizedCwd = rawCwd === '/' || /^[A-Za-z]:\/$/.test(rawCwd ?? '')
    ? rawCwd
    : rawCwd?.replace(/\/+$/, '');
  const isAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
  const combined = !isAbsolute && normalizedCwd
    ? `${normalizedCwd}${normalizedCwd.endsWith('/') ? '' : '/'}${normalizedPath}`
    : normalizedPath;
  const isUnc = /^\/\/[^/]/.test(combined);
  const isPosixAbsolute = !isUnc && combined.startsWith('/');
  const prefix = isUnc ? '//' : isPosixAbsolute ? '/' : '';
  const body = prefix ? combined.slice(prefix.length) : combined;
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') {
      parts.pop();
      continue;
    }
    if (part === '..' && prefix) continue;
    parts.push(part);
  }
  const result = `${prefix}${parts.join('/')}`;
  return isUnc || /^[A-Za-z]:\//.test(result) ? result.toLowerCase() : result;
}

function resetsReadDeduplication<TMessage extends WorkActivityMessageLike>(
  activity: ProjectedWorkActivity<TMessage>,
): boolean {
  return activity.kind === 'tool' && !activity.exploration;
}

function explorationForDescriptor(
  descriptor: ToolUseDescriptor,
  intentOverride: CommandIntent | undefined,
  allowCommandIntent: boolean,
): ExplorationActivity | undefined {
  if (descriptor.kind === 'file' && descriptor.action === 'read') {
    const readKey = normalizeReadPath(descriptor.filePath, undefined);
    return { kind: 'read', ...(readKey ? { readKey } : {}) };
  }
  if (descriptor.kind === 'search') return { kind: 'search' };
  if (descriptor.kind !== 'command' || !allowCommandIntent) return undefined;

  const intent = intentOverride ?? descriptor.intent;
  if (intent?.action === 'read') {
    const readKey = normalizeReadPath(intent.path ?? intent.target, descriptor.cwd);
    return { kind: 'read', ...(readKey ? { readKey } : {}) };
  }
  if (intent?.action === 'search') return { kind: 'search' };
  if (intent?.action === 'list') return { kind: 'list' };
  return undefined;
}

function projectToolMessage<TMessage extends WorkActivityMessageLike>(
  child: ProjectableWorkChild<TMessage>,
  message: TMessage,
  isStreaming: boolean,
): ProjectedToolActivity<TMessage>[] {
  const input = (message.toolInput as Record<string, unknown> | null) ?? null;
  const descriptor = describeToolUse(message.toolName ?? '', input);
  const rawActions = input?.commandActions;
  const structured = inspectStructuredCommandActions(rawActions);
  const intents = descriptor.kind === 'command'
    ? commandIntentsFromActions(rawActions, descriptor.command)
    : [];
  const canSplit = structured.complete && structured.count > 1 && intents.length === structured.count;
  const commandProjectionIsComplete =
    structured.count === 0 || (structured.complete && intents.length === structured.count);
  const done =
    child.resultMap?.has(message.clientId) === true
    || child.settledIds?.has(message.clientId) === true;
  const status = isStreaming && !done ? 'running' : 'done';
  const toolResult = child.resultMap?.get(message.clientId);

  if (canSplit) {
    return intents.map((intent, index) => ({
      kind: 'tool',
      key: `${message.clientId}:action:${index}`,
      message,
      ...(toolResult !== undefined ? { toolResult } : {}),
      status,
      intentOverride: intent,
      exploration: explorationForDescriptor(descriptor, intent, true),
    }));
  }

  return [{
    kind: 'tool',
    key: message.clientId,
    message,
    ...(toolResult !== undefined ? { toolResult } : {}),
    status,
    exploration: explorationForDescriptor(descriptor, undefined, commandProjectionIsComplete),
  }];
}

function projectThinkingMessage<TMessage extends WorkActivityMessageLike>(
  message: TMessage,
): ProjectedThinkingActivity | null {
  if (message.thinkingRedacted) return null;
  const rawContent = message.content.trim();
  const content = rawContent.replace(/\s+/g, ' ');
  return content
    ? { kind: 'thinking', key: message.clientId, rawContent, content }
    : null;
}

/** Reverse hot path used by the running latest-N preview. */
export function projectRecentWorkActivities<TMessage extends WorkActivityMessageLike>(
  childItems: readonly ProjectableWorkChild<TMessage>[],
  isStreaming: boolean,
  limit: number,
): ProjectedWorkActivity<TMessage>[] {
  if (limit <= 0) return [];
  const reversed: ProjectedWorkActivity<TMessage>[] = [];
  const seenReadKeys = new Set<string>();

  const append = (activity: ProjectedWorkActivity<TMessage>): boolean => {
    if (resetsReadDeduplication(activity)) seenReadKeys.clear();
    if (
      activity.kind === 'tool'
      && activity.exploration?.kind === 'read'
      && activity.exploration.readKey
    ) {
      if (seenReadKeys.has(activity.exploration.readKey)) return false;
      seenReadKeys.add(activity.exploration.readKey);
    }
    reversed.push(activity);
    return reversed.length === limit;
  };

  for (let childIndex = childItems.length - 1; childIndex >= 0; childIndex -= 1) {
    const child = childItems[childIndex];
    if (child.kind === 'tools' && Array.isArray(child.toolCalls)) {
      for (let toolIndex = child.toolCalls.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const activities = projectToolMessage(child, child.toolCalls[toolIndex], isStreaming);
        for (let actionIndex = activities.length - 1; actionIndex >= 0; actionIndex -= 1) {
          if (append(activities[actionIndex])) return reversed.reverse();
        }
      }
      continue;
    }
    if (child.kind === 'thinking' && child.message) {
      const activity = projectThinkingMessage(child.message);
      if (activity && append(activity)) return reversed.reverse();
    }
  }
  return reversed.reverse();
}

/** Build the shared presentation model used by expanded work-group views. */
export function projectWorkActivities<TMessage extends WorkActivityMessageLike>(
  childItems: readonly ProjectableWorkChild<TMessage>[],
  isStreaming: boolean,
): WorkActivityProjection<TMessage> {
  const rawActivities: ProjectedWorkActivity<TMessage>[] = [];
  const rawToolActivitiesByChildKey = new Map<string, ProjectedToolActivity<TMessage>[]>();

  for (const child of childItems) {
    if (child.kind === 'tools' && Array.isArray(child.toolCalls)) {
      const childActivities = child.toolCalls.flatMap((message) =>
        projectToolMessage(child, message, isStreaming));
      rawToolActivitiesByChildKey.set(child.key, childActivities);
      rawActivities.push(...childActivities);
      continue;
    }
    if (child.kind === 'thinking' && child.message) {
      const activity = projectThinkingMessage(child.message);
      if (activity) rawActivities.push(activity);
    }
  }

  const keptKeys = new Set<string>();
  const seenReadKeys = new Set<string>();
  for (let index = rawActivities.length - 1; index >= 0; index -= 1) {
    const activity = rawActivities[index];
    if (resetsReadDeduplication(activity)) seenReadKeys.clear();
    if (
      activity.kind === 'tool'
      && activity.exploration?.kind === 'read'
      && activity.exploration.readKey
    ) {
      if (seenReadKeys.has(activity.exploration.readKey)) continue;
      seenReadKeys.add(activity.exploration.readKey);
    }
    keptKeys.add(activity.key);
  }

  const activities = rawActivities.filter((activity) => keptKeys.has(activity.key));
  const toolActivitiesByChildKey = new Map<string, ProjectedToolActivity<TMessage>[]>();
  for (const [childKey, childActivities] of rawToolActivitiesByChildKey) {
    toolActivitiesByChildKey.set(
      childKey,
      childActivities.filter((activity) => keptKeys.has(activity.key)),
    );
  }

  const toolActivities = activities.filter(
    (activity): activity is ProjectedToolActivity<TMessage> => activity.kind === 'tool',
  );
  const explorationCounts: WorkActivityProjection<TMessage>['explorationCounts'] = {
    read: 0,
    search: 0,
    list: 0,
  };
  for (const activity of toolActivities) {
    if (activity.exploration) explorationCounts[activity.exploration.kind] += 1;
  }

  return {
    activities,
    toolActivitiesByChildKey,
    explorationCounts,
    isPureExploration:
      toolActivities.length > 0 && toolActivities.every((activity) => !!activity.exploration),
  };
}
