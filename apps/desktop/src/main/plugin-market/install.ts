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
import {
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileNoFollow,
} from '../utils/readBoundedFile.js';

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
  /**
   * 提交段(复核 + 落位)的互斥包装,与来源增删共享同一把锁。
   *
   * 只在 `beforeCommit` 里复核不够:它返回后 `installOrUpdateMarketGhostPackage`
   * 还要先 await 包检查才开始真正改动运行时,那段时间另一窗口仍能添加声明同一
   * ghostId 的来源,复核结论在落位前就过期了。把"复核 + 落位"整段放进锁里,
   * 来源变更插不进来。
   */
  withCommitLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<InstalledGhost> {
  let raw: unknown;
  try {
    // 与发现层同一把闸(单句柄限量读,拒符号链接):详情展示后、确认安装前,
    // 本地市场目录仍是用户可写的活目录,按路径无界 readFile 会被换成超大文件
    // 或 /dev/zero 链接卡死 main。超限/非普通文件与读取失败同语义拒绝。
    const bytes = await readBoundedFileNoFollow(
      path.join(input.pluginDir, 'ghost.json'),
      GHOST_MANIFEST_MAX_BYTES,
    );
    if (bytes === null) throw new Error('not a bounded regular file');
    raw = JSON.parse(bytes.toString('utf8'));
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
    // 复核与落位必须在同一把锁内完成,否则复核结论会在落位前过期。
    const commit = async (): Promise<InstalledGhost> => {
      await input.beforeCommit?.();
      return installOrUpdateMarketGhostPackage(tempPath, {
        ghostId: validated.manifest.id,
        version: validated.manifest.version,
      });
    };
    return await (input.withCommitLock ? input.withCommitLock(commit) : commit());
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
