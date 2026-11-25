import type { DownloadProgress } from './downloadProgress';
import type { GhostManifest, InstalledGhost } from './ghost';
import type { GhostReadmeContent, PluginCatalogCounts, PluginDownloadStatistics, PluginIconMetadata, PluginUsageStatistics } from '@cindy/plugin-protocol';

export type PluginMarketScope = 'public' | 'organization' | 'personal';
export type PluginMarketInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'conflict';

/** 市场项来源：服务端市场，或用户添加的 Git / 本地自定义市场。 */
export type PluginMarketItemSource = 'server' | 'git-market' | 'local-market';

/** Renderer-safe Plugin 市场列表项；所有字段都来自协议或本地安装事实。 */
export interface PluginMarketItem {
  usageStatistics?: PluginUsageStatistics;
  downloadStatistics?: PluginDownloadStatistics;
  pluginId: string;
  ghostId: string;
  /** Host-verified namespace. Missing is legacy wire; null is root. */
  namespace?: string | null;
  name: string;
  description: string | null;
  author: string | null;
  /** Display identity from verified public publishing; never grants runtime trust. */
  publisherKind?: 'official' | 'personal' | null;
  /** Main verified a public installation's market origin; attribution spans versions. */
  installedAuthor?: string | null;
  scope: PluginMarketScope;
  organizationId: string | null;
  defaultInstall: boolean;
  releaseId: string;
  version: string;
  publishedAt: string;
  icon: PluginIconMetadata | null;
  /**
   * 自定义市场图标的本地身份键。它是 Main 根据当前来源事实计算的本地投影身份，
   * 不包含本地路径或字节；读取失败或事实不确定时也可能携带该键并由 localIcons
   * 返回 missing/retryable。服务端市场与未声明 icon 的自定义插件不携带。
   */
  customIconKey?: string;
  installState: PluginMarketInstallState;
  enabled: boolean | null;
  /** 来源类型；服务端市场项为 'server'。 */
  sourceType: PluginMarketItemSource;
  /** 来源市场名（自定义市场项必填；服务端项为 null）。 */
  sourceMarketName: string | null;
  /**
   * 自定义市场项的去敏来源身份（Main 按该条目的来源配置与当前缓存版本的取包记录生成，见
   * pluginMarketSourceIdentity）。服务端项、以及无法安全生成或无法核实时缺省。
   */
  sourceIdentity?: PluginMarketSourceIdentity;
  /**
   * 这台电脑上当前已装实例的来源标识（同 `sourceIdentity.sourceId` 的算法，由安装账本记录的来源指纹
   * 生成）。只在已装实例存在、账本记录为已安装且属于本条目的 `pluginId` 时给出。控制端核实回执过期的
   * 安装时，要求它与原尝试确认回执里的 `originSource.sourceId` 完全相等。
   */
  installedSourceId?: string;
  /**
   * 新版本比已装版本权限变多，或（自定义市场）实际来源与已装版本不同，后台更新已暂停、
   * 等待用户确认。只在 Main 按真实包与来源记录判定过后出现；缺省表示未知或无需确认，
   * 不能据此推断可以静默更新。
   */
  updateRequiresConsent?: true;
}
/** 市场快照。服务不可用时 renderer 保留本地插件并只展示非阻断提示。 */
export interface PluginMarketSnapshot {
  items: PluginMarketItem[];
  unavailableReason: string | null;
  /** 已添加的自定义市场名（按添加顺序）；驱动"自定义"筛选 tab 的可见性。 */
  customSourceNames: string[];
  /** 本轮发现失败的自定义市场名；失败来源不影响其它来源和官方市场。 */
  unavailableCustomSourceNames: string[];
  /**
   * 企业目录单独不可用时的错误码，包含客户端尚未认识的新码。null 或缺失表示本轮没有这个状态；
   * 公开目录和已安装插件照常。
   */
  organizationAccessError?: string | null;
}

export interface PluginMarketQuery {
  query?: string;
  scope?: 'all' | PluginMarketScope | 'custom';
  cursor?: string | null;
  limit?: number;
  excludeInstalled?: boolean;
  /** Readers that only need items/cursors can omit the complete first-page count. */
  counts?: boolean;
}
export interface PluginMarketCounts extends PluginCatalogCounts {
  custom: number;
}
export interface PluginMarketPage extends PluginMarketSnapshot {
  customSourceCounts?: Array<{ name: string; count: number }>;
  nextCursor: string | null;
  /** Complete query counts on the first page; subsequent pages reuse them. */
  counts: PluginMarketCounts | null;
}

/** 服务端清理的一次性汇总提示：按 owner 缓存，consume 前跨多轮对账累加，consume 后即清。 */
export interface PluginRemovalUserNotice {
  count: number;
  /** 累计单条且插件名经安全过滤后非空时为插件名；其余情况为 null，只展示数量。 */
  name: string | null;
}

export type OfficialModelPlugin = Pick<PluginMarketItem, 'pluginId' | 'ghostId' | 'namespace' | 'name' | 'description'>;
export interface OfficialModelPluginPage {
  incomplete?: boolean;
  officialIds: string[];
  totalOfficial: number | null;
  items: OfficialModelPlugin[];
  nextCursor: string | null;
}

/** 详情携带安装前展示给用户的 manifest；官方来自 release，自定义来自本地发现。 */
export interface PluginMarketDetail extends PluginMarketItem {
  manifest: GhostManifest;
  /**
   * 详细介绍，只在详情页请求时提供：官方市场的图片是服务端签发的短期地址，自定义市场
   * 的图片是 data URL。`null` 表示没有介绍；字段缺省表示调用方没有请求。
   */
  readme?: GhostReadmeContent | null;
}

/** Main 生成并接受的自定义市场图标身份键形状；首位 0 为保留值。 */
export const PLUGIN_MARKET_CUSTOM_ICON_KEY_RE = /^[1-9a-f][a-f0-9]{63}$/;
export const PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH = 16;
export const PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH = 16;

export function isPluginMarketCustomIconKey(value: string): boolean {
  return PLUGIN_MARKET_CUSTOM_ICON_KEY_RE.test(value);
}

/** Renderer 只用这个不透明 token 做同来源传输限流，不解析 Main 侧身份事实。 */
export function pluginMarketCustomIconSourceToken(value: string): string | null {
  if (!isPluginMarketCustomIconKey(value)) return null;
  return value.slice(1, 1 + PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH);
}

/** Main 从图标键恢复快照投影代际，用于读取时重算并核对完整键。 */
export function pluginMarketCustomIconProjectionToken(value: string): string | null {
  if (!isPluginMarketCustomIconKey(value)) return null;
  const start = 1 + PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH;
  return value.slice(start, start + PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH);
}

/** Renderer 请求 Main 按当前自定义市场事实读取一个本地图标。 */
export interface PluginMarketLocalIconRequest {
  pluginId: string;
  expectedIconKey: string;
}

/** Main 的批量图标读取结果；请求身份原样带回，供 Renderer 安全归并。 */
export type PluginMarketLocalIconResult =
  | (PluginMarketLocalIconRequest & { status: 'loaded'; dataUrl: string })
  | (PluginMarketLocalIconRequest & { status: 'missing' | 'retryable' });

export interface PluginMarketInstallOptions {
  /** 用户点击时看到的目标 release；Main 会在下载前重新核对。 */
  expectedReleaseId: string;
  /** 自定义来源详情读取时的完整清单；Main 会在打包前重新核对。 */
  expectedManifest?: GhostManifest;
  /**
   * receipt 模型的并发护栏：receipt 派生 token。读取与落位之间安装状态若变化即拒绝。
   */
  expectedInstalledApproval?: string;
  /** 仅详情页上用户明确点击“替换”时为 true；更新和批量更新不得切换来源。 */
  allowSourceReplacement?: boolean;
}

/** 市场安装成功后返回已落位插件。 */
export interface PluginMarketInstallResult {
  ghost: InstalledGhost;
}

/**
 * Pushed on `plugin-market:install-progress` to the window that started an install or update.
 * Display only: the install's outcome is still the `plugin-market:install` result. Local IPC,
 * not part of the device-link or plugin wire contracts.
 */
export interface PluginMarketInstallProgress {
  pluginId: string;
  download: DownloadProgress;
  /** The verified package is waiting for the user to confirm its permissions. */
  awaitingConsent?: true;
}

/* ------------------------------------------------------------------------ */
/* 自定义市场源（Git / 本地文件夹）                                           */
/* ------------------------------------------------------------------------ */

/** 用户添加的市场来源。Git 源支持可选引用与稀疏检出；本地源指向文件夹。 */
export type MarketSource =
  | { type: 'git'; url: string; ref?: string; sparsePaths: string[] }
  | { type: 'local'; path: string };

/** 持久化的市场来源配置（sources.v1.json）。 */
export interface MarketSourceConfig {
  /** 市场名，来自 marketplace.json 的 name；全局唯一，作为管理主键。 */
  name: string;
  addedAt: string;
  lastSyncedAt: string | null;
  /** 最近一次同步到的 Git commit SHA；本地源为 null。 */
  lastRevision: string | null;
  source: MarketSource;
}

/** Renderer 管理视图使用的来源摘要。 */
export interface MarketSourceSummary extends MarketSourceConfig {
  /** 最近一次发现到的插件数；发现失败时为 0 并携带 status。 */
  pluginCount: number;
  /** 清单中因内容非法被跳过的插件条目数。 */
  skippedCount: number;
  /** 清单中因权限、文件锁或瞬时 I/O 暂时无法读取的插件条目数。 */
  unreadableCount: number;
  status: 'ok' | 'error';
  /** status === 'error' 时的 IPC 错误码（Renderer 按码本地化）。 */
  errorCode: string | null;
}

/**
 * 可以展示给用户和远程控制端的来源身份（契约第 2 版）。
 * - `sourceId`：Host 用本机密钥对来源指纹（`marketSourceKey`）做的 HMAC 截断，不透明、不可反推，
 *   区分不同本地目录、端口、协议写法与稀疏路径；控制端用它核对「装的是哪个来源」。
 * - Git 来源另给 `repository`（实际取包地址的 `host/owner/repo`）与可选 `ref`，只用于展示。
 * 不含任何凭证、查询串、片段、端口或本地路径。
 * 远程协议见 docs/dev-rules/protocol-compatibility/same-account-remote-plugin-management.md。
 */
export type PluginMarketSourceIdentity =
  | { kind: 'git'; repository: string; ref?: string; sourceId: string }
  | { kind: 'local'; sourceId: string };

/** 展示用仓库标识的整体形状；远程控制端按同一形状校验。 */
export const PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){2,4}$/;
/** 来源标识：16 字节 HMAC 截断的 base64url（无填充）。 */
export const PLUGIN_MARKET_SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** 与 sources/parse.ts 的 REF_PATTERN 同一口径。 */
const SOURCE_IDENTITY_REF = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SOURCE_IDENTITY_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SOURCE_IDENTITY_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/**
 * 地址里出现即不生成：空白、C0/C1 控制符、零宽与双向控制符（视觉欺骗）、反斜杠
 * （WHATWG URL 把它当 `/`，git 不会，两边认定的 host 会不一致）、百分号编码（`%2e%2e`
 * 会被 URL 解析成 `..` 后归一掉，展示的路径就不再是 git 实际请求的路径）。
 */
// eslint-disable-next-line no-control-regex
const SOURCE_IDENTITY_UNSAFE_CHARS = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\\%]/;
/**
 * 只接受「最无争议的形状」，任何一处可能让 git（libcurl / ssh）与这里认定的主机、端口、路径不同就整体不生成：
 * - 整串先拒绝 `?` `#` `[` `]`（再加上 SOURCE_IDENTITY_UNSAFE_CHARS 的空白、控制符、`\`、`%`），在拆分之前；
 * - userinfo 非空、只含 RFC 3986 的 unreserved / sub-delims 与 `:`，不含 `@` `/`；
 * - host 是严格的 ASCII DNS 名（不收 IPv6 方括号）；端口是不带前导零的十进制；
 * - 路径各段只含 `A-Za-z0-9._~+-`，没有空段与 `.` / `..` 段，可带一个结尾斜杠。
 */
const SOURCE_IDENTITY_URL_AMBIGUOUS = /[?#[\]]/;
const SOURCE_IDENTITY_URL =
  /^(https?|ssh|git):\/\/(?:([A-Za-z0-9._~!$&'()*+,;=:-]+)@)?([A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?((?:\/[A-Za-z0-9._~+-]+)+\/?)$/i;
const SOURCE_IDENTITY_PATH_DOT_SEGMENT = /(?:^|\/)\.{1,2}(?=\/|$)/;
const SOURCE_IDENTITY_DEFAULT_PORT: Record<string, string> = { http: '80', https: '443' };
/** scp 形式 `user@host:owner/repo`：用户、主机、路径都按严格字符集；路径不能以 `/` 开头，没有空段。 */
const SOURCE_IDENTITY_SCP = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~+-]+(?:\/[A-Za-z0-9._~+-]+)*\/?)$/;
/** SSH 登录用户：只进本机 HMAC 输入，字符集限制在常见账户名内，其它一律按无法核实处理。 */
const SOURCE_IDENTITY_SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** 实际取包地址按白名单取出的部件（不含用户名、密码、令牌、查询串、片段），只用于生成 sourceId。 */
export interface PluginMarketFetchAddress {
  /** 小写协议；scp 形式记作 `scp`。 */
  scheme: 'https' | 'http' | 'ssh' | 'git' | 'scp';
  /**
   * SSH 登录用户（仅 `ssh` / `scp`；其它协议为空串）。在普通 SSH 服务上，同一主机、同一路径（尤其 scp 的
   * 相对路径、`~user/…`）可随登录用户解析到不同家目录和仓库，所以它是来源身份的一部分；ssh:// 带绝对路径时
   * 也一律纳入，结果只会更保守。只进本机 HMAC 输入，不进展示、记录、回执或日志。https / http / git 的
   * userinfo（含 `https://TOKEN@host` 单段令牌）是凭证，一律不读取，凭证轮换不改变来源标识。
   */
  user: string;
  /** 小写 host（DNS 不区分大小写；只接受 ASCII 主机名，不做 IDNA 转换）。 */
  host: string;
  /** 端口，按地址里写的原样（`:443` 与缺省不归并，`0443` 与 `443` 也不归并），缺省为空串。 */
  port: string;
  /**
   * 路径，按地址里写的原样（以 `/` 开头；scp 形式为冒号后的部分）。不去掉结尾 `.git` 或 `/`、不改大小写：
   * 有的服务把 `plugins` 与 `plugins.git`、带不带结尾斜杠、大小写不同的路径当成不同仓库，核实用的标识宁可
   * 按原值区分（展示用的 repository 另行规整，见 pluginMarketRepositoryFromUrl）。
   */
  path: string;
}

/**
 * 把一个 Git 地址（配置地址，或 git 解析出的实际取包地址）白名单拆成部件，解析不了返回 null：
 * - 先对 git 实际使用的原始字节校验，再拆分；不做任何会把两个不同实际地址变成同一组部件的规整：不 trim
 *   （首尾空白也是地址的一部分，出现即拒绝）、不经 URL 解析器归一、端口与路径保持原样。只有协议与 host 转成
 *   小写：DNS 主机名不区分大小写；git 对大写协议要么按同一协议处理、要么取包失败（不会有身份），都不会把两个
 *   能取到包的不同地址并成一个；
 * - 只接受 `https` / `http` / `ssh` / `git` 与 `user@host:path` 的 scp 形式；
 * - 只读取协议、SSH 登录用户（仅 ssh / scp）、host、端口、路径；https / http / git 的用户名与密码（含
 *   `https://TOKEN@host` 这类单段令牌，例如 `insteadOf` 改写注入的）与任何密码一律不读取；
 * - 整串含 `?` `#` `[` `]` 时在拆分之前就不生成：URL 解析器会把 `?`/`#` 当成查询串、片段截掉（出现在
 *   userinfo 一段时还会改变 libcurl 认定的主机），git 却把它们当成仓库路径的一部分（ssh / git）或拼进请求；
 * - 只接受最无争议的形状（见 SOURCE_IDENTITY_URL / SOURCE_IDENTITY_SCP），并与 WHATWG URL 的解析结果交叉核对，
 *   任何分歧都不生成；宁可多拒绝（身份缺省，控制端按无法核实处理），不给出可能与实际取包主机不同的身份。
 * 输入按不可信处理（手工改过的配置、git 解析出的改写地址）。结果不写日志。
 */
export function pluginMarketFetchAddress(value: unknown): PluginMarketFetchAddress | null {
  if (typeof value !== 'string') return null;
  const url = value;
  if (
    !url ||
    url.length > 2048 ||
    SOURCE_IDENTITY_UNSAFE_CHARS.test(url) ||
    SOURCE_IDENTITY_URL_AMBIGUOUS.test(url)
  ) {
    return null;
  }
  const parsed = SOURCE_IDENTITY_URL.exec(url);
  if (parsed) {
    const [, rawScheme, userinfo, rawHost, port = '', path] =
      parsed as unknown as [string, string, string | undefined, string, string | undefined, string];
    if (SOURCE_IDENTITY_PATH_DOT_SEGMENT.test(path) || Number(port || '0') > 65535) return null;
    const host = rawHost.toLowerCase();
    if (host.length > 253 || !SOURCE_IDENTITY_HOST.test(host)) return null;
    const protocol = rawScheme.toLowerCase() as PluginMarketFetchAddress['scheme'];
    // 只有 ssh 的用户名是身份；其它协议的 userinfo 是凭证，不读取。ssh 的 `user:password` 只取用户名。
    const user = protocol === 'ssh' && userinfo ? userinfo.split(':', 1)[0]! : '';
    if (protocol === 'ssh' && userinfo !== undefined && !SOURCE_IDENTITY_SSH_USER.test(user)) return null;
    // 交叉核对：与 WHATWG URL 解析的主机、端口、路径、ssh 用户名逐项一致才接受，任何分歧都按无法核实处理。
    let whatwg: URL;
    try {
      whatwg = new URL(url);
    } catch {
      return null;
    }
    const expectedPort = SOURCE_IDENTITY_DEFAULT_PORT[protocol] === port ? '' : port;
    if (
      whatwg.hostname.toLowerCase() !== host ||
      whatwg.port !== expectedPort ||
      whatwg.pathname !== path ||
      (protocol === 'ssh' && whatwg.username !== user)
    ) {
      return null;
    }
    return { scheme: protocol, user, host, port, path };
  }
  // 带 `://` 却不合上面的严格形状：不能再当 scp 形式解读。
  if (url.includes('://')) return null;
  const scp = SOURCE_IDENTITY_SCP.exec(url);
  if (!scp) return null;
  const user = scp[1]!;
  const host = scp[2]!.toLowerCase();
  const path = scp[3]!;
  if (
    !SOURCE_IDENTITY_SSH_USER.test(user) ||
    host.length > 253 ||
    !SOURCE_IDENTITY_HOST.test(host) ||
    SOURCE_IDENTITY_PATH_DOT_SEGMENT.test(path)
  ) {
    return null;
  }
  return { scheme: 'scp', user, host, port: '', path };
}

/**
 * 把一个 Git 地址白名单归约成展示用的 `host/owner/repo`，生成不出就返回 null：在
 * pluginMarketFetchAddress 的基础上，路径限 2–4 段（允许 GitLab 子组），每段只允许字母数字与 `._-`
 * 且不以 `.` 开头，去掉结尾 `.git`。端口不进入展示（核实靠 sourceId 区分端口）。
 */
export function pluginMarketRepositoryFromUrl(value: unknown): string | null {
  const address = pluginMarketFetchAddress(value);
  if (!address) return null;
  const segments = address.path.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '').split('/');
  if (segments.length < 2 || segments.length > 4) return null;
  if (!segments.every((segment) => segment !== '.' && segment !== '..' && SOURCE_IDENTITY_SEGMENT.test(segment))) {
    return null;
  }
  const repository = `${address.host}/${segments.join('/')}`;
  return repository.length <= 256 && PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN.test(repository) ? repository : null;
}

/**
 * 组装来源身份，任何一项生成不出就整体返回 null：
 * - `sourceId` 由 Main 用本机密钥算出（见 main/plugin-market/sources/sourceId.ts），必须合形；
 * - 本地文件夹来源只给 `{kind:'local', sourceId}`，不含路径；
 * - Git 来源的 `repository` 取**实际取包地址**的去敏结果（该缓存版本的取包记录），不取配置字符串；
 * - 没配置 ref 时不给 ref；配置了 ref 但不是合法引用（只可能来自手工改坏的配置）时整个身份不生成：
 *   git 实际仍会用它取包，不能给出缺了 ref 的身份。
 */
export function pluginMarketSourceIdentity(
  source: MarketSource,
  facts: { sourceId: string | null; fetchedRepository: string | null },
): PluginMarketSourceIdentity | null {
  if (!source || typeof source !== 'object') return null;
  const { sourceId, fetchedRepository } = facts;
  if (typeof sourceId !== 'string' || !PLUGIN_MARKET_SOURCE_ID_PATTERN.test(sourceId)) return null;
  if (source.type === 'local') return { kind: 'local', sourceId };
  if (source.type !== 'git') return null;
  // 添加来源时没填 ref 存成缺省键，git 侧按真假判断，所以 null / 空串同样视为未配置。
  const rawRef: unknown = source.ref;
  let ref: string | undefined;
  if (rawRef !== undefined && rawRef !== null && rawRef !== '') {
    if (typeof rawRef !== 'string' || !SOURCE_IDENTITY_REF.test(rawRef)) return null;
    ref = rawRef;
  }
  if (
    typeof fetchedRepository !== 'string' ||
    fetchedRepository.length > 256 ||
    !PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN.test(fetchedRepository)
  ) {
    return null;
  }
  return { kind: 'git', repository: fetchedRepository, ...(ref !== undefined ? { ref } : {}), sourceId };
}

/** 来源标识的形状（`installedSourceId` 等单独出现的标识也经这里）。 */
export function isPluginMarketSourceId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_MARKET_SOURCE_ID_PATTERN.test(value);
}

/**
 * 校验一份来源身份的形状（远程 Host 发来的确认请求也经这里）。只接受契约里的键：
 * Git 形式 `kind`／`repository`／可选 `ref`／`sourceId`，本地形式只有 `kind`／`sourceId`。
 */
export function isPluginMarketSourceIdentity(value: unknown): value is PluginMarketSourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!isPluginMarketSourceId(record.sourceId)) return false;
  if (record.kind === 'local') return keys.length === 2;
  return (
    record.kind === 'git' &&
    keys.every((key) => key === 'kind' || key === 'repository' || key === 'ref' || key === 'sourceId') &&
    typeof record.repository === 'string' &&
    record.repository.length <= 256 &&
    PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN.test(record.repository) &&
    (record.ref === undefined || (typeof record.ref === 'string' && SOURCE_IDENTITY_REF.test(record.ref)))
  );
}

/**
 * 来源的规范化指纹。市场名是 marketplace.json 自报的、**可复用**——移除来源 A 后
 * 添加一个同名的来源 B,`customMarketPluginId` 完全相同;账本所有权若只锚在
 * pluginId 上,无关甚至恶意仓库就能借同名市场"更新"A 装出来的插件。所以自定义
 * 安装的账本记录同时记下这个指纹,所有权校验必须两者都对上。
 * 与 sources/store 的 sourcesEqual、sources/index 的 marketCloneSlug 同一套
 * 判定维度(type + 定位 + ref + 稀疏路径)。
 *
 * 序列化必须**无歧义**:用分隔符拼接(`join(',')`、`#ref:sparse`)会产生可构造的
 * 碰撞——`sparsePaths:['a,b','c']` 与 `['a','b,c']`、`ref:'x' + ['p']` 与
 * `ref:'x:p' + []` 都会得到同一 key,两个不同来源被判成同一个,所有权校验随之
 * 失效。JSON 数组序列化对每个元素定界,不存在拼接歧义。
 */
export function marketSourceKey(source: MarketSource): string {
  return source.type === 'local'
    ? JSON.stringify(['local', source.path])
    : JSON.stringify(['git', source.url, source.ref ?? null, source.sparsePaths]);
}

/**
 * 自定义市场插件的合成 pluginId。与服务端 CUID（^c[a-z0-9]{24}$）互不相交，
 * Main 在 detail/install/uninstall 入口据此分流，Renderer 无需感知差异。
 */
export const CUSTOM_MARKET_PLUGIN_ID_PREFIX = 'custom:';

export function customMarketPluginId(marketName: string, ghostId: string): string {
  return `${CUSTOM_MARKET_PLUGIN_ID_PREFIX}${encodeURIComponent(marketName)}/${encodeURIComponent(ghostId)}`;
}

export function parseCustomMarketPluginId(
  pluginId: string,
): { marketName: string; ghostId: string } | null {
  if (!pluginId.startsWith(CUSTOM_MARKET_PLUGIN_ID_PREFIX)) return null;
  const rest = pluginId.slice(CUSTOM_MARKET_PLUGIN_ID_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  try {
    return {
      marketName: decodeURIComponent(rest.slice(0, slash)),
      ghostId: decodeURIComponent(rest.slice(slash + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * 自定义市场插件的合成 releaseId。版本变化即产生新 releaseId，
 * 从而复用服务端市场既有的 update-available / expectedReleaseId 机制。
 */
export function customMarketReleaseId(marketName: string, ghostId: string, version: string): string {
  return `custom:${encodeURIComponent(marketName)}:${encodeURIComponent(ghostId)}:${encodeURIComponent(version)}`;
}

/** A task or button may offer one installation only when all configured
 * sources resolve the requested identity to one available listing. */
export function uniquePluginInstallCandidate(
  market: PluginMarketSnapshot,
  target: { ghostId: string; namespace?: string | null; marketPluginId?: string },
): PluginMarketItem | undefined {
  if (market.unavailableReason || market.organizationAccessError || market.unavailableCustomSourceNames?.length) return;
  const matches = market.items.filter(item =>
    item.ghostId === target.ghostId &&
    (target.namespace === undefined || item.namespace === target.namespace) &&
    (!target.marketPluginId || item.pluginId === target.marketPluginId),
  );
  if (matches.length === 1 && matches[0].installState === 'not-installed') return matches[0];
}
