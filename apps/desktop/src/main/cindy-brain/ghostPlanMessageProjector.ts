/**
 * Ghost Plan 的受控消息投影。
 *
 * plan-create 强制创建新消息；plan-update 按当前置顶 Plan 决定原地更新还是
 * 创建新的消息。消息仍是恢复与跨端同步的唯一事实来源。
 */

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  GHOST_PLAN_TOOL_NAME,
  getLatestMessageTodoState,
} from '@cindy/maker-shared';

import { getDbClient } from '../localDb/client/current.js';
import {
  broadcastMessageRow,
  createMessage,
  updateMessageContent,
} from '../localDb/ipc/messages.js';
import { messageToCamel } from '../localDb/mapper.js';
import { messages, sessions } from '../localDb/schema.js';
import { enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import type { GhostPipePlanPayload } from '../../shared/ghost.js';
import type { PlanProjector, PlanUpdateSessionContext } from './planSlot.js';

const GHOST_PLAN_ID_PREFIX = 'plan:ghost:';
const PLAN_TOOL_NAMES = [
  'TodoWrite',
  'update_plan',
  GHOST_PLAN_TOOL_NAME,
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
];
const messageRowid = sql<number>`rowid`;
let lastGeneration = 0;

type PlanUpdate = Omit<GhostPipePlanPayload, 'type'>;

export interface GhostPinnedPlanMessage {
  clientId: string;
  toolUseId: string | null;
  toolName: string;
}

export type GhostPlanMessageWrite =
  | { kind: 'send'; toolUseId: string }
  | { kind: 'update'; clientId: string; toolUseId: string };

function nextGeneration(): string {
  lastGeneration = Math.max(Date.now(), lastGeneration + 1);
  return lastGeneration.toString(36);
}

function createGhostPlanId(ghostId: string): string {
  return `${GHOST_PLAN_ID_PREFIX}${ghostId}:${nextGeneration()}`;
}

export function ghostIdFromPlanId(toolUseId: string | null | undefined): string | null {
  if (!toolUseId?.startsWith(GHOST_PLAN_ID_PREFIX)) return null;
  const separator = toolUseId.lastIndexOf(':');
  if (separator <= GHOST_PLAN_ID_PREFIX.length || separator === toolUseId.length - 1) return null;
  return toolUseId.slice(GHOST_PLAN_ID_PREFIX.length, separator);
}

export function decideGhostPlanMessageWrite(
  ghostId: string,
  current: GhostPinnedPlanMessage | null,
  forceCreate = false,
): GhostPlanMessageWrite {
  if (!forceCreate && (
    current?.toolName === GHOST_PLAN_TOOL_NAME
    && ghostIdFromPlanId(current.toolUseId) === ghostId
    && current.toolUseId
  )) {
    return { kind: 'update', clientId: current.clientId, toolUseId: current.toolUseId };
  }
  return { kind: 'send', toolUseId: createGhostPlanId(ghostId) };
}

async function getCurrentPinnedPlanMessage(sessionId: string): Promise<GhostPinnedPlanMessage | null> {
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const visibleAfterClear = session?.clearedAt == null
    ? undefined
    : gt(messages.createdAt, session.clearedAt);
  const toolName = sql<string>`json_extract(${messages.content}, '$.toolName')`;
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'tool_use'),
        isNull(messages.rewindAt),
        visibleAfterClear,
        inArray(toolName, PLAN_TOOL_NAMES),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));
  const visible = rows.map(messageToCamel);
  const state = getLatestMessageTodoState(visible);
  if (!state.insertion || state.latestPlanIndex < 0 || state.latestInsertionIndex !== state.latestPlanIndex) {
    return null;
  }
  const current = visible[state.latestPlanIndex];
  const content = current.content as { toolName?: unknown } | null;
  return {
    clientId: current.clientId,
    toolUseId: current.toolUseId,
    toolName: typeof content?.toolName === 'string' ? content.toolName : '',
  };
}

async function projectGhostPlanMessage(
  operation: 'create' | 'update',
  ghostId: string,
  context: PlanUpdateSessionContext,
  update: PlanUpdate,
): Promise<void> {
  await enqueueDurableWrite(`ghost-plan:${context.sessionId}:${ghostId}`, async (ownerScope) => {
    const current = await getCurrentPinnedPlanMessage(context.sessionId);
    const write = decideGhostPlanMessageWrite(ghostId, current, operation === 'create');
    const content = {
      toolUseId: write.toolUseId,
      toolName: GHOST_PLAN_TOOL_NAME,
      input: update,
    };

    if (write.kind === 'update') {
      const updated = await updateMessageContent(context.sessionId, write.clientId, content);
      if (updated) {
        broadcastMessageRow(context.sessionId, updated, ownerScope);
        return;
      }
    }

    await createMessage(context.sessionId, {
      clientId: createId(),
      role: 'tool_use',
      content,
      toolUseId: write.toolUseId,
      agentMeta: null,
      agentKind: null,
    }, { broadcastOwnerScope: ownerScope });
  });
}

/** Host-only projector injected into PlanSlot; not a generic plugin message API. */
export const projectGhostPlan: PlanProjector = projectGhostPlanMessage;
