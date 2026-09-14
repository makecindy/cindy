/**
 * 伙伴的家 —— 每个伙伴一个账号隔离的文件夹。
 *
 * ## 为什么要有它
 *
 * 在这之前,伙伴的身份、用户画像和能力位全部只活在数据库字段里,只能通过设置页
 * 那几个表单改。对照 Hermes:它的每个 agent 就是一个目录(`~/.hermes/` 及
 * `~/.hermes/profiles/<名字>/`),`SOUL.md`、`memories/USER.md`、`skills/` 都是
 * 摊开的文件 —— 用户能用编辑器改、能 diff、能备份。Agent 只写自己的内容目录；
 * Home 根部的身份与宿主策略通过受控入口更新，不能把文件可写等同于权限可写。
 *
 * 所以这里把权威搬到磁盘上。数据库不再是内容的家,只留索引与状态。
 *
 * ## 文件是当前值,版本行是冻结快照
 *
 * 有一处张力必须讲清楚:文件随时可改,而一个正在跑的任务不能中途换身份。
 * 两者的分工是 ——
 *
 *   - **文件** = 当前值。用户在设置页改，或伙伴通过受控内容工具学习，都会落在这里。
 *   - **`bot_profile_versions` 行** = 某一次的冻结快照。任务启动时认版本号,
 *     整轮不变。
 *
 * 于是改完 `SOUL.md` 不会让正在进行的对话当场变身,而是**下一轮生效** ——
 * 这正是契约 9.3 节要的那三种状态里的第三种,不是缺陷。设置页据此显示
 * 「等待下一轮生效」。
 *
 * ## 落在哪
 *
 * `<ownerRoot>/bots/<botId>/`,其中 `ownerRoot` 是当前账号隔离的 userData 根。
 * 不进任何 Git 仓、不落 Session 工作目录(credentials-and-local-storage.md 的
 * 「路径与生命周期」)。
 *
 * ```
 * <ownerRoot>/bots/<botId>/
 *   SOUL.md                     ← 身份。Hermes 同名同义
 *   memories/USER.md            ← 用户画像。Hermes 同路径
 *   system_prompt.md            ← 用户维护的 prompt overlay(有内容才生效,不取代核心协议)
 *   config.json                 ← 旧版兼容副本；运行时权限不再从这里读取
 *   .claude-plugin/plugin.json  ← 让整个目录能被 Claude Code 当本地 plugin 挂载
 *   skills/<slug>/SKILL.md      ← 技能。pi 直接 `--skill <这个目录>`
 * ```
 *
 * 这个模块只认上面这几样**有代码消费**的槽。用户或伙伴自己在家里放的其它文件
 * (Hermes 的 `knowledge/`、`preferences/` 之类)照样躺在那儿、照样跟着导出走,
 * 但不由这里建、不由这里读 —— 伙伴知道家在哪、有文件工具,要用就自己去看。
 *
 * ## 一条抄歪了又抄回来的教训
 *
 * 早前这里还有过 `todo.json` 槽和「把 `knowledge/` / `preferences/` 的文件名列进
 * 提示词」的机制,理由写的是「对齐 Hermes」。复核后两条都不成立:
 *
 *   - `todo.json` 在 Hermes 的 agent 代码里**一个字都没有**,它只出现在导出白名单
 *     和迁移工具里 —— 那是旧 OpenClaw 工作区的**遗留状态文件**,是要被清理的东西。
 *     当时是从一份「历史遗留清单」上抄了个文件名,当成了功能。
 *   - `knowledge/` / `preferences/` 在 Hermes 里同样从不进提示词。列名字不给路径,
 *     等于开一张模型打不开的空头支票 —— 跟 botProfileRuntime 里那条
 *     「Project Memory 这些条目打不开」的注释是同一种病。
 *
 * 对 Bot 真正有用的做法是：让它知道自己的 Home 和明确可写内容目录，不把全局目录
 * 清单塞进上下文，也不把宿主权限配置暴露为可写文件。
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
 * - Agent 原始文件工具只挂载 workspace；memories / skills 由宿主的类型化工具写入，
 *   Home 根部不进入 writableDirs。
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** 原子写的临时文件序号,进程内自增 —— 见 writeTextAtomic 里的并发说明。 */
let writeSeq = 0;
const LEGACY_OWNER_CLAIM = '.cindy-owner-claim-v1.json';

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

/**
 * Stable unbound work area shared by every physical Session of one Bot.
 * It is part of the Bot home, so Session replacement must never remove it.
 */
export async function ensureBotWorkspaceDir(
  userDataDir: string,
  botId: string,
  legacyUserDataDir?: string,
): Promise<string> {
  await migrateLegacyBotProfileFolder(userDataDir, legacyUserDataDir, botId);
  const workspace = path.join(botProfileDir(userDataDir, botId), 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

/** Bot 长期记忆与 USER.md 共处一个可浏览目录；存储层会忽略 USER.md。 */
export function botProfileMemoryDir(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), 'memories');
}

/**
 * Agent 的原始文件工具只拿 workspace，不拿整个 Home。memories / skills 虽然也在
 * Home 内，但只能经宿主的类型化 Memory / Skill 接口写入：这样既不会把 fts.db、
 * 迁移 receipt 等内部文件暴露给模型，也不能用 symlink 把宿主写操作引到 Home 外。
 */
export async function ensureBotContentDirs(
  userDataDir: string,
  botId: string,
  legacyUserDataDir?: string,
): Promise<string[]> {
  await migrateLegacyBotProfileFolder(userDataDir, legacyUserDataDir, botId);
  const home = botProfileDir(userDataDir, botId);
  const workspace = path.join(home, 'workspace');
  const dirs = [workspace, path.join(home, 'memories'), path.join(home, 'skills')];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
  return [workspace];
}

/** 家里的固定成员。相对路径,拼接前都会过 `resolveInside`。 */
const SLOT = {
  soul: 'SOUL.md',
  userContext: path.join('memories', 'USER.md'),
  systemPrompt: 'system_prompt.md',
  config: 'config.json',
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
  /*
    临时文件名要**每次都不同**。只带 pid 的话,同一进程里两处并发写同一个槽
    (设置页保存 + 开新任务时的对账派生)会用同一个临时名:后写的内容可能在前一个
    rename 之前把临时文件覆盖掉,于是「先保存的那次」落盘的其实是另一次的内容。
    文件不会损坏,但会静默丢一次保存。
  */
  const tmp = `${absPath}.tmp-${process.pid}-${(writeSeq += 1)}`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, absPath);
  } catch (cause) {
    // rename 失败时别把临时文件留在伙伴的家里 —— 那是用户会打开看的目录。
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
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
  const [identitySource, userContextSource, systemPromptOverride, configRaw] = await Promise.all([
    readTextSlot(at(SLOT.soul)),
    readTextSlot(at(SLOT.userContext)),
    readTextSlot(at(SLOT.systemPrompt)),
    readTextSlot(at(SLOT.config)),
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
  };
}

/** 只写传进来的那几项,没传的原样不动。 */
export interface BotProfileFolderPatch {
  identitySource?: string;
  userContextSource?: string;
  systemPromptOverride?: string;
  config?: Record<string, unknown>;
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
  await Promise.all(writes);
}

/** 删掉整个家(伙伴被永久删除时)。不存在时静默返回。 */
export async function removeBotProfileFolder(
  userDataDir: string,
  botId: string,
  legacyUserDataDir?: string,
): Promise<void> {
  await fs.rm(botProfileDir(userDataDir, botId), { recursive: true, force: true });
  if (!legacyUserDataDir || path.resolve(userDataDir) === path.resolve(legacyUserDataDir)) return;
  for (const legacyDir of [
    botProfileDir(legacyUserDataDir, botId),
    path.join(legacyUserDataDir, 'bot-skills', botDirName(botId)),
  ]) {
    if (await legacyOwnerClaimMatches(legacyDir, userDataDir)) {
      await fs.rm(legacyDir, { recursive: true, force: true });
    }
  }
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
  legacyUserDataDir?: string,
): Promise<BotProfileFolderMigration> {
  await migrateLegacyBotProfileFolder(userDataDir, legacyUserDataDir, botId);
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

  const skillsMoved = await migrateBotSkillsIntoProfileFolder(userDataDir, botId, legacyUserDataDir);
  return { seeded, skillsMoved };
}

/**
 * Copy the pre-owner Home into the active owner's namespace exactly once.
 * Source data is intentionally retained for rollback and for another owner
 * whose database can independently prove the same Bot id belongs to it.
 */
export async function migrateLegacyBotProfileFolder(
  ownerRoot: string,
  legacyUserDataDir: string | undefined,
  botId: string,
): Promise<boolean> {
  if (!legacyUserDataDir || path.resolve(ownerRoot) === path.resolve(legacyUserDataDir)) return false;
  const source = botProfileDir(legacyUserDataDir, botId);
  const target = botProfileDir(ownerRoot, botId);
  const receipt = path.join(target, '.cindy-home-migration-v1.json');
  try {
    await fs.access(receipt);
    return false;
  } catch {
    // No completed migration receipt yet.
  }
  try {
    await fs.access(source);
  } catch {
    return false;
  }
  if (!(await claimLegacyOwner(source, ownerRoot))) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.migrating-${process.pid}-${(writeSeq += 1)}`;
  await fs.rm(staging, { recursive: true, force: true });
  try {
    await copyRegularTree(source, staging);
    try {
      await fs.rename(staging, target);
      await writeBotHomeMigrationReceipt(receipt);
      return true;
    } catch {
      // A memory store may have created `<home>/memories` before Profile
      // hydration. Merge only missing legacy entries and never overwrite the
      // new authoritative Home or a concurrent migration.
      await fs.mkdir(target, { recursive: true });
      const changed = (await mergeMissingTree(staging, target)) > 0;
      await writeBotHomeMigrationReceipt(receipt);
      return changed;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Copy a legacy tree without ever following symlinks. Legacy Bot Homes were raw-writable,
 * so a link inside memories/skills cannot be trusted as a host-owned migration source.
 */
async function copyRegularTree(source: string, target: string): Promise<void> {
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new BotProfileFolderError('INVALID_ARGS', 'legacy Bot Home must be a real directory');
  }
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === LEGACY_OWNER_CLAIM) continue;
    if (entry.isSymbolicLink()) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyRegularTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

function legacyOwnerClaimValue(ownerRoot: string): string {
  return createHash('sha256').update(path.resolve(ownerRoot), 'utf8').digest('hex');
}

async function legacyOwnerClaimMatches(source: string, ownerRoot: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(source, LEGACY_OWNER_CLAIM), 'utf8'),
    ) as { ownerRootSha256?: unknown };
    return parsed.ownerRootSha256 === legacyOwnerClaimValue(ownerRoot);
  } catch {
    return false;
  }
}

/** Atomically bind a pre-owner legacy directory to the first owner that migrates it. */
async function claimLegacyOwner(source: string, ownerRoot: string): Promise<boolean> {
  const claimPath = path.join(source, LEGACY_OWNER_CLAIM);
  const ownerRootSha256 = legacyOwnerClaimValue(ownerRoot);
  try {
    const handle = await fs.open(claimPath, 'wx');
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, ownerRootSha256 })}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    return legacyOwnerClaimMatches(source, ownerRoot);
  }
}

async function writeBotHomeMigrationReceipt(receipt: string): Promise<void> {
  const tmp = `${receipt}.tmp-${process.pid}-${(writeSeq += 1)}`;
  await fs.writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString() })}\n`, 'utf8');
  try {
    await fs.rename(tmp, receipt);
  } catch (cause) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
}

/** Move only missing staging entries into target; existing authoritative files win. */
async function mergeMissingTree(staging: string, target: string): Promise<number> {
  let moved = 0;
  const entries = await fs.readdir(staging, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(staging, entry.name);
    const targetPath = path.join(target, entry.name);
    try {
      await fs.rename(sourcePath, targetPath);
      moved += 1;
      continue;
    } catch {
      // Existing target or a concurrent writer: inspect before descending.
    }
    if (!entry.isDirectory()) continue;
    try {
      if (!(await fs.stat(targetPath)).isDirectory()) continue;
    } catch {
      continue;
    }
    moved += await mergeMissingTree(sourcePath, targetPath);
  }
  return moved;
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
  legacyUserDataDir?: string,
): Promise<boolean> {
  await migrateLegacyBotProfileFolder(userDataDir, legacyUserDataDir, botId);
  const legacyRoot = path.join(legacyUserDataDir ?? userDataDir, 'bot-skills', botDirName(botId));
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
  const crossOwnerMigration = path.resolve(legacyUserDataDir ?? userDataDir) !== path.resolve(userDataDir);
  if (crossOwnerMigration) {
    if (!(await claimLegacyOwner(legacyRoot, userDataDir))) return false;
    await copyRegularTree(path.join(legacyRoot, 'skills'), skillsTarget);
  } else {
    await fs.rename(path.join(legacyRoot, 'skills'), skillsTarget);
  }
  // plugin 清单跟着技能走;缺了它 Claude Code 挂不起这个本地 plugin。
  const pluginSource = path.join(legacyRoot, '.claude-plugin');
  const pluginTarget = resolveInside(userDataDir, botId, '.claude-plugin');
  if (crossOwnerMigration) {
    await copyRegularTree(pluginSource, pluginTarget).catch(() => {});
  } else {
    await fs.rename(pluginSource, pluginTarget).catch(() => {});
    await fs.rm(legacyRoot, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}
