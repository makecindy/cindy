import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botProfileVersions, messages } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { subscribeNewMakerDefaults } from '../maker-host/newMakerDefaultsCache.js';
import { resolveSystemLocale, type SupportedLocale } from '../../shared/locale.js';
import { type BotWelcomeContext } from '../../shared/botWelcomeContext.js';
import { prepareBotInvitationAvatar, finishBotInvitationAvatar } from './botInvitationAvatar.js';
import { botInvitationProgress, type BotInvitationProgress } from '../../shared/botInvitation.js';
import { botOpeningGreeting, type BotPackageOpening } from '../../shared/botMarket.js';
import { withStarterOptionList } from '../../shared/botStarterOptions.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { t } from '../i18n.desktop.js';
import { seedBotSkillIfMissing } from './botSkillStore.js';
import { ensureBotContentDirs, writeBotProfileFolder } from './botProfileFolder.js';
import {
  type BotInvitationDraft,
} from './botInvitationDraft.js';

/** The IPC owner supplies reverse calls; this worker never imports the IPC registry. */
export interface BotInvitationCallbacks {
  canStartWelcome?(config: Record<string, unknown>): Promise<boolean>;
  getUserName?(): string | null | undefined;
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
  welcomeContext?: BotWelcomeContext;
  welcomeClientId?: string;
  /** Bundled Market package opening; absent for every other invitation. */
  opening?: BotPackageOpening;
}

const log = createLogger('botInvitation');
type InvitationTask = () => Promise<void | 'waiting-for-model'>;
const pending = new Map<string, InvitationTask>();
const waitingForModel = new Map<string, InvitationTask>();
const running = new Set<string>();
const MAX_RUNNING = 2;
let modelRetryTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeDefaults: (() => void) | undefined;

const CJK_SPACED_LOCALES = new Set<SupportedLocale>([
  'zh-CN',
  'zh-TW',
  'zh-Hans-x-lzh',
  'zh-Hant-x-lzh',
]);
const HAN_CHAR = /\p{Script=Han}/u;
const ASCII_ALNUM = /[A-Za-z0-9]/;

function sanitizeGreetingName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Host-authored opening line for newly invited teammates.
 * Uses the invitation locale (12 supported UI locales, including classical Chinese),
 * greeting the signed-in user by display name when available and introducing the teammate's name.
 */
export function buildStaticBotGreeting(input: {
  botName: string;
  userName?: string | null;
  locale?: string | null;
}): string {
  const locale = resolveSystemLocale(input.locale);
  const name = sanitizeGreetingName(input.botName) || 'Cindy';
  const userName = sanitizeGreetingName(input.userName);
  const template = t(userName ? 'bots.welcome.withUser' : 'bots.welcome.generic', locale);
  const spaceCjkLatin = CJK_SPACED_LOCALES.has(locale);
  const vars: Record<string, string> = { name, userName };
  return template.replace(
    /\{\{(name|userName)\}\}/g,
    (match, key: string, offset: number, source: string) => {
      const value = vars[key] ?? '';
      if (!spaceCjkLatin || !value) return value;
      const prev = offset > 0 ? source[offset - 1]! : '';
      const next = source[offset + match.length] ?? '';
      const lead = prev && HAN_CHAR.test(prev) && ASCII_ALNUM.test(value[0]!) ? ' ' : '';
      const trail =
        next && HAN_CHAR.test(next) && ASCII_ALNUM.test(value[value.length - 1]!) ? ' ' : '';
      return `${lead}${value}${trail}`;
    },
  );
}

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
        if (callbacks.canStartWelcome && !(await callbacks.canStartWelcome(current.config))) {
          assertOwner();
          return 'waiting-for-model';
        }
      } catch (error) {
        assertOwner();
        if ((error as { code?: string }).code === 'MODEL_VISIBILITY_NOT_READY')
          return 'waiting-for-model';
        throw error;
      }
      assertOwner();
      const canonical = await callbacks.createCanonicalSession({
        botId,
        expectedCanonicalSessionId: current.profile.canonicalSessionId,
        expectedProfileVersion: current.profile.currentVersion,
      });
      assertOwner();
      // Host writes the opening directly as a normal teammate message — no companion-model
      // turn or auxiliary-model rewrite — unless the user has already spoken.
      const sessionId = canonical.canonicalSessionId;
      const userHasSpoken = async () =>
        (
          await db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
            .limit(1)
        ).length > 0;
      if (!(await userHasSpoken())) {
        assertOwner();
        const opening = current.invitation?.opening;
        const options = opening?.starterOptions ?? [];
        const text = opening
          ? withStarterOptionList(botOpeningGreeting(opening.welcome), options)
          : buildStaticBotGreeting({
              botName: current.profile.displayName,
              userName: callbacks.getUserName?.(),
              locale: current.invitation?.locale,
            });
        try {
          await createMessage(
            sessionId,
            {
              clientId: `bot-opening:${invitationId}`,
              role: 'assistant',
              content: text,
              agentKind: null,
              ...(options.length ? { agentMeta: { botStarterOptions: options } } : {}),
            },
            {
              broadcastOwnerScope: captureDataOwnerBroadcastScope(),
              requireNoUserMessage: true,
            },
          );
        } catch (error) {
          assertOwner();
          if ((error as { code?: string }).code !== 'MESSAGE_USER_ALREADY_SPOKE') {
            const count = (openingWriteFailures.get(invitationId) ?? 0) + 1;
            if (count >= OPENING_WRITE_ATTEMPTS) {
              openingWriteFailures.delete(invitationId);
              throw error;
            }
            // The chat already exists: re-queue on the 5s waiter for transient DB failures.
            openingWriteFailures.set(invitationId, count);
            log.warn('opening message not stored; retrying', {
              botId,
              count,
              errorName: error instanceof Error ? error.name : typeof error,
            });
            return 'waiting-for-model';
          }
        }
      }
      openingWriteFailures.delete(invitationId);
      assertOwner();
      // Draft skills are now real SKILL.md files; do not duplicate their bodies forever.
      await save({
        stage: 'ready',
        draft: undefined,
        welcomeContext: undefined,
        welcomeClientId: undefined,
        opening: undefined,
      });
    } catch (error) {
      openingWriteFailures.delete(invitationId);
      log.warn('companion preparation paused', {
        botId,
        error: error instanceof Error ? error.name : typeof error,
      });
      await save({ stage: 'failed' }).catch(() => undefined);
    }
  });
  drainInvitations();
}

/** Stored-write failures per invitation; the third one marks the invitation failed. */
const OPENING_WRITE_ATTEMPTS = 3;
const openingWriteFailures = new Map<string, number>();

function drainInvitations(): void {
  while (running.size < MAX_RUNNING && pending.size) {
    const [key, task] = pending.entries().next().value!;
    pending.delete(key);
    running.add(key);
    let waiting = false;
    void task()
      .then(outcome => {
        waiting = outcome === 'waiting-for-model';
      })
      .catch(() => undefined)
      .finally(() => {
        running.delete(key);
        if (waiting) retainModelWaiter(key, task);
        drainInvitations();
      });
  }
}
