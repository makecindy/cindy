/** Desktop type adapter for the framework-agnostic shared activity projection. */
import {
  projectRecentWorkActivities as projectRecentSharedWorkActivities,
  projectWorkActivities as projectSharedWorkActivities,
  type ExplorationActivity,
  type ExplorationActivityKind,
  type ProjectableWorkChild,
  type ProjectedThinkingActivity,
  type ProjectedToolActivity as SharedProjectedToolActivity,
  type ProjectedWorkActivity as SharedProjectedWorkActivity,
  type WorkActivityProjection as SharedWorkActivityProjection,
} from '@cindy/maker-shared/work-activity-projection';

import type { ChatMessage } from '@/lib/makerChatStore';
import { createMessageProjectionCache } from '@/components/chat/messageProjectionCache';

export type { ExplorationActivity, ExplorationActivityKind, ProjectedThinkingActivity };
export type ProjectedToolActivity = SharedProjectedToolActivity<ChatMessage>;
export type ProjectedWorkActivity = SharedProjectedWorkActivity<ChatMessage>;
export type WorkActivityProjection = SharedWorkActivityProjection<ChatMessage>;

const projectSnapshot = createMessageProjectionCache<ChatMessage, WorkActivityProjection>();

export function projectRecentWorkActivities(
  childItems: readonly ProjectableWorkChild<ChatMessage>[],
  isStreaming: boolean,
  limit: number,
): ProjectedWorkActivity[] {
  return projectRecentSharedWorkActivities(childItems, isStreaming, limit);
}

export function projectWorkActivities(
  childItems: readonly ProjectableWorkChild<ChatMessage>[],
  isStreaming: boolean,
): WorkActivityProjection {
  // Group wrappers and result Maps are reconstructed on mount. Their immutable
  // source messages and the exact values consumed by the projector are stable.
  // Never retain rendered-child closures in the cross-mount cache.
  const dependencies: unknown[] = [isStreaming];
  let first: ChatMessage | undefined;
  for (const child of childItems) {
    dependencies.push(child.kind, child.key);
    if (child.kind === 'tools') {
      for (const message of child.toolCalls ?? []) {
        first ??= message;
        dependencies.push(
          message,
          child.resultMap?.has(message.clientId),
          child.resultMap?.get(message.clientId),
          child.settledIds?.has(message.clientId),
        );
      }
    } else if (child.kind === 'thinking' && child.message) {
      first ??= child.message;
      dependencies.push(child.message);
    }
  }
  const compute = () => projectSharedWorkActivities(childItems, isStreaming);
  return first ? projectSnapshot(first, dependencies, compute) : compute();
}
