import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import {
  boundAgentReferenceText,
  projectPersistedAgentFacingUserText,
  readAgentInputReferences,
  type AgentInputBotHostSnapshot,
  type AgentInputReference,
} from '@cindy/maker-shared/agent-input-projection';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  botDelegations,
  botProfiles,
  botRuntimeSnapshots,
  botSessionLinks,
  messages,
  sessions,
} from '../localDb/schema.js';

import { extractPlainText } from './agentHandoff.js';

type ReferencedMessageLookup =
  | { state: 'visible'; text: string | null }
  | { state: 'hidden' }
  | { state: 'missing' };

export interface AgentInputReferenceHydrationOptions {
  /** Main-owned live turn lookup. null means the runtime cannot be observed. */
  isSessionTurnRunning?: (sessionId: string) => boolean | null;
}

const ACTIVE_DELEGATION_STATUSES = ['queued', 'running', 'waiting'] as const;

async function readBotHostSnapshot(
  botId: string,
  opts: AgentInputReferenceHydrationOptions,
): Promise<{ name: string; snapshot: AgentInputBotHostSnapshot }> {
  const db = getDbClient().drizzle;
  const [profile] = await db
    .select({
      name: botProfiles.displayName,
      status: botProfiles.status,
      attentionReason: botProfiles.attentionReason,
    })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile) {
    return {
      name: botId,
      snapshot: {
        availability: 'unavailable',
        activity: 'unknown',
        activeDelegations: 0,
        reason: 'The selected Bot no longer exists.',
      },
    };
  }
  if (profile.status !== 'active') {
    return {
      name: profile.name,
      snapshot: {
        availability: 'unavailable',
        activity: 'idle',
        activeDelegations: 0,
        reason: `The selected Bot is ${profile.status}.`,
      },
    };
  }

  const [[canonical], activeDelegations] = await Promise.all([
    db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(and(
        eq(botSessionLinks.botId, botId),
        eq(botSessionLinks.role, 'canonical'),
        isNull(botSessionLinks.archivedAt),
      ))
      .limit(1),
    db
      .select({ id: botDelegations.id })
      .from(botDelegations)
      .where(and(
        or(
          eq(botDelegations.requestingBotId, botId),
          eq(botDelegations.targetBotId, botId),
        ),
        inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
      )),
  ]);
  const [runtime] = canonical
    ? await db
        .select({ status: botRuntimeSnapshots.status })
        .from(botRuntimeSnapshots)
        .where(and(
          eq(botRuntimeSnapshots.botId, botId),
          eq(botRuntimeSnapshots.sessionId, canonical.sessionId),
        ))
        .orderBy(desc(botRuntimeSnapshots.preparedAt))
        .limit(1)
    : [];
  const liveTurn = canonical && opts.isSessionTurnRunning
    ? opts.isSessionTurnRunning(canonical.sessionId)
    : null;
  const availability = runtime?.status === 'applied'
    ? 'ready'
    : runtime?.status === 'degraded'
      ? 'degraded'
      : runtime?.status === 'failed'
        ? 'failed'
        : 'unverified';
  return {
    name: profile.name,
    snapshot: {
      availability,
      activity: liveTurn === true || activeDelegations.length > 0
        ? 'working'
        : canonical
          ? 'idle'
          : 'unknown',
      activeDelegations: activeDelegations.length,
      ...(profile.attentionReason
        ? { reason: profile.attentionReason.slice(0, 240) }
        : !canonical
          ? { reason: 'The selected Bot has no active main task.' }
          : {}),
    },
  };
}

async function readReferencedMessageText(
  sessionId: string,
  messageClientId: string,
): Promise<ReferencedMessageLookup> {
  const [row] = await getDbClient()
    .drizzle.select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      rewindAt: messages.rewindAt,
      clearedAt: sessions.clearedAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, messageClientId)))
    .limit(1);
  if (!row) return { state: 'missing' };
  if (
    row.rewindAt != null
    || (row.clearedAt != null && row.createdAt <= row.clearedAt)
  ) {
    return { state: 'hidden' };
  }
  const projected = row.role === 'user'
    ? projectPersistedAgentFacingUserText(row.content)
    : null;
  return {
    state: 'visible',
    text: (projected ?? extractPlainText(row.content)).trim() || null,
  };
}

function persistReferences(
  persistedContent: string,
  references: readonly AgentInputReference[],
): string {
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return persistedContent;
    const next = { ...(parsed as Record<string, unknown>) };
    delete next.agentReferences;
    const persistentReferences = references.map((reference) => {
      if (reference.kind !== 'bot' || reference.hostSnapshot === undefined) return reference;
      const persistent = { ...reference };
      delete persistent.hostSnapshot;
      return persistent;
    });
    return JSON.stringify({
      ...next,
      ...(persistentReferences.length > 0 ? { agentReferences: persistentReferences } : {}),
    });
  } catch {
    return persistedContent;
  }
}

function readPersistedReferences(
  persistedContent: string,
  text: string,
): { present: boolean; references: AgentInputReference[] } {
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { present: false, references: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      present: Object.hasOwn(record, 'agentReferences'),
      references: readAgentInputReferences(record.agentReferences, text),
    };
  } catch {
    return { present: false, references: [] };
  }
}

/**
 * Validate reference metadata and hydrate missing message bodies from the
 * authoritative host DB before the queue accepts/persists the item.
 */
export async function hydrateQueuedAgentReferences(
  queued: AgentInputQueuedMessage,
  opts: AgentInputReferenceHydrationOptions = {},
): Promise<AgentInputQueuedMessage> {
  const persisted = readPersistedReferences(queued.persistedContent, queued.text);
  const references = queued.agentReferences !== undefined
    ? readAgentInputReferences(queued.agentReferences, queued.text)
    : persisted.references;
  if (references.length === 0) {
    if (queued.agentReferences === undefined && !persisted.present) return queued;
    const sanitized = { ...queued };
    delete sanitized.agentReferences;
    sanitized.persistedContent = persistReferences(queued.persistedContent, []);
    return sanitized;
  }

  const hydrated = await Promise.all(references.map(async (reference): Promise<AgentInputReference> => {
    if (reference.kind === 'bot') {
      const base = { ...reference };
      delete base.hostSnapshot;
      try {
        const resolved = await readBotHostSnapshot(reference.botId, opts);
        return {
          ...base,
          name: resolved.name,
          hostSnapshot: resolved.snapshot,
        };
      } catch {
        // DB handover can race input preparation. Keep the exact stable Bot ID;
        // projection will use the one-call status fallback instead of inventing state.
        return base;
      }
    }
    if (reference.kind !== 'message') return reference;
    let lookup: ReferencedMessageLookup = { state: 'missing' };
    try {
      lookup = await readReferencedMessageText(
        reference.sessionId,
        reference.messageClientId,
      );
    } catch {
      // Cross-device references may not exist in this host DB. The bounded
      // Composer-captured body remains a valid fallback.
    }
    const sourceText = lookup.state === 'visible'
      ? lookup.text ?? ''
      : lookup.state === 'hidden'
        ? ''
        : reference.text ?? '';
    const bounded = boundAgentReferenceText(sourceText);
    const capturedTruncated = reference.truncated;
    const base = { ...reference };
    delete base.text;
    delete base.truncated;
    return {
      ...base,
      ...(bounded.text ? { text: bounded.text } : {}),
      ...((lookup.state === 'missing' && capturedTruncated === true) || bounded.truncated
        ? { truncated: true }
        : {}),
    };
  }));

  return {
    ...queued,
    agentReferences: hydrated,
    persistedContent: persistReferences(queued.persistedContent, hydrated),
  };
}
