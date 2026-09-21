import type { StartSkillLearningParams } from '@cindy/mcps';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import {
  isDbClientNotReadyError,
  tryGetDbClient,
} from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';

export type LearnInvocationGrantResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: 'HOST_NOT_READY' | 'INTERNAL' | 'USER_REQUEST_REQUIRED';
      message: string;
    };

interface LatestUserInvocation {
  messageId: string;
  text: string;
  grant: CindyLearnInvocationGrant | null;
}

/** Main-owned snapshot of the Skill winner captured for one accepted user turn. */
export interface CindyLearnInvocationGrant {
  version: 1;
  sessionInstanceId: string;
  resolvedSkillPath: string;
}

type ReadLatestUserInvocation = (
  sessionId: string,
) => Promise<LatestUserInvocation | null>;

type ConsumeUserInvocation = (
  sessionId: string,
  messageId: string,
  sessionInstanceId: string,
) => Promise<boolean>;

const messageRowid = sql<number>`"messages"."rowid"`;

function normalizeInput(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function parseDirectLearnInvocation(
  text: string,
): Omit<StartSkillLearningParams, 'callerSessionId'> | null {
  // Slash-skill dispatch resolves names case-insensitively. Keep the grant
  // parser on the same rule so an invocation accepted as the Learn Skill is
  // also accepted when that Skill calls the privileged host tool.
  const command = /^\/(?:skill:)?learn(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!command) return null;

  const arg = (command[1] ?? '').trim();
  const hubMatch = /^hub:(?:(market|team):)?([a-z0-9][a-z0-9-]*)\s*/.exec(arg);
  if (hubMatch) {
    return {
      input: arg.slice(hubMatch[0].length).trim(),
      sourceKind: 'hub',
      hubSlug: hubMatch[2],
      hubCatalogScope: (hubMatch[1] as 'market' | 'team' | undefined) ?? 'market',
    };
  }
  return {
    input: arg,
    sourceKind: arg ? 'freetext' : 'session',
  };
}

function matchesInvocation(
  invocation: Omit<StartSkillLearningParams, 'callerSessionId'>,
  request: StartSkillLearningParams,
): boolean {
  if (invocation.sourceKind !== request.sourceKind) return false;
  if (normalizeInput(invocation.input) !== normalizeInput(request.input)) return false;
  if (invocation.sourceKind !== 'hub') {
    return request.hubSlug === undefined && request.hubCatalogScope === undefined;
  }
  return invocation.hubSlug === request.hubSlug
    && invocation.hubCatalogScope === (request.hubCatalogScope ?? 'market');
}

export function createLearnInvocationGrantConsumer(
  readLatestUserInvocation: ReadLatestUserInvocation,
  consumeUserInvocation: ConsumeUserInvocation,
): (
  request: StartSkillLearningParams,
  sessionInstanceId: string | undefined,
) => Promise<LearnInvocationGrantResult> {
  return async (request, sessionInstanceId) => {
    let latest: LatestUserInvocation | null;
    try {
      latest = await readLatestUserInvocation(request.callerSessionId);
    } catch (error) {
      return {
        ok: false,
        errorCode: isDbClientNotReadyError(error) ? 'HOST_NOT_READY' : 'INTERNAL',
        message: 'Cindy could not verify the current /learn request.',
      };
    }
    const invocation = latest ? parseDirectLearnInvocation(latest.text) : null;
    if (
      !latest
      || !invocation
      || !sessionInstanceId
      || latest.grant?.version !== 1
      || latest.grant.sessionInstanceId !== sessionInstanceId
      || !latest.grant.resolvedSkillPath
      || !matchesInvocation(invocation, request)
    ) {
      return {
        ok: false,
        errorCode: 'USER_REQUEST_REQUIRED',
        message: 'Start Learn by invoking /learn directly in the current task.',
      };
    }
    let consumed: boolean;
    try {
      consumed = await consumeUserInvocation(
        request.callerSessionId,
        latest.messageId,
        sessionInstanceId,
      );
    } catch (error) {
      return {
        ok: false,
        errorCode: isDbClientNotReadyError(error) ? 'HOST_NOT_READY' : 'INTERNAL',
        message: 'Cindy could not record the current /learn request.',
      };
    }
    if (!consumed) {
      return {
        ok: false,
        errorCode: 'USER_REQUEST_REQUIRED',
        message: 'This /learn request has already been used.',
      };
    }
    return { ok: true };
  };
}

function parseLearnInvocationGrant(agentMeta: string | null): CindyLearnInvocationGrant | null {
  if (!agentMeta) return null;
  try {
    const value = (JSON.parse(agentMeta) as { cindyLearnInvocation?: unknown }).cindyLearnInvocation;
    if (!value || typeof value !== 'object') return null;
    const grant = value as Partial<CindyLearnInvocationGrant>;
    return grant.version === 1
      && typeof grant.sessionInstanceId === 'string'
      && grant.sessionInstanceId.length > 0
      && typeof grant.resolvedSkillPath === 'string'
      && grant.resolvedSkillPath.length > 0
      ? grant as CindyLearnInvocationGrant
      : null;
  } catch {
    return null;
  }
}

async function readLatestUserInvocation(
  sessionId: string,
): Promise<LatestUserInvocation | null> {
  const dbClient = tryGetDbClient();
  if (!dbClient) {
    throw Object.assign(new Error('DbClient not ready'), { code: 'HOST_NOT_READY' });
  }
  const [row] = await dbClient.drizzle
    .select({ id: messages.id, content: messages.content, agentMeta: messages.agentMeta })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        sql`(${messages.agentMeta} IS NULL OR CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.autoResume') END IS NOT 1)`,
        // Same-turn steering is persisted as a newer user row, but it does not
        // start a new turn or replace the original turn's Learn authorization.
        // Keep ordinary later turns as blockers so an old grant cannot leak
        // across turn boundaries.
        sql`CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.delivery') END IS NOT 'steer'`,
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!row) return null;
  return {
    messageId: row.id,
    text: visibleMessageTextForConversationSearch('user', row.content),
    grant: parseLearnInvocationGrant(row.agentMeta),
  };
}

async function consumeUserInvocation(
  sessionId: string,
  messageId: string,
  sessionInstanceId: string,
): Promise<boolean> {
  const dbClient = tryGetDbClient();
  if (!dbClient) {
    throw Object.assign(new Error('DbClient not ready'), { code: 'HOST_NOT_READY' });
  }
  // Claim the exact persisted user message with one compare-and-update. Keeping
  // the marker in agent_meta makes the one-shot grant survive app restarts;
  // JSON object metadata is preserved, while malformed/non-object metadata
  // fails closed instead of being overwritten.
  const result = await dbClient.exec(
    `UPDATE messages
        SET agent_meta = json_set(COALESCE(agent_meta, '{}'), '$.cindyLearnInvocationConsumed', 1)
      WHERE id = ?
        AND session_id = ?
        AND role = 'user'
        AND rewind_at IS NULL
        AND CASE
              WHEN agent_meta IS NULL THEN 1
              WHEN json_valid(agent_meta) THEN
                json_type(agent_meta) = 'object'
                AND json_type(agent_meta, '$.cindyLearnInvocationConsumed') IS NULL
              ELSE 0
            END
        AND json_extract(agent_meta, '$.cindyLearnInvocation.version') = 1
        AND json_extract(agent_meta, '$.cindyLearnInvocation.sessionInstanceId') = ?
        AND json_type(agent_meta, '$.cindyLearnInvocation.resolvedSkillPath') = 'text'`,
    [messageId, sessionId, sessionInstanceId],
  );
  return result.changes === 1;
}

export const consumeLearnInvocationGrant = createLearnInvocationGrantConsumer(
  readLatestUserInvocation,
  consumeUserInvocation,
);
