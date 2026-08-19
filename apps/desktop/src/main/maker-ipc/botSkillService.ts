/**
 * 伙伴真技能的**会话绑定层**:把「哪个 session 在调」翻成「哪个伙伴的技能目录」。
 *
 * 纯文件系统那一半在 `botSkillStore.ts`(可脱离 Electron 单测);这里只做三件事:
 * 归属解析、错误码统一、userData 根定位。归属判据与
 * `botDurableNoteService.resolveBotContext` 逐条对齐 —— 同一个 Bot 会话面,
 * 「不是 Bot 任务 / 已归档 / 只读历史任务」三种拒绝口径不该有两套。
 */

import { app } from 'electron';
import { and, eq } from 'drizzle-orm';

import {
  BotSkillStoreError,
  botSkillRootDir,
  deleteBotSkill,
  listBotSkills,
  readBotSkill,
  saveBotSkill,
  type BotSkillSummary,
} from './botSkillStore.js';
import type {
  BotSkillDetail,
  BotSkillSummary as SharedBotSkillSummary,
} from '../../shared/botSkill.js';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, sessions } from '../localDb/schema.js';

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
  };
}

/** 测试注入用:默认取 Electron 的 userData 根。 */
export interface BotSkillServiceDeps {
  userDataDir?: string;
  resolveBotId?: (callerSessionId: string) => Promise<
    | { ok: true; botId: string }
    | { ok: false; errorCode: string; message: string }
  >;
}

function userDataDirOf(deps: BotSkillServiceDeps): string {
  return deps.userDataDir ?? app.getPath('userData');
}

async function defaultResolveBotId(callerSessionId: string): Promise<
  { ok: true; botId: string } | { ok: false; errorCode: string; message: string }
> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      sessionStatus: sessions.status,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) {
    return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
  }
  if (row.sessionStatus !== 'active') {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '已归档的 Bot 任务不能沉淀技能' };
  }
  if (row.role !== 'canonical' && row.role !== 'route') {
    return { ok: false, errorCode: 'BOT_SESSION_READ_ONLY', message: '当前 Bot 历史任务为只读状态' };
  }
  return { ok: true, botId: row.botId };
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
 * 写完**当前会话不会立刻多出一个可调用技能** —— harness 的技能面在 spawn 时冻结。
 * 返回值里的 `effective: 'next-session'` 就是这件事的诚实说明,让模型不要转头去
 * 调一个还没挂上的技能。
 */
export async function saveBotSkillForSession(
  params: { callerSessionId: string; name: string; description: string; body: string; slug?: string },
  deps: BotSkillServiceDeps = {},
): Promise<
  BotSkillResult<{
    skill: BotSkillWireSummary;
    created: boolean;
    effective: 'next-session';
  }>
> {
  const owner = await (deps.resolveBotId ?? defaultResolveBotId)(params.callerSessionId);
  if (!owner.ok) return owner;
  try {
    const { record, created } = await saveBotSkill(userDataDirOf(deps), owner.botId, {
      name: params.name,
      description: params.description,
      body: params.body,
      ...(params.slug ? { slug: params.slug } : {}),
    });
    return {
      ok: true,
      created,
      effective: 'next-session',
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
  params: { callerSessionId: string },
  deps: BotSkillServiceDeps = {},
): Promise<BotSkillResult<{ skills: BotSkillWireSummary[] }>> {
  const owner = await (deps.resolveBotId ?? defaultResolveBotId)(params.callerSessionId);
  if (!owner.ok) return owner;
  try {
    const skills = await listBotSkills(userDataDirOf(deps), owner.botId);
    return { ok: true, skills: skills.map(toWire) };
  } catch (cause) {
    return storeError(cause);
  }
}

/** 设置页「TA 学会的」的数据源(按 botId 直查,不经会话)。 */
export async function listBotSkillsForBot(
  botId: string,
  deps: BotSkillServiceDeps = {},
): Promise<BotSkillWireSummary[]> {
  return (await listBotSkills(userDataDirOf(deps), botId)).map(toWire);
}

/** 设置页展开某条技能时读正文。 */
export async function readBotSkillForBot(
  botId: string,
  slug: string,
  deps: BotSkillServiceDeps = {},
): Promise<BotSkillDetail | null> {
  const record = await readBotSkill(userDataDirOf(deps), botId, slug);
  return record
    ? {
        slug: record.slug,
        name: record.name,
        description: record.description,
        updatedAt: record.updatedAt,
        body: record.body,
      }
    : null;
}

/** 设置页删除一条技能。 */
export async function deleteBotSkillForBot(
  botId: string,
  slug: string,
  deps: BotSkillServiceDeps = {},
): Promise<boolean> {
  return deleteBotSkill(userDataDirOf(deps), botId, slug);
}

/**
 * 会话启动时要挂载的东西:每个技能的目录 + Claude Code 用的 plugin 根。
 *
 * 一份磁盘事实两种消费方式 —— pi 拿 `dirPath` 走 `--skill`,Claude Code 拿
 * `pluginRoot` 走本地 plugin。没有技能时返回空,调用方据此完全不注入。
 */
export async function collectBotOwnSkillMounts(
  botId: string,
  deps: BotSkillServiceDeps = {},
): Promise<{
  pluginRoot: string;
  skills: { name: string; description: string; path: string }[];
}> {
  const userDataDir = userDataDirOf(deps);
  const skills = await listBotSkills(userDataDir, botId);
  return {
    pluginRoot: botSkillRootDir(userDataDir, botId),
    skills: skills.map((item) => ({
      name: item.name,
      description: item.description,
      path: item.dirPath,
    })),
  };
}
