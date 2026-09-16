import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botProfileVersions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { subscribeNewMakerDefaults } from '../maker-host/newMakerDefaultsCache.js';
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import { prepareBotInvitationAvatar, finishBotInvitationAvatar } from './botInvitationAvatar.js';
import { botInvitationProgress, type BotInvitationProgress } from '../../shared/botInvitation.js';
import { seedBotSkillIfMissing } from './botSkillStore.js';
import { ensureBotContentDirs, writeBotProfileFolder } from './botProfileFolder.js';
import {
  type BotInvitationDraft,
} from './botInvitationDraft.js';

/** The IPC owner supplies reverse calls; this worker never imports the IPC registry. */
export interface BotInvitationCallbacks {
  canStartWelcome?(config: Record<string, unknown>): Promise<boolean>;
  createCanonicalSession(input: {
    botId: string;
    expectedCanonicalSessionId: string | null;
    expectedProfileVersion: number;
  }): Promise<{ canonicalSessionId: string }>;
  broadcastProfileChanged(payload: { botId: string; change: 'updated' }): void;
}

interface Invitation extends BotInvitationProgress {
  id: string;
  locale: string;
  avatarRequested: boolean;
  draft?: BotInvitationDraft;
  avatarInvocationId?: string;
  avatarPrompt?: string;
}

type WelcomeDispatch = (input: {
  targetSessionId: string;
  message: string;
  persistedContent: string;
  clientId: string;
}) => Promise<{ ok: boolean }>;
let welcomeDispatch: WelcomeDispatch | undefined;
export function setBotInvitationWelcomeDispatch(dispatch: WelcomeDispatch): void {
  welcomeDispatch = dispatch;
  drainInvitations();
}

const log = createLogger('botInvitation');
type InvitationTask = () => Promise<void | 'waiting-for-model'>;
const pending = new Map<string, InvitationTask>();
const waitingForModel = new Map<string, InvitationTask>();
const running = new Set<string>();
const MAX_RUNNING = 2;
let modelRetryTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeDefaults: (() => void) | undefined;

function wakeModelWaiters(): void {
  clearTimeout(modelRetryTimer);
  modelRetryTimer = undefined;
  unsubscribeDefaults?.();
  unsubscribeDefaults = undefined;
  for (const [key, task] of waitingForModel) pending.set(key, task);
  waitingForModel.clear();
  drainInvitations();
}

function retainModelWaiter(key: string, task: InvitationTask): void {
  waitingForModel.set(key, task);
  unsubscribeDefaults ??= subscribeNewMakerDefaults(wakeModelWaiters);
  // Connections, visibility and harness readiness can change without a new default
  // mirror. Recheck only deferred jobs, without occupying a worker or calling AI.
  modelRetryTimer ??= setTimeout(wakeModelWaiters, 5000);
  modelRetryTimer.unref();
}

/** Main owns the queue. Closing a renderer never cancels preparation. */
export function queueBotInvitation(
  botId: string,
  callbacks: BotInvitationCallbacks,
  retry = false,
): void {
  if (isAppSessionBoundaryPending()) return;
  const owner = activeOwnerScopeKey();
  const userDataDir = ownerScopedUserDataPath();
  const client = getDbClient();
  const key = `${owner}:${botId}`;
  if (pending.has(key) || running.has(key) || waitingForModel.has(key)) return;
  const assertOwner = () => {
    if (
      isAppSessionBoundaryPending() ||
      activeOwnerScopeKey() !== owner ||
      getDbClient() !== client
    )
      throw new Error('INVITATION_OWNER_CHANGED');
  };
  pending.set(key, async () => {
    const db = client.drizzle;
    const load = async () => {
      assertOwner();
      const [profile] = await db
        .select()
        .from(botProfiles)
        .where(eq(botProfiles.id, botId))
        .limit(1);
      if (!profile || profile.status === 'archived' || profile.status === 'deleting')
        throw new Error('INVITATION_UNAVAILABLE');
      const [version] = await db
        .select()
        .from(botProfileVersions)
        .where(
          and(
            eq(botProfileVersions.botId, botId),
            eq(botProfileVersions.version, profile.currentVersion),
          ),
        )
        .limit(1);
      assertOwner();
      if (!version) throw new Error('INVITATION_UNAVAILABLE');
      const config = JSON.parse(version.capabilitiesJson) as Record<string, unknown>;
      const invitation = botInvitationProgress(config.invitation)
        ? (config.invitation as Invitation)
        : undefined;
      return { profile, version, config, invitation };
    };
    const first = await load();
    if (
      !first.invitation ||
      (first.invitation.stage === 'ready' && !(retry && first.invitation.avatarSkipped)) ||
      (first.invitation.stage === 'failed' && !retry)
    )
      return;
    const portraitOnly =
      first.invitation.stage === 'ready' ||
      (first.invitation.stage === 'avatar' && Boolean(first.profile.canonicalSessionId));
    const invitationId = first.invitation.id;
    const save = async (
      patch: Partial<Invitation>,
      identitySource?: string,
      avatar?: { url: string; hash: string },
    ) => {
      // Merge onto the current version: sidebar pin/read changes must not erase progress.
      // SQLite CAS rejects simultaneous edits; no unconditional stale-profile writes.
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await load();
        if (current.invitation?.id !== invitationId) throw new Error('INVITATION_REPLACED');
        const config = { ...current.config, invitation: { ...current.invitation, ...patch } };
        assertOwner();
        try {
          await client.tx('bots.updateProfile', {
            id: botId,
            expectedCurrentVersion: current.profile.currentVersion,
            identitySource: identitySource ?? current.version.identitySource,
            capabilitiesJson: JSON.stringify(config),
            profileContentChanged: true,
            now: Date.now(),
            ...(avatar && current.profile.avatar === first.profile.avatar
              ? {
                  avatar: avatar.url,
                  botAvatarRef: { id: randomUUID(), hash: avatar.hash, createdAt: Date.now() },
                }
              : {}),
          });
          assertOwner();
          callbacks.broadcastProfileChanged({ botId, change: 'updated' });
          return;
        } catch (error) {
          if (attempt === 2 || (error as { code?: string }).code !== 'PRECONDITION_FAILED')
            throw error;
        }
      }
    };
    try {
      let state = first.invitation;
      if (portraitOnly) {
        await save({ stage: 'avatar' });
        state = (await load()).invitation!;
      }
      if (state.stage === 'failed') {
        await save({ stage: 'skills' });
        state = (await load()).invitation!;
      }
      const draft = state.draft;
      // Old invitations already store their identity. Retired template ids must
      // never reconstruct or overwrite that identity on upgrade.
      if (state.stage === 'profile') await save({ stage: 'skills' });
      const identity = draft
        ? `${draft.background}\n\n${draft.conversationStyle}`
        : first.version.identitySource;
      // Resume from real artifacts, with no paid generation repeated after a successful checkpoint.
      state = (await load()).invitation!;
      if (state.stage === 'skills') {
        assertOwner();
        await ensureBotContentDirs(userDataDir, botId);
        assertOwner();
        if (draft)
          for (const skill of draft.skills) {
            assertOwner();
            await seedBotSkillIfMissing(userDataDir, botId, skill);
          }
        assertOwner();
        await writeBotProfileFolder(userDataDir, botId, { identitySource: identity });
        assertOwner();
        await save({ stage: 'avatar' }, identity);
      }
      state = (await load()).invitation!;
      if (state.stage === 'avatar') {
        let skipped = false;
        const avatarPrompt = draft?.avatarPrompt ?? state.avatarPrompt;
        if (state.avatarRequested && avatarPrompt) {
          try {
            let invocationId = state.avatarInvocationId;
            if (!invocationId) {
              invocationId = (await prepareBotInvitationAvatar(assertOwner)) ?? undefined;
              if (invocationId) await save({ avatarInvocationId: invocationId });
            }
            if (invocationId) {
              const avatar = await finishBotInvitationAvatar(
                invocationId,
                avatarPrompt,
                assertOwner,
                db,
              );
              assertOwner();
              await save({}, undefined, avatar);
            } else skipped = true;
          } catch {
            // Optional artwork never traps an otherwise prepared companion. A resumed
            // request reuses its saved Core invocation; Core alone owns paid-submit deduplication.
            assertOwner();
            skipped = true;
          }
        }
        await save({ stage: portraitOnly ? 'ready' : 'welcome', avatarSkipped: skipped });
      }
      if (portraitOnly) return;
      const current = await load();
      try {
        if (callbacks.canStartWelcome && !await callbacks.canStartWelcome(current.config)) {
          assertOwner();
          return 'waiting-for-model';
        }
      } catch (error) {
        assertOwner();
        if ((error as { code?: string }).code === 'MODEL_VISIBILITY_NOT_READY') return 'waiting-for-model';
        throw error;
      }
      assertOwner();
      const canonical = await callbacks.createCanonicalSession({
        botId,
        expectedCanonicalSessionId: current.profile.canonicalSessionId,
        expectedProfileVersion: current.profile.currentVersion,
      });
      assertOwner();
      if (!welcomeDispatch) throw new Error('INVITATION_RUNTIME_UNAVAILABLE');
      const message =
        'The user has just invited you. Start with a brief, natural first message in your own voice, using your current identity and memory. If you have met before, acknowledge that naturally. Do not quote a prepared introduction, list your setup, or start unrelated work.';
      const accepted = await welcomeDispatch({
        targetSessionId: canonical.canonicalSessionId,
        clientId: `bot-welcome:${botId}`,
        message,
        persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`,
      });
      if (!accepted.ok) throw new Error('INVITATION_WELCOME_NOT_ACCEPTED');
      assertOwner();
      // Draft skills are now real SKILL.md files; do not duplicate their bodies forever.
      await save({ stage: 'ready', draft: undefined });
    } catch (error) {
      log.warn('companion preparation paused', {
        botId,
        error: error instanceof Error ? error.name : typeof error,
      });
      await save({ stage: 'failed' }).catch(() => undefined);
    }
  });
  drainInvitations();
}

function drainInvitations(): void {
  // DB recovery can precede Maker IPC registration. Keep owner-bound work queued
  // until the real dispatcher exists, rather than persisting a false failure.
  if (!welcomeDispatch) return;
  while (running.size < MAX_RUNNING && pending.size) {
    const [key, task] = pending.entries().next().value!;
    pending.delete(key);
    running.add(key);
    let waiting = false;
    void task()
      .then(outcome => { waiting = outcome === 'waiting-for-model'; })
      .catch(() => undefined)
      .finally(() => {
        running.delete(key);
        if (waiting) retainModelWaiter(key, task);
        drainInvitations();
      });
  }
}
