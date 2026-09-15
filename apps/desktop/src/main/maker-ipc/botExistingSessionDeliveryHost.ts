import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { InteractionRequest, Session } from '@cindy/maker-core';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { t } from '../i18n.js';
import { requestHostInteraction } from './interactionRouter.js';
import {
  createBotExistingSessionDelivery,
  ExistingSessionDeliveryError,
  type ExistingSessionDeliveryDeps,
} from './botExistingSessionDelivery.js';

interface HostDeps extends Pick<ExistingSessionDeliveryDeps, 'withTargetLock' | 'prepare' | 'flush'> {
  getLiveSession(id: string): Session | undefined;
  restoreQueue(id: string): Promise<void>;
  getInputGeneration(id: string): number;
  assertInputCurrent(id: string, generation: number): void;
  findQueued(id: string, clientId: string): { message: string } | null;
  hasKnownInput(id: string, clientId: string): boolean;
}
const stale = () => new ExistingSessionDeliveryError('CONTEXT_CHANGED', 'The caller or target changed. Inspect the current Session before trying again.');

/** Uses only the active owner's database and an exact, Host-presented permission request. */
export function createDesktopBotExistingSessionDelivery(deps: HostDeps) {
  return createBotExistingSessionDelivery({
    ...deps,
    capture: async (input) => {
      const scope = activeOwnerScopeKey();
      const dbClient = getDbClient();
      const caller = deps.getLiveSession(input.callerSessionId);
      const permission = caller?.stablePermissionModeState;
      if (!caller || !permission) throw stale();
      const turn = caller.getTurnGeneration();
      const controller = new AbortController();
      const assertCaller = () => {
        if (controller.signal.aborted || !getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending() ||
            activeOwnerScopeKey() !== scope || getDbClient() !== dbClient ||
            deps.getLiveSession(input.callerSessionId) !== caller || caller.getTurnGeneration() !== turn ||
            !caller.isTurnRunning() || caller.getStatus() !== 'active' ||
            caller.stablePermissionModeState?.generation !== permission.generation) throw stale();
      };
      assertCaller();
      const read = async () => {
        assertCaller();
        const [owned] = await dbClient.drizzle.select({ botId: botSessionLinks.botId })
          .from(botSessionLinks).innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
          .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
          .where(and(eq(botSessionLinks.sessionId, input.callerSessionId), eq(botSessionLinks.role, 'canonical'),
            eq(sessions.source, 'bot'), eq(sessions.status, 'active'), eq(botProfiles.status, 'active'))).limit(1);
        assertCaller();
        if (!owned) throw new ExistingSessionDeliveryError('NOT_A_BOT_SESSION', 'The caller is not an active teammate main Session.');
        const [target] = await dbClient.drizzle.select({
          id: sessions.id, title: sessions.title, source: sessions.source, status: sessions.status,
          clearedAt: sessions.clearedAt, model: sessions.model, agentKind: sessions.agentKind,
          providerId: sessions.providerId, permissionMode: sessions.permissionMode,
          workingDir: sessions.workingDir, remoteHostId: sessions.remoteHostId,
          effort: sessions.effort, fastMode: sessions.fastMode,
          planModeEnabled: sessions.planModeEnabled,
        }).from(sessions)
          .where(eq(sessions.id, input.targetSessionId)).limit(1);
        assertCaller();
        if (!target || target.status !== 'active') throw new ExistingSessionDeliveryError('TARGET_UNAVAILABLE', 'The target is missing, archived or deleted. No replacement Session was created.');
        if (target.source === 'bot') throw new ExistingSessionDeliveryError('INVALID_TARGET', 'Use teammate messaging for a teammate main Session.');
        if (target.source === 'review') throw new ExistingSessionDeliveryError('INVALID_TARGET', 'Review Sessions do not accept external input. Send follow-up work to the original task instead.');
        return { owned, target };
      };
      const original = await read();
      const fingerprint = (row: typeof original) => JSON.stringify([
        row.owned.botId, row.target.id, row.target.title, row.target.source, row.target.status, row.target.clearedAt,
        row.target.model, row.target.agentKind, row.target.providerId, row.target.permissionMode,
        row.target.workingDir, row.target.remoteHostId, row.target.effort, row.target.fastMode, row.target.planModeEnabled,
      ]);
      await deps.restoreQueue(input.targetSessionId);
      assertCaller();
      const generation = deps.getInputGeneration(input.targetSessionId);
      const targetRuntime = deps.getLiveSession(input.targetSessionId);
      const targetPermission = targetRuntime?.stablePermissionModeState;
      if (targetRuntime && !targetPermission) throw stale();
      const assertCurrent = () => {
        assertCaller();
        deps.assertInputCurrent(input.targetSessionId, generation);
      };
      const validate = async () => {
        if (fingerprint(await read()) !== fingerprint(original)) throw stale();
        const live = deps.getLiveSession(input.targetSessionId);
        if (live !== targetRuntime || (live && live.stablePermissionModeState?.generation !== targetPermission?.generation)) throw stale();
        assertCurrent();
      };
      await validate();
      const unsubscribe = caller.onStatusChange(() => {
        try { assertCurrent(); } catch { controller.abort(); }
      });
      return {
        ownerScope: scope, assertCurrent, validate,
        dispose: () => { unsubscribe(); controller.abort(); },
        confirm: async () => {
          assertCurrent();
          const request: InteractionRequest = {
            kind: 'permission', requestId: randomUUID(), toolName: 'cindy.send_to_existing_session',
            title: t('botExistingSessionDelivery.title'),
            description: t('botExistingSessionDelivery.description'),
            input: {
              session_id: input.targetSessionId, title: original.target.title, message: input.message,
              execution_location: original.target.remoteHostId
                ? t('botExistingSessionDelivery.remoteTarget').replace('{{hostId}}', () => original.target.remoteHostId!)
                : t('botExistingSessionDelivery.localTarget'),
              remote_host_id: original.target.remoteHostId,
              working_directory: original.target.workingDir,
              model: original.target.model,
              agent_kind: original.target.agentKind,
              provider_id: original.target.providerId,
              permission_mode: original.target.permissionMode,
              plan_mode_enabled: original.target.planModeEnabled,
              effort: original.target.effort,
              fast_mode: original.target.fastMode,
            },
            metadata: { hostOwnedConfirmation: 'bot_existing_session_delivery' },
          };
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8 * 60_000)]);
          const decision = await caller.runHostInteraction(request, () => requestHostInteraction(caller, request, signal));
          await validate();
          // Approval applies only to the displayed target/message. Ignore updatedInput and persistent grants.
          return decision.kind === 'permission' && decision.behavior === 'allow';
        },
      };
    },
    readAccepted: async (id, clientId, callerSessionId) => {
      await deps.restoreQueue(id);
      const queued = deps.findQueued(id, clientId);
      if (queued) return queued;
      const [persisted] = await getDbClient().drizzle.select({ content: messages.content, agentMeta: messages.agentMeta })
        .from(messages).where(and(eq(messages.sessionId, id), eq(messages.clientId, clientId))).limit(1);
      if (persisted) {
        // Hooks may rewrite content. The Host-authored session origin retains the
        // authorization body in both queue snapshots and the pre-dispatch message row.
        if (persisted.agentMeta) {
          let meta;
          try { meta = JSON.parse(persisted.agentMeta); }
          catch { throw new ExistingSessionDeliveryError('DELIVERY_UNVERIFIED', 'The existing receipt metadata is unreadable. Keep the same delivery key.'); }
          const origin = meta?.origin;
          if (origin) {
            if (origin.kind !== 'session' || origin.senderSessionId !== callerSessionId || typeof origin.displayText !== 'string')
              throw new ExistingSessionDeliveryError('DELIVERY_UNVERIFIED', 'The existing receipt origin cannot be verified. Keep the same delivery key.');
            return { message: origin.displayText };
          }
        }
        return { message: persisted.content };
      }
      // The queue may have just completed/been removed before its transcript is queryable.
      // Never re-admit an ID whose previous outcome cannot be proven.
      if (deps.hasKnownInput(id, clientId)) throw new ExistingSessionDeliveryError('DELIVERY_UNVERIFIED', 'This delivery key is already known, but its message is not queryable. Do not use a new key to retry.');
      return null;
    },
  });
}
