/**
 * Git 来源每个缓存版本的取包记录（契约第 2 版 V2.3）。
 *
 * git 的 `url.*.insteadOf` 可以把配置里的地址改写到另一个仓库。展示与远程投影里的 `repository`
 * 因此取**实际取包地址**：每次 clone / 快进刷新在网络操作前后各用 `ls-remote --get-url` 解析一次，
 * 两次一致才把白名单去敏后的 `host/owner/repo` 写进这次取到的工作目录的 `.git/` 下；目录随后整体
 * 落位成不可变的版本目录，记录与版本一一对应。
 *
 * - 只存去敏结果（展示用 repository 与核实用 sourceId），不存解析出的原始地址：改写可能注入令牌
 *   （`url."https://TOKEN@host/".insteadOf`）。原始结果只在内存里用一次，不写日志、不进错误详情。
 * - 快进刷新会先复制当前版本（连同旧记录）再 fetch，所以每次取包后必须重写或删除记录；删除失败
 *   时抛错，让调用方放弃这份暂存目录，绝不让新版本带着上一次的记录落位。
 * - 读不到记录（升级前取的旧版本、解析失败、两次不一致）即「无法核实」，身份整体缺省；下次刷新
 *   自动补上，不在读取路径写文件。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  PLUGIN_MARKET_SOURCE_ID_PATTERN,
  PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN,
  pluginMarketFetchAddress,
  pluginMarketRepositoryFromUrl,
} from '../../../shared/pluginMarket.js';
import { atomicWriteFileSync } from '../../utils/atomicWriteFile.js';
import type { MarketSourceIdOf } from './sourceId.js';

const FETCH_IDENTITY_FILE = 'cindy-fetch-identity.json';
const FETCH_IDENTITY_VERSION = 2;

function recordPath(repoDir: string): string {
  return path.join(repoDir, '.git', FETCH_IDENTITY_FILE);
}

/**
 * 实际取包地址对应的来源标识（含地址的白名单部件，见 sourceId.ts）；地址解析不了或没有密钥时为 null。
 * 快进刷新用它判断这次的实际地址是否还是上一版本记录里的那个来源。
 */
export function fetchedSourceId(
  resolved: string | null,
  sourceKey: string,
  sourceIdOf: MarketSourceIdOf | undefined,
): string | null {
  const address = pluginMarketFetchAddress(resolved);
  return address ? sourceIdOf?.({ kind: 'git', sourceKey, address }) ?? null : null;
}

/**
 * 在取包所用的工作目录里写下（或清掉）这次的取包记录。`resolved` 是调用方在取包的仓库上下文里、网络操作
 * 前后各解析一次且一致的实际取包地址（不一致或解析失败时为 null），只在这里用一次：分别白名单生成展示用
 * repository 与核实用 sourceId，记录里只存这两个去敏结果；两者都生成不出时清掉记录。
 */
export function writeFetchIdentity(
  repoDir: string,
  facts: { resolved: string | null; revision: string; sourceKey: string; sourceIdOf?: MarketSourceIdOf },
): void {
  const file = recordPath(repoDir);
  const repository = pluginMarketRepositoryFromUrl(facts.resolved);
  const sourceId = fetchedSourceId(facts.resolved, facts.sourceKey, facts.sourceIdOf);
  if ((repository || sourceId) && fs.existsSync(path.dirname(file))) {
    atomicWriteFileSync(
      file,
      `${JSON.stringify({ version: FETCH_IDENTITY_VERSION, revision: facts.revision, repository, sourceId })}\n`,
    );
    return;
  }
  // 无法核实：必须确保目录里没有从上一个版本复制来的旧记录。
  fs.rmSync(file, { force: true });
}

/** 读版本目录的取包记录；没有记录或格式不对返回 null，两项各自可缺省。 */
export function readFetchIdentity(repoDir: string): { repository: string | null; sourceId: string | null } | null {
  const file = recordPath(repoDir);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.version !== FETCH_IDENTITY_VERSION) return null;
    if (typeof value.revision !== 'string' || !value.revision) return null;
    const repository = typeof value.repository === 'string' && value.repository.length <= 256 &&
      PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN.test(value.repository) ? value.repository : null;
    const sourceId = typeof value.sourceId === 'string' && PLUGIN_MARKET_SOURCE_ID_PATTERN.test(value.sourceId)
      ? value.sourceId : null;
    return repository || sourceId ? { repository, sourceId } : null;
  } catch {
    return null;
  }
}
