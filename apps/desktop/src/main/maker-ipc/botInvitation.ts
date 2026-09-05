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
import { getMaker } from '../maker-host/index.js';
import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { prepareBotInvitationAvatar, finishBotInvitationAvatar } from './botInvitationAvatar.js';
import { botInvitationProgress, type BotInvitationProgress } from '../../shared/botInvitation.js';
import {
  BOT_TEMPLATE_PRESET_IDENTITIES,
  isBotTemplatePresetId,
} from '../../shared/botTemplatePreset.js';
import { seedBotTemplateSkills } from './botTemplateSkillSeed.js';
import { seedBotSkillIfMissing } from './botSkillStore.js';
import { ensureBotContentDirs, writeBotProfileFolder } from './botProfileFolder.js';
import {
  botInvitationPrompt,
  parseBotInvitationDraft,
  type BotInvitationDraft,
} from './botInvitationDraft.js';

/** The IPC owner supplies reverse calls; this worker never imports the IPC registry. */
export interface BotInvitationCallbacks {
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

const log = createLogger('botInvitation');
const pending = new Map<string, () => Promise<void>>();
const running = new Set<string>();
const MAX_RUNNING = 2;

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
  if (pending.has(key) || running.has(key)) return;
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
    const portraitOnly = first.invitation.stage === 'ready' ||
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
        await save({ stage: state.draft ? 'skills' : 'profile' });
        state = (await load()).invitation!;
      }
      const preset = isBotTemplatePresetId(first.config.templateId)
        ? first.config.templateId
        : null;
      let draft = state.draft;
      if (!preset && !draft && state.stage === 'profile') {
        assertOwner();
        const result = await requestUtilityText(
          getMaker(),
          botInvitationPrompt(first.profile.displayName, first.profile.description, state.locale),
          {
            maxTokens: 5500,
            timeoutMs: 90000,
            disableReasoning: true,
            signal: AbortSignal.timeout(100000),
            beforeDispatch: async () => {
              assertOwner();
              return true;
            },
          },
        );
        assertOwner();
        if (!result.ok) throw new Error('INVITATION_GENERATION_FAILED');
        draft = parseBotInvitationDraft(result.text);
        await save({ draft, avatarPrompt: draft.avatarPrompt, stage: 'skills' });
      } else if (state.stage === 'profile') await save({ stage: 'skills' });

      const presetVoice = state.locale.startsWith('zh')
        ? ({
            cindy:
              '性格与聊天习惯：亲切、好奇，愿意听人把话说完。日常回复通常两三句话，不把闲聊变成工作清单；写作或整理资料时再充分展开。',
            dash: '性格与聊天习惯：开朗坦率，有审美也有主见，喜欢聊产品背后的人。日常交流简短有来有往；认真讨论决策时才展开理由，不摆领导架子。',
            lizi: '性格与聊天习惯：耐心，爱钻研，带一点轻松的幽默。闲聊通常两三句话，用熟悉的例子解释难题；需要写代码或分析时再完整展开。',
          } as const)
        : ({
            cindy:
              'Personality and voice: warm, curious, an attentive listener. Keep everyday replies to a few natural sentences; expand for writing and research. Do not turn casual conversation into a checklist.',
            dash: 'Personality and voice: candid, curious and opinionated, interested in people behind products. Keep everyday conversation brief; expand reasoning for real decisions. Never condescend.',
            lizi: 'Personality and voice: patient, inventive and quietly humorous. A few natural sentences for everyday conversation; familiar examples for hard ideas, full detail for code and analysis.',
          } as const);
      const presetIdentity = preset
        ? BOT_TEMPLATE_PRESET_IDENTITIES[preset].replace(
            /^# 身份\n你是 (?:Cindy|Dash|LiZi)/,
            `# 身份\n你是 ${first.profile.displayName}`,
          )
        : first.version.identitySource;
      const identity = draft
        ? `${draft.background}\n\n${draft.conversationStyle}`
        : `${presetIdentity}\n\n${first.profile.description}\n\n${preset ? presetVoice[preset] : ''}`;
      // Resume from real artifacts, with no paid generation repeated after a successful checkpoint.
      state = (await load()).invitation!;
      if (state.stage === 'skills') {
        assertOwner();
        await ensureBotContentDirs(userDataDir, botId);
        assertOwner();
        if (preset) await seedBotTemplateSkills(userDataDir, botId, preset);
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
      const canonical = await callbacks.createCanonicalSession({
        botId,
        expectedCanonicalSessionId: current.profile.canonicalSessionId,
        expectedProfileVersion: current.profile.currentVersion,
      });
      assertOwner();
      await createMessage(canonical.canonicalSessionId, {
        clientId: `bot-welcome:${botId}`,
        role: 'assistant',
        content: draft?.greeting || first.profile.description || first.profile.displayName,
        agentKind: null,
      });
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
  while (running.size < MAX_RUNNING && pending.size) {
    const [key, task] = pending.entries().next().value!;
    pending.delete(key);
    running.add(key);
    void task()
      .catch(() => undefined)
      .finally(() => {
        running.delete(key);
        drainInvitations();
      });
  }
}
