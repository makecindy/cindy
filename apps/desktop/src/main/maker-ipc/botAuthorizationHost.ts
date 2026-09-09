import { getSessionRewindGeneration, withSendToSessionLock } from './sendToSessionLock.js';
import { shell } from 'electron';
import { t } from '../i18n.js';
import { and, eq, isNull, ne, or, gt, like, desc, inArray } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, botProfiles, botRuntimeSnapshots, sessions, messages } from '../localDb/schema.js';
import {
  createMessage,
  patchMessageAgentMeta,
  broadcastMessageAgentMetaUpdate,
  updateMessageContent,
} from '../localDb/ipc/messages.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import {
  getGhostManager,
  getGhostSetupAssessment,
  executeGhostSetupAction,
  executeGhostSetupInlineAction,
  isGhostAvailableForActiveSession,
  acquireGhostMutationLeaseForMcp,
  captureGhostMutationOwnerForMcp,
} from '../cindy-brain/index.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';
import { classifyGhostVisibility } from '../cindy-brain/ghostVisibility.js';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import {
  getGrokAccessToken,
  hasGrokOAuthLogin,
  runGrokOAuthLogin,
  getGrokOAuthCredentialGeneration,
  cancelGrokOAuthLogin,
} from '../maker-host/grok-oauth-login.js';
import { toReauthInteractionAssessment } from '../cindy-brain/ghostSetupCoordinator.js';
import { initBotAuthorizationService } from './botAuthorizationService.js';
import { readBotAuthorizationCard } from '../../shared/botAuthorization.js';
import type { BotAuthorizationCard } from '../../shared/botAuthorization.js';
import { sanitizeGhostSetupSnapshotForDesktop } from '../cindy-brain/ghostSetupInteractionBridge.js';
import { createLogger } from '../logger.js';
const log = createLogger('bot-authorization');

/** Uses the canonical DB link, never an agent-supplied bot identity. */
export async function isBotAuthorizationSession(sessionId: string): Promise<boolean> {
  const [row] = await getDbClient()
    .drizzle.select({ id: botSessionLinks.botId, status: botProfiles.status })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(
      and(
        eq(botSessionLinks.sessionId, sessionId),
        eq(botSessionLinks.role, 'canonical'),
        isNull(botSessionLinks.archivedAt),
        ne(sessions.status, 'deleted'),
        ne(sessions.status, 'archived'),
      ),
    )
    .limit(1);
  return row?.status === 'active';
}

/** Adapts existing Host credentials and plugin configuration into the same card lifecycle. */
export function initializeBotAuthorizationHost(
  resume: (card: BotAuthorizationCard, validate: () => Promise<void>, assertCurrent: () => void) => Promise<void>,
  captureInputGuard: (sessionId: string) => () => void = () => () => {},
) {
  const ownerScopes = new Map<string, ReturnType<typeof captureDataOwnerBroadcastScope>>();
  const assertPluginPolicy = async (sessionId: string, pluginId: string) => {
    // The applied snapshot survives Host restarts; never infer teammate grants
    // from global plugin visibility or from the card's display metadata.
    const [snapshot] = await getDbClient()
      .drizzle
      .select({ resolvedJson: botRuntimeSnapshots.resolvedJson })
      .from(botRuntimeSnapshots)
      .where(
        and(
          eq(botRuntimeSnapshots.sessionId, sessionId),
          inArray(botRuntimeSnapshots.status, ['applied', 'degraded']),
        ),
      )
      .orderBy(desc(botRuntimeSnapshots.preparedAt))
      .limit(1);
    let resolved: { toolsets?: unknown } | null = null;
    try {
      resolved = JSON.parse(snapshot?.resolvedJson ?? 'null');
    } catch {
      /* deny malformed policy */
    }
    if (!Array.isArray(resolved?.toolsets) || !resolved.toolsets.includes(pluginId))
      throw new Error('Plugin is disabled in teammate profile');
  };
  const assertSession = async (sessionId: string) => {
    const scope = ownerScopes.get(sessionId);
    if (
      !scope ||
      !isDataOwnerBroadcastScopeCurrent(scope) ||
      !(await isBotAuthorizationSession(sessionId)) ||
      !isDataOwnerBroadcastScopeCurrent(scope)
    )
      throw new Error('Authorization owner or teammate is unavailable');
  };
  return initBotAuthorizationService({
    async adapter(sessionId, target) {
      const scope = captureDataOwnerBroadcastScope();
      if (!scope) throw new Error('Authorization owner unavailable');
      const known = ownerScopes.get(sessionId);
      if (known && !isDataOwnerBroadcastScopeCurrent(known))
        throw new Error('Authorization owner changed');
      ownerScopes.set(sessionId, scope);
      await assertSession(sessionId);
      const bus = getGhostSetupChangeBus();
      if (target.kind === 'host') {
        if (target.id !== 'grok') throw new Error('Unsupported Host connection');
        const credentialGeneration = getGrokOAuthCredentialGeneration();
        return {
          identity: { id: 'grok', name: 'Grok' },
          async assess() {
            await assertSession(sessionId);
            let ready = false;
            if (
              hasGrokOAuthLogin() &&
              (!target.reauthorize || credentialGeneration !== getGrokOAuthCredentialGeneration())
            ) {
              try {
                await getGrokAccessToken();
                ready = hasGrokOAuthLogin();
              } catch {
                /* offer login */
              }
            }
            await assertSession(sessionId);
            if (target.reauthorize && credentialGeneration === getGrokOAuthCredentialGeneration())
              ready = false;
            return {
              state: ready ? ('ready' as const) : ('required' as const),
              revision: bus.currentRevision('host:grok'),
              groups: ready
                ? []
                : [
                    {
                      id: 'grok-account',
                      mode: 'any_of' as const,
                      items: [
                        {
                          ref: 'grok-account',
                          kind: 'oauth' as const,
                          label: 'Grok',
                          state: 'missing' as const,
                          actions: [{ id: 'connect-grok', kind: 'oauth_connect' as const }],
                        },
                      ],
                    },
                  ],
            };
          },
          subscribe: (wake) => bus.subscribe('host:grok', wake),
          async execute(_action, _sender, _value, onAuthorizationUrl, assertCurrent, beforeCommit) {
            await assertSession(sessionId);
            assertCurrent?.();
            const result = await runGrokOAuthLogin({ onAuthorizationUrl, assertCurrent, beforeCommit });
            assertCurrent?.();
            if (result.ok) {
              bus.emit('host:grok', { source: 'oauth' });
              return { ok: true as const };
            }
            return {
              ok: false as const,
              errorCode:
                result.reason === 'timeout' ? ('TIMEOUT' as const) : ('AUTH_FAILED' as const),
            };
          },
        };
      }
      const [session] = await getDbClient()
        .drizzle.select({ workingDir: sessions.workingDir })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const validate = async () => {
        await assertSession(sessionId);
        await assertPluginPolicy(sessionId, target.id);
        await assertSession(sessionId);
        const result = classifyGhostVisibility(target.id, session?.workingDir ?? null, {
          listGhosts: () => getGhostManager().list(),
          isAvailableForActiveSession: isGhostAvailableForActiveSession,
          isDisabledForWorkdir: isGhostDisabledForWorkdir,
        });
        if (!result.ok) throw new Error('Plugin is unavailable');
        return result.ghost;
      };
      const ghost = await validate();
      let reconnected = false;
      return {
        identity: {
          id: target.id,
          name: ghost.manifest.name,
          ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        },
        async assess() {
          await validate();
          const assessment = getGhostSetupAssessment(target.id);
          if (!target.reauthorize) return assessment;
          const suggested = toReauthInteractionAssessment(assessment);
          // A plugin-wide OAuth event (or successful action) cannot satisfy a
          // credential whose authoritative scope/reauth requirement still exists.
          if (suggested) return suggested;
          if (reconnected) return assessment;
          if (assessment.state !== 'ready') return assessment;
          const groups = assessment.groups.flatMap((group) => {
            const items = group.items
              .filter(
                (item) =>
                  item.kind === 'oauth' &&
                  item.actions.some((action) => action.kind === 'oauth_connect'),
              )
              .map((item) => ({ ...item, state: 'expired' as const }));
            return items.length ? [{ ...group, items }] : [];
          });
          return groups.length ? { ...assessment, state: 'required' as const, groups } : assessment;
        },
        subscribe: (wake) =>
          bus.subscribe(target.id, (event) => {
            if (event.source === 'oauth') reconnected = true;
            wake();
          }),
        async execute(action, sender, value, onAuthorizationUrl, assertCurrent, beforeCommit) {
          await validate();
          assertCurrent?.();
          const release = acquireGhostMutationLeaseForMcp(captureGhostMutationOwnerForMcp());
          try {
            if (action.kind === 'inline_form') {
              if (value === undefined) return { ok: false, errorCode: 'INLINE_UNAVAILABLE' };
              return await executeGhostSetupInlineAction({
                sessionId,
                ghostId: target.id,
                action,
                value,
              });
            }
            const result = await executeGhostSetupAction({
              sessionId,
              ghostId: target.id,
              action,
              responseTarget: sender,
              onAuthorizationUrl,
              assertCurrent,
              beforeCommit,
            });
            if (result.ok && action.kind === 'oauth_connect') reconnected = true;
            return result;
          } finally {
            release();
          }
        },
      };
    },
    captureRequestGuard(sessionId) {
      const assertInputCurrent = captureInputGuard(sessionId);
      const generation = getSessionRewindGeneration(sessionId);
      return () => {
        assertInputCurrent();
        if (getSessionRewindGeneration(sessionId) !== generation)
          throw new Error('Authorization request was rewound');
      };
    },
    async save(card, assertCurrent) {
      return withSendToSessionLock(card.sessionId, async () => {
        assertCurrent?.();
        await assertSession(card.sessionId);
        const [row] = await getDbClient()
          .drizzle.select({ clearedAt: sessions.clearedAt })
          .from(sessions)
          .where(eq(sessions.id, card.sessionId))
          .limit(1);
        if (!row || (row.clearedAt !== null && row.clearedAt >= card.createdAt))
          throw new Error('Authorization card was cleared');
        card = {
          ...card,
          snapshot: {
            ...sanitizeGhostSetupSnapshotForDesktop(card.snapshot),
            ...(card.snapshot.reopenActionId ? { reopenActionId: card.snapshot.reopenActionId } : {}),
          },
        };
        const clientId = `bot-authorization:${card.snapshot.requestId}`;
        const phase = card.snapshot.steps.find((s) => s.phase !== 'satisfied')?.phase ?? 'satisfied';
        const fallback = `${card.snapshot.ghost.name} · ${t(`newChat.pluginSetup.phase.${phase}`)}${card.snapshot.terminal ? '' : ` · ${t('newChat.pluginSetup.completeOnDesktop')}`}`;
        // Only the presentation is stored. Current assessment/actions are re-read on every click.
        assertCurrent?.();
        await createMessage(
          card.sessionId,
          {
            clientId,
            role: 'assistant',
            content: fallback,
            agentMeta: { botAuthorization: card },
            createdAt: card.createdAt,
          },
          {
            broadcastOwnerScope: ownerScopes.get(card.sessionId),
            expectedClearBoundaryMs: row.clearedAt,
          },
        );
        await assertSession(card.sessionId);
        await updateMessageContent(card.sessionId, clientId, fallback);
        await patchMessageAgentMeta(card.sessionId, clientId, { botAuthorization: card });
        await broadcastMessageAgentMetaUpdate(
          card.sessionId,
          clientId,
          ownerScopes.get(card.sessionId),
        );
      });
    },
    async load(requestId) {
      const [row] = await getDbClient()
        .drizzle.select({ sessionId: messages.sessionId, meta: messages.agentMeta })
        .from(messages)
        .innerJoin(sessions, eq(sessions.id, messages.sessionId))
        .where(
          and(
            eq(messages.clientId, `bot-authorization:${requestId}`),
            isNull(messages.rewindAt),
            or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
          ),
        )
        .limit(1);
      if (!row) return null;
      const card = readStoredAuthorization(row);
      return card?.snapshot.requestId === requestId ? card : null;
    },
    async findPending(sessionId, target) {
      await assertSession(sessionId);
      const rows = await getDbClient()
        .drizzle.select({ sessionId: messages.sessionId, meta: messages.agentMeta })
        .from(messages)
        .innerJoin(sessions, eq(sessions.id, messages.sessionId))
        .where(
          and(
            eq(messages.sessionId, sessionId),
            like(messages.clientId, 'bot-authorization:%'),
            isNull(messages.rewindAt),
            or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
          ),
        )
        .orderBy(desc(messages.createdAt));
      await assertSession(sessionId);
      for (const row of rows) {
        const card = readStoredAuthorization(row);
        if (
          card &&
          !card.snapshot.terminal &&
          card.target.kind === target.kind &&
          card.target.id === target.id &&
          !!card.target.reauthorize === !!target.reauthorize
        )
          return card;
      }
      return null;
    },
    async resume(card, assertCurrent) {
      await resume(card, async () => {
        await assertSession(card.sessionId);
        if (card.target.kind === 'plugin')
          await assertPluginPolicy(card.sessionId, card.target.id);
        const [row] = await getDbClient()
          .drizzle.select({ id: messages.id })
          .from(messages)
          .innerJoin(sessions, eq(sessions.id, messages.sessionId))
          .where(
            and(
              eq(messages.sessionId, card.sessionId),
              eq(messages.clientId, `bot-authorization:${card.snapshot.requestId}`),
              isNull(messages.rewindAt),
              or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
            ),
          )
          .limit(1);
        if (!row) throw new Error('Authorization card is no longer visible');
        await assertSession(card.sessionId);
      }, assertCurrent);
    },
    onDisposing: () => cancelGrokOAuthLogin(),
    onDispose: () => ownerScopes.clear(),
    openExternal: (url) => shell.openExternal(url),
    warn: () => log.warn('Authorization card operation failed'),
  });
}

function readStoredAuthorization(row: {
  sessionId: string;
  meta: unknown;
}): BotAuthorizationCard | null {
  let meta: unknown;
  try {
    meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta;
  } catch {
    return null;
  }
  const card = readBotAuthorizationCard((meta as Record<string, unknown> | null)?.botAuthorization);
  return card?.sessionId === row.sessionId ? card : null;
}
