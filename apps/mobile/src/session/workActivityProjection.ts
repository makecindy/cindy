/** Mobile adapter for the shared desktop/mobile work activity projection. */
import {
  projectRecentWorkActivities,
  projectWorkActivities,
  type ProjectableWorkChild,
  type ProjectedThinkingActivity,
  type ProjectedToolActivity,
  type ProjectedWorkActivity,
  type WorkActivityMessageLike,
  type WorkActivityProjection,
} from '@cindy/maker-shared/work-activity-projection';

import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import type { MobileWorkChildItem } from '@/session/messageRenderModel';

export interface MobileWorkActivityMessage extends WorkActivityMessageLike {
  normalized: NormalizedRemoteMessage;
}

export type MobileProjectedToolActivity = ProjectedToolActivity<MobileWorkActivityMessage>;
export type MobileProjectedThinkingActivity = ProjectedThinkingActivity;
export type MobileProjectedWorkActivity = ProjectedWorkActivity<MobileWorkActivityMessage>;
export type MobileWorkActivityProjection = WorkActivityProjection<MobileWorkActivityMessage>;

/** Compare the data consumed by WorkToolActivityRow, not projection wrappers. */
export function sameMobileWorkToolActivity(
  previous: MobileProjectedToolActivity,
  next: MobileProjectedToolActivity,
): boolean {
  return previous === next || (
    previous.key === next.key
    && previous.message.normalized === next.message.normalized
    && previous.status === next.status
    && previous.toolResult === next.toolResult
    && previous.intentOverride?.action === next.intentOverride?.action
    && previous.intentOverride?.target === next.intentOverride?.target
    && previous.intentOverride?.path === next.intentOverride?.path
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function activityMessage(
  normalized: NormalizedRemoteMessage,
  thinkingRedacted = false,
): MobileWorkActivityMessage {
  const sourceContent = readRecord(normalized.source.content);
  return {
    clientId: normalized.source.clientId || normalized.source.id || normalized.key,
    content: normalized.body,
    toolName: readString(sourceContent?.toolName) ?? readString(sourceContent?.name) ?? normalized.label,
    toolInput: sourceContent?.input,
    thinkingRedacted,
    normalized,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function projectableChild(
  child: MobileWorkChildItem,
): ProjectableWorkChild<MobileWorkActivityMessage> {
  if (child.type === 'tool_group') {
    const toolCalls = child.tools.map((tool) => activityMessage(tool));
    const resultMap = new Map<string, string>();
    const settledIds = new Set<string>();
    for (const message of toolCalls) {
      if (message.normalized.secondaryBody !== undefined) {
        resultMap.set(message.clientId, message.normalized.secondaryBody);
      }
      if (message.normalized.toolSettled === true) settledIds.add(message.clientId);
    }
    return { kind: 'tools', key: child.key, toolCalls, resultMap, settledIds };
  }
  if (child.type === 'thinking') {
    return {
      kind: 'thinking',
      key: child.key,
      message: activityMessage(child.message, child.redacted),
    };
  }
  return { kind: child.type, key: child.key };
}

export function projectRecentMobileWorkActivities(
  children: readonly MobileWorkChildItem[],
  isStreaming: boolean,
  limit: number,
): MobileProjectedWorkActivity[] {
  return projectRecentWorkActivities(children.map(projectableChild), isStreaming, limit);
}

export function projectMobileWorkActivities(
  children: readonly MobileWorkChildItem[],
  isStreaming: boolean,
): MobileWorkActivityProjection {
  return projectWorkActivities(children.map(projectableChild), isStreaming);
}
