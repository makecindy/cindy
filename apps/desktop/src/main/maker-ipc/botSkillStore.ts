/**
 * 伙伴自己沉淀的**真技能**存储(批次 ζ「学会的本事」)。
 *
 * 与「TA 记得的」的关系:记忆分片回答「我知道什么」,技能回答「这类事我怎么做」。
 * 批次 ε 只有 `learned-` 前缀的记忆分片 —— 那是一条笔记,harness 不会把它当技能
 * 挂载。本模块给的是真东西:每个技能一个目录 + 一份 `SKILL.md`,下一次会话由
 * botProfileRuntime 交给 harness 真正挂进去(pi 走 `--skill`,Claude Code 走本地
 * plugin 根)。
 *
 * ## 落盘位置
 *
 * `<userData>/bot-skills/<botId>/` —— 走 `app.getPath('userData')`,不进任何 Git
 * 仓、不落会话工作目录(credentials-and-local-storage.md 的「路径与生命周期」)。
 * 目录内布局刻意长成 Claude Code 本地 plugin 的样子:
 *
 * ```
 * <userData>/bot-skills/<botId>/
 *   .claude-plugin/plugin.json      ← 让整个根目录能被 CC 当 local plugin 挂载
 *   skills/<slug>/SKILL.md          ← pi 直接 `--skill <这个目录>`
 * ```
 *
 * 一份磁盘事实同时喂两个 harness,不需要为每个 harness 复制一份内容。
 *
 * ## 边界
 *
 * - slug 由 name 规范化而来,只保留 `[a-z0-9-]`;拼不出合法 slug 就拒绝写入,
 *   绝不退化成随机名(用户在设置页看到的必须是他能认出来的东西)。
 * - 所有对外入口都用 `resolveSkillDir` 解析并断言落在自己的 `skills/` 下,
 *   `../` 一类穿越在这一步被挡掉,不依赖调用方先做净化。
 * - 单个技能正文与技能条数都有硬上限:模型可以自己写,但不能把用户磁盘写满。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 一个技能在磁盘上的完整形态。 */
export interface BotSkillRecord {
  /** 目录名,同时是删除 / 更新时的稳定标识。 */
  slug: string;
  /** frontmatter.name —— 展示用的技能名。 */
  name: string;
  /** frontmatter.description —— 一句话说明何时该用它。 */
  description: string;
  /** frontmatter.updatedAt(ISO 串);解析不出来时为空串,由展示方降级。 */
  updatedAt: string;
  /** SKILL.md 正文(不含 frontmatter)。 */
  body: string;
  /** 技能目录的绝对路径 —— 挂载时交给 harness 的就是它。 */
  dirPath: string;
  /** SKILL.md 的绝对路径。 */
  filePath: string;
}

/** list 只需要元信息时用的轻量形态(不读正文,省 IO)。 */
export type BotSkillSummary = Omit<BotSkillRecord, 'body'>;

export const BOT_SKILL_MAX_NAME_CHARS = 64;
export const BOT_SKILL_MAX_DESCRIPTION_CHARS = 280;
/** 单个 SKILL.md 正文上限。技能是「怎么做」的清单,不是知识库。 */
export const BOT_SKILL_MAX_BODY_BYTES = 64 * 1024;
/** 每个伙伴的技能条数上限。超过就必须先删旧的,避免无声膨胀。 */
export const BOT_SKILL_MAX_COUNT = 100;

export type BotSkillErrorCode =
  | 'INVALID_ARGS'
  | 'SKILL_NAME_UNUSABLE'
  | 'SKILL_BODY_TOO_LARGE'
  | 'SKILL_LIMIT_REACHED'
  | 'NOT_FOUND';

export class BotSkillStoreError extends Error {
  constructor(readonly errorCode: BotSkillErrorCode, message: string) {
    super(message);
    this.name = 'BotSkillStoreError';
  }
}

/** botId 也要过一遍净化:它进的是路径段,不能带分隔符或 `..`。 */
function botDirName(botId: string): string {
  const trimmed = botId.trim();
  if (!trimmed) throw new BotSkillStoreError('INVALID_ARGS', 'botId required');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!safe) throw new BotSkillStoreError('INVALID_ARGS', 'botId is not usable as a directory name');
  return safe;
}

/** 一个伙伴的技能根目录(= Claude Code 本地 plugin 根)。 */
export function botSkillRootDir(userDataDir: string, botId: string): string {
  return path.join(userDataDir, 'bot-skills', botDirName(botId));
}

/** 技能真正躺的地方。CC plugin 规范要求这一层就叫 `skills`。 */
export function botSkillsDir(userDataDir: string, botId: string): string {
  return path.join(botSkillRootDir(userDataDir, botId), 'skills');
}

/**
 * name → slug。
 *
 * 只保留 ASCII 字母数字与连字符。中文名会被整段过滤掉 —— 那不是 bug:CC / pi 的
 * 技能目录名进的是 CLI 参数与 slash command 名,非 ASCII 在各 harness 上的行为
 * 不一致。拼不出 slug 时由调用方回落到显式 slug 参数,而不是在这里造一个用户
 * 认不出来的名字。
 */
export function normalizeBotSkillSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BOT_SKILL_MAX_NAME_CHARS);
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}

/** 解析并断言目标目录仍在这个伙伴的 `skills/` 下 —— 路径穿越在这里止步。 */
function resolveSkillDir(userDataDir: string, botId: string, slug: string): string {
  const root = path.resolve(botSkillsDir(userDataDir, botId));
  const resolved = path.resolve(root, slug);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new BotSkillStoreError('INVALID_ARGS', `unsafe skill slug: ${slug}`);
  }
  return resolved;
}

function escapeFrontmatterValue(value: string): string {
  // 单行 YAML 标量:双引号包裹 + 转义反斜杠与引号,换行压成空格。
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function unescapeFrontmatterValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function renderBotSkillFile(input: {
  name: string;
  description: string;
  updatedAt: string;
  body: string;
}): string {
  const frontmatter = [
    '---',
    `name: ${escapeFrontmatterValue(input.name)}`,
    `description: ${escapeFrontmatterValue(input.description)}`,
    `updatedAt: ${escapeFrontmatterValue(input.updatedAt)}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${input.body.trim()}\n`;
}

/** 解析 SKILL.md。frontmatter 缺失或残缺时尽力而为,不抛 —— 手写的技能也要能列出来。 */
export function parseBotSkillFile(source: string): {
  name: string;
  description: string;
  updatedAt: string;
  body: string;
} {
  const normalized = source.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { name: '', description: '', updatedAt: '', body: normalized.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = unescapeFrontmatterValue(line.slice(separator + 1));
  }
  return {
    name: fields.name ?? '',
    description: fields.description ?? '',
    updatedAt: fields.updatedAt ?? '',
    body: normalized.slice(match[0].length).trim(),
  };
}

/**
 * Claude Code 本地 plugin 清单。
 *
 * 有它,`<userData>/bot-skills/<botId>` 整个目录就能被 CC 当 `{type:'local'}`
 * plugin 挂载,里面的 `skills/*` 随之进入会话 —— 这是 CC 侧唯一不污染用户
 * `~/.claude/skills`(那是全局的,会串到别的伙伴和普通任务)的挂载方式。
 */
function renderPluginManifest(botId: string): string {
  return `${JSON.stringify(
    {
      name: `cindy-bot-${botDirName(botId)}`,
      description: 'Skills this Cindy Bot learned for itself.',
      version: '1.0.0',
    },
    null,
    2,
  )}\n`;
}

async function ensureLayout(userDataDir: string, botId: string): Promise<void> {
  const root = botSkillRootDir(userDataDir, botId);
  await fs.mkdir(path.join(root, 'skills'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    renderPluginManifest(botId),
    'utf8',
  );
}

async function readSkillFilePath(skillDir: string): Promise<string | null> {
  for (const candidate of ['SKILL.md', 'skill.md']) {
    const filePath = path.join(skillDir, candidate);
    try {
      if ((await fs.stat(filePath)).isFile()) return filePath;
    } catch {
      // 继续试下一个大小写
    }
  }
  return null;
}

/**
 * 列出一个伙伴的全部技能(按 name 排序,不读正文)。
 *
 * 目录不存在 = 还没学会任何东西,返回空表而不是抛 —— 「TA 学会的」是设置页
 * 常驻区块,不该因为一次都没写过就报错。
 */
export async function listBotSkills(
  userDataDir: string,
  botId: string,
): Promise<BotSkillSummary[]> {
  const dir = botSkillsDir(userDataDir, botId);
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: BotSkillSummary[] = [];
  for (const slug of entries.sort()) {
    const skillDir = path.join(dir, slug);
    const filePath = await readSkillFilePath(skillDir);
    if (!filePath) continue;
    let parsed: ReturnType<typeof parseBotSkillFile>;
    try {
      parsed = parseBotSkillFile(await fs.readFile(filePath, 'utf8'));
    } catch {
      continue;
    }
    out.push({
      slug,
      name: parsed.name || slug,
      description: parsed.description,
      updatedAt: parsed.updatedAt,
      dirPath: skillDir,
      filePath,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读一个技能的完整内容(含正文)。不存在返回 null。 */
export async function readBotSkill(
  userDataDir: string,
  botId: string,
  slug: string,
): Promise<BotSkillRecord | null> {
  const skillDir = resolveSkillDir(userDataDir, botId, slug);
  const filePath = await readSkillFilePath(skillDir);
  if (!filePath) return null;
  const parsed = parseBotSkillFile(await fs.readFile(filePath, 'utf8'));
  return {
    slug,
    name: parsed.name || slug,
    description: parsed.description,
    updatedAt: parsed.updatedAt,
    body: parsed.body,
    dirPath: skillDir,
    filePath,
  };
}

/**
 * 新建或更新一个技能。
 *
 * 同 slug 就是更新 —— 「再遇到同类任务发现改进点就更新它」是产品要求的一半,
 * 所以这里不做撞名保护,而是原地覆盖并刷新 updatedAt。返回值里的 `created`
 * 让调用方能分辨「学会了」和「改进了」。
 */
export async function saveBotSkill(
  userDataDir: string,
  botId: string,
  input: { name: string; description: string; body: string; slug?: string; now?: number },
): Promise<{ record: BotSkillRecord; created: boolean }> {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.trim();
  if (!name || !description || !body) {
    throw new BotSkillStoreError('INVALID_ARGS', 'name / description / body are all required');
  }
  if (name.length > BOT_SKILL_MAX_NAME_CHARS) {
    throw new BotSkillStoreError('INVALID_ARGS', `name is at most ${BOT_SKILL_MAX_NAME_CHARS} characters`);
  }
  if (description.length > BOT_SKILL_MAX_DESCRIPTION_CHARS) {
    throw new BotSkillStoreError(
      'INVALID_ARGS',
      `description is at most ${BOT_SKILL_MAX_DESCRIPTION_CHARS} characters`,
    );
  }
  if (Buffer.byteLength(body, 'utf8') > BOT_SKILL_MAX_BODY_BYTES) {
    throw new BotSkillStoreError(
      'SKILL_BODY_TOO_LARGE',
      `body is at most ${BOT_SKILL_MAX_BODY_BYTES} bytes`,
    );
  }
  const slug = normalizeBotSkillSlug(input.slug?.trim() || name);
  if (!slug) {
    throw new BotSkillStoreError(
      'SKILL_NAME_UNUSABLE',
      'name could not be turned into a directory-safe slug; pass an explicit ASCII slug',
    );
  }
  const existing = await listBotSkills(userDataDir, botId);
  const created = !existing.some((item) => item.slug === slug);
  if (created && existing.length >= BOT_SKILL_MAX_COUNT) {
    throw new BotSkillStoreError(
      'SKILL_LIMIT_REACHED',
      `this Bot already has ${BOT_SKILL_MAX_COUNT} skills; delete one before adding another`,
    );
  }
  await ensureLayout(userDataDir, botId);
  const skillDir = resolveSkillDir(userDataDir, botId, slug);
  await fs.mkdir(skillDir, { recursive: true });
  const updatedAt = new Date(input.now ?? Date.now()).toISOString();
  const filePath = path.join(skillDir, 'SKILL.md');
  // 只写 SKILL.md,不去删同目录的 skill.md:macOS / Windows 的文件系统大小写不敏感,
  // 那条「清理」会把刚写好的这份自己删掉。读取一侧本来就优先 SKILL.md。
  await fs.writeFile(filePath, renderBotSkillFile({ name, description, updatedAt, body }), 'utf8');
  return {
    record: { slug, name, description, updatedAt, body, dirPath: skillDir, filePath },
    created,
  };
}

/** 删除一个技能。不存在时返回 false,不抛 —— 重复删除是安全的。 */
export async function deleteBotSkill(
  userDataDir: string,
  botId: string,
  slug: string,
): Promise<boolean> {
  const skillDir = resolveSkillDir(userDataDir, botId, slug);
  try {
    if (!(await fs.stat(skillDir)).isDirectory()) return false;
  } catch {
    return false;
  }
  await fs.rm(skillDir, { recursive: true, force: true });
  return true;
}
