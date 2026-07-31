import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ghostContentTree —— 「插件内容目录怎么读」的**唯一判据**。
 *
 * 为什么存在这个模块:插件链路上有六处各自 readdir + 判类型的实现(技能指纹、
 * 技能快照拷贝、安装目录漂移指纹、随包种子指纹、种子复制、Forge 打包收集),
 * 还有五处各自 `path.join(dir, ...rel.split('/'))` 之后再判一次类型。它们本该
 * 是同一条判据,却分别用 Dirent 类型位 / `lstat` / `stat` / realpath 钳制写过,
 * 于是每一轮审查都能在其中一处找到没覆盖的角落 —— 补一处、下一轮换另一处。
 *
 * 所以类型判定与相对路径解析在本模块各只有一份实现,差异只允许以**显式策略
 * 参数**表达(点开头条目算不算内容、非普通条目是拒还是只记状态位)。新增读插件
 * 内容的代码一律从这里取判据,不要再就地 readdir + isDirectory()。
 */

/**
 * 目录条目类型。`link` 与 `other` 都属于"非普通条目",单独区分只为错误信息
 * 能说清是链接还是别的(FIFO / 设备节点等)。
 */
export type GhostDirEntryKind = 'file' | 'directory' | 'link' | 'other';

/**
 * 类型判据的唯一实现:一律看 `lstat`,**不信 Dirent 的类型位**。
 *
 * Dirent 的类型位来自 readdir 的批量结果,当前 libuv 把 reparse point(软链与
 * Windows junction)都报成 link,但那是实现细节、Node 公开契约没保证;判据自己
 * 拿 lstat 说话,哪天类型位把 junction 报成 directory 也不会跟进去。
 */
function kindOfStat(stat: fs.Stats): GhostDirEntryKind {
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

export async function classifyGhostDirEntry(absPath: string): Promise<GhostDirEntryKind> {
  return kindOfStat(await fs.promises.lstat(absPath));
}

export function classifyGhostDirEntrySync(absPath: string): GhostDirEntryKind {
  return kindOfStat(fs.lstatSync(absPath));
}

/** 普通条目 = 真目录或普通文件;其余(链接等)一律非普通。 */
export function isRegularGhostDirEntry(kind: GhostDirEntryKind): boolean {
  return kind === 'file' || kind === 'directory';
}

export interface ResolveGhostContentPathOptions {
  /** 最终段期望的类型。 */
  expect: 'directory' | 'file';
  /** 错误信息前缀(如 `approved skill` / `bundled locale`)。 */
  label: string;
}

/**
 * 解析清单声明的相对路径,**逐段**确认每一段都是真目录 / 最终段是期望类型。
 *
 * 只 lstat 最终段是不够的:中间段被换成软链 / Windows junction 时 OS 会静默穿透
 * —— 对最终段 lstat 报的是"真目录、非链接"(已实测),于是字节从插件目录之外取。
 * 首次批准那条路径尤其致命:技能指纹是现算的,外部内容会被钉成"批准字节"再复制
 * 成快照,而 `checkSkillMdConsistency` 只校验 frontmatter 的 name/description,
 * 这两个值在 manifest 里公开可抄,拦不住。
 *
 * `baseDir` 自身不在这里校验(它由调用方给出:安装根下的 `<id>` 若被换成链接,
 * `GhostManager.list()` 的 `entry.isDirectory()` 已经把它整条跳过;状态根下的
 * temp / 快照目录是宿主自己创建的)。相对路径的结构安全由清单校验保证
 * (`isSafeGhostRelativePath` / skill dir 正则:无盘符、无反斜杠、无 `.`/`..` 段)。
 */
export async function resolveGhostContentPath(
  baseDir: string,
  relPath: string,
  options: ResolveGhostContentPathOptions,
): Promise<string> {
  const segments = relPath.split('/').filter((segment) => segment.length > 0);
  let current = baseDir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    assertSegment(
      await classifyGhostDirEntry(current),
      index === segments.length - 1 ? options.expect : 'directory',
      relPath,
      options.label,
    );
  }
  return current;
}

export function resolveGhostContentPathSync(
  baseDir: string,
  relPath: string,
  options: ResolveGhostContentPathOptions,
): string {
  const segments = relPath.split('/').filter((segment) => segment.length > 0);
  let current = baseDir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    assertSegment(
      classifyGhostDirEntrySync(current),
      index === segments.length - 1 ? options.expect : 'directory',
      relPath,
      options.label,
    );
  }
  return current;
}

function assertSegment(
  kind: GhostDirEntryKind,
  expect: 'directory' | 'file',
  relPath: string,
  label: string,
): void {
  if (kind === 'link') {
    throw new Error(`${label} path segment is a link: ${relPath}`);
  }
  if (kind !== expect) {
    throw new Error(
      `${label} path segment is not a ${expect === 'directory' ? 'directory' : 'regular file'}: ${relPath}`,
    );
  }
}

export interface CollectGhostContentOptions {
  /**
   * 点开头条目:`include` = 算内容(技能目录 —— 技能指令可以引用目录里的任意
   * 文件,漏掉一类就是漏掉一条改写通道);`skip` = 不算内容(安装目录 / 随包种子
   * —— `.disabled`、`.cindy-trust.json` 是用户与宿主状态,不是插件内容)。
   *
   * `skip` 下点开头条目仍然**要过类型判定**:名为 `.x` 的链接不进内容指纹,但
   * 会按 `nonRegular` 策略处理。点开头**目录**整条跳过(不递归、不进指纹):清单
   * 声明的相对路径首字符必须是 `[a-zA-Z0-9_]`,任何声明都不可能指向点开头目录里
   * 的文件,所以它们既不会被当代码加载、也不会被当技能读取。
   */
  dotEntries: 'include' | 'skip';
  /**
   * 非普通条目(链接 / FIFO 等):`throw` = 立即拒(授权判据路径);`flag` = 只翻
   * `hasNonRegularEntry`,不进内容指纹(对账判据路径 —— 需要"判不一致"而不是抛错,
   * 才能走重新播种把目录换回随包字节)。
   *
   * `flag` 下**不能拿 sentinel 喂进哈希**:任何 sentinel 都能被"同路径下内容恰好
   * 等于该 sentinel 的普通文件"撞上(已实测:内容为 `non-regular` 的普通文件与同名
   * junction 的摘要完全相等),于是被塞进链接的目录仍会被判成逐字节相同。所以类型
   * 状态是独立字段,不掺进字节流。
   */
  nonRegular: 'throw' | 'flag';
  /** 错误信息前缀。 */
  label: string;
}

export interface GhostContentTree {
  /** 普通文件的相对路径(正斜杠归一化保证双平台一致),已排序。 */
  files: string[];
  /** 是否遇到过非普通条目(仅 `nonRegular: 'flag'` 时可能为 true)。 */
  hasNonRegularEntry: boolean;
}

/** 递归收集目录里的普通文件相对路径;类型判定与策略见 `CollectGhostContentOptions`。 */
export async function collectGhostContentFiles(
  rootDir: string,
  options: CollectGhostContentOptions,
): Promise<GhostContentTree> {
  const files: string[] = [];
  let hasNonRegularEntry = false;

  const collect = async (relativeDir: string): Promise<void> => {
    const absoluteDir = path.join(rootDir, ...relativeDir.split('/').filter(Boolean));
    for (const entry of await fs.promises.readdir(absoluteDir, { withFileTypes: true })) {
      const isDotEntry = entry.name.startsWith('.');
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const kind = await classifyGhostDirEntry(path.join(absoluteDir, entry.name));
      if (!isRegularGhostDirEntry(kind)) {
        // 类型判定排在点开头过滤**之前**:名为 `.x` 的链接同样是一条改写通道,
        // 不能因为"点开头不算内容"就连它是不是链接都不看。
        if (options.nonRegular === 'throw') {
          throw new Error(
            `${options.label} rejects ${kind === 'link' ? 'link' : 'non-regular'} entry: ${relativePath}`,
          );
        }
        hasNonRegularEntry = true;
        continue;
      }
      if (isDotEntry && options.dotEntries === 'skip') continue;
      if (kind === 'directory') {
        await collect(relativePath);
      } else {
        files.push(relativePath);
      }
    }
  };

  await collect('');
  files.sort();
  return { files, hasNonRegularEntry };
}

/**
 * 内容指纹:版本前缀 + 长度前缀路径 + 每文件 SHA-256。
 *
 * 不使用 `path \0 bytes \0` 这类分隔符编码:文件内容可以合法包含 NUL,于是
 * `{ a: "x\0b\0y" }` 与 `{ a: "x", b: "y" }` 会在进入 SHA-256 前形成完全
 * 相同的字节流。路径使用 UTF-8 字节长度前缀,文件内容先流式收成固定 32 字节摘要,
 * 因此文件边界无歧义。
 *
 * 文件仍然流式读取,不整份进内存 —— 插件目录里除 SKILL.md 之外的文件没有尺寸
 * 上限,整份 readFile 会让一个塞进来的超大文件把 Host 撑爆。
 */
export async function hashGhostContentFiles(
  rootDir: string,
  files: readonly string[],
): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update('cindy-ghost-content-v2\0');
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const pathLength = Buffer.allocUnsafe(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.byteLength));
    hash.update(pathLength);
    hash.update(pathBytes);

    const fileHash = crypto.createHash('sha256');
    const stream = fs.createReadStream(path.join(rootDir, ...relativePath.split('/')));
    for await (const chunk of stream) fileHash.update(chunk as Buffer);
    hash.update(fileHash.digest());
  }
  return hash.digest('hex');
}
