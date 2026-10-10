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
 * - 单次生成正文有界；存储容量不按技能条数限制。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBotSkillFrontmatterReader, isFrontmatterBlock } from './botSkillFrontmatter.js';
import { invalidateBotSkillRuntime } from './botSkillRuntimeCache.js';
export { unescapeFrontmatterValue } from './botSkillFrontmatter.js';

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
  /** Imported disabled skills are retained outside the native plugin scan. */
  enabled?: boolean;
}

/** list 只需要元信息时用的轻量形态(不读正文,省 IO)。 */
export type BotSkillSummary = Omit<BotSkillRecord, 'body'> & {
  /** Charge the native loader's entire header, including YAML fields we do not interpret. */
  frontmatterBytes: number;
  /** One-based line at which a bounded read can skip even a very large header. */
  bodyStartLine: number;
  /** Legacy headers that cannot safely be handed to a native Skill parser. */
  requiresDiscovery?: boolean;
};

export const BOT_SKILL_MAX_NAME_CHARS = 64;
export const BOT_SKILL_MAX_DESCRIPTION_CHARS = 280;
/** 单个 SKILL.md 正文上限。技能是「怎么做」的清单,不是知识库。 */
export const BOT_SKILL_MAX_BODY_BYTES = 64 * 1024;

export interface BotSkillWriteInput {
  name: string;
  description: string;
  body: string;
  slug?: string;
  now?: number;
  /** Review snapshots may only replace the exact version they read (null means create). */
  expectedUpdatedAt?: string | null;
}

export type BotSkillErrorCode =
  | 'INVALID_ARGS'
  | 'SKILL_NAME_UNUSABLE'
  | 'SKILL_BODY_TOO_LARGE'
  | 'SKILL_LIMIT_REACHED'
  | 'NOT_FOUND'
  | 'OWNER_SCOPE_CHANGED';

export class BotSkillStoreError extends Error {
  constructor(
    readonly errorCode: BotSkillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BotSkillStoreError';
  }
}

/** botId 也要过一遍净化:它进的是路径段,不能带分隔符或 `..`。 */
function botDirName(botId: string): string {
  const trimmed = botId.trim();
  if (!trimmed) throw new BotSkillStoreError('INVALID_ARGS', 'botId required');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!safe)
    throw new BotSkillStoreError('INVALID_ARGS', 'botId is not usable as a directory name');
  return safe;
}

/**
 * 一个伙伴的技能根目录(= Claude Code 本地 plugin 根)。
 *
 * 这里就是**伙伴的家**(`botProfileFolder.ts`)。技能原来单独住在
 * `<userData>/bot-skills/<botId>/`,与灵魂、用户画像、能力位分居两处;现在一个
 * 伙伴一个家,技能是家里的 `skills/`。搬家由 `migrateBotProfileFolder` 完成,
 * 内容与 slug 都不变,挂载路径每次会话现算、没有任何地方持久化过旧路径。
 *
 * 目录布局刻意仍长成 CC 本地 plugin 的样子(`.claude-plugin/` + `skills/`),
 * 与 SOUL.md 等文件互不干扰 —— CC 只认那两个名字。
 */
export function botSkillRootDir(userDataDir: string, botId: string): string {
  return path.join(userDataDir, 'bots', botDirName(botId));
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
function resolveSkillDir(userDataDir: string, botId: string, slug: string, enabled = true): string {
  const root = path.resolve(enabled ? botSkillsDir(userDataDir, botId) : path.join(botSkillRootDir(userDataDir, botId), 'disabled-skills'));
  const resolved = path.resolve(root, slug);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new BotSkillStoreError('INVALID_ARGS', `unsafe skill slug: ${slug}`);
  }
  return resolved;
}

function escapeFrontmatterValue(value: string): string {
  // 单行 YAML 标量:双引号包裹 + 转义反斜杠与引号,换行压成空格。
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')}"`;
}

export function renderBotSkillFile(input: {
  slug: string;
  name: string;
  description: string;
  updatedAt: string;
  body: string;
}): string {
  const frontmatter = [
    '---',
    `name: ${escapeFrontmatterValue(input.slug)}`,
    `description: ${escapeFrontmatterValue(input.description)}`,
    'metadata:',
    `  displayName: ${escapeFrontmatterValue(input.name)}`,
    `  updatedAt: ${escapeFrontmatterValue(input.updatedAt)}`,
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
  const metadata = createBotSkillFrontmatterReader();
  for (const line of match[1].split('\n')) metadata.line(line);
  const fields = metadata.finish();
  return {
    name: fields.get('displayName') ?? fields.get('name') ?? '',
    description: fields.get('description') ?? '',
    updatedAt: fields.get('updatedAt') ?? '',
    body: normalized.slice(match[0].length).trim(),
  };
}

/**
 * 早期 Cindy 文件把展示名与 updatedAt 都写成顶层字段，不符合通用 Skill
 * frontmatter。只迁移这一个可精确识别的三字段旧格式，正文与用户编辑全部保留；
 * 含有任何其它字段的手写 Skill 不动。
 */
export async function readCompatibleBotSkillSource(filePath: string, slug: string): Promise<string> {
  const source = await fs.readFile(filePath, 'utf8');
  const normalized = source.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return source;
  const lines = match[1].split('\n');
  const keys = lines.map((line) => line.slice(0, line.indexOf(':')).trim());
  if (
    lines.some((line) => /^\s/.test(line) || line.indexOf(':') <= 0 || isFrontmatterBlock(line.slice(line.indexOf(':') + 1))) ||
    keys.length !== 3 ||
    !['name', 'description', 'updatedAt'].every((key) => keys.includes(key))
  ) {
    return source;
  }
  const parsed = parseBotSkillFile(source);
  const migrated = renderBotSkillFile({
    slug,
    name: parsed.name || slug,
    description: parsed.description,
    updatedAt: parsed.updatedAt,
    body: parsed.body,
  });
  await fs.writeFile(filePath, migrated, 'utf8');
  invalidateBotSkillRuntime(path.dirname(path.dirname(path.dirname(filePath))));
  return migrated;
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
  includeDisabled = true,
  enabled = true,
): Promise<BotSkillSummary[]> {
  const dir = enabled ? botSkillsDir(userDataDir, botId) : path.join(botSkillRootDir(userDataDir, botId), 'disabled-skills');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }
  const out: BotSkillSummary[] = [];
  for (const slug of entries.sort()) {
    const skillDir = path.join(dir, slug);
    const filePath = await readSkillFilePath(skillDir);
    if (!filePath) continue;
    let parsed: ReturnType<typeof parseBotSkillFile>;
    let frontmatterBytes: number;
    let bodyStartLine: number;
    try {
      const source = await readCompatibleBotSkillSource(filePath, slug);
      parsed = parseBotSkillFile(source);
      const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0] ?? '';
      // A nonstandard header is not safe to hand to a different native parser.
      frontmatterBytes = Buffer.byteLength(header || source);
      bodyStartLine = header ? header.split('\n').length : 1;
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
      frontmatterBytes,
      bodyStartLine,
      ...(enabled ? {} : { enabled: false }),
    });
  }
  if (includeDisabled && enabled) out.push(...await listBotSkills(userDataDir, botId, false, false));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读一个技能的完整内容(含正文)。不存在返回 null。 */
export async function readBotSkill(
  userDataDir: string,
  botId: string,
  slug: string,
): Promise<BotSkillRecord | null> {
  let skillDir = resolveSkillDir(userDataDir, botId, slug);
  let filePath = await readSkillFilePath(skillDir);
  let enabled = true;
  if (!filePath) { enabled = false; skillDir = resolveSkillDir(userDataDir, botId, slug, false); filePath = await readSkillFilePath(skillDir); }
  if (!filePath) return null;
  const parsed = parseBotSkillFile(await readCompatibleBotSkillSource(filePath, slug));
  return {
    slug,
    name: parsed.name || slug,
    description: parsed.description,
    updatedAt: parsed.updatedAt,
    body: parsed.body,
    dirPath: skillDir,
    filePath,
    ...(enabled ? {} : { enabled: false }),
  };
}

function normalizeBotSkillWriteInput(input: BotSkillWriteInput): {
  name: string;
  description: string;
  body: string;
  slug: string;
  updatedAt: string;
} {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.trim();
  if (!name || !description || !body) {
    throw new BotSkillStoreError('INVALID_ARGS', 'name / description / body are all required');
  }
  if (name.length > BOT_SKILL_MAX_NAME_CHARS) {
    throw new BotSkillStoreError(
      'INVALID_ARGS',
      `name is at most ${BOT_SKILL_MAX_NAME_CHARS} characters`,
    );
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
  return {
    name,
    description,
    body,
    slug,
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}

/**
 * 只在一个固定 slug 还不存在时写入初始技能。
 *
 * 这是内置伙伴模板的安装入口：模板可以给新伙伴一套真实工作方法，但绝不能在
 * 后续启动或并发创建时覆盖用户已经编辑过的 SKILL.md。`wx` 让最终写入原子地
 * 赢一次；输掉竞争的调用直接读取胜者留下的内容。
 */
export async function seedBotSkillIfMissing(
  userDataDir: string,
  botId: string,
  input: BotSkillWriteInput,
): Promise<{ record: BotSkillRecord; created: boolean }> {
  const normalized = normalizeBotSkillWriteInput(input);
  const existing = await readBotSkill(userDataDir, botId, normalized.slug);
  if (existing) return { record: existing, created: false };

  await ensureLayout(userDataDir, botId);
  const skillDir = resolveSkillDir(userDataDir, botId, normalized.slug);
  await fs.mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  try {
    await fs.writeFile(filePath, renderBotSkillFile(normalized), { encoding: 'utf8', flag: 'wx' });
    invalidateBotSkillRuntime(botSkillRootDir(userDataDir, botId));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== 'EEXIST') throw cause;
    const raced = await readBotSkill(userDataDir, botId, normalized.slug);
    if (!raced) throw cause;
    return { record: raced, created: false };
  }
  return {
    record: {
      slug: normalized.slug,
      name: normalized.name,
      description: normalized.description,
      updatedAt: normalized.updatedAt,
      body: normalized.body,
      dirPath: skillDir,
      filePath,
    },
    created: true,
  };
}

/**
 * 新建或更新一个技能。
 *
 * 同 slug 就是更新 —— 「再遇到同类任务发现改进点就更新它」是产品要求的一半,
 * 所以这里不做撞名保护,而是原地覆盖并刷新 updatedAt。返回值里的 `created`
 * 让调用方能分辨「学会了」和「改进了」。
 */
const skillWrites = new Map<string, Promise<unknown>>();
export async function saveBotSkill(
  userDataDir: string, botId: string, input: BotSkillWriteInput,
): Promise<{ record: BotSkillRecord; created: boolean }> {
  const key = botSkillRootDir(userDataDir, botId);
  const pending = (skillWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(() => writeBotSkill(userDataDir, botId, input));
  skillWrites.set(key, pending);
  try { return await pending; }
  finally { if (skillWrites.get(key) === pending) skillWrites.delete(key); }
}
async function writeBotSkill(
  userDataDir: string,
  botId: string,
  input: BotSkillWriteInput,
): Promise<{ record: BotSkillRecord; created: boolean }> {
  const { name, description, body, slug, updatedAt } = normalizeBotSkillWriteInput(input);
  const previous = await readBotSkill(userDataDir, botId, slug);
  if (input.expectedUpdatedAt !== undefined && (previous?.updatedAt ?? null) !== input.expectedUpdatedAt)
    throw new BotSkillStoreError('INVALID_ARGS', 'Skill changed during review');
  const created = !previous;
  await ensureLayout(userDataDir, botId);
  const skillDir = resolveSkillDir(userDataDir, botId, slug, previous?.enabled !== false);
  await fs.mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  // 只写 SKILL.md,不去删同目录的 skill.md:macOS / Windows 的文件系统大小写不敏感,
  // 那条「清理」会把刚写好的这份自己删掉。读取一侧本来就优先 SKILL.md。
  await fs.writeFile(
    filePath,
    renderBotSkillFile({ slug, name, description, updatedAt, body }),
    'utf8',
  );
  invalidateBotSkillRuntime(botSkillRootDir(userDataDir, botId));
  return {
    record: { slug, name, description, updatedAt, body, dirPath: skillDir, filePath, ...(previous?.enabled === false ? { enabled: false } : {}) },
    created,
  };
}

/** Shared preflight for imports, before creating a profile or persisting its checkpoint. */
export function validateBotSkillFiles(slug: string,
  files: readonly { name: string; bytes: Buffer; executable: boolean; interpreterLink?: string }[]): void {
  if (!normalizeBotSkillSlug(slug) || normalizeBotSkillSlug(slug) !== slug)
    throw new BotSkillStoreError('INVALID_ARGS', 'Invalid imported skill');
  const entrypoint = files.find(file => file.name === 'SKILL.md');
  if (!entrypoint || !entrypoint.bytes.length)
    throw new BotSkillStoreError('SKILL_BODY_TOO_LARGE', 'Invalid skill entrypoint');
  for (const file of files) {
    if (file.name.includes('\\') || file.name.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(file.name))
      throw new BotSkillStoreError('INVALID_ARGS', 'Invalid skill resource');
    if (file.interpreterLink && (!/^(?:\.venv|venv)\/(?:bin|Scripts)\/python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(file.name) || !path.isAbsolute(file.interpreterLink)))
      throw new BotSkillStoreError('INVALID_ARGS', 'Invalid imported interpreter');
  }
}

/** Import a selected real skill with its scripts/templates; keep the native SKILL.md bytes. */
export async function importBotSkillFiles(userDataDir: string, botId: string, slug: string,
  files: readonly { name: string; bytes: Buffer; executable: boolean; interpreterLink?: string }[], assertOwner: () => void, enabled = true): Promise<void> {
  validateBotSkillFiles(slug, files);
  await ensureLayout(userDataDir, botId);
  assertOwner();
  // Slugs identify one skill across both stores. A source must not create a
  // second, indistinguishable entry or overwrite a skill learned during retry.
  try {
    await fs.lstat(resolveSkillDir(userDataDir, botId, slug, !enabled));
    throw new BotSkillStoreError('INVALID_ARGS', 'Imported skill conflicts with an existing skill');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const target = resolveSkillDir(userDataDir, botId, slug, enabled);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(botSkillRootDir(userDataDir, botId), `.import-skill-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of files) {
      const output = path.join(temporary, ...file.name.split('/'));
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      assertOwner();
      if (file.interpreterLink) await fs.symlink(file.interpreterLink, output, 'file');
      else await fs.writeFile(output, file.bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    }
    assertOwner();
    try {
      await fs.rename(temporary, target);
      invalidateBotSkillRuntime(botSkillRootDir(userDataDir, botId));
    }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // Resume after a committed rename, without overwriting a later user edit.
      if (!(await fs.lstat(target)).isDirectory()) throw new BotSkillStoreError('INVALID_ARGS', 'Invalid imported skill folder');
      for (const file of files) {
        const entry = path.join(target, ...file.name.split('/'));
        if (file.interpreterLink) {
          if (!(await fs.lstat(entry)).isSymbolicLink() || await fs.readlink(entry) !== file.interpreterLink)
            throw new BotSkillStoreError('INVALID_ARGS', 'Imported interpreter was edited');
          continue;
        }
        const resolved = await fs.realpath(entry);
        const relative = path.relative(await fs.realpath(target), resolved);
        if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new BotSkillStoreError('INVALID_ARGS', 'Invalid imported skill resource');
        const stat = await fs.lstat(entry);
        if (!stat.isFile() || !(await fs.readFile(entry)).equals(file.bytes))
          throw new BotSkillStoreError('INVALID_ARGS', 'Imported skill was edited');
      }
    }
    assertOwner();
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

/** 删除一个技能。不存在时返回 false,不抛 —— 重复删除是安全的。 */
export async function deleteBotSkill(
  userDataDir: string,
  botId: string,
  slug: string,
): Promise<boolean> {
  // Match read/edit precedence, including any pre-existing duplicate directories.
  // Deleting one visible skill must never remove another directory implicitly.
  for (const enabled of [true, false]) {
    const skillDir = resolveSkillDir(userDataDir, botId, slug, enabled);
    try { if (!(await fs.stat(skillDir)).isDirectory()) continue; }
    catch { continue; }
    await fs.rm(skillDir, { recursive: true, force: true });
    invalidateBotSkillRuntime(botSkillRootDir(userDataDir, botId));
    return true;
  }
  return false;
}
