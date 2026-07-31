/**
 * 自定义市场插件的安装管道。
 *
 * 复用服务端市场的装入出口（installOrUpdateMarketGhostPackage）：打包 →
 * inspect 校验 → 原子换目录 → 布局停靠，全部走同一条已验证路径。差异只在
 * 包来源与信任闸：
 * - 包字节来自用户添加的 Git/本地源，未经 plugin-server 校验，因此保留前缀
 *   闸（cindy- 等官方 id）与服务端市场相反——按本地 .cindy 装入语义拒绝。
 * - 打包产物落系统临时目录（唯一文件名），装完即删，不污染市场克隆缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { app } from 'electron';

import {
  validateGhostManifest,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import {
  installOrUpdateMarketGhostPackage,
  rejectReservedGhostIdForCustomMarket,
} from '../cindy-brain/index.js';
import { packGhostDirToFile } from '../cindy-brain/forge.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * 把插件目录装成运行中的 Ghost。
 *
 * expected 是 Renderer 确认框实际审阅过的完整 manifest；这里重读 ghost.json
 * 逐字比对，确认到打包之间目录被改动时拒绝滑入（与服务端市场的
 * expectedReleaseId 同一防线，但自定义市场必须核对权限与能力声明本身）。
 */
export async function installCustomMarketPlugin(input: {
  pluginDir: string;
  expected: GhostManifest;
  /**
   * 打包完成后、实际改动 Ghost 运行时之前调用的校验钩(可异步)。
   * 自定义市场按调用方捕获的账户审阅 manifest;打包是异步的,装出前必须
   * 重新确认会话未漂移,避免把 A 审阅的插件装进当前账户 B 的运行时。
   * 跨来源 ghostId 所有权也在这里复核——打包耗时,期间另一窗口可能添加了
   * 声明同一 ghostId 的来源。
   */
  beforeCommit?: () => void | Promise<void>;
}): Promise<InstalledGhost> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await fs.promises.readFile(path.join(input.pluginDir, 'ghost.json'), 'utf8'),
    );
  } catch {
    throwIpcError('GHOST_FILE_INVALID', 'The Plugin manifest is missing or unreadable');
  }
  // 前置快速失败:清单非法或官方保留 id 直接拒,避免无谓打包。
  const validated = validateGhostManifest(raw);
  if (!validated.ok) {
    throwIpcError('GHOST_FILE_INVALID', validated.reason);
  }
  rejectReservedGhostIdForCustomMarket(validated.manifest.id);

  const tempPath = path.join(
    app.getPath('temp'),
    `cindy-custom-market-${validated.manifest.id}-${crypto.randomUUID()}.cindy`,
  );
  try {
    const packed = await packGhostDirToFile(input.pluginDir, tempPath);
    if (!packed.ok) {
      throwIpcError(
        packed.errorCode === 'TOO_LARGE' || packed.errorCode === 'MANIFEST_INVALID'
          ? 'GHOST_FILE_INVALID'
          : packed.errorCode === 'DIR_NOT_FOUND'
            ? 'NOT_FOUND'
            : 'INTERNAL',
        packed.message,
      );
    }
    // 唯一防篡改防线:比对实际打进包的 manifest,而非打包前磁盘上的 ghost.json。
    // 堵住"前置比对通过后、打包读取文件前"目录被改(保持 id/version 却新增
    // 权限声明)的窗口——装的就是 packed.manifest,必须以它为准。
    if (JSON.stringify(packed.manifest) !== JSON.stringify(input.expected)) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'Plugin changed after permission review',
      );
    }
    // 装出前最后防线:打包期间账号可能已切换、也可能有别的来源声明了同一 ghostId。
    await input.beforeCommit?.();
    return await installOrUpdateMarketGhostPackage(tempPath, {
      ghostId: validated.manifest.id,
      version: validated.manifest.version,
    });
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
