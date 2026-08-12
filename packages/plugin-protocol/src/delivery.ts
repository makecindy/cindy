import {
  ghostManifestUsesOidcToken,
  isValidGhostId,
  validateGhostManifest,
  type GhostManifest,
} from './manifest.js';
import {
  PluginProtocolError,
  httpsUrl,
  isoDate,
  nextCursor,
  object,
  sha256,
  string,
} from './internal/parse.js';
import { isValidPluginResourceId } from './internal/pluginResourceId.js';

export { PluginProtocolError } from './internal/parse.js';
export { isValidPluginResourceId } from './internal/pluginResourceId.js';

/** Plugin 客户端 HTTP list/detail envelope 版本；与 ghost.json 版本独立演进。 */
export const PLUGIN_API_SCHEMA_VERSION = 2 as const;

/** 客户端请求 Plugin Server 时携带的 Cindy 版本请求头。 */
export const CINDY_CLIENT_VERSION_HEADER = 'x-cindy-version' as const;

/** 普通客户端可见的 Plugin 来源范围。 */
export const PLUGIN_SCOPES = ['public', 'organization', 'personal'] as const;

/** `public` 对所有已登录身份可见；其余范围只对对应组织或自然人可见。 */
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

/** 服务端为当前客户端选择的 Release 图标元数据；URL 为短期授权地址。 */
export interface PluginIconMetadata {
  /** 图标 MIME 类型，例如 image/png 或 image/svg+xml。 */
  mimeType: string;
  /** 图标对象的 SHA-256，固定为 64 位小写十六进制。 */
  sha256: string;
  /** 图标原始字节数，恒为正整数。 */
  sizeBytes: number;
  /** 短期 HTTPS 图标下载地址。 */
  url: string;
  /** 图标地址过期时间，格式为带毫秒的 UTC ISO 8601。 */
  expiresAt: string;
}

/** 列表和详情共用的客户端兼容 Release 摘要。 */
export interface PluginReleaseSummary {
  /** plugin-server 生成的 Release 资源 ID；调用方应将其视为不透明字符串。 */
  id: string;
  /** 与该 Release 的 `manifest.version` 一致。 */
  version: string;
  /** `.cindy` 原始字节的 SHA-256，固定为 64 位小写十六进制。 */
  sha256: string;
  /** `.cindy` 原始字节数，恒为正整数。 */
  sizeBytes: number;
  /** Release 发布时间，格式为带毫秒的 UTC ISO 8601。 */
  publishedAt: string;
  /** 发布时从包内提取并单独存储的图标；未声明图标时为 null。 */
  icon: PluginIconMetadata | null;
}

/** 详情响应中的客户端兼容 Release；在摘要基础上包含已校验的完整 manifest。 */
export interface PluginReleaseDetail extends PluginReleaseSummary {
  /** 已通过 `validateGhostManifest` 规范化的当前 manifest。 */
  manifest: GhostManifest;
}

/** Plugin 列表项；只含市场展示和版本对账所需的摘要。 */
export interface VisiblePluginSummary {
  /** plugin-server 生成的永久资源 ID，也是客户端管理安装实例的主键。 */
  id: string;
  /** 包内 `ghost.json.id`；跨不同来源允许重名，不能代替 `id`。 */
  ghostId: string;
  /** 客户端兼容 Release manifest 的展示名。 */
  name: string;
  /** 客户端兼容 Release manifest 的描述；未声明时为 `null`。 */
  description: string | null;
  /** 客户端兼容 Release manifest 的作者；未声明时为 `null`。 */
  author: string | null;
  /** Plugin 的来源范围。 */
  scope: PluginScope;
  /** Organization 必须是非空组织 ID；Public 和 Personal 恒为 `null`。 */
  organizationId: string | null;
  /** 对当前请求身份计算后的默认安装值，不表示强制安装或强制启用。 */
  defaultInstall: boolean;
  /** 服务端为该客户端选择的 Release；优先 current，不兼容时回退到历史兼容版本。 */
  currentRelease: PluginReleaseSummary;
}

/** Plugin 详情；展示字段必须与 `currentRelease.manifest` 保持一致。 */
export interface VisiblePluginDetail {
  /** plugin-server 生成的永久资源 ID，也是客户端管理安装实例的主键。 */
  id: string;
  /** 包内 `ghost.json.id`；跨不同来源允许重名，不能代替 `id`。 */
  ghostId: string;
  /** 客户端兼容 Release manifest 的展示名。 */
  name: string;
  /** 客户端兼容 Release manifest 的描述；未声明时为 `null`。 */
  description: string | null;
  /** 客户端兼容 Release manifest 的作者；未声明时为 `null`。 */
  author: string | null;
  /** Plugin 的来源范围。 */
  scope: PluginScope;
  /** Organization 必须是非空组织 ID；Public 和 Personal 恒为 `null`。 */
  organizationId: string | null;
  /** 对当前请求身份计算后的默认安装值，不表示强制安装或强制启用。 */
  defaultInstall: boolean;
  /** 服务端为该客户端选择的 Release，包含完整 manifest。 */
  currentRelease: PluginReleaseDetail;
}

/** 清理通告支持的处置动作；解析器会跳过动作未知的通告（未来扩展位）。 */
export const PLUGIN_REMOVAL_ACTIONS = ['purge'] as const;

/** `purge` 表示删除本地已安装副本及插件本地数据。 */
export type PluginRemovalAction = (typeof PLUGIN_REMOVAL_ACTIONS)[number];

/** 曾上架、现已下架并被要求处置本地副本的 Plugin 的清理通告。 */
export interface PluginRemovalNotice {
  /** 被清理 Plugin 的永久资源 ID；客户端据此匹配本地安装记录并跨分页去重。 */
  pluginId: string;
  /** 通告对应的 `ghost.json.id` 快照；供客户端双重校验，不能代替 `pluginId`。 */
  ghostId: string;
  /** 被清理 Plugin 的来源范围；当前服务端只对 organization 下发通告。 */
  scope: PluginScope;
  /** Organization 必须是非空组织 ID；Public 和 Personal 恒为 `null`。 */
  organizationId: string | null;
  /** 处置动作。 */
  action: PluginRemovalAction;
  /** 最近一次下架时间；重新上架再下架会刷新，消费方不得假设单调。 */
  removedAt: string;
}

/** Plugin 分页列表响应。 */
export interface ListPluginsResponse {
  /** Plugin HTTP envelope 版本。 */
  schemaVersion: typeof PLUGIN_API_SCHEMA_VERSION;
  /** 当前页内对请求身份可见的 Plugin 摘要。 */
  plugins: VisiblePluginSummary[];
  /** 下一页使用的不透明游标；调用方只可原样回传，没有下一页时为 `null`。 */
  nextCursor: string | null;
  /** 对请求身份可见的清理通告；服务端每页重复完整下发，缺失时规范化为空数组。 */
  removals: PluginRemovalNotice[];
}

/** 单个 Plugin 详情响应。 */
export interface GetPluginResponse {
  /** Plugin HTTP envelope 版本。 */
  schemaVersion: typeof PLUGIN_API_SCHEMA_VERSION;
  /** 当前身份可见且处于 active 状态的 Plugin 详情。 */
  plugin: VisiblePluginDetail;
}

/** 当前 Release 的短期私有下载凭证；不重复携带 HTTP envelope 版本。 */
export interface PluginDownloadResponse {
  /** 短期 HTTPS 下载地址。 */
  url: string;
  /** 下载地址过期时间，格式为带毫秒的 UTC ISO 8601。 */
  expiresAt: string;
  /** 必须与客户端准备下载的当前 Release 摘要一致。 */
  sha256: string;
  /** 必须与客户端准备下载的当前 Release 摘要一致。 */
  sizeBytes: number;
}

function parseIconMetadata(value: unknown, path: string): PluginIconMetadata | null {
  // 老的 v2 服务端尚未提供 icon 字段时，客户端继续使用本地兜底图标。
  if (value === null || value === undefined) return null;
  const raw = object(value, path);
  const mimeType = string(raw.mimeType, `${path}.mimeType`, 128);
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw new PluginProtocolError(`${path}.mimeType 必须是 image/* MIME 类型`);
  }
  if (
    typeof raw.sizeBytes !== 'number' ||
    !Number.isSafeInteger(raw.sizeBytes) ||
    raw.sizeBytes <= 0
  ) {
    throw new PluginProtocolError(`${path}.sizeBytes 必须是正整数`);
  }
  return {
    mimeType,
    sha256: sha256(raw.sha256, `${path}.sha256`),
    sizeBytes: raw.sizeBytes,
    url: httpsUrl(raw.url, `${path}.url`),
    expiresAt: isoDate(raw.expiresAt, `${path}.expiresAt`),
  };
}

function parseReleaseSummary(value: unknown, path: string): PluginReleaseSummary {
  const raw = object(value, path);
  const version = string(raw.version, `${path}.version`, 32);
  if (
    typeof raw.sizeBytes !== 'number' ||
    !Number.isSafeInteger(raw.sizeBytes) ||
    raw.sizeBytes <= 0
  ) {
    throw new PluginProtocolError(`${path}.sizeBytes 必须是正整数`);
  }
  return {
    id: string(raw.id, `${path}.id`, 128),
    version,
    sha256: sha256(raw.sha256, `${path}.sha256`),
    sizeBytes: raw.sizeBytes,
    publishedAt: isoDate(raw.publishedAt, `${path}.publishedAt`),
    icon: parseIconMetadata(raw.icon, `${path}.icon`),
  };
}

function parseReleaseDetail(value: unknown, ghostId: string, path: string): PluginReleaseDetail {
  const raw = object(value, path);
  const summary = parseReleaseSummary(raw, path);
  const validatedManifest = validateGhostManifest(raw.manifest);
  if (!validatedManifest.ok) {
    throw new PluginProtocolError(`${path}.manifest 不合法: ${validatedManifest.reason}`);
  }
  if (validatedManifest.manifest.id !== ghostId) {
    throw new PluginProtocolError(`${path}.manifest.id 与 ghostId 不一致`);
  }
  if (summary.version !== validatedManifest.manifest.version) {
    throw new PluginProtocolError(`${path}.version 与 manifest.version 不一致`);
  }
  return { ...summary, manifest: validatedManifest.manifest };
}

function parseScope(value: unknown, path: string): PluginScope {
  if (!(PLUGIN_SCOPES as readonly unknown[]).includes(value)) {
    throw new PluginProtocolError(`${path}.scope 不合法`);
  }
  return value as PluginScope;
}

function parseScopedOrganizationId(
  scope: PluginScope,
  value: unknown,
  path: string,
): string | null {
  if (
    ((scope === 'public' || scope === 'personal') && value !== null) ||
    (scope === 'organization' && (typeof value !== 'string' || value.length === 0))
  ) {
    throw new PluginProtocolError(`${path}.organizationId 与 scope 不一致`);
  }
  return value as string | null;
}

function parseVisiblePluginBase(
  value: unknown,
  path: string,
): {
  raw: Record<string, unknown>;
  id: string;
  ghostId: string;
  name: string;
  description: string | null;
  author: string | null;
  scope: PluginScope;
  organizationId: string | null;
  defaultInstall: boolean;
} {
  const raw = object(value, path);
  if (!isValidPluginResourceId(raw.id)) throw new PluginProtocolError(`${path}.id 不合法`);
  if (!isValidGhostId(raw.ghostId)) throw new PluginProtocolError(`${path}.ghostId 不合法`);
  const scope = parseScope(raw.scope, path);
  const organizationId = parseScopedOrganizationId(scope, raw.organizationId, path);
  if (typeof raw.defaultInstall !== 'boolean') {
    throw new PluginProtocolError(`${path}.defaultInstall 必须是 boolean`);
  }
  return {
    raw,
    id: raw.id,
    ghostId: raw.ghostId,
    name: string(raw.name, `${path}.name`),
    description:
      raw.description === null ? null : string(raw.description, `${path}.description`, 300),
    author: raw.author === null ? null : string(raw.author, `${path}.author`),
    scope,
    organizationId,
    defaultInstall: raw.defaultInstall,
  };
}

function parseVisiblePluginSummary(value: unknown, index: number): VisiblePluginSummary {
  const path = `plugins[${index}]`;
  const parsed = parseVisiblePluginBase(value, path);
  return {
    id: parsed.id,
    ghostId: parsed.ghostId,
    name: parsed.name,
    description: parsed.description,
    author: parsed.author,
    scope: parsed.scope,
    organizationId: parsed.organizationId,
    defaultInstall: parsed.defaultInstall,
    currentRelease: parseReleaseSummary(parsed.raw.currentRelease, `${path}.currentRelease`),
  };
}

function parseVisiblePluginDetail(value: unknown, path: string): VisiblePluginDetail {
  const parsed = parseVisiblePluginBase(value, path);
  const currentRelease = parseReleaseDetail(
    parsed.raw.currentRelease,
    parsed.ghostId,
    `${path}.currentRelease`,
  );
  if (ghostManifestUsesOidcToken(currentRelease.manifest) && parsed.scope !== 'organization') {
    throw new PluginProtocolError(
      `${path}.currentRelease.manifest 的 oidc-token 仅允许 organization scope`,
    );
  }
  const manifestDescription = currentRelease.manifest.description ?? null;
  const manifestAuthor = currentRelease.manifest.author ?? null;
  if (parsed.name !== currentRelease.manifest.name) {
    throw new PluginProtocolError(`${path}.name 与 currentRelease.manifest.name 不一致`);
  }
  if (parsed.description !== manifestDescription) {
    throw new PluginProtocolError(
      `${path}.description 与 currentRelease.manifest.description 不一致`,
    );
  }
  if (parsed.author !== manifestAuthor) {
    throw new PluginProtocolError(`${path}.author 与 currentRelease.manifest.author 不一致`);
  }
  return {
    id: parsed.id,
    ghostId: parsed.ghostId,
    name: parsed.name,
    description: parsed.description,
    author: parsed.author,
    scope: parsed.scope,
    organizationId: parsed.organizationId,
    defaultInstall: parsed.defaultInstall,
    currentRelease,
  };
}

function parseRemovalNotice(value: unknown, path: string): PluginRemovalNotice | null {
  const raw = object(value, path);
  if (!isValidPluginResourceId(raw.pluginId)) {
    throw new PluginProtocolError(`${path}.pluginId 不合法`);
  }
  if (!isValidGhostId(raw.ghostId)) throw new PluginProtocolError(`${path}.ghostId 不合法`);
  const scope = parseScope(raw.scope, path);
  const organizationId = parseScopedOrganizationId(scope, raw.organizationId, path);
  const action = string(raw.action, `${path}.action`, 64);
  const removedAt = isoDate(raw.removedAt, `${path}.removedAt`);
  // 未知动作是未来扩展位：结构校验通过后跳过该条而不是拒绝整个响应，
  // 这样服务端新增动作不会打挂旧客户端的整轮列表解析。
  if (!(PLUGIN_REMOVAL_ACTIONS as readonly string[]).includes(action)) return null;
  return {
    pluginId: raw.pluginId,
    ghostId: raw.ghostId,
    scope,
    organizationId,
    action: action as PluginRemovalAction,
    removedAt,
  };
}

function parseRemovals(value: unknown): PluginRemovalNotice[] {
  // 老的 v2 服务端或未携带通告的身份不带该字段；缺失时规范化为空数组。
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new PluginProtocolError('response.removals 必须是数组');
  const notices: PluginRemovalNotice[] = [];
  value.forEach((entry, index) => {
    const notice = parseRemovalNotice(entry, `removals[${index}]`);
    if (notice) notices.push(notice);
  });
  return notices;
}

/**
 * 解析并规范化 Plugin 分页列表响应。
 *
 * 未知字段会被忽略；已知字段缺失、值不合法或 schema 版本不支持时抛出
 * `PluginProtocolError`。`removals` 缺失时规范化为空数组，动作未知的通告
 * 会被跳过而不影响其余内容。
 */
export function parseListPluginsResponse(value: unknown): ListPluginsResponse {
  const raw = object(value, 'response');
  if (raw.schemaVersion !== PLUGIN_API_SCHEMA_VERSION) {
    throw new PluginProtocolError(`response.schemaVersion 必须为 ${PLUGIN_API_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.plugins)) throw new PluginProtocolError('response.plugins 必须是数组');
  return {
    schemaVersion: PLUGIN_API_SCHEMA_VERSION,
    plugins: raw.plugins.map(parseVisiblePluginSummary),
    nextCursor: nextCursor(raw.nextCursor, 'response.nextCursor'),
    removals: parseRemovals(raw.removals),
  };
}

/**
 * 解析并规范化单个 Plugin 详情响应。
 *
 * 除通用字段校验外，还要求 manifest 的 id、version 和展示字段与外层数据一致。
 * 校验失败时抛出 `PluginProtocolError`。
 */
export function parseGetPluginResponse(value: unknown): GetPluginResponse {
  const raw = object(value, 'response');
  if (raw.schemaVersion !== PLUGIN_API_SCHEMA_VERSION) {
    throw new PluginProtocolError(`response.schemaVersion 必须为 ${PLUGIN_API_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: PLUGIN_API_SCHEMA_VERSION,
    plugin: parseVisiblePluginDetail(raw.plugin, 'response.plugin'),
  };
}

/**
 * 解析并规范化当前 Release 的短期下载凭证。
 *
 * 只接受 HTTPS URL、UTC 时间、合法 SHA-256 和正整数文件大小；校验失败时抛出
 * `PluginProtocolError`。
 */
export function parsePluginDownloadResponse(value: unknown): PluginDownloadResponse {
  const raw = object(value, 'response');
  if (
    typeof raw.sizeBytes !== 'number' ||
    !Number.isSafeInteger(raw.sizeBytes) ||
    raw.sizeBytes <= 0
  ) {
    throw new PluginProtocolError('response.sizeBytes 必须是正整数');
  }
  return {
    url: httpsUrl(raw.url, 'response.url'),
    expiresAt: isoDate(raw.expiresAt, 'response.expiresAt'),
    sha256: sha256(raw.sha256, 'response.sha256'),
    sizeBytes: raw.sizeBytes,
  };
}
