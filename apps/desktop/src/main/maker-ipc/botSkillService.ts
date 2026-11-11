/**
 * 伙伴真技能的**会话绑定层**:把「哪个 session 在调」翻成「哪个伙伴的技能目录」。
 *
 * 纯文件系统那一半在 `botSkillStore.ts`(可脱离 Electron 单测);这里只做三件事:
 * 归属解析、错误码统一、userData 根定位。归属判据与
 * `botDurableNoteService.resolveBotContext` 逐条对齐 —— 同一个 Bot 会话面,
 * 「不是 Bot 任务 / 已归档 / 只读历史任务」三种拒绝口径不该有两套。
 */

import path from 'node:path';
import { app } from 'electron';
import { collectTeammateGuideMount } from './teammateGuideStore.js';
import { botSkillRuntimeSummary, projectBotSkillMounts } from './botSkillRuntimeProjection.js';
import { queryBotSkillIndex } from './botSkillQueryIndex.js';
import { cachedBotSkillRuntime } from './botSkillRuntimeCache.js';
import { iterateBotSkillRuntimeSummaries } from './botSkillRuntimeSource.js';
import { requestBotRuntimeEpochRefresh } from './botRuntimeEpochRefreshSignal.js';
import { and, eq } from 'drizzle-orm';

import { migrateBotSkillsIntoProfileFolder } from './botProfileFolder.js';
import { readTeammateProjectMode } from './botWorkspaceRuntime.js';
import {
  BotSkillStoreError,
  botSkillRootDir,
  botSkillsDir,
  setBotProjectSkillsDir,
  deleteBotSkill,
  listBotSkills,
  readBotSkill,
  readBotSkillSource,
  listBotSkillSources,
  applyBotSkillFiles,
  listBotSkillFiles,
  readBotSkillFiles,
  saveBotSkill,
  saveBotSkillSource,
  setBotSkillEnabled,
  type BotSkillSummary,
} from './botSkillStore.js';
import type { BotSkillFile, LocalBotSkillFile } from './botSkillFiles.js';
import type {
  BotSkillDetail,
  BotSkillSummary as SharedBotSkillSummary,
} from '../../shared/botSkill.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';

export type BotSkillResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; errorCode: string; message: string };

/**
 * 技能交给模型 / 设置页看的形状 —— 不含正文,`list` 只是让它别重复学。
 * 与 shared 的线型同一份,避免两处各写一遍再漂移。
 */
export type BotSkillWireSummary = SharedBotSkillSummary;

function toWire(item: BotSkillSummary): BotSkillWireSummary {
  return {
    slug: item.slug,
    name: item.name,
    description: item.description,
    updatedAt: item.updatedAt,
    ...(item.enabled === false ? { enabled: false } : {}),
  };
}

/** 测试注入用:默认取 Electron 的 userData 根。 */
export interface BotSkillServiceDeps {
  userDataDir?: string;
  ownerScopeKey?: () => string;
  ownerBoundaryPending?: () => boolean;
  /**
   * Whether the stored profile is a V2 (project-mode) teammate, whose skills are its project's.
   * Defaults to the database when the userData root is not injected.
   */
  readProjectMode?: (botId: string) => Promise<boolean>;
  requestRefresh?: typeof requestBotRuntimeEpochRefresh;
  resolveBotId?: (callerSessionId: string, callerSessionInstanceId?: string) => Promise<
    | { ok: true; botId: string; canonicalSessionId?: string | null; refresh?: () => Promise<void> }
    | { ok: false; errorCode: string; message: string }
  >;
}

interface BotSkillOwnerBoundary {
  userDataDir: string;
  scopeKey: string | null;
}

function captureOwnerBoundary(deps: BotSkillServiceDeps): BotSkillOwnerBoundary {
  const scopeKey = deps.ownerScopeKey
    ? deps.ownerScopeKey()
    : deps.userDataDir
      ? null
      : activeOwnerScopeKey();
  if ((deps.ownerBoundaryPending ?? isAppSessionBoundaryPending)()) {
    throw new BotSkillStoreError('OWNER_SCOPE_CHANGED', '账号正在切换，请稍后重试');
  }
  return { userDataDir: deps.userDataDir ?? ownerScopedUserDataPath(), scopeKey };
}

function assertOwnerBoundary(deps: BotSkillServiceDeps, boundary: BotSkillOwnerBoundary): void {
  if (boundary.scopeKey === null) return;
  if (
    (deps.ownerBoundaryPending ?? isAppSessionBoundaryPending)()
    || (deps.ownerScopeKey ?? activeOwnerScopeKey)() !== boundary.scopeKey
  ) {
    throw new BotSkillStoreError('OWNER_SCOPE_CHANGED', '账号已切换，请重试');
  }
}

/**
 * userData 根,外加「这个伙伴的技能已经搬进它自己的家」这条保证。
 *
 * 技能原来单独住在 `<userData>/bot-skills/<botId>/`,现在归到伙伴的家
 * (`<userData>/bots/<botId>/`)。搬家挂在每个读写入口前而不是只挂在启动时:
 * 任何一条路径进来都不该读到旧家 —— 漏一条就是「技能凭空消失」。
 *
 * 幂等且便宜:搬完之后每次只是一次失败的 `access`。搬家失败不阻断本次操作
 * (最坏是这次读到空技能表),但绝不会丢:旧目录只在 rename 成功后才删。
 */
async function skillHomeOf(
  deps: BotSkillServiceDeps,
  botId: string,
  boundary: BotSkillOwnerBoundary,
): Promise<string> {
  assertOwnerBoundary(deps, boundary);
  const dir = boundary.userDataDir;
  await migrateBotSkillsIntoProfileFolder(
    dir,
    botId,
    deps.userDataDir ? undefined : app.getPath('userData'),
  ).catch(() => {});
  // Every entry decides the skills folder from the stored profile: a cloud upload or take-over
  // may come before anything else registered it, and must never read the old `skills/` folder
  // of a V2 teammate (its skills would look deleted). An unreadable profile keeps the last answer.
  const readProjectMode = deps.readProjectMode ?? (deps.userDataDir ? undefined : readTeammateProjectMode);
  if (readProjectMode) {
    const projectMode = await readProjectMode(botId).catch(() => null);
    assertOwnerBoundary(deps, boundary);
    if (projectMode !== null) setBotProjectSkillsDir(dir, botId, projectMode);
  }
  assertOwnerBoundary(deps, boundary);
  return dir;
}

async function defaultResolveBotId(
  callerSessionId: string,
): Promise<
  { ok: true; botId: string; canonicalSessionId: string | null; refresh?: () => Promise<void> } | { ok: false; errorCode: string; message: string }
> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      canonicalSessionId: botProfiles.canonicalSessionId,
      sessionStatus: sessions.status,
      remoteHostId: sessions.remoteHostId,
      profileStatus: botProfiles.status,
      linkArchivedAt: botSessionLinks.archivedAt,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) {
    return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
  }
  if (row.sessionStatus !== 'active' || row.profileStatus !== 'active' || row.linkArchivedAt !== null) {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '已归档的 Bot 任务不能沉淀技能' };
  }
  // Runtime hydration cannot mount the local personal shelf on an SSH host.
  // Reject before migration/read/write and before refreshing the local canonical.
  // Device-link callers executing on this desktop still have no remoteHostId.
  if (row.remoteHostId) {
    return { ok: false, errorCode: 'REMOTE_SKILLS_UNAVAILABLE', message: '当前远端任务尚未挂载伙伴自有 Skill 存储，不能读取或保存本机 Skill，也不能承诺远端生效' };
  }
  return { ok: true, botId: row.botId, canonicalSessionId: row.canonicalSessionId };
}

function storeError(cause: unknown): { ok: false; errorCode: string; message: string } {
  if (cause instanceof BotSkillStoreError) {
    return { ok: false, errorCode: cause.errorCode, message: cause.message };
  }
  return {
    ok: false,
    errorCode: 'INTERNAL',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * 伙伴把一次做法沉淀成技能(新建或更新同名技能)。
 *
 * 工具面在 spawn 时冻结。保存后请求宿主在安全轮次边界刷新同一个主任务，
 * 不打断当前轮、授权卡或后台工作；未配置刷新桥的宿主仍诚实返回 next-session。
 */
export async function saveBotSkillForSession(
  params: {
    callerSessionId: string;
    callerSessionInstanceId?: string;
    name: string;
    description: string;
    body: string;
    slug?: string;
    expectedUpdatedAt?: string | null;
  },
  deps: BotSkillServiceDeps = {},
): Promise<
  BotSkillResult<{
    skill: BotSkillWireSummary;
    created: boolean;
    effective: 'next-turn' | 'next-session';
  }>
> {
  try {
    const boundary = captureOwnerBoundary(deps);
    const owner = await (deps.resolveBotId
      ?? defaultResolveBotId)(
      params.callerSessionId, params.callerSessionInstanceId,
    );
    if (!owner.ok) return owner;
    assertOwnerBoundary(deps, boundary);
    const { record, created } = await saveBotSkill(await skillHomeOf(deps, owner.botId, boundary), owner.botId, {
      name: params.name,
      description: params.description,
      body: params.body,
      expectedUpdatedAt: params.expectedUpdatedAt,
      ...(params.slug ? { slug: params.slug } : {}),
    });
    assertOwnerBoundary(deps, boundary);
    const refreshed = await (deps.requestRefresh ?? requestBotRuntimeEpochRefresh)(
      owner.canonicalSessionId ?? params.callerSessionId, 'resource',
    );
    assertOwnerBoundary(deps, boundary);
    return {
      ok: true,
      created,
      effective: refreshed ? 'next-turn' : 'next-session',
      skill: {
        slug: record.slug,
        name: record.name,
        description: record.description,
        updatedAt: record.updatedAt,
      },
    };
  } catch (cause) {
    return storeError(cause);
  }
}

/** 列出这个伙伴已经学会的技能,供模型避免重复学 / 决定该更新哪一条。 */
export async function listBotSkillsForSession(
  params: { callerSessionId: string; callerSessionInstanceId?: string; query?: string; offset?: number; limit?: number },
  deps: BotSkillServiceDeps = {},
): Promise<BotSkillResult<{ skills: ReturnType<typeof botSkillRuntimeSummary>[]; total: number; nextOffset?: number }>> {
  try {
    const boundary = captureOwnerBoundary(deps);
    const owner = await (deps.resolveBotId
      ?? defaultResolveBotId)(
      params.callerSessionId, params.callerSessionInstanceId,
    );
    if (!owner.ok) return owner;
    assertOwnerBoundary(deps, boundary);
    const home = await skillHomeOf(deps, owner.botId, boundary);
    assertOwnerBoundary(deps, boundary);
    const result = await queryBotSkillIndex(botSkillRootDir(home, owner.botId), home, owner.botId, params);
    assertOwnerBoundary(deps, boundary);
    await owner.refresh?.();
    assertOwnerBoundary(deps, boundary);
    return { ok: true, ...result };
  } catch (cause) {
    return storeError(cause);
  }
}

/** 设置页「TA 学会的」的数据源(按 botId 直查,不经会话)。 */
export async function listBotSkillsForBot(
  botId: string,
  deps: BotSkillServiceDeps = {},
): Promise<BotSkillWireSummary[]> {
  const boundary = captureOwnerBoundary(deps);
  const result = (await listBotSkills(await skillHomeOf(deps, botId, boundary), botId)).map(toWire);
  assertOwnerBoundary(deps, boundary);
  return result;
}

/** 设置页展开某条技能时读正文。 */
export async function readBotSkillForBot(
  botId: string,
  slug: string,
  deps: BotSkillServiceDeps = {},
): Promise<BotSkillDetail | null> {
  const boundary = captureOwnerBoundary(deps);
  const record = await readBotSkill(await skillHomeOf(deps, botId, boundary), botId, slug);
  assertOwnerBoundary(deps, boundary);
  return record
    ? {
        slug: record.slug,
        name: record.name,
        description: record.description,
        updatedAt: record.updatedAt,
        body: record.body,
        ...(record.enabled === false ? { enabled: false } : {}),
      }
    : null;
}

/** One own skill's SKILL.md exactly as stored (cloud companions upload it unchanged). */
export async function readBotSkillSourceForBot(botId: string, slug: string, deps: BotSkillServiceDeps = {}): Promise<string | null> {
  const boundary = captureOwnerBoundary(deps);
  const source = await readBotSkillSource(await skillHomeOf(deps, botId, boundary), botId, slug);
  assertOwnerBoundary(deps, boundary);
  return source;
}

/** Every own skill's SKILL.md for cloud sync; read errors propagate instead of reading as "no skill". */
export async function listBotSkillSourcesForBot(botId: string, deps: BotSkillServiceDeps = {}): Promise<Array<{ slug: string; source: string; enabled: boolean }>> {
  const boundary = captureOwnerBoundary(deps);
  const sources = await listBotSkillSources(await skillHomeOf(deps, botId, boundary), botId);
  assertOwnerBoundary(deps, boundary);
  return sources;
}

/** Restore one own skill's SKILL.md verbatim (cloud companions), keeping its native frontmatter. */
export async function saveBotSkillSourceForBot(botId: string, slug: string, source: string,
  options: { enabled?: boolean; expectedUpdatedAt?: string } = {}, deps: BotSkillServiceDeps = {}): Promise<void> {
  const boundary = captureOwnerBoundary(deps);
  await saveBotSkillSource(await skillHomeOf(deps, botId, boundary), botId, slug, source, options);
  assertOwnerBoundary(deps, boundary);
}

/** The files beside one own skill's SKILL.md (cloud companions). */
export async function listBotSkillFilesForBot(botId: string, slug: string, enabled: boolean, deps: BotSkillServiceDeps = {}): Promise<LocalBotSkillFile[]> {
  const boundary = captureOwnerBoundary(deps);
  const files = await listBotSkillFiles(await skillHomeOf(deps, botId, boundary), botId, slug, enabled);
  assertOwnerBoundary(deps, boundary);
  return files;
}

/** The same, wherever the skill lives now. */
export async function readBotSkillFilesForBot(botId: string, slug: string, deps: BotSkillServiceDeps = {}): Promise<LocalBotSkillFile[]> {
  const boundary = captureOwnerBoundary(deps);
  const files = await readBotSkillFiles(await skillHomeOf(deps, botId, boundary), botId, slug);
  assertOwnerBoundary(deps, boundary);
  return files;
}

/** Restore the files beside one own skill's SKILL.md (cloud companions). */
export async function applyBotSkillFilesForBot(botId: string, slug: string, files: BotSkillFile[],
  fetch: (file: BotSkillFile) => Promise<string | null>, options: { removeOthers: boolean; keep?: string[] }, deps: BotSkillServiceDeps = {}): Promise<string[]> {
  const boundary = captureOwnerBoundary(deps);
  const missing = await applyBotSkillFiles(await skillHomeOf(deps, botId, boundary), botId, slug, files, fetch, options);
  assertOwnerBoundary(deps, boundary);
  return missing;
}

/** 设置页开关一条学会的技能：只移动文件夹，不改内容。 */
export async function setBotSkillEnabledForBot(botId: string, slug: string, enabled: boolean, deps: BotSkillServiceDeps = {}): Promise<void> {
  const boundary = captureOwnerBoundary(deps);
  await setBotSkillEnabled(await skillHomeOf(deps, botId, boundary), botId, slug, enabled);
  assertOwnerBoundary(deps, boundary);
}

/** 设置页删除一条技能。 */
export async function deleteBotSkillForBot(
  botId: string,
  slug: string,
  deps: BotSkillServiceDeps = {},
): Promise<boolean> {
  const boundary = captureOwnerBoundary(deps);
  const deleted = await deleteBotSkill(await skillHomeOf(deps, botId, boundary), botId, slug);
  assertOwnerBoundary(deps, boundary);
  return deleted;
}

/**
 * 会话启动时的有界挂载:小目录直接挂载，大目录按需检索完整原文件。
 *
 * 一份磁盘事实两种消费方式 —— pi 拿 `dirPath` 走 `--skill`,Claude Code 拿
 * `pluginRoot` 走本地 plugin。没有技能时返回空,调用方据此完全不注入。
 */
export async function collectBotOwnSkillMounts(
  botId: string,
  deps: BotSkillServiceDeps = {},
): Promise<{
  pluginRoot: string;
  baseline: Awaited<ReturnType<typeof collectTeammateGuideMount>>;
  skills: { name: string; description: string; path: string; filePath: string; updatedAt?: string }[];
}> {
  const boundary = captureOwnerBoundary(deps);
  const userDataDir = await skillHomeOf(deps, botId, boundary);
  const baseline = await collectTeammateGuideMount(userDataDir);
  const root = botSkillRootDir(userDataDir, botId);
  // A V2 teammate's Skills are in its project, not in `root/skills` (its V1 copies): no native
  // mount of root, and the cache follows the project's Skills folder instead.
  const skillsDir = botSkillsDir(userDataDir, botId);
  const native = skillsDir === path.join(root, 'skills');
  const projected = await cachedBotSkillRuntime(native ? root : path.dirname(skillsDir), async () =>
    projectBotSkillMounts(root, iterateBotSkillRuntimeSummaries(userDataDir, botId), { native }));
  assertOwnerBoundary(deps, boundary);
  return { ...projected, baseline };
}
