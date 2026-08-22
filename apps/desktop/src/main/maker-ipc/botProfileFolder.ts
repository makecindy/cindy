/**
 * 伙伴的家 —— 每个伙伴一个文件夹,用户和伙伴自己都能直接编辑。
 *
 * ## 为什么要有它
 *
 * 在这之前,伙伴的身份、用户画像和能力位全部只活在数据库字段里,只能通过设置页
 * 那几个表单改。对照 Hermes:它的每个 agent 就是一个目录(`~/.hermes/` 及
 * `~/.hermes/profiles/<名字>/`),`SOUL.md`、`memories/USER.md`、`skills/` 都是
 * 摊开的文件 —— 用户能用编辑器改、能 diff、能备份、能复制一份改改就是新 agent,
 * **而 agent 自己也读得到、改得动自己的灵魂**。最后这条是它「像个活物」的一大半
 * 原因,数据库字段给不了。
 *
 * 所以这里把权威搬到磁盘上。数据库不再是内容的家,只留索引与状态。
 *
 * ## 文件是当前值,版本行是冻结快照
 *
 * 有一处张力必须讲清楚:文件随时可改,而一个正在跑的任务不能中途换身份。
 * 两者的分工是 ——
 *
 *   - **文件** = 当前值。用户在设置页改、伙伴自己用文件工具改,都落在这里。
 *   - **`bot_profile_versions` 行** = 某一次的冻结快照。任务启动时认版本号,
 *     整轮不变。
 *
 * 于是改完 `SOUL.md` 不会让正在进行的对话当场变身,而是**下一轮生效** ——
 * 这正是契约 9.3 节要的那三种状态里的第三种,不是缺陷。设置页据此显示
 * 「等待下一轮生效」。
 *
 * ## 落在哪
 *
 * `<userData>/bots/<botId>/`,走 `app.getPath('userData')`,不进任何 Git 仓、
 * 不落会话工作目录(credentials-and-local-storage.md 的「路径与生命周期」)。
 *
 * ```
 * <userData>/bots/<botId>/
 *   SOUL.md                     ← 身份。Hermes 同名同义
 *   memories/USER.md            ← 用户画像。Hermes 同路径
 *   system_prompt.md            ← 整段提示词覆盖(有内容才生效)
 *   config.json                 ← 能力位 + 展示元数据
 *   todo.json                   ← 待办
 *   knowledge/*.md              ← 知识
 *   preferences/*.md            ← 偏好
 *   .claude-plugin/plugin.json  ← 让整个目录能被 Claude Code 当本地 plugin 挂载
 *   skills/<slug>/SKILL.md      ← 技能。pi 直接 `--skill <这个目录>`
 * ```
 *
 * `skills/` 与 `.claude-plugin/` 是从 `<userData>/bot-skills/<botId>/` 整体搬过来
 * 的(见 `migrateBotProfileFolder`)—— 一个伙伴一个家,不该散在两处。技能内容与
 * slug 都不变,挂载路径每次会话现算,没有任何地方持久化过旧路径。
 *
 * ## 边界
 *
 * - `botId` 进路径段前先净化,`..` 与分隔符在这一步止步;
 * - 所有写入都是**先写临时文件再 rename** 的原子替换,断电不会留下半截文件;
 * - 每个文本槽有大小上限,伙伴可以自己写,但不能把用户磁盘写满;
 * - 读取一律容错:文件缺失 / 内容损坏都回落到空值,绝不让一个坏文件卡死伙伴。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 单个文本槽的上限。灵魂与画像是「说明」,不是知识库。 */
export const BOT_PROFILE_TEXT_MAX_BYTES = 64 * 1024;

export type BotProfileFolderErrorCode = 'INVALID_ARGS' | 'TEXT_TOO_LARGE';

export class BotProfileFolderError extends Error {
  constructor(
    readonly errorCode: BotProfileFolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BotProfileFolderError';
  }
}

/**
 * botId 进的是路径段,不能带分隔符或 `..`。
 * 与 botSkillStore 的 `botDirName` 同一套规则 —— 两边指向同一个目录,净化口径
 * 必须逐字一致,否则搬家会搬到另一个名字下面去。
 */
function botDirName(botId: string): string {
  const trimmed = botId.trim();
  if (!trimmed) throw new BotProfileFolderError('INVALID_ARGS', 'botId required');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!safe) {
    throw new BotProfileFolderError('INVALID_ARGS', 'botId is not usable as a directory name');
  }
  return safe;
}

/** 一个伙伴的家。 */
export function botProfileDir(userDataDir: string, botId: string): string {
  return path.join(userDataDir, 'bots', botDirName(botId));
}

/** 家里的固定成员。相对路径,拼接前都会过 `resolveInside`。 */
const SLOT = {
  soul: 'SOUL.md',
  userContext: path.join('memories', 'USER.md'),
  systemPrompt: 'system_prompt.md',
  config: 'config.json',
  todo: 'todo.json',
} as const;

/** 目录型槽位。列目录时只认 `.md`。 */
const DIR_SLOT = {
  knowledge: 'knowledge',
  preferences: 'preferences',
} as const;

/** 解析并断言目标仍在这个伙伴的家里面 —— 路径穿越在这里止步。 */
function resolveInside(userDataDir: string, botId: string, relative: string): string {
  const root = path.resolve(botProfileDir(userDataDir, botId));
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new BotProfileFolderError('INVALID_ARGS', `unsafe path: ${relative}`);
  }
  return resolved;
}

/** 读一个文本槽。缺失或读不动一律当空,不抛 —— 坏文件不该卡死伙伴。 */
async function readTextSlot(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 原子写:先写同目录下的临时文件,再 rename 顶上去。
 *
 * 直接 `writeFile` 的话,写到一半断电会留下一个**半截的 SOUL.md** —— 伙伴下次
 * 启动就带着半句话的身份。rename 在同一文件系统上是原子的,要么旧的要么新的。
 */
async function writeTextAtomic(absPath: string, content: string): Promise<void> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > BOT_PROFILE_TEXT_MAX_BYTES) {
    throw new BotProfileFolderError(
      'TEXT_TOO_LARGE',
      `content exceeds ${BOT_PROFILE_TEXT_MAX_BYTES} bytes`,
    );
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, absPath);
}

/** 一份摊开的伙伴档案。 */
export interface BotProfileFolderContent {
  /** 身份(SOUL.md)。 */
  identitySource: string;
  /** 用户画像(memories/USER.md)。 */
  userContextSource: string;
  /** 整段系统提示词覆盖。空 = 不覆盖,走默认组装。 */
  systemPromptOverride: string;
  /** 能力位与展示元数据(config.json)。解析不出来时是空对象。 */
  config: Record<string, unknown>;
  /** 待办(todo.json)。解析不出来时是空数组。 */
  todo: unknown[];
  /** 知识条目的文件名(不含目录),按名字排序。 */
  knowledge: string[];
  /** 偏好条目的文件名,同上。 */
  preferences: string[];
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function parseJsonOr<T>(raw: string, fallback: T, accept: (value: unknown) => boolean): T {
  if (!raw.trim()) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return accept(parsed) ? (parsed as T) : fallback;
  } catch {
    // 用户手改坏了 config.json 不该让伙伴起不来:回落到空,由上层用数据库里的
    // 冻结快照继续跑,并在设置页显示真实状态。
    return fallback;
  }
}

export async function readBotProfileFolder(
  userDataDir: string,
  botId: string,
): Promise<BotProfileFolderContent> {
  const at = (relative: string) => resolveInside(userDataDir, botId, relative);
  const [identitySource, userContextSource, systemPromptOverride, configRaw, todoRaw] =
    await Promise.all([
      readTextSlot(at(SLOT.soul)),
      readTextSlot(at(SLOT.userContext)),
      readTextSlot(at(SLOT.systemPrompt)),
      readTextSlot(at(SLOT.config)),
      readTextSlot(at(SLOT.todo)),
    ]);
  const [knowledge, preferences] = await Promise.all([
    listMarkdown(at(DIR_SLOT.knowledge)),
    listMarkdown(at(DIR_SLOT.preferences)),
  ]);
  return {
    identitySource,
    userContextSource,
    systemPromptOverride,
    config: parseJsonOr<Record<string, unknown>>(
      configRaw,
      {},
      (value) => !!value && typeof value === 'object' && !Array.isArray(value),
    ),
    todo: parseJsonOr<unknown[]>(todoRaw, [], (value) => Array.isArray(value)),
    knowledge,
    preferences,
  };
}

/** 只写传进来的那几项,没传的原样不动。 */
export interface BotProfileFolderPatch {
  identitySource?: string;
  userContextSource?: string;
  systemPromptOverride?: string;
  config?: Record<string, unknown>;
  todo?: unknown[];
}

export async function writeBotProfileFolder(
  userDataDir: string,
  botId: string,
  patch: BotProfileFolderPatch,
): Promise<void> {
  const at = (relative: string) => resolveInside(userDataDir, botId, relative);
  const writes: Array<Promise<void>> = [];
  if (patch.identitySource !== undefined) {
    writes.push(writeTextAtomic(at(SLOT.soul), patch.identitySource));
  }
  if (patch.userContextSource !== undefined) {
    writes.push(writeTextAtomic(at(SLOT.userContext), patch.userContextSource));
  }
  if (patch.systemPromptOverride !== undefined) {
    writes.push(writeTextAtomic(at(SLOT.systemPrompt), patch.systemPromptOverride));
  }
  if (patch.config !== undefined) {
    writes.push(writeTextAtomic(at(SLOT.config), `${JSON.stringify(patch.config, null, 2)}\n`));
  }
  if (patch.todo !== undefined) {
    writes.push(writeTextAtomic(at(SLOT.todo), `${JSON.stringify(patch.todo, null, 2)}\n`));
  }
  await Promise.all(writes);
}

/** 删掉整个家(伙伴被永久删除时)。不存在时静默返回。 */
export async function removeBotProfileFolder(
  userDataDir: string,
  botId: string,
): Promise<void> {
  await fs.rm(botProfileDir(userDataDir, botId), { recursive: true, force: true });
}

export interface BotProfileFolderSeed {
  identitySource: string;
  userContextSource: string;
  config: Record<string, unknown>;
}

export interface BotProfileFolderMigration {
  /** 这次是不是真的建了家(false = 本来就有,什么都没动)。 */
  seeded: boolean;
  /** 技能是不是从 `bot-skills/` 搬过来了。 */
  skillsMoved: boolean;
}

/**
 * 把一个伙伴的家建起来 —— 幂等,已经有 `SOUL.md` 就整个跳过。
 *
 * 两件事:
 *
 *   1. 用数据库里的当前值播种 `SOUL.md` / `memories/USER.md` / `config.json`。
 *      **只在没有 SOUL.md 时做**,绝不覆盖用户已经改过的文件。
 *   2. 把 `<userData>/bot-skills/<botId>/` 整个搬成 `<家>/skills` 的邻居
 *      (`.claude-plugin/` 一并带走)。一个伙伴一个家,不该散在两处。
 *
 * 搬家用 rename,同一文件系统上原子且瞬时。目标已存在(重复迁移、或用户手工建过)
 * 时保留目标、不动源,宁可留一份孤儿也不覆盖用户的技能。
 */
export async function migrateBotProfileFolder(
  userDataDir: string,
  botId: string,
  seed: BotProfileFolderSeed,
): Promise<BotProfileFolderMigration> {
  const soulPath = resolveInside(userDataDir, botId, SLOT.soul);
  let seeded = false;
  try {
    await fs.access(soulPath);
  } catch {
    await writeBotProfileFolder(userDataDir, botId, {
      identitySource: seed.identitySource,
      userContextSource: seed.userContextSource,
      config: seed.config,
    });
    seeded = true;
  }

  const skillsMoved = await migrateBotSkillsIntoProfileFolder(userDataDir, botId);
  return { seeded, skillsMoved };
}

/**
 * 只搬技能,不碰档案内容 —— 因此**不需要数据库**。
 *
 * 分出来是因为触发时机不同:技能层(`botSkillService`)每次读写技能前都要保证
 * 已经搬完,而它拿不到、也不该去拿伙伴的身份文本。档案播种由 IPC 写入口负责。
 *
 * 幂等:新家已有 `skills/` 就整个跳过,宁可在旧处留一份孤儿也不覆盖用户的技能。
 * 返回 true 表示这次真的搬了。
 */
export async function migrateBotSkillsIntoProfileFolder(
  userDataDir: string,
  botId: string,
): Promise<boolean> {
  const legacyRoot = path.join(userDataDir, 'bot-skills', botDirName(botId));
  const skillsTarget = resolveInside(userDataDir, botId, 'skills');
  try {
    await fs.access(path.join(legacyRoot, 'skills'));
  } catch {
    // 没有旧技能目录 —— 新伙伴的常态,也是搬完之后的常态。
    return false;
  }
  try {
    await fs.access(skillsTarget);
    return false;
  } catch {
    // 目标还不存在,可以搬。
  }
  await fs.mkdir(botProfileDir(userDataDir, botId), { recursive: true });
  await fs.rename(path.join(legacyRoot, 'skills'), skillsTarget);
  // plugin 清单跟着技能走;缺了它 Claude Code 挂不起这个本地 plugin。
  await fs
    .rename(
      path.join(legacyRoot, '.claude-plugin'),
      resolveInside(userDataDir, botId, '.claude-plugin'),
    )
    .catch(() => {});
  await fs.rm(legacyRoot, { recursive: true, force: true }).catch(() => {});
  return true;
}
