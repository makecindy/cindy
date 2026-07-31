import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  GHOST_LOCALE_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  isValidGhostId,
  validateGhostManifest,
  validateGhostManifestLocaleResource,
  type GhostManifest,
  type GhostManifestLocaleResource,
  type GhostTrustInfo,
} from '../../shared/ghost.js';
import {
  classifyGhostDirEntry,
  collectGhostContentFiles,
  hashGhostContentFiles,
  isRegularGhostDirEntry,
  resolveGhostContentPath,
} from './ghostContentTree.js';
import { checkSkillMdConsistency } from './skillSlot.js';

// v2 pairs receipts with the unambiguous ghostContentTree framing. Keeping v1
// readable would let an old ambiguous digest authorize a snapshot under the
// new verifier, so old receipts intentionally fail closed and require approval
// to be written again.
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_ICON_DATA_URL_BYTES = 768 * 1024;
/**
 * 受管 icon 快照的完整形态:声明的图片 mime + 严格 base64 载荷。载荷字符集也要
 * 校验 —— 只认前缀会让被改写的 receipt 把任意字符串塞进 renderer 的 img src。
 */
const ICON_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 一次明确批准的插件安装事实；只允许 Host 写入安装目录之外的状态根。
 *
 * receipt 钉住的是**授权事实**(批准过的 manifest / trust / 启停 / revision)。
 * 它不保证安装目录里的内容字节此后一直没被改过 —— 逻辑页代码仍从可变的安装
 * 目录加载，只有技能目录因为越出沙箱而被拷成快照。
 */
export interface GhostInstallReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  id: string;
  revision: string;
  manifest: GhostManifest;
  localeResources: Record<string, GhostManifestLocaleResource>;
  enabled: boolean;
  trust: GhostTrustInfo;
  /**
   * 批准时点的来源指纹，仅供审计与人工比对：市场/本地包是 `.cindy` 文件哈希，
   * 随包种子是内容目录哈希。**运行时不校验它**，不要据此认为安装内容持续完整。
   */
  packageSha256?: string;
  /**
   * 按 skill item 目录钉住的批准字节指纹(`item.dir` → sha256)。声明了 skill 槽
   * 时逐项必填，没声明时是空对象。
   *
   * 这一项**是运行期判据**，与只作审计用的 `packageSha256` 不同：快照缺失需要从
   * 可变安装目录重建时，必须先重算并逐字节对上才允许重建。少了它，改写 SKILL.md
   * 正文或往技能目录塞辅助文件就能在一次"启用"里被固化成已批准快照并全局挂链，
   * 而 frontmatter 一致性校验只看 name/description，拦不住这类漂移。
   */
  skillContentSha256: Record<string, string>;
  iconDataUrl?: string;
}

export type GhostInstallReceiptReadResult =
  | { state: 'approved'; receipt: GhostInstallReceipt }
  | { state: 'legacy-unapproved' }
  | { state: 'invalid'; reason: string };

/** Host-owned receipt store：严格读取、同目录临时文件 + rename 原子提交。 */
export class GhostInstallReceiptStore {
  constructor(private readonly getRootDir: () => string) {}

  rootDir(): string {
    return path.resolve(this.getRootDir());
  }

  read(id: string): GhostInstallReceiptReadResult {
    const receiptPath = this.receiptPath(id);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'legacy-unapproved' };
      }
      return {
        state: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
      return { state: 'invalid', reason: 'receipt 不是普通文件或超过大小上限' };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as unknown;
      const validated = validateReceipt(parsed, id);
      return validated.ok
        ? { state: 'approved', receipt: validated.receipt }
        : { state: 'invalid', reason: validated.reason };
    } catch (error) {
      return {
        state: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 写入批准事实。`skillSourceDir` 是快照缺失时的取字节来源:装入/更新传新
   * 内容目录，纯状态改写(启停)传当前安装目录即可自愈。
   *
   * `requireSkillSnapshot: false` 用于**必须成功的收敛方向**(停用):快照
   * 已被外部删掉时不该把插件卡在"既不能用也不能关"的状态，此时按无 skill
   * 落链继续写批准事实，由对账撤掉链接。
   */
  async write(
    receipt: GhostInstallReceipt,
    options: { skillSourceDir?: string; requireSkillSnapshot?: boolean } = {},
  ): Promise<void> {
    const validated = validateReceipt(receipt, receipt.id);
    if (!validated.ok) throw new Error(`refusing to write invalid ghost receipt: ${validated.reason}`);

    const root = this.rootDir();
    await fs.promises.mkdir(root, { recursive: true });
    try {
      await this.ensureSkillSnapshot(receipt, options.skillSourceDir);
    } catch (error) {
      if (options.requireSkillSnapshot !== false) throw error;
    }
    const target = this.receiptPath(receipt.id);
    const temp = path.join(
      root,
      `.${receipt.id}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
    await this.pruneStaleSkillSnapshots(receipt);
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.receiptPath(id), { force: true });
    await fs.promises.rm(path.join(this.rootDir(), 'skill-snapshots', id), {
      recursive: true,
      force: true,
    });
  }

  skillSnapshotRoot(id: string, revision: string): string {
    if (!isValidGhostId(id) || !isRevision(revision)) {
      throw new Error('invalid ghost skill snapshot identity');
    }
    return path.join(this.rootDir(), 'skill-snapshots', id, revision);
  }

  private receiptPath(id: string): string {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for receipt path');
    return path.join(this.rootDir(), `${id}.json`);
  }

  private async ensureSkillSnapshot(
    receipt: GhostInstallReceipt,
    skillSourceDir: string | undefined,
  ): Promise<void> {
    const items = receipt.manifest.skill?.items ?? [];
    if (items.length === 0) return;
    const target = this.skillSnapshotRoot(receipt.id, receipt.revision);
    let existing: fs.Stats | null;
    try {
      existing = await fs.promises.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = null;
    }
    if (existing) {
      if (!existing.isDirectory()) {
        throw new Error('approved skill snapshot target is not a directory');
      }
      // 快照已存在**不等于**它还是被批准的那份字节:状态根里的目录同样可被同权限
      // 进程改写,而主 Agent 是顺着共享技能链接持续读它的。所以这里必须重算,
      // 不能像上一版那样直接早退信任它。
      if (await this.skillSnapshotMatchesReceipt(receipt, target)) return;
      // 对不上的快照一律不可信:删掉,退回下面的重建路径 —— 重建本身仍要过安装
      // 目录的字节校验,所以"损坏快照"能自愈,"安装字节已漂移"仍然拒。
      await fs.promises.rm(target, { recursive: true, force: true });
    }
    if (!skillSourceDir) {
      throw new Error('approved skill snapshot is missing');
    }
    const parent = path.dirname(target);
    const temp = path.join(
      parent,
      `.${receipt.revision}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    await fs.promises.mkdir(parent, { recursive: true });
    try {
      await fs.promises.mkdir(temp, { recursive: false });

      // 顺序是安全要点,不要改回"先校验源目录、再复制":源目录随时可被同权限进程
      // 改写,校验和复制各读一次就有一个可换字节的窗口,复制出来的快照可能不是被
      // 校验过的那一份。因此**先复制到 temp,再对 temp 里(即将成为快照的)那份字节
      // 做全部权威校验**,校验通过才 rename 就位。
      for (const item of items) {
        // 与算指纹同一个解析入口:逐段确认真目录,挡住"中间段被换成链接"这条从技能
        // 目录之外取字节的路子。两侧必须共用,否则一侧穿透、一侧不穿透,复制的和
        // 算指纹的就不是同一组字节。
        const source = await resolveGhostContentPath(skillSourceDir, item.dir, {
          expect: 'directory',
          label: 'approved skill',
        });
        // 复制前的便宜预检:只为早失败、少做无用功(避免整份拷一个超大 SKILL.md)。
        // **这不是安全边界** —— 它读的是可变源目录,结论随时可能过期,真正说话的是
        // 下面对 temp 的校验。
        const sourceSkillMdStat = await fs.promises
          .lstat(path.join(source, 'SKILL.md'))
          .catch(() => null);
        if (
          sourceSkillMdStat &&
          (!sourceSkillMdStat.isFile() || sourceSkillMdStat.size > GHOST_SKILL_MD_MAX_BYTES)
        ) {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is not a regular file or exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`,
          );
        }
        await copyRegularDirectory(source, path.join(temp, ...item.dir.split('/')));
      }

      // 权威校验一律针对 temp:此刻这些字节已经脱离可变安装目录,复制期间被换过也
      // 会在这里暴露。**尺寸上限必须排在算指纹之前** —— 源目录那道预检不是安全边界
      // (预检后可被换成超大文件),若先算指纹就等于上限在权威路径上一次都没生效。
      for (const item of items) {
        const copiedSkillMdPath = path.join(temp, ...item.dir.split('/'), 'SKILL.md');
        // 包一层领域错误:这一段现在排在算指纹之前,SKILL.md 缺失时若直接抛裸 ENOENT,
        // 日志里就看不出是"技能内容被动过"这件事(只有被篡改时才可达,两种写法都
        // fail closed,纯粹为可读性)。
        const copiedSkillMdStat = await fs.promises.lstat(copiedSkillMdPath).catch((error) => {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is unreadable in the snapshot: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        if (!copiedSkillMdStat.isFile() || copiedSkillMdStat.size > GHOST_SKILL_MD_MAX_BYTES) {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is not a regular file or exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`,
          );
        }
      }
      // 指纹判定走与"接受既有快照""发布后复核"同一个 helper:同一判据只有一份实现,
      // 否则三处各写一遍、日后只改其中一处,就是这条链路前几轮反复出问题的形态。
      if (!(await this.skillSnapshotMatchesReceipt(receipt, temp))) {
        throw new Error(
          `approved skill content for ${receipt.id} no longer matches the bytes approved at install time`,
        );
      }
      for (const item of items) {
        // 指纹相符已经蕴含 frontmatter 一致(批准时点那份过过这道校验),这里重跑一遍
        // 是防止钉指纹那条路径本身有 bug,并给出更具体的错误。
        const consistencyError = checkSkillMdConsistency(
          await fs.promises.readFile(path.join(temp, ...item.dir.split('/'), 'SKILL.md'), 'utf8'),
          item,
        );
        if (consistencyError) {
          throw new Error(`approved skill ${item.dir} is inconsistent: ${consistencyError}`);
        }
      }

      await fs.promises.rename(temp, target);

      // rename 之前 temp 位于状态根内、同权限进程仍可改写它,所以就位之后再核一遍:
      // 这一步把"校验通过 → rename"之间那段窗口收掉 —— 在那段里被换过的字节到这里
      // 会暴露,并且不会留在盘上。
      //
      // 残留窗口(已知、未关):这次核对之后、主 Agent 顺着共享技能链接读取之前,快照
      // 仍可被改写。要真正关掉需要给状态根写保护或在消费侧校验,都不在本函数范围内;
      // 该缺口已正式登记在 docs/dev-rules/plugin-security-and-authoring.md 第 6 节
      // (与"内容根字节可变"是两条并列的不同缺口)。
      if (!(await this.skillSnapshotMatchesReceipt(receipt, target))) {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
        throw new Error('approved skill snapshot changed while being published');
      }
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 快照目录里的字节是否仍等于 receipt 钉住的批准指纹。
   *
   * 三处调用共用同一判据(接受既有快照 / 复制后发布前 / 发布后复核) —— 这类判定散落
   * 多处再各写一遍,就是本 PR 前几轮反复出问题的成因。读不动或含非普通条目一律按
   * 不匹配处理:调用方对"不匹配"的收敛动作都是删掉重建或拒绝,始终 fail closed。
   */
  async skillSnapshotMatchesReceipt(
    receipt: GhostInstallReceipt,
    snapshotDir: string,
  ): Promise<boolean> {
    const actual = await hashApprovedSkillContent(receipt.manifest, snapshotDir).catch(
      () => null,
    );
    if (!actual) return false;
    return (receipt.manifest.skill?.items ?? []).every(
      (item) => actual[item.dir] === receipt.skillContentSha256[item.dir],
    );
  }

  /**
   * 回收同一插件下非当前 revision 的技能快照与崩溃残留的 `.tmp` 目录。
   *
   * 只在新 receipt 已经原子提交之后跑:此刻旧 revision 已不是批准事实，留着
   * 就是每次更新泄漏一份完整拷贝。共享技能根里指向旧 revision 的链接会因此
   * 短暂断链，直到下一轮对账重指——对越出沙箱的 skill 槽来说，短暂"技能不可
   * 用"是正确的收敛方向，留着旧批准版本继续生效不是。
   *
   * best-effort:批准事实已经落盘，回收失败只记为待清理状态，不回滚安装。
   */
  private async pruneStaleSkillSnapshots(receipt: GhostInstallReceipt): Promise<void> {
    const parent = path.join(this.rootDir(), 'skill-snapshots', receipt.id);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.name !== receipt.revision)
        .map((entry) =>
          fs.promises
            .rm(path.join(parent, entry.name), { recursive: true, force: true })
            .catch(() => undefined),
        ),
    );
  }
}

export function createGhostInstallReceipt(input: {
  manifest: GhostManifest;
  localeResources: Record<string, GhostManifestLocaleResource>;
  enabled: boolean;
  trust: GhostTrustInfo;
  /** 由 `hashApprovedSkillContent` 从**这次批准的内容目录**现算，不可沿用旧值。 */
  skillContentSha256: Record<string, string>;
  packageSha256?: string;
  iconDataUrl?: string;
}): GhostInstallReceipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    id: input.manifest.id,
    revision: crypto.randomUUID(),
    manifest: input.manifest,
    localeResources: input.localeResources,
    enabled: input.enabled,
    trust: input.trust,
    skillContentSha256: input.skillContentSha256,
    ...(input.packageSha256 ? { packageSha256: input.packageSha256 } : {}),
    ...(input.iconDataUrl ? { iconDataUrl: input.iconDataUrl } : {}),
  };
}

/**
 * 逐 skill item 目录算规范化内容指纹(排序后的相对路径 + 字节)。
 *
 * 判据全部取自 `ghostContentTree`(路径逐段解析 + 条目类型判定 + 指纹格式),与
 * 快照拷贝侧 `copyRegularDirectory`、安装目录漂移指纹 `hashApprovedDirectory`、
 * 随包种子指纹 `fingerprintDirContent` 共用同一份实现。差异只有显式策略:技能
 * 目录**不跳过点开头条目**(技能指令可以引用目录里的任意文件,漏掉一类就是漏掉
 * 一条改写通道),非普通条目一律拒。
 */
export async function hashApprovedSkillContent(
  manifest: GhostManifest,
  sourceDir: string | undefined,
): Promise<Record<string, string>> {
  const items = manifest.skill?.items ?? [];
  if (items.length === 0) return {};
  if (!sourceDir) throw new Error('skill content hash requires a source directory');
  const result: Record<string, string> = {};
  for (const item of items) {
    const itemRoot = await resolveGhostContentPath(sourceDir, item.dir, {
      expect: 'directory',
      label: 'approved skill',
    });
    const { files } = await collectGhostContentFiles(itemRoot, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: `approved skill ${item.dir}`,
    });
    result[item.dir] = await hashGhostContentFiles(itemRoot, files);
  }
  return result;
}

function validateReceipt(
  raw: unknown,
  expectedId: string,
): { ok: true; receipt: GhostInstallReceipt } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'receipt 必须是对象' };
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return { ok: false, reason: 'receipt schemaVersion 不受支持' };
  }
  if (value.id !== expectedId || !isValidGhostId(expectedId)) {
    return { ok: false, reason: 'receipt id 与安装目录不一致' };
  }
  if (typeof value.revision !== 'string' || !isRevision(value.revision)) {
    return { ok: false, reason: 'receipt revision 不合法' };
  }
  const manifestResult = validateGhostManifest(value.manifest);
  if (!manifestResult.ok || manifestResult.manifest.id !== expectedId) {
    return {
      ok: false,
      reason: manifestResult.ok ? 'receipt manifest id 不一致' : manifestResult.reason,
    };
  }
  if (typeof value.enabled !== 'boolean') {
    return { ok: false, reason: 'receipt enabled 不合法' };
  }
  const trust = validateTrust(value.trust);
  if (!trust) return { ok: false, reason: 'receipt trust 不合法' };
  if (
    value.packageSha256 !== undefined &&
    (typeof value.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.packageSha256))
  ) {
    return { ok: false, reason: 'receipt packageSha256 不合法' };
  }
  // 技能字节指纹是运行期判据,必填且键集必须与清单声明严格一致 —— 留"字段缺失就
  // 跳过校验"的可选口子等于给漂移留一条绕过路径。receipt 格式尚未随任何版本发布,
  // 不存在需要兼容的旧 receipt。
  const skillContentSha256: Record<string, string> = {};
  {
    const raw = value.skillContentSha256;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'receipt skillContentSha256 不合法' };
    }
    const expectedDirs = (manifestResult.manifest.skill?.items ?? [])
      .map((item) => item.dir)
      .sort();
    const actualDirs = Object.keys(raw as Record<string, unknown>).sort();
    if (
      expectedDirs.length !== actualDirs.length ||
      expectedDirs.some((dir, index) => dir !== actualDirs[index])
    ) {
      return { ok: false, reason: 'receipt skillContentSha256 与 manifest 声明不一致' };
    }
    for (const [dir, digest] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
        return { ok: false, reason: `receipt skillContentSha256 不合法:${dir}` };
      }
      skillContentSha256[dir] = digest;
    }
  }
  if (
    value.iconDataUrl !== undefined &&
    (
      typeof value.iconDataUrl !== 'string' ||
      Buffer.byteLength(value.iconDataUrl, 'utf8') > MAX_ICON_DATA_URL_BYTES ||
      !ICON_DATA_URL_RE.test(value.iconDataUrl)
    )
  ) {
    return { ok: false, reason: 'receipt iconDataUrl 不合法' };
  }
  if (!value.localeResources || typeof value.localeResources !== 'object' || Array.isArray(value.localeResources)) {
    return { ok: false, reason: 'receipt localeResources 不合法' };
  }
  const expectedLocalePaths = [
    ...new Set(Object.values(manifestResult.manifest.locales ?? {})),
  ].sort();
  const actualLocalePaths = Object.keys(
    value.localeResources as Record<string, unknown>,
  ).sort();
  if (
    expectedLocalePaths.length !== actualLocalePaths.length ||
    expectedLocalePaths.some((localePath, index) => localePath !== actualLocalePaths[index])
  ) {
    return { ok: false, reason: 'receipt localeResources 与 manifest 声明不一致' };
  }
  const localeResources: Record<string, GhostManifestLocaleResource> = {};
  for (const [localePath, resource] of Object.entries(
    value.localeResources as Record<string, unknown>,
  )) {
    if (Buffer.byteLength(JSON.stringify(resource), 'utf8') > GHOST_LOCALE_MAX_BYTES) {
      return { ok: false, reason: `receipt locale 超过大小上限:${localePath}` };
    }
    const validated = validateGhostManifestLocaleResource(resource, manifestResult.manifest);
    if (!validated.ok) return { ok: false, reason: `receipt locale 不合法:${localePath}` };
    localeResources[localePath] = validated.resource;
  }
  return {
    ok: true,
    receipt: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      id: expectedId,
      revision: value.revision,
      manifest: manifestResult.manifest,
      localeResources,
      enabled: value.enabled,
      trust,
      skillContentSha256,
      ...(typeof value.packageSha256 === 'string'
        ? { packageSha256: value.packageSha256 }
        : {}),
      ...(typeof value.iconDataUrl === 'string' ? { iconDataUrl: value.iconDataUrl } : {}),
    },
  };
}

function isRevision(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

async function copyRegularDirectory(source: string, target: string): Promise<void> {
  // 类型判据与 hashApprovedSkillContent 同源(ghostContentTree):两侧必须同形,
  // 否则指纹算的和快照拷的可能不是同一组字节。
  if ((await classifyGhostDirEntry(source)) !== 'directory') {
    throw new Error(`skill source is not a directory: ${source}`);
  }
  await fs.promises.mkdir(target, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const kind = await classifyGhostDirEntry(from);
    if (!isRegularGhostDirEntry(kind)) {
      throw new Error(
        `skill snapshot rejects ${kind === 'link' ? 'link' : 'non-regular'} entry: ${from}`,
      );
    }
    if (kind === 'directory') {
      await copyRegularDirectory(from, to);
    } else {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
}

function validateTrust(raw: unknown): GhostTrustInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    !['cindy-official', 'reviewed', 'verified-publisher', 'unverified'].includes(
      String(value.level),
    ) ||
    typeof value.publisherSigned !== 'boolean' ||
    typeof value.publisherVerified !== 'boolean' ||
    typeof value.reviewed !== 'boolean'
  ) {
    return null;
  }
  const optionalStrings = [
    'publisherName',
    'publisherKeyId',
    'reviewerName',
  ] as const;
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  if (value.unknownReviewer !== undefined && typeof value.unknownReviewer !== 'boolean') {
    return null;
  }
  return value as unknown as GhostTrustInfo;
}
