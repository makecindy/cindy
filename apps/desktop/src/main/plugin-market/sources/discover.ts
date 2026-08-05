/**
 * 自定义市场发现：在市场根目录查找 Codex 兼容的 marketplace.json 并解析插件列表。
 *
 * 兼容 Codex 的清单位置与基础 schema（name + plugins[]，source 为相对路径或
 * {source:"local",path}），但插件本体必须是 Cindy 插件（目录内含合法 ghost.json）。
 * 清单里的描述性字段不作为事实来源——展示与安装一律以 ghost.json 为准。
 *
 * 容错策略与 Codex 一致：单个插件条目非法只跳过并记日志，不让整个市场不可用。
 * 跳过在每次发现结束时汇总成**一个物理行**的 warn（条目下标 + 相对路径 + 原因 +
 * errno，payload 自行 JSON 序列化，理由见调用处）——跳过是逐条发生的，逐条打会被
 * 反复调用的发现路径放大成日志洪水。
 */
import fs from 'node:fs';
import path from 'node:path';

import { validateGhostManifest, type GhostManifest } from '../../../shared/ghost.js';
import { createLogger } from '../../logger.js';
import {
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileFollowLinks,
  readBoundedFileNoFollow,
} from '../../utils/readBoundedFile.js';
import { redactAbsolutePaths } from './git.js';

const log = createLogger('plugin-market-discover');

/** 与 Codex 相同的清单位置，按优先级查找。 */
export const MARKETPLACE_MANIFEST_PATHS = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
] as const;

/**
 * 清单与身份卡的读取上限。市场仓库是不受信内容,git clone 不限制单文件大小,
 * 不设上限时一份数 GB 的 marketplace.json / ghost.json 会在 readFile + JSON.parse
 * 里把 main 进程内存打爆。合法清单远小于此(Codex 生态同量级)。
 */
const MARKETPLACE_MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * 插件条目数上限。每个条目都会触发 realpath + 读身份卡,不设上限时一份十万条目的
 * 清单能把快照/列表/刷新拖住很久。合法市场远小于此。
 */
const MARKETPLACE_MAX_PLUGIN_ENTRIES = 512;

/** 市场名上限:进 store 持久化、进 pluginId、进 UI,不能不设边界。 */
const MARKET_NAME_MAX_CHARS = 128;

/**
 * 单次发现最多记录多少条跳过明细。跳过是**逐条**发生的,而发现会被列表/快照/详情
 * 反复调用——不限量时一份数百条非法条目的清单每次都刷同样多的日志行。超出的条数在
 * 同一行里以 detailsTruncated 如实标注,不静默丢弃。
 */
const SKIP_LOG_DETAIL_LIMIT = 20;

/** 明细里相对路径的截断上限:清单自报的路径同样不受信,不能无界进日志。 */
const SKIP_LOG_TEXT_MAX_CHARS = 200;

/** 控制字符与双向文本控制符不允许出现在市场名里,防 UI 欺骗与日志注入。 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * 以单一文件句柄完成"拒符号链接 → 校验普通文件与大小 → 限量读取 → JSON 解析"。
 * 实体见 readBoundedFileNoFollow(发现/安装/打包三条链路共用同一实现,含
 * Windows 无 O_NOFOLLOW 时的 lstat+dev/ino 回退闸)。非普通文件/超限返回 null;
 * 打开失败(含 O_NOFOLLOW 对 symlink 的拒绝)抛出,由调用方决定语义。
 */
async function readBoundedJsonFile(
  filePath: string,
  maxBytes: number,
  realRoot: string,
): Promise<unknown | null> {
  // containWithin 复核堵"realpath 校验后、open 前中间目录被换成根外链接"的
  // 窗口:O_NOFOLLOW 只管最后一个路径分量。
  const bytes = await readBoundedFileNoFollow(filePath, maxBytes, {
    containWithin: realRoot,
  });
  if (bytes === null) return null;
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

/** 清单侧变体:路径已是 realpath 产物且经根包含校验,允许跟随链接,其余同上。 */
async function readBoundedManifest(
  filePath: string,
  realRoot: string,
): Promise<unknown | null> {
  const bytes = await readBoundedFileFollowLinks(filePath, MARKETPLACE_MANIFEST_MAX_BYTES, {
    containWithin: realRoot,
  });
  if (bytes === null) return null;
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

/** 错误 message 可能携带完整宿主路径(ENOENT/EACCES 自带),进 IPC detail 前脱敏。 */
function sanitizedDetail(error: unknown): string {
  return redactAbsolutePaths(error instanceof Error ? error.message : String(error)).slice(0, 256);
}

export type DiscoverError =
  | 'MARKET_MANIFEST_MISSING'
  | 'MARKET_SOURCE_INVALID';

export interface DiscoveredMarketPlugin {
  ghostId: string;
  version: string;
  /** 插件目录的绝对路径（已校验不越出市场根目录）。 */
  dir: string;
  manifest: GhostManifest;
}

export interface DiscoveredMarketplace {
  name: string;
  displayName: string | null;
  plugins: DiscoveredMarketPlugin[];
  /**
   * 因**内容非法**被跳过的条目数(非法 source / 目录不存在 / 越出根 / 清单不合格 /
   * 超限)。这类是永久事实,跳过即结论,不影响目录完整性。
   */
  skippedCount: number;
  /**
   * 因**读取事实不明**未能判定的条目数(文件锁、权限、网络盘抖动、瞬时 I/O)。
   *
   * 与 skippedCount 必须分开:>0 表示"这个市场声明了哪些 ghostId"当前给不出完整
   * 答案。展示可以照旧容错,但**新的所有权提交必须 fail closed**——否则同 ghostId
   * 的服务端默认安装/手动安装会在它暂时不可读的窗口里抢占先装先得,恢复后该插件
   * 永久 conflict。与来源级失败(result.ok === false)同一口径,只是粒度到条目。
   */
  unreadableCount: number;
}

export type DiscoverResult =
  | { ok: true; marketplace: DiscoveredMarketplace }
  | { ok: false; code: DiscoverError; detail?: string };

interface RawMarketplaceManifest {
  name?: unknown;
  interface?: unknown;
  plugins?: unknown;
}

/** 解析插件条目的 source 字段为市场内相对路径；不支持的形态返回 null。 */
function pluginEntryRelativePath(source: unknown): string | null {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    if (record.source === 'local' && typeof record.path === 'string') return record.path;
    // url / git-subdir / npm 形态的远程插件源 Phase 1 不支持。
    return null;
  }
  return null;
}

/**
 * 单个插件条目的解析结论。
 * - `ok`:可用。
 * - `invalid`:**永久**非法(路径形态、目录不存在、越出根、清单不合格、超限、
 *   ghost.json 是符号链接)。跳过即结论。
 * - `unreadable`:**事实不明**(文件锁、权限、网络盘抖动、瞬时 I/O)。不能与
 *   invalid 混同——它会让"本市场声明了哪些 ghostId"给不出完整答案。
 */
type PluginDirResolution =
  | { kind: 'ok'; plugin: DiscoveredMarketPlugin }
  // 两种失败必须是**各自独立**的联合成员:合并成 kind: 'invalid' | 'unreadable'
  // 就不再是可辨识联合,调用方逐个排除 kind 后收窄不到 'ok'。
  | ({ kind: 'invalid' } & PluginSkipInfo)
  | ({ kind: 'unreadable' } & PluginSkipInfo);

/**
 * 跳过原因。**只用于日志**:计数与控制流仍只看 `kind`,这里的细分不参与任何判定,
 * 因此新增取值不影响调用方。
 *
 * 粒度按"排查时需要区分的事实"划分,几个关键区分:
 * - `dir-missing`(目录本身不存在)与 `manifest-missing`(目录在、`ghost.json` 不在)
 *   必须分开:后者是市场仓库把插件目录做成了 **Git submodule** 的典型表现——克隆不
 *   递归 submodule,留下的空目录会让整个市场发现出 0 个插件,而清单本身完全合法,
 *   没有任何错误码会被触发(见 sources/git.ts:无 --recurse-submodules)。只记
 *   "invalid" 时排查者无从判断是哪一种。
 * - `manifest-symlink-rejected` 是 O_NOFOLLOW 拒掉符号链接的结果,属攻击面,不该
 *   与普通的读取失败混在一起。
 * - `manifest-unreadable` **只用于事实不明**(kind === 'unreadable':文件锁、权限、
 *   网络盘抖动)。永久性的打开失败(ENOTDIR / EISDIR 等)走 `manifest-open-failed`——
 *   否则新增的诊断会把结构损坏说成"暂时读不到",排障者按瞬时故障处理、干等恢复。
 * - `manifest-bounded-read-rejected` 是限量读取闸返回 null,**三种成因**:非普通
 *   文件、超过 GHOST_MANIFEST_MAX_BYTES、根内复核不过(Windows 无 O_NOFOLLOW 时
 *   的符号链接与 dev/ino 不匹配也在此)。闸只给"拒了"这一个信号,不带原因,所以
 *   reason 名不对文件类型下断言;要细分得先改 readBoundedFile* 的返回契约,那会
 *   牵动发现/安装/打包三条共用链路,不属本次范围。
 */
type PluginSkipReason =
  | 'entry-not-object'
  | 'source-unsupported'
  | 'path-not-relative'
  | 'escapes-root'
  | 'dir-missing'
  | 'dir-unresolvable'
  | 'manifest-missing'
  | 'manifest-symlink-rejected'
  | 'manifest-bounded-read-rejected'
  | 'manifest-open-failed'
  | 'manifest-unreadable'
  | 'manifest-unparsable'
  | 'manifest-invalid'
  | 'duplicate-ghost-id';

interface PluginSkipInfo {
  reason: PluginSkipReason;
  /** 底层 errno(有则带上):同一 reason 下 EACCES 与 EIO 的处置完全不同。 */
  errno?: string;
}

/**
 * 可重试的文件系统错误码 = 事实不明。
 *
 * 刻意**不含 ENOENT / ELOOP / ENOTDIR**:清单指向一个不存在的目录是常见的永久
 * 错误(市场删了插件却没更新 marketplace.json),把它当"暂时读不到"会让这类市场
 * 永久处于"目录不完整",默认安装被永久阻塞;ELOOP 是 O_NOFOLLOW 拒符号链接的
 * 结果,属攻击/非法内容,同样是永久结论。
 */
const TRANSIENT_FS_CODES = new Set([
  'EACCES',
  'EPERM',
  'EBUSY',
  'EIO',
  'EAGAIN',
  'ETIMEDOUT',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'ESTALE',
]);

function classifyFsFailure(error: unknown): 'invalid' | 'unreadable' {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code && TRANSIENT_FS_CODES.has(code) ? 'unreadable' : 'invalid';
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** ghost.json 读取失败的日志原因(仅日志,不参与判定)。 */
function manifestReadReason(
  kind: 'invalid' | 'unreadable',
  errno: string | undefined,
): PluginSkipReason {
  if (kind === 'unreadable') return 'manifest-unreadable';
  // 目录在、ghost.json 不在:submodule 未检出的典型形态(见 PluginSkipReason)。
  if (errno === 'ENOENT') return 'manifest-missing';
  // O_NOFOLLOW 平台对符号链接的拒绝。Windows 没有该 flag,回退闸走 lstat+dev/ino
  // 并**返回 null**(不抛),因此那边的符号链接落在 manifest-bounded-read-rejected。
  if (errno === 'ELOOP') return 'manifest-symlink-rejected';
  // 到这里 kind 必为 'invalid':是**永久**的打开失败(ENOTDIR / EISDIR / 无 errno 的
  // 异常等)。绝不能回落到 manifest-unreadable —— 那个 reason 专表事实不明。
  return 'manifest-open-failed';
}

/**
 * Unicode 换行类:NEL(U+0085)、LINE SEPARATOR(U+2028)、PARAGRAPH SEPARATOR(U+2029)。
 *
 * 它们不在 C0/DEL 与双向控制符集合里,但日志序列化(JSON.stringify 与 util.inspect
 * 都不转义这三个码位)会原样写出,查看器与终端普遍按换行渲染 —— 于是不受信路径能把
 * 一行 warn 劈成攻击者控制的多行,正是本消毒声称要挡住的东西。
 *
 * 只补在**日志剥离**侧,不动 FORBIDDEN_NAME_CHARS:那是市场名的准入判据,往里加字符
 * 会改变"哪些市场名被拒绝",属于内容判据变更(可能影响存量市场),不在本次范围内。
 */
const LOG_UNSAFE_LINE_BREAKS = '\\u0085\\u2028\\u2029';

/**
 * 把清单自报的相对路径写进日志前消毒:换行能伪造出额外的日志行,双向控制符能让路径
 * 显示成另一个位置。字符类取自 FORBIDDEN_NAME_CHARS(市场名那道校验闸)再并上 Unicode
 * 换行类,改为带 g 的**剥离**——与那道闸共用同一份来源,不各自抄一遍。市场名出现即拒,
 * 路径不能拒:它是跳过原因的关键线索。
 */
const LOG_UNSAFE_CHARS = new RegExp(
  `${FORBIDDEN_NAME_CHARS.source}|[${LOG_UNSAFE_LINE_BREAKS}]`,
  'g',
);

/** 清单自报的任意文本(条目路径、市场名)进日志前一律过这里。 */
function logSafeText(value: string): string {
  return value.replace(LOG_UNSAFE_CHARS, '').slice(0, SKIP_LOG_TEXT_MAX_CHARS);
}

/** 把 classifyFsFailure 的结论装成解析结果:kind 是变量,联合成员要显式分流。 */
function skippedBy(
  kind: 'invalid' | 'unreadable',
  reason: PluginSkipReason,
  errno: string | undefined,
): PluginDirResolution {
  const info: PluginSkipInfo = { reason, ...(errno ? { errno } : {}) };
  return kind === 'invalid' ? { kind: 'invalid', ...info } : { kind: 'unreadable', ...info };
}

async function resolvePluginDir(
  marketRoot: string,
  relPath: string,
): Promise<PluginDirResolution> {
  const trimmed = relPath.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return { kind: 'invalid', reason: 'path-not-relative' };
  }
  const dir = path.resolve(marketRoot, trimmed);
  const rootWithSep = marketRoot.endsWith(path.sep) ? marketRoot : `${marketRoot}${path.sep}`;
  if (dir !== marketRoot && !dir.startsWith(rootWithSep)) {
    return { kind: 'invalid', reason: 'escapes-root' };
  }

  let realRoot: string;
  let realDir: string;
  try {
    // 字符串前缀只能挡住 "../" 形式的路径穿越；市场内 symlink 仍会指向外部。
    // 边界判定必须以真实路径为准，市场克隆缓存也不应允许 symlink 越出根目录。
    [realRoot, realDir] = await Promise.all([
      fs.promises.realpath(marketRoot),
      fs.promises.realpath(dir),
    ]);
  } catch (error) {
    const kind = classifyFsFailure(error);
    const errno = errnoOf(error);
    // ENOENT 是"清单指向的目录不存在"(市场删了插件却没更新 marketplace.json);
    // 其余(ELOOP/ENOTDIR/权限等)统一归为解析不了。
    return skippedBy(
      kind,
      kind === 'invalid' && errno === 'ENOENT' ? 'dir-missing' : 'dir-unresolvable',
      errno,
    );
  }
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (realDir !== realRoot && !realDir.startsWith(realRootWithSep)) {
    return { kind: 'invalid', reason: 'escapes-root' };
  }

  let raw: unknown;
  try {
    // 身份卡的校验与读取必须落在**同一个文件句柄**上:先 lstat 再按路径 readFile
    // 是两次独立打开,并发方可以在两次之间把 ghost.json 换成超大文件或指向
    // /dev/zero 的链接,绕过类型与大小闸。O_NOFOLLOW 让 open 对 symlink 直接
    // 失败(与打包侧"符号链接一律不穿透"同口径;Windows 无此 flag 时走
    // lstat+dev/ino 回退闸,同样拒链接);随后 stat 与限量读取都作用于已打开的
    // inode,路径再被替换也影响不到它。
    raw = await readBoundedJsonFile(
      path.join(realDir, 'ghost.json'),
      GHOST_MANIFEST_MAX_BYTES,
      realRoot,
    );
    // null = 非普通文件 / 超限 / 根内复核不过:都是内容判据,属永久非法。闸不区分
    // 三者,reason 也不下断言(见 PluginSkipReason)。
    if (raw === null) return { kind: 'invalid', reason: 'manifest-bounded-read-rejected' };
  } catch (error) {
    // JSON 解析失败是内容非法;fs 错误按可重试性分类。
    if (error instanceof SyntaxError) return { kind: 'invalid', reason: 'manifest-unparsable' };
    const kind = classifyFsFailure(error);
    const errno = errnoOf(error);
    return skippedBy(kind, manifestReadReason(kind, errno), errno);
  }
  const validated = validateGhostManifest(raw);
  if (!validated.ok) return { kind: 'invalid', reason: 'manifest-invalid' };
  return {
    kind: 'ok',
    plugin: {
      ghostId: validated.manifest.id,
      version: validated.manifest.version,
      dir: realDir,
      manifest: validated.manifest,
    },
  };
}

/**
 * 在市场根目录发现插件。marketRoot 必须已存在（调用方负责克隆/路径校验）。
 */
export async function discoverMarketplace(marketRoot: string): Promise<DiscoverResult> {
  let manifestPath: string | null = null;
  for (const relPath of MARKETPLACE_MANIFEST_PATHS) {
    const candidate = path.join(marketRoot, ...relPath.split('/'));
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      break;
    }
  }
  if (!manifestPath) return { ok: false, code: 'MARKET_MANIFEST_MISSING' };

  // 清单读取也必须按真实路径做包含性判定(与 resolvePluginDir 同一套):候选路径是
  // 我们自己拼的,挡不住仓库内的 symlink —— 恶意市场可以把
  // `.agents/plugins/marketplace.json` 做成指向市场根目录外的链接,从而让宿主去读
  // 任意路径。realpath 落在根目录外一律拒。
  let realManifestPath: string;
  let realMarketRoot: string;
  try {
    const [realRoot, realManifest] = await Promise.all([
      fs.promises.realpath(marketRoot),
      fs.promises.realpath(manifestPath),
    ]);
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    if (!realManifest.startsWith(realRootWithSep)) {
      return {
        ok: false,
        code: 'MARKET_SOURCE_INVALID',
        detail: 'marketplace manifest escapes the marketplace root',
      };
    }
    realManifestPath = realManifest;
    realMarketRoot = realRoot;
  } catch (error) {
    // realpath 的 ENOENT/EACCES message 自带完整宿主路径,进 IPC detail 前必须脱敏。
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: sanitizedDetail(error) };
  }

  let raw: RawMarketplaceManifest;
  try {
    // 校验与读取共用同一句柄(见 readBoundedJsonFile):数 GB 的清单在读之前按
    // 大小拒掉,且两次之间不存在被替换的窗口。realpath 已解析链接并做过根包含
    // 校验,这里不再加 O_NOFOLLOW(根内链接指向根内文件是允许的)。
    const parsed = await readBoundedManifest(realManifestPath, realMarketRoot);
    if (parsed === null) {
      return {
        ok: false,
        code: 'MARKET_SOURCE_INVALID',
        detail: `marketplace manifest must be a regular file within ${MARKETPLACE_MANIFEST_MAX_BYTES} bytes`,
      };
    }
    raw = parsed as RawMarketplaceManifest;
  } catch (error) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: sanitizedDetail(error) };
  }
  if (!raw || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace.json missing name' };
  }
  const name = raw.name.trim();
  // 市场名会进 store 持久化、进 pluginId、进 UI 与路径 slug,必须有边界:超长
  // 会让配置与账本无界膨胀,控制字符/双向控制符可伪装 UI 文案与污染日志。
  if (name.length > MARKET_NAME_MAX_CHARS || FORBIDDEN_NAME_CHARS.test(name)) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace name is invalid' };
  }
  if (!Array.isArray(raw.plugins)) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace.json plugins must be an array' };
  }
  if (raw.plugins.length > MARKETPLACE_MAX_PLUGIN_ENTRIES) {
    return {
      ok: false,
      code: 'MARKET_SOURCE_INVALID',
      detail: `marketplace lists more than ${MARKETPLACE_MAX_PLUGIN_ENTRIES} plugins`,
    };
  }

  const rawDisplayName =
    raw.interface &&
    typeof raw.interface === 'object' &&
    !Array.isArray(raw.interface) &&
    typeof (raw.interface as Record<string, unknown>).displayName === 'string'
      ? ((raw.interface as Record<string, unknown>).displayName as string).trim()
      : null;
  // displayName 是描述性字段:非法就丢弃,不因它拒掉整个市场。
  const displayName =
    rawDisplayName &&
    rawDisplayName.length <= MARKET_NAME_MAX_CHARS &&
    !FORBIDDEN_NAME_CHARS.test(rawDisplayName)
      ? rawDisplayName
      : null;

  const plugins: DiscoveredMarketPlugin[] = [];
  const seenGhostIds = new Set<string>();
  let skippedCount = 0;
  let unreadableCount = 0;
  /**
   * 跳过明细,**只进日志**:计数与返回值不受影响。此前跳过是完全静默的——市场发现出
   * 0 个插件时,清单合法所以没有任何错误码,用户看到"0 个插件"、排查者连一行日志都
   * 没有。典型成因是插件目录被做成 Git submodule(克隆不递归,留下空目录)。
   */
  const skippedDetails: Array<{ index: number; path?: string } & PluginSkipInfo> = [];
  const noteSkip = (index: number, relPath: string | null, info: PluginSkipInfo): void => {
    if (skippedDetails.length >= SKIP_LOG_DETAIL_LIMIT) return;
    // 逐字段取,不展开 info:传进来的解析结论还带着 kind,展开会让日志字段随内部
    // 类型变化漂移。明细固定为 index / path / reason / errno。
    skippedDetails.push({
      index,
      ...(relPath === null ? {} : { path: logSafeText(relPath) }),
      reason: info.reason,
      ...(info.errno ? { errno: info.errno } : {}),
    });
  };
  for (const [index, entry] of raw.plugins.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skippedCount += 1;
      noteSkip(index, null, { reason: 'entry-not-object' });
      continue;
    }
    const relPath = pluginEntryRelativePath((entry as Record<string, unknown>).source);
    if (!relPath) {
      skippedCount += 1;
      // 合法但 Phase 1 不支持的远程源(url / git-subdir / npm)也落这里。
      noteSkip(index, null, { reason: 'source-unsupported' });
      continue;
    }
    const resolved = await resolvePluginDir(marketRoot, relPath);
    if (resolved.kind === 'unreadable') {
      // 事实不明:不能与"内容非法"共用静默跳过分支,否则调用方会把目录当完整,
      // 允许同 ghostId 的默认安装/手动安装在这个窗口里抢占所有权。
      unreadableCount += 1;
      noteSkip(index, relPath, resolved);
      continue;
    }
    if (resolved.kind === 'invalid') {
      skippedCount += 1;
      noteSkip(index, relPath, resolved);
      continue;
    }
    if (seenGhostIds.has(resolved.plugin.ghostId)) {
      skippedCount += 1;
      noteSkip(index, relPath, { reason: 'duplicate-ghost-id' });
      continue;
    }
    seenGhostIds.add(resolved.plugin.ghostId);
    plugins.push(resolved.plugin);
  }
  if (skippedCount > 0 || unreadableCount > 0) {
    const detailsTruncated = skippedCount + unreadableCount - skippedDetails.length;
    // payload 必须**自己**序列化成紧凑单行:main logger 走 util.format,对象参数会经
    // util.inspect 按 breakLength 展开 —— 实测 1 条明细写出 15 个物理行、20 条写出
    // 129 行,且续行不带时间戳/级别/scope。那既是本改动声称要避免的日志洪水,也会
    // 打断按行解析 main 日志的工具。字符串参数 util.format 直接拼接,恒为一行。
    //
    // 注意 JSON.stringify **不**转义 U+2028 / U+2029 / NEL(著名的 JSON-vs-JS 缺口),
    // 所以 market 与 path 仍各自过 logSafeText,不能指望这一层兜住。
    log.warn(
      'marketplace skipped plugin entries',
      JSON.stringify({
        // name 与 path 同源(都来自不受信清单),消毒口径必须一致:市场名那道准入闸
        // 不含 Unicode 换行类,带这些码位的名字能通过校验再原样进日志。
        market: logSafeText(name),
        declared: raw.plugins.length,
        accepted: plugins.length,
        skippedCount,
        unreadableCount,
        entries: skippedDetails,
        ...(detailsTruncated > 0 ? { detailsTruncated } : {}),
      }),
    );
  }

  return {
    ok: true,
    marketplace: { name, displayName, plugins, skippedCount, unreadableCount },
  };
}
