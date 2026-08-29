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
  ghostNetworkAuthorizationWithinCap,
  ghostNodeSecretAuthorizationWithinCap,
  ghostSetupAuthorizationWithinCap,
  ghostSettingsUiWithinCap,
  ghostSubscribeAuthorizationWithinCap,
  ghostToolParametersWithinCap,
  ghostUnknownV3FieldsWithinCap,
  unreviewedGhostPermissionItems,
  validateGhostManifest,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import {
  getGhostManager,
  installOrUpdateMarketGhostPackage,
  rejectReservedGhostIdForCustomMarket,
  type MarketGhostPackageCommitEvidence,
} from '../cindy-brain/index.js';
import type { PluginMarketInstallResult } from '../../shared/pluginMarket.js';
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
 * 这里先安全打包，再让 Main 从实际 `.cindy` 解析 canonical manifest；
 * 校验和落位始终绑定同一个临时包。
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
  expected?: GhostManifest;
  /** 更新时把发起操作时读取的 Host receipt token 贯穿到最终安装出口。 */
  expectedInstalledApproval?: string;
  expectedGhostId: string;
  expectedVersion: string;
  /**
   * 打包完成后、实际改动 Ghost 运行时之前调用的校验钩(可异步)。
   * 调用方按当前账户捕获市场 manifest;打包是异步的,装出前必须重新确认
   * 会话未漂移,避免把账户 A 选择的插件装进当前账户 B 的运行时。
   * 这里同时复核当前账号、所选来源和运行时已安装插件事实。
   */
  beforeCommit?: () => void | Promise<void>;
  /** 真实包完成检查后、即将改动运行时前的同步事务钩。 */
  beforePackagePlacement?: () => void;
  /** 新包完成原子换位后的同步事务钩。 */
  onPackagePlaced?: () => void;
  /**
   * 提交段(复核 + 落位)的互斥包装,与来源增删共享同一把锁。
   *
   * 只在 `beforeCommit` 里复核不够:它返回后 `installOrUpdateMarketGhostPackage`
   * 还要先 await 包检查才开始真正改动运行时,那段时间另一窗口仍能移除或替换
   * 所选来源,复核结论在落位前就过期了。把“复核 + 落位”整段放进锁里，来源
   * 变更插不进来。
   */
  withCommitLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * 落位成功后、仍在 `withCommitLock` 与 owner mutation lease 内执行的溯源写入钩。
   *
   * 账本写入必须与落位同锁:放在锁外时,另一条路径(本地 .cindy 装入/更新)可以
   * 插在"包已落位"与"写下溯源"之间换掉同 id 的包,账本随后认领一个其实已被替换
   * 的包。抛错则整个安装按失败上报(包已落位,由调用方决定补偿)。
   */
  afterCommit?: (
    installed: InstalledGhost,
    packagedManifest: GhostManifest,
    evidence: MarketGhostPackageCommitEvidence,
  ) => Promise<void>;
}): Promise<PluginMarketInstallResult> {
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
  if (
    validated.manifest.id !== input.expectedGhostId ||
    validated.manifest.version !== input.expectedVersion
  ) {
    throwIpcError('PRECONDITION_FAILED', 'The Plugin identity changed after selection');
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
    // 堵住前置比对通过后目录被改的窗口；expected 存在时还要与调用方选中的
    // 市场条目完全一致。
    if (
      input.expected !== undefined &&
      JSON.stringify(packed.manifest) !== JSON.stringify(input.expected)
    ) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'Plugin changed after selection',
      );
    }
    const inspected = await getGhostManager().inspect(tempPath);
    if (!('rejection' in inspected)) {
      if (
        inspected.canonicalManifest.id !== input.expectedGhostId ||
        inspected.canonicalManifest.version !== input.expectedVersion
      ) {
        throwIpcError('GHOST_FILE_INVALID', 'The packaged Plugin identity changed');
      }
      const extraCapabilities = unreviewedGhostPermissionItems(
        validated.manifest,
        undefined,
        inspected.canonicalManifest,
      );
      if (
        extraCapabilities.length > 0 ||
        !ghostNetworkAuthorizationWithinCap(validated.manifest, inspected.canonicalManifest) ||
        !ghostNodeSecretAuthorizationWithinCap(validated.manifest, inspected.canonicalManifest) ||
        !ghostSetupAuthorizationWithinCap(validated.manifest, inspected.canonicalManifest) ||
        !ghostSettingsUiWithinCap(validated.manifest, inspected.canonicalManifest) ||
        !ghostSubscribeAuthorizationWithinCap(validated.manifest, inspected.canonicalManifest) ||
        !ghostToolParametersWithinCap(validated.manifest, inspected.canonicalManifest) ||
        !ghostUnknownV3FieldsWithinCap(validated.manifest, inspected.canonicalManifest)
      ) {
        throwIpcError(
          'GHOST_FILE_INVALID',
          'The packaged Plugin capabilities exceed the selected market manifest',
        );
      }
    }
    const commit = async (): Promise<PluginMarketInstallResult> => {
      const run = async (): Promise<PluginMarketInstallResult> => {
        await input.beforeCommit?.();
        // 自定义来源已经把 Renderer 审阅的本地清单与实际打包清单逐字节绑定，
        // 不再进入官方市场“下载真实包后复核”的分支。
        const installed = await installOrUpdateMarketGhostPackage(tempPath, {
          // Main 会从真实临时包再次解析并与所选市场条目的身份核对；不能使用
          // 打包前活目录里的值，否则目录在打包窗口变化时会把另一个插件装入。
          ghostId: input.expectedGhostId,
          version: input.expectedVersion,
          // 发现时读到的规范化 Manifest 是这次安装允许的能力上限。打包窗口
          // 中目录若发生能力扩张，Host 会按真实包不一致直接拒绝。
          manifestCap: validated.manifest,
          ...(input.expectedInstalledApproval
            ? { expectedInstalledApproval: input.expectedInstalledApproval }
            : {}),
          ...(input.beforePackagePlacement
            ? { beforeCommitInLock: input.beforePackagePlacement }
            : {}),
          ...(input.onPackagePlaced
            ? { onPackagePlacedInLock: input.onPackagePlaced }
            : {}),
          ...(input.afterCommit
            ? {
                afterCommitInLock: (committed, evidence) =>
                  input.afterCommit!(committed, packed.manifest, evidence),
              }
            : {}),
        });
        return { ghost: installed };
      };
      return input.withCommitLock ? input.withCommitLock(run) : run();
    };
    return await commit();
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
