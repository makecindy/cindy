/**
 * profile.ts —— learn 的用户画像证据层(Maker Memory 分片 → prompt 画像块)。
 *
 * 与 evidence.ts(按主题检索历史会话片段)互补:画像回答"这个用户是谁、
 * 偏好什么、在做什么",让蒸馏产物真正为该用户改写,而不是程序化裁剪。
 *
 * 来源边界(防跨项目张冠李戴 —— 实测踩过:把别的项目的 build 禁令写进
 * Cindy skill):
 *   - user_* 分片:person 级事实,取自**所有** workdir 的 memory 目录
 *   - feedback_* / project_* 分片:项目域规则,只取**触发会话所在 workdir**
 *     的 memory 目录,且格式化时标注来源,prompt 里禁止跨项目移植
 *
 * 规则 9:取哪些分片、多少、什么顺序、怎么截断全部代码钉死;每条过 redact。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { sanitizeWorkdir } from '@cindy/maker-core';

import { ownerScopedUserDataPath } from '../appSessionState';
import { createLogger } from '../logger';
import { readMemorySettings } from '../maker-host/memory-settings-store';
import { redactSensitive } from './redaction';

const log = createLogger('learn-host:profile');

/** 单分片正文字符上限(超出截尾)。 */
export const PROFILE_PER_SHARD_CHAR_CAP = 1200;
/** 画像块总字符预算。 */
export const PROFILE_TOTAL_CHAR_BUDGET = 6000;
/** 分片数上限(user 优先,其次 feedback,再 project;组内按 mtime 新→旧)。 */
export const PROFILE_MAX_SHARDS = 12;

export interface ProfileShard {
  /** 'user' | 'feedback' | 'project'(其余 memory type 不进画像)。 */
  type: string;
  /** frontmatter title(缺失回退 slug)。 */
  title: string;
  /** 正文(已 redact、已截断)。 */
  body: string;
  /** 来源 workdir 的展示名('user' 类为空 —— person 级,与项目无关)。 */
  sourceLabel: string;
}

export interface ProfileBundle {
  /** 渲染进 prompt 的画像块(空串 = 无画像)。 */
  block: string;
  /** 是否实际注入了画像内容(⇒ provenance.personal,与会话证据同责)。 */
  used: boolean;
}

function memoryRoot(): string {
  return ownerScopedUserDataPath('maker-memory');
}

function redactProfileLabel(value: string): string {
  return redactSensitive(value).text.trim();
}

/** 读一个分片文件 → ProfileShard(解析失败返 null,画像是尽力而为)。 */
async function readShard(filePath: string, type: string, sourceLabel: string): Promise<ProfileShard | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = matter(raw);
    const title =
      String((parsed.data as Record<string, unknown>).title ?? '').trim() ||
      path.basename(filePath, '.md').replace(/^[a-z]+_/, '');
    const clipped =
      parsed.content.trim().length > PROFILE_PER_SHARD_CHAR_CAP
        ? `${parsed.content.trim().slice(0, PROFILE_PER_SHARD_CHAR_CAP)}\n[...truncated]`
        : parsed.content.trim();
    const { text } = redactSensitive(clipped);
    if (!text) return null;
    return {
      type,
      title: redactProfileLabel(title),
      body: text,
      sourceLabel: redactProfileLabel(sourceLabel),
    };
  } catch {
    return null;
  }
}

/** 列出某 memory 目录下指定前缀的分片路径(mtime 新→旧)。 */
async function listShardFiles(dir: string, prefixes: string[]): Promise<Array<{ file: string; mtime: number }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    if (!prefixes.some((p) => name.startsWith(`${p}_`))) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      out.push({ file: full, mtime: stat.mtimeMs });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 纯格式化:分片 → prompt 画像块(供单测;空分片返回空串)。 */
export function formatProfileBlock(shards: ProfileShard[]): string {
  if (shards.length === 0) return '';
  const sections: string[] = [];
  let used = 0;
  for (const s of shards) {
    const title = redactProfileLabel(s.title);
    const sourceLabel = redactProfileLabel(s.sourceLabel);
    const origin = sourceLabel ? `, project: ${sourceLabel}` : '';
    const section = `--- ${title} (${s.type}${origin}) ---\n${s.body}`;
    if (used + section.length > PROFILE_TOTAL_CHAR_BUDGET) break;
    sections.push(section);
    used += section.length;
  }
  return sections.join('\n\n');
}

/**
 * 收集用户画像:全局 user 分片 + 触发 workdir 的 feedback/project 分片。
 * 任何 IO 失败静默降级(画像缺失不阻断蒸馏)。
 */
export async function collectUserProfile(originWorkdir: string | null): Promise<ProfileBundle> {
  try {
    if (!readMemorySettings().maker) return { block: '', used: false };

    const root = memoryRoot();
    let dirs: string[];
    try {
      dirs = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name));
    } catch {
      return { block: '', used: false };
    }

    // user_* 来自所有 workdir(person 级);组内 mtime 新→旧
    const userFiles: Array<{ file: string; mtime: number }> = [];
    for (const dir of dirs) {
      userFiles.push(...(await listShardFiles(dir, ['user'])));
    }
    userFiles.sort((a, b) => b.mtime - a.mtime);

    // feedback_* / project_* 只来自触发 workdir 的 memory 目录
    const scopedFiles: Array<{ file: string; mtime: number }> = [];
    let scopedLabel = '';
    if (originWorkdir) {
      const scopedDir = path.join(root, sanitizeWorkdir(originWorkdir));
      scopedLabel = path.basename(originWorkdir);
      scopedFiles.push(...(await listShardFiles(scopedDir, ['feedback', 'project'])));
    }

    const shards: ProfileShard[] = [];
    for (const { file } of userFiles) {
      if (shards.length >= PROFILE_MAX_SHARDS) break;
      const shard = await readShard(file, 'user', '');
      if (shard) shards.push(shard);
    }
    for (const { file } of scopedFiles) {
      if (shards.length >= PROFILE_MAX_SHARDS) break;
      const type = path.basename(file).startsWith('feedback_') ? 'feedback' : 'project';
      const shard = await readShard(file, type, scopedLabel);
      if (shard) shards.push(shard);
    }

    const block = formatProfileBlock(shards);
    return { block, used: block.length > 0 };
  } catch (err) {
    log.warn('collectUserProfile failed (continuing without profile):', err);
    return { block: '', used: false };
  }
}
