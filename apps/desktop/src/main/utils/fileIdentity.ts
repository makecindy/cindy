/** 可用于路径 stat 与已打开句柄 stat 的最小文件身份。 */
export interface FileIdentity<T extends number | bigint = number | bigint> {
  dev: T;
  ino: T;
}

function isZero(value: number | bigint): boolean {
  return value === 0 || value === 0n;
}

function hasExactBigIntIdentity(
  left: FileIdentity<number | bigint>,
  right: FileIdentity<number | bigint>,
): boolean {
  return (
    typeof left.dev === 'bigint' &&
    typeof left.ino === 'bigint' &&
    typeof right.dev === 'bigint' &&
    typeof right.ino === 'bigint'
  );
}

/**
 * 比较两个文件身份。Windows 的路径 stat 可能令双方 dev 都为 0；只要两边
 * 非零 FileId 相等即可继续比较其它版本字段。其它平台或缺失 FileId 时拒绝。
 *
 * **这是弱变体，只适用于「同一个已打开句柄的前后两次 stat」这类两端同源的比对**
 * （两端都是 handle stat 时 dev 都是真实卷序列号，两端同时为 0 的分支实际取不到）。
 * 路径 stat 与句柄 stat 的比对必须用 {@link samePathAndHandleFileIdentity}：
 * 那条路径上「两边 dev 都为 0」意味着只剩 ino 单独作证，而 NTFS FileId 只在卷内
 * 唯一，跨卷可能撞号。调用方若拿不准，选强的那个。
 */
export function sameFileIdentity<T extends number | bigint>(
  left: FileIdentity<T>,
  right: FileIdentity<T>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isZero(left.ino) || isZero(right.ino) || left.ino !== right.ino) return false;
  if (left.dev === right.dev) {
    if (!isZero(left.dev)) return true;
    return platform === 'win32' && hasExactBigIntIdentity(left, right);
  }
  return (
    platform === 'win32' &&
    (isZero(left.dev) || isZero(right.dev)) &&
    hasExactBigIntIdentity(left, right)
  );
}

/**
 * 判断路径当前指向的文件与已打开句柄是否为同一对象。
 *
 * Windows 的路径 stat 可能固定返回 dev=0，而句柄 stat 返回真实卷序列号；
 * 此时非零且相等的 NTFS FileId(ino)仍可证明身份。该兼容只允许恰好一边
 * 缺失 dev：两边都缺失、任一 ino 缺失，或非 Windows 上缺失 dev 时仍拒绝。
 */
export function samePathAndHandleFileIdentity<T extends number | bigint>(
  pathIdentity: FileIdentity<T>,
  handleIdentity: FileIdentity<T>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!sameFileIdentity(pathIdentity, handleIdentity, platform)) return false;
  return !isZero(pathIdentity.dev) || !isZero(handleIdentity.dev);
}
