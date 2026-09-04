/** Cindy Bots 的 main-side 权威数据边界。
 *
 * Bot profile / channel / Session 归属只在这里写入 SQLite；renderer 的
 * localStorage 只能作为旧版本迁移的临时来源，不能决定 canonical Session。
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { getDbClient, tryGetDbClient } from '../client/current';
import type {
  BotsReparentDelegationsResult,
  BotsReplaceCanonicalSessionResult,
} from '../client/tx/types.js';
import {
  botDelegations,
  botProfileVersions,
  botProfiles,
  botRuntimeSnapshots,
  botSessionLinks,
  messages,
  sessions,
} from '../schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import { requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { resolveBusinessSessionId } from '../../sessionIds.js';
import { ensureProjectGitInitialized } from '../../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import {
  readBotModelChainSettingsState,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../../maker-host/bot-model-chain-settings-store.js';
import { extractMessagePreview, sessionCreateToRow, sessionToCamel } from '../mapper.js';
import {
  botProfileContentChanged,
  mergeBotProfileCapabilities,
  normalizeBotProfileModelChain,
} from './botProfileVersioning.js';
import {
  botProfileDir,
  ensureBotWorkspaceDir,
  migrateBotProfileFolder,
  readBotProfileFolder,
  writeBotProfileFolder,
} from '../../maker-ipc/botProfileFolder.js';
import { syncBotProfileFromFolder } from '../../maker-ipc/botProfileFolderSync.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createLogger } from '../../logger.js';
import {
  NEW_BOT_DEFAULT_PI_EFFORT,
  NEW_BOT_DEFAULT_PI_MODEL,
  NEW_BOT_DEFAULT_PI_PROVIDER,
} from '../../../shared/botDefaults.js';
import { normalizeBotModelChain } from '../../../shared/botModelChain.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../../appSessionState.js';
import {
  isManagedBotAvatarUrl,
  isSupportedBotAvatarValue,
  portableBotAvatarOrFallback,
} from '../../../shared/botAvatarValue.js';
import { MAKER_PUSH } from '../../maker-ipc/channels.js';
import { writeBlob } from '../../cindy-media/blobStore.js';
import { recordBlob } from '../../cindy-media/ledger.js';
import { validateBotAvatarBuffer } from './botAvatarSelection.js';
import {
  inferBotTemplatePresetId,
  isBotTemplatePresetId,
} from '../../../shared/botTemplatePreset.js';
import { seedBotTemplateSkills } from '../../maker-ipc/botTemplateSkillSeed.js';
import { createMessage } from './messages.js';
import { BOT_DELEGATION_CLIENT_ID } from '../../../shared/botCollaboration.js';

const log = createLogger('bots');

/**
 * 把这份档案摊到伙伴自己的家(`<userData>/bots/<botId>/`)。
 *
 * 分工见 botProfileFolder.ts 的开头:**文件是当前值与编辑面**(用户拿编辑器改、
 * 伙伴自己用文件工具改都落这里),**`bot_profile_versions` 行是运行时的冻结快照**
 * (任务启动认版本号,整轮不变)。所以改完文件不会让进行中的对话当场变身,而是
 * 下一轮生效 —— 契约 9.3 节要的第三种状态。
 *
 * `userContextSource` 存在 capabilities 里,但它在磁盘上有自己的位置
 * (`memories/USER.md`,与 Hermes 同路径),所以这里拆出来单独写。
 *
 * 写文件失败**不让保存整个失败**:数据库那份才是运行时读的东西,文件只影响
 * 「能不能用编辑器改」。吞掉异常但记一笔,不静默。
 */
async function syncBotProfileFolder(
  botId: string,
  identitySource: string,
  config: Record<string, unknown>,
  userDataDir = ownerScopedUserDataPath(),
): Promise<void> {
  const { userContextSource } = config;
  try {
    await writeBotProfileFolder(userDataDir, botId, {
      identitySource,
      userContextSource: typeof userContextSource === 'string' ? userContextSource : '',
    });
  } catch (cause) {
    log.warn('write bot profile folder failed', { botId, error: String(cause) });
  }
}
import { buildDefaultBotIdentity } from '../../../shared/botProfileDefaults.js';
import { coordinateBotCanonicalReplacement } from '../../maker-ipc/botCanonicalReplacementCoordinator.js';
import { searchConversations } from '../conversationSearch.js';
import {
  BOT_FAILURE_REASONS,
  isBotFailureAttentionWorthy,
  type BotFailureReason,
} from '../../../shared/botFailureReason.js';

/** Sender of the latest visible message in a Bot's canonical chat. */
type BotChatRole = 'user' | 'assistant';

const MAX_TEXT = 4000;
/**
 * An avatar is either a single grapheme or a reserved `cindy://avatar/…` sentinel
 * that resolves to bundled artwork (see
 * `renderer/features/bots/botAvatarIdentity.ts`). The longest sentinel shipped
 * today is `cindy://avatar/preset/whitecat` (30 chars). Custom images are strict
 * `cindy-media://blobs/<sha>.<image-ext>` addresses produced by main; arbitrary
 * URLs, file paths and inline blobs remain outside this field's contract.
 */
const MAX_AVATAR_TEXT = 128;

function readBotAvatar(value: unknown, required = false): string {
  const avatar = readText(value, 'avatar', MAX_AVATAR_TEXT, required);
  if (!avatar && !required) return '';
  if (!isSupportedBotAvatarValue(avatar)) {
    throwIpcError('INVALID_PARAMS', 'avatar 只能是一个表情、内置角色或已上传图片');
  }
  return avatar;
}

export interface CreateBotCanonicalSessionInput {
  botId: string;
  expectedCanonicalSessionId: string | null;
  expectedProfileVersion: number;
  /** Repair a dangling profile pointer only; never renew a task that still exists. */
  recoverMissingOnly?: boolean;
}

type CreateBotCanonicalSessionResult = {
  created: boolean;
  canonicalSessionId: string;
  session: ReturnType<typeof sessionToCamel>;
};

type CanonicalLinkReconciliation = {
  status:
    | 'unchanged'
    | 'repaired-mirror'
    | 'migrated'
    | 'missing-pointer'
    | 'missing-session'
    | 'conflict';
  canonicalSessionId: string | null;
};

let createBotCanonicalSessionImpl:
  ((input: CreateBotCanonicalSessionInput) => Promise<CreateBotCanonicalSessionResult>) | null =
  null;

/** Main-side canonical creator shared by first creation, restore and missing-task repair. */
export async function createBotCanonicalSession(
  input: CreateBotCanonicalSessionInput,
): Promise<CreateBotCanonicalSessionResult> {
  if (!createBotCanonicalSessionImpl) {
    throwIpcError('PRECONDITION_FAILED', 'Bot 数据服务尚未初始化');
  }
  await recoverBotTemplateSkills(input.botId);
  return createBotCanonicalSessionImpl(input);
}

/**
 * Canonical identity is owned by bot_session_links(role=canonical). The
 * bot_profiles.canonical_session_id column is retained only as a compatibility
 * mirror while old databases are being brought forward.
 */
async function reconcileCanonicalLink(botId: string): Promise<CanonicalLinkReconciliation> {
  try {
    return await getDbClient().tx<CanonicalLinkReconciliation>('bots.reconcileCanonicalLink', {
      botId,
      now: Date.now(),
    });
  } catch (error) {
    // A failed reconciliation must never make us guess a Session. Consumers
    // treat this as a closed recovery state and surface health/repair UI.
    log.warn('canonical link reconciliation failed closed', { botId, error: String(error) });
    return { status: 'conflict', canonicalSessionId: null };
  }
}

/**
 * 把伙伴家里的文件收进数据库 —— 用户拿编辑器改完 SOUL.md、或者伙伴自己用文件
 * 工具改完自己的灵魂之后,由这里派生一个新版本。
 *
 * 派生而不是就地改:运行中的任务认版本号,**进行中的对话仍跑在旧版本上,下一轮
 * 才换过去**。就地改会让一个跑到一半的任务中途换身份。
 *
 * 挂在开新任务之前 —— 那正是「下一轮」的起点。整个过程失败不阻断开任务:最坏是
 * 这一轮还用旧身份,下一轮再收。
 */
export async function reconcileBotProfileFolder(botId: string): Promise<void> {
  const userDataDir = ownerScopedUserDataPath();
  const legacyUserDataDir = app.getPath('userData');
  const db = getDbClient().drizzle;
  try {
    await syncBotProfileFromFolder(botId, {
      readSnapshot: async (id) => {
        const [profile] = await db
          .select({ currentVersion: botProfiles.currentVersion })
          .from(botProfiles)
          .where(eq(botProfiles.id, id))
          .limit(1);
        if (!profile) return null;
        const [version] = await db
          .select()
          .from(botProfileVersions)
          .where(
            and(
              eq(botProfileVersions.botId, id),
              eq(botProfileVersions.version, profile.currentVersion),
            ),
          )
          .limit(1);
        if (!version) return null;
        return {
          identitySource: version.identitySource,
          config: parseJson(version.capabilitiesJson),
          currentVersion: profile.currentVersion,
        };
      },
      readFolder: (id) => readBotProfileFolder(userDataDir, id),
      // 播种顺带把技能从旧目录搬进来 —— 存量伙伴第一次走到这里时一并完成。
      seedFolder: async (id, seed) => {
        await migrateBotProfileFolder(userDataDir, id, seed, legacyUserDataDir);
      },
      deriveVersion: async (input) => {
        await getDbClient().tx('bots.updateProfile', {
          id: input.botId,
          identitySource: input.identitySource,
          capabilitiesJson: safeJson(input.config),
          profileContentChanged: true,
          expectedCurrentVersion: input.expectedCurrentVersion,
          now: Date.now(),
        });
      },
    });
  } catch (cause) {
    log.warn('reconcile bot profile folder failed', { botId, error: String(cause) });
  }
}

function botSessionAgentKind(config: { harness?: unknown }): 'cc' | 'codex' | 'pi' {
  return config.harness === 'codex' ? 'codex' : config.harness === 'pi' ? 'pi' : 'cc';
}

function defaultBotModelForConfig(config: Record<string, unknown>): string {
  return botSessionAgentKind(config) === 'pi' ? NEW_BOT_DEFAULT_PI_MODEL : 'claude-sonnet-4-6';
}

function botSessionPermissionMode(config: Record<string, unknown>): 'ask' | 'bypassPermissions' {
  return config.permissions === 'trusted' ? 'bypassPermissions' : 'ask';
}

function readText(value: unknown, field: string, max = MAX_TEXT, required = false): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throwIpcError('INVALID_PARAMS', `${field} 必须是字符串`);
  }
  const text = value.trim();
  if (required && !text) throwIpcError('INVALID_PARAMS', `${field} 不能为空`);
  if (text.length > max) throwIpcError('INVALID_PARAMS', `${field} 超过长度上限 ${max}`);
  return text;
}

/**
 * 角色性别。只收已知取值,别的一律当没给 —— 界面文案据它取「她 / 他」,
 * 收到脏值不如回落到「用名字称呼」(见 shared/botGender.ts)。
 */
function readBotGender(value: unknown): 'female' | 'male' | undefined {
  return value === 'female' || value === 'male' ? value : undefined;
}

function parseJson(value: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function normalizeBotModelCapabilitiesOrThrow(
  config: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return normalizeBotProfileModelChain(config);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      error instanceof Error ? error.message : 'Bot model chain is invalid',
    );
  }
}

/** How many candidate rows the preview query inspects (see below). */
const CANONICAL_PREVIEW_SCAN = 5;

/**
 * Latest visible message of a Bot's canonical chat, for the Bots list rows.
 *
 * Read-only projection, same visibility rules as the sidebar preview of an
 * ordinary task (`LATEST_MSG_CONTENT_SQL` in `ipc/sessions.ts`): only
 * user / assistant rows, no rewind-truncated rows, no hidden auto-resume
 * prompts, and nothing before the session's `/clear` boundary. One indexed
 * query per Bot on `idx_messages_session_created`, no join.
 *
 * A small window instead of `LIMIT 1`: `content` is a serialized structure, and
 * rows whose text cannot be extracted (attachment-only sends, synthetic UI
 * triggers) must be skipped rather than shown as an empty preview.
 */
async function readCanonicalChatPreview(
  db: ReturnType<typeof getDbClient>['drizzle'],
  canonicalSessionId: string | null,
  clearedAt: number | null,
): Promise<{ preview: string | null; createdAt: number | null; role: BotChatRole | null }> {
  if (!canonicalSessionId) return { preview: null, createdAt: null, role: null };
  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, canonicalSessionId),
        inArray(messages.role, ['user', 'assistant']),
        isNull(messages.rewindAt),
        sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
        ...(clearedAt !== null ? [gt(messages.createdAt, clearedAt)] : []),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(CANONICAL_PREVIEW_SCAN);
  for (const row of rows) {
    const preview = extractMessagePreview(row.content, row.role);
    if (preview) {
      return {
        preview,
        createdAt: row.createdAt ?? null,
        role: row.role === 'user' ? 'user' : 'assistant',
      };
    }
  }
  return { preview: null, createdAt: null, role: null };
}

/** Anything above this is rendered as `99+`, so counting further is wasted work. */
const CANONICAL_UNREAD_SCAN = 100;

/**
 * How many replies landed in a Bot's canonical chat after the user last read it.
 *
 * Read position is renderer state (see `features/bots/botReadState.ts`) and is
 * passed in per request — main never persists it, so this stays a pure read.
 * Only the Bot's own `assistant` output counts: the user's sends and internal
 * Bot-to-Bot conversation traces are never "unread". The remaining visibility
 * rules are exactly the preview's (no rewind-truncated rows, no hidden
 * auto-resume prompts, nothing before the `/clear` boundary). One indexed
 * range scan per Bot on `idx_messages_session_created`, capped at
 * `CANONICAL_UNREAD_SCAN` rows.
 */
async function countCanonicalUnread(
  db: ReturnType<typeof getDbClient>['drizzle'],
  canonicalSessionId: string | null,
  clearedAt: number | null,
  lastReadAt: number | null,
): Promise<number> {
  if (!canonicalSessionId || lastReadAt === null) return 0;
  const boundary = clearedAt !== null ? Math.max(clearedAt, lastReadAt) : lastReadAt;
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, canonicalSessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
        sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
        sql`(${messages.agentMeta} IS NULL OR json_type(${messages.agentMeta}, '$.botDirectMessage') IS NULL)`,
        gt(messages.createdAt, boundary),
      ),
    )
    .limit(CANONICAL_UNREAD_SCAN);
  return rows.length;
}

async function readProfile(
  db: ReturnType<typeof getDbClient>['drizzle'],
  botId: string,
  /** Renderer-owned read position for this Bot; omitted ⇒ no unread accounting. */
  lastReadAt: number | null = null,
) {
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  const canonicalResolution = await reconcileCanonicalLink(botId);
  const canonicalSessionId = canonicalResolution.canonicalSessionId;
  const links = await db
    .select()
    .from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId))
    .orderBy(desc(botSessionLinks.createdAt));
  const sessionRows = links.length
    ? await db
        .select()
        .from(sessions)
        .where(
          inArray(
            sessions.id,
            links.map((link) => link.sessionId),
          ),
        )
    : [];
  const byId = new Map(sessionRows.map((row) => [row.id, row]));
  const runtimeRows = links.length
    ? await db
        .select()
        .from(botRuntimeSnapshots)
        .where(
          inArray(
            botRuntimeSnapshots.sessionId,
            links.map((link) => link.sessionId),
          ),
        )
        .orderBy(desc(botRuntimeSnapshots.preparedAt), desc(botRuntimeSnapshots.appliedAt))
    : [];
  const runtimeBySession = new Map<string, (typeof runtimeRows)[number]>();
  for (const row of runtimeRows) {
    if (!runtimeBySession.has(row.sessionId)) runtimeBySession.set(row.sessionId, row);
  }
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
  const canonicalClearedAt = byId.get(canonicalSessionId ?? '')?.clearedAt ?? null;
  const latestMessage = await readCanonicalChatPreview(db, canonicalSessionId, canonicalClearedAt);
  const unreadCount = await countCanonicalUnread(
    db,
    canonicalSessionId,
    canonicalClearedAt,
    lastReadAt,
  );
  const config = parseJson(version?.capabilitiesJson ?? '{}');
  const modelChain = readEffectiveBotModelChain(config);
  const primaryModelRoute = modelChain[0];
  const failureReason = BOT_FAILURE_REASONS.includes(profile.attentionReason as BotFailureReason)
    ? (profile.attentionReason as BotFailureReason)
    : null;
  const needsAttention =
    profile.attentionAt !== null &&
    failureReason !== null &&
    isBotFailureAttentionWorthy(failureReason);
  return {
    id: profile.id,
    name: profile.displayName,
    description: profile.description,
    identitySource: version?.identitySource ?? '',
    userContextSource: typeof config.userContextSource === 'string' ? config.userContextSource : '',
    // 与 userContextSource 同款:存在档案 JSON 里,投影成顶层字段。老档案没有这
    // 个键 → undefined → 界面回落「用名字称呼」,与升级前行为一致。
    ...(readBotGender(config.gender) ? { gender: readBotGender(config.gender) } : {}),
    avatar: profile.avatar,
    avatarColor: profile.avatarColor,
    enabled: profile.status === 'active',
    hiddenAt: profile.hiddenAt,
    pinnedAt: profile.pinnedAt,
    failureReason,
    needsAttention,
    status: profile.status,
    currentVersion: profile.currentVersion,
    canonicalSessionId: canonicalSessionId ?? undefined,
    /*
      伙伴的家在磁盘上的位置。文件夹化的全部用户价值就是「能用编辑器改、能备份、
      能复制一份」—— 而在这之前界面上没有一处告诉用户它在哪。

      Hermes 不需要这个:它是命令行,用户本来就站在文件系统里(`~/.hermes/profiles/<名字>/`,
      见 bot-mode.md 的 CLI parity 表)。Cindy 是桌面应用,不给入口就等于没有。
      这一条是 Cindy 自己的产品判断,不是抄来的。
    */
    homeDir: botProfileDir(ownerScopedUserDataPath(), profile.id),
    lastMessagePreview: latestMessage.preview,
    lastMessageAt: latestMessage.createdAt,
    lastMessageRole: latestMessage.role,
    unreadCount,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    skills: Array.isArray(config.skills)
      ? config.skills.filter((item): item is string => typeof item === 'string')
      : [],
    capabilities: {
      model:
        primaryModelRoute?.model ??
        (typeof config.model === 'string' ? config.model : 'claude-sonnet-4-6'),
      // Renderer treats this as the source-of-truth marker: null means the
      // concrete model above is only a resolved cache and must follow the
      // current Gateway/Catalog default.
      modelOverride:
        config.modelOverride && typeof config.modelOverride === 'object'
          ? config.modelOverride
          : null,
      providerId:
        primaryModelRoute?.providerId ??
        (typeof config.providerId === 'string'
          ? config.providerId
          : config.providerId === null
            ? null
            : undefined),
      effort: primaryModelRoute?.effort ?? (typeof config.effort === 'string' ? config.effort : ''),
      fastMode: primaryModelRoute?.fastMode ?? config.fastMode === true,
      harness:
        primaryModelRoute?.harness ??
        (config.harness === 'codex' || config.harness === 'pi' ? config.harness : 'claude'),
      modelChain,
      modelChainOverride: Array.isArray(config.modelChainOverride)
        ? normalizeBotModelChain(config.modelChainOverride)
        : null,
      skillMode: config.skillMode === 'allowlist' ? 'allowlist' : 'inherit',
      // 跟随全局时被单独关掉的那几项(见 botProfileRuntime 的 excludedSkills)。
      skillsExcluded: Array.isArray(config.skillsExcluded)
        ? config.skillsExcluded.filter((item): item is string => typeof item === 'string')
        : [],
      toolsetMode: 'allowlist',
      toolsets: Array.isArray(config.toolsets)
        ? config.toolsets.filter((item): item is string => typeof item === 'string')
        : [],
      mcpMode: 'allowlist',
      mcpServers: Array.isArray(config.mcpServers)
        ? config.mcpServers.filter((item): item is string => typeof item === 'string')
        : [],
      memory: config.memory !== false,
      permissions: config.permissions === 'trusted' ? 'trusted' : 'ask',
    },
    sessions: links.flatMap((link) => {
      const row = byId.get(link.sessionId);
      if (!row) return [];
      return [
        {
          id: row.id,
          title: row.title,
          kind:
            link.role === 'canonical' ? 'chat' : link.role === 'delegation' ? 'worker' : 'history',
          updatedAt: row.updatedAt,
          status: row.status,
          role: link.role,
          profileVersion: link.profileVersion,
          runtimeSnapshot: runtimeBySession.has(row.id)
            ? (() => {
                const runtime = runtimeBySession.get(row.id)!;
                return {
                  profileVersion: runtime.profileVersion,
                  agentKind: runtime.agentKind,
                  status: runtime.status,
                  preparedAt: runtime.preparedAt || runtime.appliedAt || 0,
                  appliedAt: runtime.appliedAt ?? undefined,
                  failedAt: runtime.failedAt ?? undefined,
                  failure: runtime.failureJson ? parseJson(runtime.failureJson) : undefined,
                  configured: parseJson(runtime.configuredJson),
                  resolved: parseJson(runtime.resolvedJson),
                };
              })()
            : undefined,
        },
      ];
    }),
  };
}

/**
 * Device-link only needs enough Bot metadata to render the Mobile directory and
 * open the canonical task. Keep this projection main-side so profile prompts,
 * channel credentials, project paths and runtime state never cross the wire.
 */
async function readRemoteBotProfile(db: ReturnType<typeof getDbClient>['drizzle'], botId: string) {
  const [profile] = await db
    .select({
      id: botProfiles.id,
      name: botProfiles.displayName,
      description: botProfiles.description,
      avatar: botProfiles.avatar,
      avatarColor: botProfiles.avatarColor,
      status: botProfiles.status,
      currentVersion: botProfiles.currentVersion,
      canonicalSessionId: botProfiles.canonicalSessionId,
    })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  const canonicalResolution = await reconcileCanonicalLink(botId);
  return {
    ...profile,
    canonicalSessionId: canonicalResolution.canonicalSessionId ?? undefined,
  };
}

/** Upper bound on how many Bot read positions one list call may carry. */
const MAX_READ_STATE_ENTRIES = 500;

/**
 * Parse the optional `{ lastReadAtByBotId }` body of `local-db:bots:list`.
 *
 * Hostile or stale renderer input must never break the Bots list, so anything
 * unparseable is dropped silently instead of failing the whole projection.
 */
function readLastReadAtMap(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const value = (raw as { lastReadAtByBotId?: unknown }).lastReadAtByBotId;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [botId, at] of Object.entries(value as Record<string, unknown>)) {
    if (out.size >= MAX_READ_STATE_ENTRIES) break;
    if (!botId || botId.length > 128) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    out.set(botId, Math.floor(at));
  }
  return out;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function defaultNewBotCapabilities(): Record<string, unknown> {
  let modelChain = readEffectiveBotModelChain({
    modelChainOverride: null,
    modelOverride: null,
  });
  const primary = modelChain[0] ?? {
    harness: 'pi' as const,
    model: NEW_BOT_DEFAULT_PI_MODEL,
    providerId: NEW_BOT_DEFAULT_PI_PROVIDER,
    effort: NEW_BOT_DEFAULT_PI_EFFORT,
    fastMode: false,
  };
  if (modelChain.length === 0) modelChain = [primary];
  return {
    ...primary,
    modelOverride: null,
    modelChain,
    modelChainOverride: null,
    skillMode: 'allowlist',
    skillsExcluded: [],
    toolsetMode: 'allowlist',
    toolsets: [],
    mcpMode: 'allowlist',
    mcpServers: [],
    memory: true,
    permissions: 'trusted',
  };
}

function broadcastBotProfileChanged(payload: {
  botId: string;
  change: 'created' | 'updated';
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_PROFILE_CHANGED, payload);
    } catch (error) {
      log.warn('Bot profile broadcast failed', { error: String(error) });
    }
  }
}

/**
 * 模板来源跟着 Profile 持久化。初次落盘若遇到短暂文件错误，伙伴第一次开任务
 * 或后续被唤醒时会再次补装；已存在的用户版本由 seedBotSkillIfMissing 保留。
 */
async function recoverBotTemplateSkills(botId: string): Promise<void> {
  if (isAppSessionBoundaryPending()) return;
  const ownerScopeKey = activeOwnerScopeKey();
  const userDataDir = ownerScopedUserDataPath();
  const db = getDbClient().drizzle;
  try {
    const [profile] = await db
      .select({ currentVersion: botProfiles.currentVersion, status: botProfiles.status })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (
      !profile ||
      profile.status === 'archived' ||
      isAppSessionBoundaryPending() ||
      activeOwnerScopeKey() !== ownerScopeKey
    )
      return;
    const [version] = await db
      .select({
        capabilitiesJson: botProfileVersions.capabilitiesJson,
        identitySource: botProfileVersions.identitySource,
      })
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, botId),
          eq(botProfileVersions.version, profile.currentVersion),
        ),
      )
      .limit(1);
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey) return;
    const storedTemplateId = parseJson(version?.capabilitiesJson ?? '{}').templateId;
    const templateId = isBotTemplatePresetId(storedTemplateId)
      ? storedTemplateId
      : inferBotTemplatePresetId(version?.identitySource ?? '');
    if (!templateId) return;
    const seeded = await seedBotTemplateSkills(userDataDir, botId, templateId);
    if (!seeded.completedNow) return;
    const [canonical] = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(
        and(
          eq(botSessionLinks.botId, botId),
          eq(botSessionLinks.role, 'canonical'),
          isNull(botSessionLinks.archivedAt),
        ),
      )
      .limit(1);
    if (canonical && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerScopeKey) {
      requestBotRuntimeEpochRefresh(canonical.sessionId, 'resource');
    }
  } catch (cause) {
    log.warn('recover bot template skills failed', {
      botId,
      error: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}

export async function recoverActiveBotTemplateSkills(): Promise<void> {
  if (isAppSessionBoundaryPending()) return;
  const client = tryGetDbClient();
  if (!client) return;
  try {
    const profiles = await client.drizzle
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(ne(botProfiles.status, 'archived'));
    await Promise.all(profiles.map(({ id }) => recoverBotTemplateSkills(id)));
  } catch (cause) {
    log.warn('recover active bot template skills failed', {
      error: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}

/** Main-owned creation path shared by the renderer and Bot runtime tools. */
export async function createBotProfile(raw: unknown) {
  const body =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = readText(body.name ?? body.displayName, 'name', 200, true);
  const description = readText(body.description, 'description');
  const id =
    readText(body.id, 'id', 128) || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestedAvatar = readBotAvatar(body.avatar) || '🤖';
  // Creation has no prior main-owned upload receipt. Never let a renderer or
  // model mint a managed-media address by string alone.
  const avatar = portableBotAvatarOrFallback(requestedAvatar);
  const avatarColor = readText(body.avatarColor, 'avatarColor', 32) || 'violet';
  const identitySource =
    readText(body.identitySource, 'identitySource', 12000) || buildDefaultBotIdentity(name);
  const skills = Array.isArray(body.skills)
    ? body.skills.filter((item): item is string => typeof item === 'string').slice(0, 100)
    : [];
  const welcomeMessage = readText(body.welcomeMessage, 'welcomeMessage');
  const hasRequestedCapabilities =
    body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities);
  const requestedCapabilities = hasRequestedCapabilities
    ? (body.capabilities as Record<string, unknown>)
    : {};
  const userContextSource = readText(body.userContextSource, 'userContextSource', 12000);
  const gender = readBotGender(body.gender);
  const templateId = body.templateId;
  if (templateId !== undefined && !isBotTemplatePresetId(templateId)) {
    throwIpcError('INVALID_PARAMS', '未知的伙伴模板');
  }
  const creationOwnerBoundary = {
    scopeKey: activeOwnerScopeKey(),
    userDataDir: ownerScopedUserDataPath(),
  };
  const assertCreationOwnerStillCurrent = () => {
    if (
      isAppSessionBoundaryPending() ||
      activeOwnerScopeKey() !== creationOwnerBoundary.scopeKey
    ) {
      throwIpcError('PRECONDITION_FAILED', '账号已切换，请在当前账号重新创建伙伴');
    }
  };
  if (isAppSessionBoundaryPending()) {
    throwIpcError('PRECONDITION_FAILED', '账号正在切换，请稍后重试');
  }
  const persistedCapabilities = normalizeBotModelCapabilitiesOrThrow({
    ...(hasRequestedCapabilities ? {} : defaultNewBotCapabilities()),
    ...requestedCapabilities,
    skills,
    userContextSource,
    ...(gender ? { gender } : {}),
  });
  if (templateId) persistedCapabilities.templateId = templateId;
  const now = Date.now();
  const client = getDbClient();
  const db = client.drizzle;
  await client.tx('bots.createProfile', {
    id,
    displayName: name,
    description,
    avatar,
    avatarColor,
    identitySource,
    capabilitiesJson: safeJson(persistedCapabilities),
    now,
  });
  assertCreationOwnerStillCurrent();
  await syncBotProfileFolder(
    id,
    identitySource,
    persistedCapabilities,
    creationOwnerBoundary.userDataDir,
  );
  assertCreationOwnerStillCurrent();
  if (templateId) {
    try {
      await seedBotTemplateSkills(creationOwnerBoundary.userDataDir, id, templateId);
    } catch (cause) {
      // Profile 已经是数据库里的权威记录；辅助 Skill 安装失败不能制造一个半创建、
      // 下次也无法恢复的幽灵伙伴。身份正文仍保留完整工作约束，错误留给日志诊断。
      log.warn('seed bot template skills failed', {
        botId: id,
        templateId,
        error: cause instanceof Error ? cause.name : typeof cause,
      });
    }
    assertCreationOwnerStillCurrent();
  }
  let profile = await readProfile(db, id);
  if (welcomeMessage) {
    try {
      const canonical = await createBotCanonicalSession({
        botId: id,
        expectedCanonicalSessionId: null,
        expectedProfileVersion: profile.currentVersion,
      });
      await createMessage(canonical.canonicalSessionId, {
        clientId: `bot-welcome:${id}`,
        role: 'assistant',
        content: welcomeMessage,
        agentKind: null,
      });
      profile = await readProfile(db, id);
    } catch (cause) {
      // The profile remains valid and can still be opened; canonical recovery is
      // idempotent and the failure is diagnosable instead of creating a second Bot.
      log.warn('persist initial Bot welcome failed', {
        botId: id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  assertCreationOwnerStillCurrent();
  broadcastBotProfileChanged({ botId: id, change: 'created' });
  return profile;
}

export function registerBotIpc(): void {
  ipcMain.handle('local-db:bots:model-chain-settings-get', async (event) => {
    assertTrustedAppRendererEvent(event);
    const state = readBotModelChainSettingsState();
    return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
  });

  ipcMain.handle('local-db:bots:model-chain-settings-set', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const state = await writeBotModelChainSettings(body.modelChain);
    return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
  });

  ipcMain.handle('local-db:bots:list', async (event, raw: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const client = tryGetDbClient();
    if (!client) return [];
    const db = client.drizzle;
    // Unread accounting is opt-in: the read position lives in the renderer, so
    // a caller that has none (device-link, first boot) simply gets zeros.
    const lastReadAtByBotId = remote ? new Map<string, number>() : readLastReadAtMap(raw);
    const profiles = await db
      .select({ id: botProfiles.id, status: botProfiles.status })
      .from(botProfiles)
      .orderBy(desc(botProfiles.updatedAt));
    // 旧版创建的内置伙伴没有 templateId。打开伙伴列表时按未修改的内置身份
    // 精确识别并补装能力，让升级后无需删除重建；远端读取不触碰本机文件。
    if (!remote) {
      await Promise.all(
        profiles
          .filter(({ status }) => status !== 'archived')
          .map(({ id }) => recoverBotTemplateSkills(id)),
      );
    }
    return Promise.all(
      profiles.map(({ id }) =>
        remote
          ? readRemoteBotProfile(db, id)
          : readProfile(db, id, lastReadAtByBotId.get(id) ?? null),
      ),
    );
  });

  ipcMain.handle('local-db:bots:get', async (event, rawId: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const db = getDbClient().drizzle;
    const botId = requireString(rawId, 'botId');
    if (!remote) await recoverBotTemplateSkills(botId);
    return remote ? readRemoteBotProfile(db, botId) : readProfile(db, botId);
  });

  ipcMain.handle('local-db:bots:choose-avatar', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const client = getDbClient();
    const db = client.drizzle;
    const [initial] = await db
      .select({ status: botProfiles.status })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!initial) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (initial.status === 'archived') {
      throwIpcError('PRECONDITION_FAILED', '已停止的 Bot 不能修改头像');
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    };
    const selection = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true };

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(selection.filePaths[0]);
    } catch {
      throwIpcError('INVALID_PARAMS', '头像文件无法读取');
    }
    const mimeType = validateBotAvatarBuffer(buffer);

    const [current] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!current) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (current.status === 'archived') {
      throwIpcError('PRECONDITION_FAILED', '已停止的 Bot 不能修改头像');
    }
    const [version] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, botId),
          eq(botProfileVersions.version, current.currentVersion),
        ),
      )
      .limit(1);
    if (!version) throwIpcError('PRECONDITION_FAILED', 'Bot Profile 版本不存在');

    // The file bytes are published first, then the profile address and durable
    // reference move together in one SQLite transaction. If the transaction
    // loses a race, the unreferenced content-addressed blob is recycler-safe.
    const written = await writeBlob({ buffer, mimeType });
    await recordBlob(
      {
        hash: written.hash,
        ext: written.ext,
        mimeType: written.mimeType,
        bytes: written.bytes,
        isCache: false,
      },
      db,
    );
    const now = Date.now();
    await client.tx('bots.updateProfile', {
      id: botId,
      avatar: written.url,
      identitySource: version.identitySource,
      capabilitiesJson: version.capabilitiesJson,
      profileContentChanged: false,
      expectedCurrentVersion: current.currentVersion,
      botAvatarRef: { id: randomUUID(), hash: written.hash, createdAt: now },
      now,
    });
    const profile = await readProfile(db, botId);
    broadcastBotProfileChanged({ botId, change: 'updated' });
    return { canceled: false, profile };
  });

  ipcMain.handle('local-db:bots:search-history', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const query = readText(body.query, 'query', 500, true);
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.max(1, Math.min(50, Math.floor(body.limit)))
        : 20;
    const db = getDbClient().drizzle;
    const [profile] = await db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    const links = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, botId));
    return searchConversations(
      {
        query,
        limit,
        semanticMode: 'hybrid',
        filters: {
          status: 'all',
          sessionIds: links.map((row) => row.sessionId),
        },
      },
      // The Bot-owned Session id set above is authoritative. Passing null here
      // allows migrated IM history to retain its original source while keeping
      // the renderer unable to widen the search scope.
      { sessionSources: null },
    );
  });

  ipcMain.handle('local-db:bots:create', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return createBotProfile(raw);
  });

  ipcMain.handle('local-db:bots:update', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const id = readText(body.id, 'botId', 128, true);
    const client = getDbClient();
    const db = client.drizzle;
    const [current] = await db.select().from(botProfiles).where(eq(botProfiles.id, id)).limit(1);
    if (!current) throwIpcError('NOT_FOUND', 'Bot 不存在');
    const now = Date.now();
    const patch: Partial<typeof botProfiles.$inferInsert> = { updatedAt: now };
    if (body.name !== undefined || body.displayName !== undefined)
      patch.displayName = readText(body.name ?? body.displayName, 'name', 200, true);
    if (body.description !== undefined)
      patch.description = readText(body.description, 'description');

    const expectedAvatar =
      body.avatar !== undefined && body.expectedAvatar !== undefined
        ? readBotAvatar(body.expectedAvatar, true)
        : current.avatar;
    if (body.avatar !== undefined) {
      const nextAvatar = readBotAvatar(body.avatar, true);
      if (isManagedBotAvatarUrl(nextAvatar) && nextAvatar !== current.avatar) {
        throwIpcError('INVALID_PARAMS', '请通过头像选择器上传图片');
      }
      // A delayed full-form autosave must not roll back an avatar that won in
      // another window. An idempotent echo of the winner remains harmless.
      if (expectedAvatar === current.avatar || nextAvatar === current.avatar) {
        patch.avatar = nextAvatar;
      }
    }
    if (body.avatarColor !== undefined)
      patch.avatarColor = readText(body.avatarColor, 'avatarColor', 32, true);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean')
        throwIpcError('INVALID_PARAMS', 'enabled 必须是 boolean');
      patch.status = body.enabled ? 'active' : 'paused';
    }
    const hiddenAt =
      body.hidden === undefined
        ? undefined
        : body.hidden === true
          ? now
          : body.hidden === false
            ? null
            : throwIpcError('INVALID_PARAMS', 'hidden 必须是 boolean');
    const pinnedAt =
      body.pinned === undefined
        ? undefined
        : body.pinned === true
          ? now
          : body.pinned === false
            ? null
            : throwIpcError('INVALID_PARAMS', 'pinned 必须是 boolean');
    const [version] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, id),
          eq(botProfileVersions.version, current.currentVersion),
        ),
      )
      .limit(1);
    const previous = parseJson(version?.capabilitiesJson ?? '{}');
    const nextConfig = mergeBotProfileCapabilities({
      previous,
      capabilities:
        body.capabilities &&
        typeof body.capabilities === 'object' &&
        !Array.isArray(body.capabilities)
          ? (body.capabilities as Record<string, unknown>)
          : undefined,
      skills: body.skills,
      hasSkills: Object.prototype.hasOwnProperty.call(body, 'skills'),
    });
    if (Object.prototype.hasOwnProperty.call(body, 'userContextSource')) {
      nextConfig.userContextSource = readText(body.userContextSource, 'userContextSource', 12000);
    }
    // 没显式传就保持原值(mergeBotProfileCapabilities 已经把 previous 整份带过来了),
    // 显式传脏值则清掉 —— 与 readBotGender 的口径一致。
    if (Object.prototype.hasOwnProperty.call(body, 'gender')) {
      const nextGender = readBotGender(body.gender);
      if (nextGender) nextConfig.gender = nextGender;
      else delete nextConfig.gender;
    }
    const normalizedNextConfig = normalizeBotModelCapabilitiesOrThrow(nextConfig);
    const nextIdentitySource =
      body.identitySource !== undefined
        ? readText(body.identitySource, 'identitySource', 12000) ||
          buildDefaultBotIdentity(patch.displayName ?? current.displayName)
        : (version?.identitySource ?? '');
    const profileContentChanged = botProfileContentChanged({
      previousCapabilities: previous,
      nextCapabilities: normalizedNextConfig,
      previousIdentitySource: version?.identitySource ?? '',
      nextIdentitySource,
    });
    await client.tx('bots.updateProfile', {
      id,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
      ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(hiddenAt !== undefined ? { hiddenAt } : {}),
      ...(pinnedAt !== undefined ? { pinnedAt } : {}),
      identitySource: nextIdentitySource,
      capabilitiesJson: safeJson(normalizedNextConfig),
      profileContentChanged,
      expectedCurrentVersion: current.currentVersion,
      clearBotAvatarRefs:
        patch.avatar !== undefined &&
        isManagedBotAvatarUrl(current.avatar) &&
        !isManagedBotAvatarUrl(patch.avatar),
      now,
    });
    await syncBotProfileFolder(id, nextIdentitySource, normalizedNextConfig);
    if (profileContentChanged) {
      const [canonical] = await db
        .select({ sessionId: botSessionLinks.sessionId })
        .from(botSessionLinks)
        .where(
          and(
            eq(botSessionLinks.botId, id),
            eq(botSessionLinks.role, 'canonical'),
            isNull(botSessionLinks.archivedAt),
          ),
        )
        .limit(1);
      if (canonical) requestBotRuntimeEpochRefresh(canonical.sessionId, 'profile');
    }
    return readProfile(db, id);
  });

  const createBotCanonicalSessionUnlocked = async (
    input: CreateBotCanonicalSessionInput,
  ): Promise<CreateBotCanonicalSessionResult> => {
    const botId = readText(input.botId, 'botId', 128, true);
    const expectedCanonicalSessionId = input.expectedCanonicalSessionId;
    if (!Number.isInteger(input.expectedProfileVersion) || input.expectedProfileVersion < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    const expectedProfileVersion = input.expectedProfileVersion;
    const db = getDbClient().drizzle;
    const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (profile.status !== 'active' && profile.status !== 'paused') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const canonicalResolution = await reconcileCanonicalLink(botId);
    const authoritativeCanonicalSessionId = canonicalResolution.canonicalSessionId;
    const recoverableCompatibilityMirror =
      input.recoverMissingOnly === true &&
      canonicalResolution.status === 'missing-session' &&
      profile.canonicalSessionId === expectedCanonicalSessionId;
    if (input.recoverMissingOnly) {
      if (
        !expectedCanonicalSessionId ||
        (authoritativeCanonicalSessionId !== expectedCanonicalSessionId &&
          !recoverableCompatibilityMirror)
      ) {
        throwIpcError('PRECONDITION_FAILED', 'Bot 主任务已变化，请刷新后重试');
      }
      const [existingCanonical] = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, expectedCanonicalSessionId))
        .limit(1);
      if (existingCanonical && existingCanonical.status !== 'deleted') {
        throwIpcError('PRECONDITION_FAILED', 'Bot 主任务仍然存在，不能按丢失任务恢复');
      }
    }
    const [profileVersion] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, botId),
          eq(botProfileVersions.version, profile.currentVersion),
        ),
      )
      .limit(1);
    if (!profileVersion) throwIpcError('PRECONDITION_FAILED', 'Bot 当前 Profile 版本不存在');

    // Ensure the Profile-owned workspace before opening the SQLite write
    // transaction. It survives every Session generation and every lost CAS.
    const now = Date.now();
    const sessionId = resolveBusinessSessionId(undefined);
    const config = parseJson(profileVersion.capabilitiesJson);
    const primaryRoute = readEffectiveBotModelChain(config)[0] ?? null;
    const workspaceKind = 'dialogue' as const;
    const workingDir = await ensureBotWorkspaceDir(
      ownerScopedUserDataPath(),
      botId,
      app.getPath('userData'),
    );
    const insertRow = {
      ...sessionCreateToRow(
        sessionId,
        {
          workspaceKind,
          workingDir,
          model:
            primaryRoute?.model ??
            (typeof config.model === 'string'
              ? config.model.trim()
              : defaultBotModelForConfig(config)),
          providerId:
            primaryRoute?.providerId ??
            (typeof config.providerId === 'string' && config.providerId.trim()
              ? config.providerId.trim()
              : config.providerId === null
                ? null
                : botSessionAgentKind(primaryRoute ?? config) === 'pi'
                  ? NEW_BOT_DEFAULT_PI_PROVIDER
                  : undefined),
          effort:
            primaryRoute?.effort ||
            (typeof config.effort === 'string' && config.effort.trim()
              ? config.effort.trim()
              : botSessionAgentKind(primaryRoute ?? config) === 'pi'
                ? NEW_BOT_DEFAULT_PI_EFFORT
                : undefined),
          fastMode: primaryRoute?.fastMode ?? config.fastMode === true,
          agentKind: botSessionAgentKind(primaryRoute ?? config),
          permissionMode: botSessionPermissionMode(config),
          remoteHostId: undefined,
          source: 'bot',
        },
        now,
      ),
      title: profile.displayName,
    };
    try {
      await ensureProjectGitInitialized({
        workingDir,
        workspaceKind,
        remoteHostId: null,
        sessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'local-db:bots:create-canonical-session',
      });
    } catch (error) {
      // Stable Bot workspace belongs to the Profile, not this creation attempt.
      throw error;
    }

    let canonicalSessionId: string | null = null;
    let archivedCanonicalSessionId: string | null = null;
    let created = false;
    try {
      const result = await getDbClient().tx<BotsReplaceCanonicalSessionResult>(
        'bots.replaceCanonicalSession',
        {
          botId,
          expectedCanonicalSessionId: recoverableCompatibilityMirror
            ? null
            : expectedCanonicalSessionId,
          compatibilityMissingCanonicalSessionId: recoverableCompatibilityMirror
            ? expectedCanonicalSessionId
            : null,
          expectedProfileVersion,
          session: {
            id: insertRow.id,
            title: insertRow.title,
            workingDir: insertRow.workingDir ?? null,
            workspaceKind: insertRow.workspaceKind,
            model: insertRow.model,
            effort: insertRow.effort,
            fastMode: insertRow.fastMode,
            permissionMode: insertRow.permissionMode,
            agentKind: insertRow.agentKind,
            remoteHostId: insertRow.remoteHostId ?? null,
            providerId: insertRow.providerId ?? null,
            extraDirs: insertRow.extraDirs,
            source: insertRow.source,
            createdAt: insertRow.createdAt,
            updatedAt: insertRow.updatedAt,
          },
          now,
        },
      );
      canonicalSessionId = result.canonicalSessionId;
      archivedCanonicalSessionId = result.archivedCanonicalSessionId;
      created = result.created;
    } finally {
      if (!created) {
        // Project bindings are user-owned. Only the exact dialogue workspace
        // allocated by a legacy attempt was eligible for compensation. The
        // Profile workspace is intentionally retained even when this CAS loses.
        // Never delete the stable Profile workspace on a lost CAS.
      }
    }

    if (!canonicalSessionId) {
      throwIpcError('PRECONDITION_FAILED', 'Bot 主任务创建失败');
    }
    if (archivedCanonicalSessionId) {
      // A missing/deleted canonical is infrastructure recovery, not a user cancellation.
      // Keep its active Session tasks alive, move their ownership to the replacement, and
      // recreate idempotent card anchors there. Explicit archive/delete paths still cancel.
      const reparented = await getDbClient().tx<BotsReparentDelegationsResult>(
        'bots.reparentDelegations',
        {
          botId,
          previousParentSessionId: archivedCanonicalSessionId,
          nextParentSessionId: canonicalSessionId,
          now: Date.now(),
        },
      );
      if (reparented.delegationIds.length > 0) {
        const rows = await db
          .select()
          .from(botDelegations)
          .where(inArray(botDelegations.id, reparented.delegationIds));
        for (const row of rows) {
          await createMessage(canonicalSessionId, {
            clientId: BOT_DELEGATION_CLIENT_ID.parentRequest(row.id),
            role: 'assistant',
            content: '',
            createdAt: row.createdAt,
            agentKind: null,
            agentMeta: {
              botCollaboration: {
                v: 1,
                role: 'delegation-request',
                delegationId: row.id,
                fromBotId: botId,
                fromBotName: profile.displayName,
                toBotId: null,
                toBotName: 'Cindy',
                parentSessionId: canonicalSessionId,
                childSessionId: row.childSessionId,
                objective: row.objective.slice(0, 400),
              },
            },
          });
        }
      }
      const { getMakerIfReady } = await import('../../maker-host/index.js');
      await getMakerIfReady()
        ?.closeSession(archivedCanonicalSessionId)
        .catch(() => undefined);
      // The Profile workspace survives recovery of a missing/deleted task.
    }
    const [canonical] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, canonicalSessionId))
      .limit(1);
    if (!canonical) throwIpcError('NOT_FOUND', 'Bot 主任务不存在');
    return {
      created,
      canonicalSessionId,
      session: sessionToCamel({
        ...canonical,
        messageCount: 0,
        latestMessageContent: null,
        latestMessageRole: null,
      }),
    };
  };

  const createBotCanonicalSessionPrepared = async (input: CreateBotCanonicalSessionInput) => {
    // Bring legacy pointer-only profiles into the link registry before any
    // create/replace CAS. Once a canonical link exists, the worker transaction
    // compares against that link rather than trusting the compatibility mirror.
    await reconcileCanonicalLink(input.botId);
    const previousSessionId = input.expectedCanonicalSessionId;
    if (!previousSessionId) return createBotCanonicalSessionUnlocked(input);
    return coordinateBotCanonicalReplacement(previousSessionId, () =>
      createBotCanonicalSessionUnlocked(input),
    );
  };

  createBotCanonicalSessionImpl = async (input) => {
    /*
      解析主任务前先把家里的文件收进来。用户拿编辑器改完 SOUL.md、
      或者伙伴自己改完自己的灵魂,都在这一刻变成一个新版本;现有主任务
      的下一轮会按新版本组装，不需要更换任务。

      放在锁外面:它只读文件、按需派生版本,不碰 canonical 指针,与替换协调器
      要保护的东西不重叠。失败已在内部吞掉并记一笔,最坏是这一轮还用旧身份。
    */
    await reconcileBotProfileFolder(input.botId);
    return createBotCanonicalSessionPrepared(input);
  };

  ipcMain.handle('local-db:bots:create-canonical-session', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    if (!Object.prototype.hasOwnProperty.call(body, 'expectedCanonicalSessionId')) {
      throwIpcError('INVALID_PARAMS', 'expectedCanonicalSessionId 必须显式提供');
    }
    const expectedCanonicalSessionId =
      body.expectedCanonicalSessionId === null
        ? null
        : readText(body.expectedCanonicalSessionId, 'expectedCanonicalSessionId', 128, true);
    if (!Number.isInteger(body.expectedProfileVersion) || Number(body.expectedProfileVersion) < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    if (body.recoverMissingOnly !== undefined && typeof body.recoverMissingOnly !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'recoverMissingOnly 必须是 boolean');
    }
    return createBotCanonicalSession({
      botId,
      expectedCanonicalSessionId,
      expectedProfileVersion: Number(body.expectedProfileVersion),
      recoverMissingOnly: body.recoverMissingOnly === true,
    });
  });

  ipcMain.handle('local-db:bots:history', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const links = await db
      .select()
      .from(botSessionLinks)
      .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.role, 'history')))
      .orderBy(desc(botSessionLinks.archivedAt));
    const result = [];
    for (const link of links) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, link.sessionId))
        .limit(1);
      if (!row) continue;
      result.push(
        sessionToCamel({
          ...row,
          messageCount: 0,
          latestMessageContent: null,
          latestMessageRole: null,
        }),
      );
    }
    return result;
  });
}
