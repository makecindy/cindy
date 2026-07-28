/**
 * apps/desktop/src/main/vendor/manifest.ts
 *
 * 通用 manifest 字段提取器：按入参 manifestField 索引 manifest 顶层字段，
 * 返回该 vendor 对应的 binary 资产元数据。
 *
 * 设计意图：让 Boss 2 改造时 `vendors/<vendor>/binaryProvisioner.ts` 调用
 * `getVendorAsset(manifest, '<vendor-field>')` 平滑替换硬编码字段访问；
 * Boss 4 接入新 vendor 时传入新 manifestField 即可，无需改通用代码。
 *
 * 实施铁律：本文件不出现任何 vendor 名称字面量。manifestField 100% 来自入参。
 */

import type { Manifest } from '../manifestService.js';

/** Vendor binary 资产元数据（与 manifestService.PlatformAsset / <VendorCodeManifest> 字段对齐） */
export interface VendorAsset {
  version: string;
  file: string;
  sha256: string;
  size: number;
}

/**
 * version 会成为 userData 下的一层目录名，必须是单个、有限长度的安全 path segment。
 * 这既阻断 manifest 通过 `../` / 分隔符逃逸安装根，也让后续 spawn 的命令路径只可能
 * 指向受管目录（CodeQL js/command-line-injection）。
 */
function isSafeVersionDirectoryName(value: string): boolean {
  return (
    value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

/**
 * 按 manifestField 字符串索引 manifest 顶层，提取 vendor binary 资产。
 *
 * - 字段缺失 / 类型错 → 返回 undefined（不抛错，让上层决定降级策略）
 * - 校验通过 → 显式重建对象，不透传额外字段
 *
 * 等价性：`getVendorAsset(m, '<vendor-field>')` 返回值的 4 字段
 * 与 `m.<vendor-field>` 完全相同。
 */
export function getVendorAsset(manifest: Manifest, manifestField: string): VendorAsset | undefined {
  const raw = (manifest as unknown as Record<string, unknown>)[manifestField];
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'string') return undefined;
  if (!isSafeVersionDirectoryName(obj.version)) return undefined;
  if (typeof obj.file !== 'string') return undefined;
  if (typeof obj.sha256 !== 'string') return undefined;
  if (typeof obj.size !== 'number') return undefined;
  return {
    version: obj.version,
    file: obj.file,
    sha256: obj.sha256,
    size: obj.size,
  };
}

/**
 * 拼接完整下载 URL。
 * 等价于现有 `${getBaseUrl()}/${asset.file}` 写法。
 */
export function resolveVendorAssetUrl(baseUrl: string, asset: VendorAsset): string {
  return `${baseUrl}/${asset.file}`;
}
