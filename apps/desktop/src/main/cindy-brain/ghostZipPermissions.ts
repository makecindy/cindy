/**
 * ZIP external-attribute 权限位的唯一归一化入口:解包侧(安装器)、打包侧
 * (forge / export)与重打包侧(签名 / 审核)共用同一套判据,避免各自写一份掩码。
 */

/** POSIX `st_mode` 分区:文件类型位、普通权限位。 */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const PERMISSION_BITS = 0o777;

/**
 * 归档里普通文件 / 目录的缺省形态:DOS 包没有 Unix 元数据时的回落值,也是宿主
 * 自己生成(而非从磁盘读取)的条目该用的属性。
 */
export const ARCHIVE_REGULAR_0644 = S_IFREG | 0o644;
const ARCHIVE_DIR_0755 = S_IFDIR | 0o755;

/**
 * Parse JSZip's public `unixPermissions` union without relying on its current
 * load-time normalization to numbers. String permissions are octal by contract.
 */
function parseZipUnixPermissions(
  unixPermissions: number | string | null | undefined,
): number | null {
  if (typeof unixPermissions === 'number') {
    return Number.isSafeInteger(unixPermissions) && unixPermissions >= 0 ? unixPermissions : null;
  }
  if (typeof unixPermissions !== 'string' || !/^[0-7]+$/.test(unixPermissions)) {
    return null;
  }
  const parsed = Number.parseInt(unixPermissions, 8);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 文件类型位为 0 = 未声明,按调用方期待的类型采信;否则必须严格匹配。 */
function declaresType(mode: number, type: number): boolean {
  const fileType = mode & S_IFMT;
  return fileType === 0 || fileType === type;
}

/** 归档声明的符号链接:装入侧一律拒绝,不跟随、不落盘。 */
export function isZipSymbolicLinkMode(
  unixPermissions: number | string | null | undefined,
): boolean {
  const parsed = parseZipUnixPermissions(unixPermissions);
  return parsed !== null && (parsed & S_IFMT) === S_IFLNK;
}

/**
 * 把真实文件的 mode 转成归档用的普通文件属性。只取 rwx 九位:setuid / setgid /
 * sticky 与宿主的文件类型位都是本机元数据,绝不能进可分发的 `.cindy`。JSZip 需要
 * POSIX 文件类型位才能写出符合规范的 UNIX external attributes。
 */
export function unixRegularFilePermissionsForArchive(mode: number | bigint): number {
  return S_IFREG | (Number(mode) & PERMISSION_BITS);
}

/**
 * Normalize an archive-declared mode before applying it to an extracted file.
 *
 * `& 0o777` strips file-type and special bits so an archive cannot install
 * setuid/setgid/sticky files. `| 0o600` keeps the owner able to read and replace
 * even a malicious mode-000 entry, which is required for later update/uninstall.
 * Missing metadata is deliberately ignored for compatibility with DOS/legacy
 * packages. Windows is also ignored because chmod there only changes the
 * read-only attribute. The caller must use chmod *after* writeFile: writeFile's
 * creation mode is filtered by umask, whereas chmod deterministically restores
 * an archived 0755 as 0755.
 *
 * Directory entries are handled separately by the extractor. When an archive
 * declares a non-regular UNIX file type, no mode is applied to the regular file
 * bytes that JSZip exposes.
 */
export function installedFileModeFromZip(
  unixPermissions: number | string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform === 'win32') return null;
  const parsed = parseZipUnixPermissions(unixPermissions);
  if (parsed === null || !declaresType(parsed, S_IFREG)) return null;
  // 篡改包或权限设置粗心的包不得把 group/world 可写文件装进插件内容目录，
  // 否则同机其它账号可改写受害用户之后会执行的插件代码。
  return (parsed & PERMISSION_BITS & ~0o022) | 0o600;
}

/**
 * Re-emit an already loaded ZIP entry on the UNIX platform without carrying
 * special/file-type bits. DOS entries receive ordinary deterministic defaults;
 * non-regular UNIX entries are downgraded to a non-executable regular file.
 */
export function unixPermissionsForRepackedEntry(
  unixPermissions: number | string | null | undefined,
  isDirectory: boolean,
): number {
  const parsed = parseZipUnixPermissions(unixPermissions);
  if (parsed === null) return isDirectory ? ARCHIVE_DIR_0755 : ARCHIVE_REGULAR_0644;
  if (isDirectory) {
    return declaresType(parsed, S_IFDIR) ? S_IFDIR | (parsed & PERMISSION_BITS) : ARCHIVE_DIR_0755;
  }
  if (!declaresType(parsed, S_IFREG)) return ARCHIVE_REGULAR_0644;
  return S_IFREG | (parsed & PERMISSION_BITS);
}
