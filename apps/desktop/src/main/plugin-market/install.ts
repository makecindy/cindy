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
}): Promise<InstalledGhost> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await fs.promises.readFile(path.join(input.pluginDir, 'ghost.json'), 'utf8'),
    );
  } catch {
    throwIpcError('GHOST_FILE_INVALID', 'The Plugin manifest is missing or unreadable');
  }
  const validated = validateGhostManifest(raw);
  if (!validated.ok) {
    throwIpcError('GHOST_FILE_INVALID', validated.reason);
  }
  if (JSON.stringify(validated.manifest) !== JSON.stringify(input.expected)) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'Plugin changed after permission review',
    );
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
    return await installOrUpdateMarketGhostPackage(tempPath, {
      ghostId: validated.manifest.id,
      version: validated.manifest.version,
    });
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
