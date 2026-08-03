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
import { createLogger } from '../logger.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { redactAbsolutePaths } from './sources/git.js';
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
const log = createLogger('plugin-market-install');

/** 进 IPC 的打包/校验详情统一脱敏(宿主路径、控制符)并截断,原文留 main 日志。 */
function sanitizeInstallDetail(message: string): string {
  return (
    redactAbsolutePaths(message)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .slice(0, 256)
  );
}

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
  /**
   * 落位成功后、仍在 `withCommitLock` 内执行的溯源写入钩。
   *
   * 账本写入必须与落位同锁:放在锁外时,另一条路径(本地 .cindy 装入/更新)可以
   * 插在"包已落位"与"写下溯源"之间换掉同 id 的包,账本随后认领一个其实已被替换
   * 的包。抛错则整个安装按失败上报(包已落位,由调用方决定补偿)。
   */
  afterCommit?: () => Promise<void>;
}): Promise<InstalledGhost> {
  // input.pluginDir 是发现层已 realpath、且已校验落在市场根内的规范路径。
  // 发现之后、打包之前,若插件目录或其某个父目录被换成指向市场外的符号链接,
  // 重新 realpath 会解析到别处——只要外部目录留着同样的 ghost.json,清单摘要
  // 复核发现不了(它只比对清单本身),市场外的 payload 就会被打包安装。
  // 这里要求重解析结果**仍等于发现时的规范路径**:任一路径段被换成链接都会
  // 让 realpath 改变,直接拒绝(比只锚新解析目录更严——那等于跟着链接走)。
  // 刻意放在下面那个 try 之外:它的 catch 会把一切压成"清单读不出来"的通用
  // 文案,这条的原因需要如实区分。
  let realPluginDir: string;
  try {
    realPluginDir = await fs.promises.realpath(input.pluginDir);
  } catch {
    throwIpcError('GHOST_FILE_INVALID', 'The Plugin directory is unreadable');
  }
  if (realPluginDir !== input.pluginDir) {
    throwIpcError('GHOST_FILE_INVALID', 'The Plugin directory changed after discovery');
  }
  let raw: unknown;
  try {
    // 与发现层同一把闸(单句柄限量读,拒符号链接):本地市场目录仍是用户可写的
    // 活目录,按路径无界 readFile 会被换成超大文件或 /dev/zero 链接卡死 main。
    // containWithin 再堵 ghost.json 这一层自身被换成根外链接的窗口。
    const bytes = await readBoundedFileNoFollow(
      path.join(realPluginDir, 'ghost.json'),
      GHOST_MANIFEST_MAX_BYTES,
      { containWithin: realPluginDir },
    );
    if (bytes === null) throw new Error('not a bounded regular file');
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    // 已经带 code 的 IPC 错误如实上抛,不被下面的通用文案覆盖。
    if (isIpcError(error)) throw error;
    // Renderer 只拿到通用文案(不泄露宿主细节),但 main 日志必须留下原始原因:
    // 少了这一行,"清单确实损坏"与"有人中途替换了插件目录"在事后排查时无从区分。
    log.warn('custom market plugin manifest unreadable', {
      detail: sanitizeInstallDetail(error instanceof Error ? error.message : String(error)),
    });
    throwIpcError('GHOST_FILE_INVALID', 'The Plugin manifest is missing or unreadable');
  }
  // 前置快速失败:清单非法或官方保留 id 直接拒,避免无谓打包。
  // reason 会插值 ghost.json 里的未知字段值(不受长度约束的不可信内容),
  // packed.message 会带 fs 错误自附的宿主绝对路径——进 IPC 前一律脱敏+截断,
  // 完整原文只留 main 日志。
  const validated = validateGhostManifest(raw);
  if (!validated.ok) {
    throwIpcError('GHOST_FILE_INVALID', sanitizeInstallDetail(validated.reason));
  }
  rejectReservedGhostIdForCustomMarket(validated.manifest.id);

  const tempPath = path.join(
    app.getPath('temp'),
    `cindy-custom-market-${validated.manifest.id}-${crypto.randomUUID()}.cindy`,
  );
  try {
    // 传**已校验的规范根**(既作为打包输入,也作为打包器的锚点):打包器会核对
    // 自己解析出的 realpath 仍等于它。少了这个传递,上面那次等值校验只能证明
    // "检查那一刻是干净的"——打包器随后自己重解析,目录在这中间被换成指向市场外
    // 的链接时,它以自己解析出的结果为锚点,外部 payload 会被打包进去。
    const packed = await packGhostDirToFile(realPluginDir, tempPath, realPluginDir);
    if (!packed.ok) {
      throwIpcError(
        packed.errorCode === 'TOO_LARGE' || packed.errorCode === 'MANIFEST_INVALID'
          ? 'GHOST_FILE_INVALID'
          : packed.errorCode === 'DIR_NOT_FOUND'
            ? 'NOT_FOUND'
            : 'INTERNAL',
        sanitizeInstallDetail(packed.message),
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
      // 这里不传 reviewedManifest:上面那道逐字节比对(packed.manifest ===
      // input.expected)比出口处的逐项权限比对**更强**,自定义来源不存在服务端
      // 那种「投影层丢字段」的漂移面。传了是死代码,不传不是漏改。
      const installed = await installOrUpdateMarketGhostPackage(tempPath, {
        ghostId: validated.manifest.id,
        version: validated.manifest.version,
      });
      // 溯源写入与落位同锁(见 afterCommit 注释)。
      await input.afterCommit?.();
      return installed;
    };
    return await (input.withCommitLock ? input.withCommitLock(commit) : commit());
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
