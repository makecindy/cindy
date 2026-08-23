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
  /** 收集开始时钉住的规范根身份，供后续流式哈希拒绝 collect→hash 间的根替换。 */
  rootIdentity: GhostContentRootIdentity;
}

export interface GhostContentRootIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface GhostContentAncestorIdentity {
  relativePath: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function sameFileIdentity(
  a: Pick<fs.BigIntStats, 'dev' | 'ino'>,
  b: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): boolean {
  if (a.dev === 0n || a.ino === 0n || b.dev === 0n || b.ino === 0n) return false;
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * 「读取期间这个文件没被换掉也没被改过」的统一判据。`ctimeNs` 让它同时覆盖
 * `chmod` —— 权限变化也算内容快照失效,导出侧据此拒绝把不同时刻的 mode 与字节
 * 拼进同一个归档条目。
 */
export function sameStableFileState(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return after.isFile() &&
    sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
}

function sameStableDirectoryState(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  // Filesystems may immediately reuse a deleted directory's inode. Timestamps
  // keep that replacement distinct and also expose namespace changes below it.
  return after.isDirectory() &&
    sameFileIdentity(before, after) &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
}

async function captureGhostContentRootIdentity(rootDir: string): Promise<GhostContentRootIdentity> {
  const lexicalBefore = await fs.promises.lstat(rootDir, { bigint: true });
  if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isDirectory()) {
    throw new Error(`ghost content root is not a real directory: ${rootDir}`);
  }
  const realPath = await fs.promises.realpath(rootDir);
  const [pathStat, realStat, lexicalAfter] = await Promise.all([
    fs.promises.stat(rootDir, { bigint: true }),
    fs.promises.stat(realPath, { bigint: true }),
    fs.promises.lstat(rootDir, { bigint: true }),
  ]);
  if (
    !sameStableDirectoryState(lexicalBefore, pathStat) ||
    !sameStableDirectoryState(pathStat, realStat) ||
    !sameStableDirectoryState(pathStat, lexicalAfter) ||
    lexicalAfter.isSymbolicLink()
  ) {
    throw new Error(`ghost content root is not a stable directory: ${rootDir}`);
  }
  return {
    realPath,
    dev: realStat.dev,
    ino: realStat.ino,
    mtimeNs: realStat.mtimeNs,
    ctimeNs: realStat.ctimeNs,
  };
}

async function assertGhostContentRootIdentity(
  rootDir: string,
  expected: GhostContentRootIdentity,
): Promise<void> {
  let current: GhostContentRootIdentity;
  try {
    current = await captureGhostContentRootIdentity(rootDir);
  } catch (error) {
    throw new Error(`ghost content root changed while reading: ${rootDir}`, { cause: error });
  }
  if (
    current.realPath !== expected.realPath ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mtimeNs !== expected.mtimeNs ||
    current.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error(`ghost content root changed while reading: ${rootDir}`);
  }
}

async function captureGhostContentAncestorIdentities(
  rootRealPath: string,
  relativePath: string,
): Promise<GhostContentAncestorIdentity[]> {
  const identities: GhostContentAncestorIdentity[] = [];
  const segments = relativePath.split('/').slice(0, -1);
  let absolutePath = rootRealPath;
  let currentRelativePath = '';
  for (const segment of segments) {
    absolutePath = path.join(absolutePath, segment);
    currentRelativePath = currentRelativePath ? `${currentRelativePath}/${segment}` : segment;
    const stat = await fs.promises.lstat(absolutePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`ghost content ancestor changed into a link: ${currentRelativePath}`);
    }
    identities.push({
      relativePath: currentRelativePath,
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    });
  }
  return identities;
}

function assertGhostContentAncestorIdentities(
  expected: readonly GhostContentAncestorIdentity[],
  current: readonly GhostContentAncestorIdentity[],
): void {
  if (
    current.length !== expected.length ||
    current.some(
      (identity, index) =>
        identity.relativePath !== expected[index]?.relativePath ||
        identity.dev !== expected[index]?.dev ||
        identity.ino !== expected[index]?.ino ||
        identity.mtimeNs !== expected[index]?.mtimeNs ||
        identity.ctimeNs !== expected[index]?.ctimeNs,
    )
  ) {
    throw new Error('ghost content ancestor changed while reading');
  }
}

/** 递归收集目录里的普通文件相对路径;类型判定与策略见 `CollectGhostContentOptions`。 */
export async function collectGhostContentFiles(
  rootDir: string,
  options: CollectGhostContentOptions,
): Promise<GhostContentTree> {
  const rootIdentity = await captureGhostContentRootIdentity(rootDir);
  const files: string[] = [];
  let hasNonRegularEntry = false;

  const collect = async (relativeDir: string): Promise<void> => {
    const absoluteDir = path.join(rootIdentity.realPath, ...relativeDir.split('/').filter(Boolean));
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
  await assertGhostContentRootIdentity(rootDir, rootIdentity);
  files.sort();
  return { files, hasNonRegularEntry, rootIdentity };
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
/**
 * `hashGhostContentFiles` 的内存版:对"路径 + 字节"的内存投影算同一 framing 的
 * 指纹(逐字节等价,有回归钉住)。用途:装入/更新时从 **.cindy 包本体**(不可变的
 * JSZip 投影)算批准基线,而不是从已公开的可变安装目录首读 —— 后者在 publish 与
 * 首次 hash 之间被换过的字节会自洽地成为批准事实(权威判据被污染源初始化)。
 */
export function hashGhostContentBuffers(files: readonly { path: string; bytes: Buffer }[]): string {
  const hash = crypto.createHash('sha256');
  hash.update('cindy-ghost-content-v2\0');
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const pathLength = Buffer.allocUnsafe(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.byteLength));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(crypto.createHash('sha256').update(file.bytes).digest());
  }
  return hash.digest('hex');
}

export async function hashGhostContentFiles(
  rootDir: string,
  files: readonly string[],
  collectedRootIdentity?: GhostContentRootIdentity,
): Promise<string> {
  const rootIdentity = collectedRootIdentity ?? (await captureGhostContentRootIdentity(rootDir));
  await assertGhostContentRootIdentity(rootDir, rootIdentity);
  const hash = crypto.createHash('sha256');
  hash.update('cindy-ghost-content-v2\0');
  for (const relativePath of files) {
    await assertGhostContentRootIdentity(rootDir, rootIdentity);
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const pathLength = Buffer.allocUnsafe(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.byteLength));
    hash.update(pathLength);
    hash.update(pathBytes);

    const fileHash = crypto.createHash('sha256');
    const filePath = path.join(rootIdentity.realPath, ...relativePath.split('/'));
    const ancestorIdentities = await captureGhostContentAncestorIdentities(
      rootIdentity.realPath,
      relativePath,
    );
    const noFollow = fs.constants.O_NOFOLLOW ?? null;
    const handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (noFollow ?? 0),
    );
    let handleStat: fs.BigIntStats;
    let initialRealFilePath: string | undefined;
    try {
      handleStat = await handle.stat({ bigint: true });
      if (!handleStat.isFile()) {
        throw new Error(`ghost content entry is not a regular file: ${relativePath}`);
      }
      assertGhostContentAncestorIdentities(
        ancestorIdentities,
        await captureGhostContentAncestorIdentities(rootIdentity.realPath, relativePath),
      );
      if (noFollow === null) {
        const linkStat = await fs.promises.lstat(filePath, { bigint: true });
        if (linkStat.isSymbolicLink() || !sameFileIdentity(linkStat, handleStat)) {
          throw new Error(`ghost content entry changed into a link: ${relativePath}`);
        }
      }
      const [pathStat, realFilePath] = await Promise.all([
        fs.promises.stat(filePath, { bigint: true }),
        fs.promises.realpath(filePath),
      ]);
      initialRealFilePath = realFilePath;
      const relativeRealPath = path.relative(rootIdentity.realPath, realFilePath);
      const outsideRoot =
        relativeRealPath === '..' ||
        relativeRealPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeRealPath);
      if (!sameFileIdentity(pathStat, handleStat) || outsideRoot) {
        throw new Error(`ghost content entry escaped its root: ${relativePath}`);
      }

      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) fileHash.update(chunk as Buffer);
      const afterReadStat = await handle.stat({ bigint: true });
      if (!sameStableFileState(handleStat, afterReadStat)) {
        throw new Error(`ghost content entry changed while reading: ${relativePath}`);
      }
    } finally {
      await handle.close();
    }
    const fileDigest = fileHash.digest();
    // Windows 的按路径 stat/lstat 在 rename/replace 后可能继续返回旧目录元数据。
    // 重新打开同一路径，并再次流式摘要；新句柄的 stat 也可能陈旧，字节对账才是最终证据。
    const verificationHandle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (noFollow ?? 0),
    );
    try {
      const verificationStat = await verificationHandle.stat({ bigint: true });
      if (!sameStableFileState(handleStat, verificationStat)) {
        throw new Error(`ghost content entry changed while reading: ${relativePath}`);
      }
      const verificationFileHash = crypto.createHash('sha256');
      const verificationStream = verificationHandle.createReadStream({ autoClose: false });
      for await (const chunk of verificationStream) verificationFileHash.update(chunk as Buffer);
      const afterVerificationReadStat = await verificationHandle.stat({ bigint: true });
      if (!sameStableFileState(verificationStat, afterVerificationReadStat)) {
        throw new Error(`ghost content entry changed while reading: ${relativePath}`);
      }
      if (!crypto.timingSafeEqual(fileDigest, verificationFileHash.digest())) {
        throw new Error(`ghost content entry changed while reading: ${relativePath}`);
      }
      const [afterReadPathStat, afterReadRealFilePath] = await Promise.all([
        fs.promises.lstat(filePath, { bigint: true }),
        fs.promises.realpath(filePath),
      ]);
      if (
        initialRealFilePath === undefined ||
        afterReadPathStat.isSymbolicLink() ||
        !afterReadPathStat.isFile() ||
        !sameFileIdentity(afterReadPathStat, afterVerificationReadStat) ||
        afterReadRealFilePath !== initialRealFilePath
      ) {
        throw new Error(`ghost content entry path changed while reading: ${relativePath}`);
      }
      if (!sameStableFileState(afterVerificationReadStat, afterReadPathStat)) {
        throw new Error(`ghost content entry changed while reading: ${relativePath}`);
      }
      assertGhostContentAncestorIdentities(
        ancestorIdentities,
        await captureGhostContentAncestorIdentities(rootIdentity.realPath, relativePath),
      );
    } finally {
      await verificationHandle.close();
    }
    hash.update(fileDigest);
  }
  await assertGhostContentRootIdentity(rootDir, rootIdentity);
  return hash.digest('hex');
}
