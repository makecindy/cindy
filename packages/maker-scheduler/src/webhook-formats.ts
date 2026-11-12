/**
 * Webhook 发送方格式：签名怎么验、事件字段在哪里。webhook-server 只执行这份描述，不内置任何一家的规则，
 * 所以新增发送方只需在这里加预设。校验与 cindy-server 仓 webhook-server/src/core/format.ts 一致，两边一起改。
 * 不依赖 Node，Renderer 也会引用。
 */

export const WEBHOOK_FIELD_NAMES = [
  'event',
  'action',
  'deliveryId',
  'repository',
  'number',
  'sender',
  'headSha',
  'conclusion',
] as const;
export type WebhookFieldName = (typeof WEBHOOK_FIELD_NAMES)[number];

export type WebhookFieldSource = { header: string } | { body: string };
export type WebhookTimestampSource = { header: string } | { param: string };

export interface WebhookHmacSignature {
  type: 'hmac';
  algorithm: 'sha256' | 'sha512';
  /** 签名所在的请求头，小写。 */
  header: string;
  /** 请求头里有多个值时的分隔符。 */
  separator?: ' ' | ',';
  /** 请求头是 key=value 列表时，签名所在的 key（如 Stripe 的 v1）；其余 key 可作为 {param:名称} 引用。 */
  key?: string;
  /** 每个签名值前的固定文本，如 sha256=、v1,。 */
  prefix?: string;
  encoding: 'hex' | 'base64';
  /** 被签名的内容：{body}、{header:名称}、{param:名称} 和普通文本，必须恰好包含一个 {body}。 */
  payload: string;
  /** text：密钥原文就是 HMAC 密钥；whsec：去掉 whsec_ 前缀后按 base64 解码。 */
  secret: 'text' | 'whsec';
  /** 被签名覆盖的时间戳，用来拒绝旧请求重放。 */
  timestamp?: { source: WebhookTimestampSource; unit: 's' | 'ms'; toleranceSec: number };
}

/** 请求头里直接带密钥，比如旧版 GitLab 的 X-Gitlab-Token。 */
export interface WebhookTokenSignature {
  type: 'token';
  header: string;
  prefix?: string;
}

export interface WebhookFormat {
  version: 1;
  /** null 表示不签名：拿到地址的人都能触发。 */
  signature: WebhookHmacSignature | WebhookTokenSignature | null;
  /** 每个字段按顺序取第一个有值的位置。 */
  fields: Partial<Record<WebhookFieldName, WebhookFieldSource[]>>;
  /** 这些事件名是发送方的连通测试，不计次、不唤醒任务。 */
  ping?: string[];
}

/** 密钥的用法。用法变了，原来的密钥就不再有效。 */
export type WebhookSecretKind = 'hmac-text' | 'hmac-whsec' | 'token';

const MAX_FORMAT_BYTES = 4_096;
const MAX_SOURCES = 5;
const MAX_PING = 5;
const MAX_PAYLOAD_LENGTH = 200;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAM = /^[A-Za-z0-9_-]{1,32}$/;
const BODY_PATH = /^[A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64}|\[\d{1,3}\]){0,9}$/;
const PREFIX = /^[\x20-\x7e]{1,16}$/;
const PING_EVENT = /^[\x21-\x7e]{1,100}$/;
const TEMPLATE_TOKEN = /\{([^{}]*)\}/g;
const TEMPLATE_LITERAL = /^[\x20-\x7a\x7c\x7e]*$/;
const TEXT_SECRET = /^[\x21-\x7e]{8,512}$/;
const WHSEC_SECRET = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasOnlyKeys(value: Json, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function parseSource(value: unknown): WebhookFieldSource | null {
  if (!isObject(value)) return null;
  if (hasOnlyKeys(value, ['header']) && typeof value.header === 'string' && HEADER.test(value.header)) {
    return { header: value.header };
  }
  if (hasOnlyKeys(value, ['body']) && typeof value.body === 'string' && BODY_PATH.test(value.body)) {
    return { body: value.body };
  }
  return null;
}

function templateTokens(template: string): string[] | null {
  if (template.length === 0 || template.length > MAX_PAYLOAD_LENGTH) return null;
  const tokens: string[] = [];
  let last = 0;
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    if (!TEMPLATE_LITERAL.test(template.slice(last, match.index))) return null;
    tokens.push(match[1]!);
    last = (match.index ?? 0) + match[0].length;
  }
  return TEMPLATE_LITERAL.test(template.slice(last)) ? tokens : null;
}

function validToken(token: string, keyed: boolean): boolean {
  if (token === 'body') return true;
  if (token.startsWith('header:')) return HEADER.test(token.slice('header:'.length));
  if (token.startsWith('param:')) return keyed && PARAM.test(token.slice('param:'.length));
  return false;
}

function parseHmac(value: Json): WebhookHmacSignature | null {
  const required = ['type', 'algorithm', 'header', 'encoding', 'payload', 'secret'];
  if (!hasOnlyKeys(value, required, ['separator', 'key', 'prefix', 'timestamp'])) return null;
  const { algorithm, header, separator, key, prefix, encoding, payload, secret, timestamp } = value;
  if (algorithm !== 'sha256' && algorithm !== 'sha512') return null;
  if (typeof header !== 'string' || !HEADER.test(header)) return null;
  if (separator !== undefined && separator !== ' ' && separator !== ',') return null;
  if (key !== undefined && (typeof key !== 'string' || !PARAM.test(key))) return null;
  if (prefix !== undefined && (typeof prefix !== 'string' || !PREFIX.test(prefix))) return null;
  if (encoding !== 'hex' && encoding !== 'base64') return null;
  if (secret !== 'text' && secret !== 'whsec') return null;
  if (typeof payload !== 'string') return null;
  const keyed = key !== undefined;
  const tokens = templateTokens(payload);
  // 签名必须覆盖正文，否则改了正文也能通过验签。
  if (!tokens || tokens.filter((token) => token === 'body').length !== 1) return null;
  if (!tokens.every((token) => validToken(token, keyed))) return null;

  const signature: WebhookHmacSignature = {
    type: 'hmac',
    algorithm,
    header,
    encoding,
    payload,
    secret,
    ...(separator !== undefined ? { separator } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
  };
  if (timestamp === undefined) return signature;
  if (!isObject(timestamp) || !hasOnlyKeys(timestamp, ['source', 'unit', 'toleranceSec'])) return null;
  const { source, unit, toleranceSec } = timestamp;
  if (unit !== 's' && unit !== 'ms') return null;
  if (!Number.isInteger(toleranceSec) || (toleranceSec as number) < 10 || (toleranceSec as number) > 3_600) return null;
  let parsedSource: WebhookTimestampSource | null = null;
  if (isObject(source) && hasOnlyKeys(source, ['param'])) {
    if (keyed && typeof source.param === 'string' && PARAM.test(source.param)) parsedSource = { param: source.param };
  } else if (isObject(source) && hasOnlyKeys(source, ['header'])) {
    if (typeof source.header === 'string' && HEADER.test(source.header)) parsedSource = { header: source.header };
  }
  if (!parsedSource) return null;
  // 时间戳必须进签名，否则把旧请求的时间戳改成当前时间就能绕过过期检查。
  const signed = 'param' in parsedSource ? `param:${parsedSource.param}` : `header:${parsedSource.header}`;
  if (!tokens.includes(signed)) return null;
  return { ...signature, timestamp: { source: parsedSource, unit, toleranceSec: toleranceSec as number } };
}

function parseSignature(value: unknown): WebhookHmacSignature | WebhookTokenSignature | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  if (value.type === 'hmac') return parseHmac(value) ?? undefined;
  if (value.type !== 'token' || !hasOnlyKeys(value, ['type', 'header'], ['prefix'])) return undefined;
  const { header, prefix } = value;
  if (typeof header !== 'string' || !HEADER.test(header)) return undefined;
  if (prefix !== undefined && (typeof prefix !== 'string' || !PREFIX.test(prefix))) return undefined;
  return { type: 'token', header, ...(prefix !== undefined ? { prefix } : {}) };
}

/** 校验并规整发送方格式；不合法时返回 null。 */
export function parseWebhookFormat(value: unknown): WebhookFormat | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['version', 'signature', 'fields'], ['ping'])) return null;
  if (value.version !== 1) return null;
  if (JSON.stringify(value).length > MAX_FORMAT_BYTES) return null;
  const signature = parseSignature(value.signature);
  if (signature === undefined) return null;

  if (!isObject(value.fields)) return null;
  const fields: WebhookFormat['fields'] = {};
  for (const [name, sources] of Object.entries(value.fields)) {
    if (!(WEBHOOK_FIELD_NAMES as readonly string[]).includes(name)) return null;
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SOURCES) return null;
    const parsed = sources.map(parseSource);
    if (parsed.some((source) => source === null)) return null;
    fields[name as WebhookFieldName] = parsed as WebhookFieldSource[];
  }

  const format: WebhookFormat = { version: 1, signature, fields };
  if (value.ping === undefined) return format;
  const { ping } = value;
  if (!Array.isArray(ping) || ping.length === 0 || ping.length > MAX_PING) return null;
  if (!ping.every((name) => typeof name === 'string' && PING_EVENT.test(name))) return null;
  return { ...format, ping: [...new Set(ping as string[])] };
}

export function webhookSecretKind(format: WebhookFormat): WebhookSecretKind | null {
  const { signature } = format;
  if (!signature) return null;
  if (signature.type === 'token') return 'token';
  return signature.secret === 'whsec' ? 'hmac-whsec' : 'hmac-text';
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

/** 与服务器相同的密钥格式检查，界面上提前提示。 */
export function isValidWebhookSecret(kind: WebhookSecretKind, secret: string): boolean {
  if (kind !== 'hmac-whsec') return TEXT_SECRET.test(secret);
  if (!WHSEC_SECRET.test(secret)) return false;
  const bytes = base64ByteLength(secret.slice('whsec_'.length));
  return bytes >= 16 && bytes <= 64;
}

// ---------------------------------------------------------------------------
// 预设

const GITHUB_FIELDS: WebhookFormat['fields'] = {
  event: [{ header: 'x-github-event' }, { header: 'x-webhook-event' }],
  deliveryId: [{ header: 'x-github-delivery' }, { header: 'x-webhook-delivery' }],
  action: [{ body: 'action' }],
  repository: [{ body: 'repository.full_name' }],
  number: [
    { body: 'pull_request.number' },
    { body: 'issue.number' },
    { body: 'check_suite.pull_requests[0].number' },
    { body: 'number' },
  ],
  sender: [{ body: 'sender.login' }],
  headSha: [{ body: 'check_suite.head_sha' }, { body: 'pull_request.head.sha' }],
  conclusion: [{ body: 'check_suite.conclusion' }],
};

const GITLAB_FIELDS: WebhookFormat['fields'] = {
  event: [{ body: 'object_kind' }],
  action: [{ body: 'object_attributes.action' }],
  repository: [{ body: 'project.path_with_namespace' }],
  number: [{ body: 'object_attributes.iid' }, { body: 'merge_request.iid' }],
  sender: [{ body: 'user.username' }],
  headSha: [{ body: 'object_attributes.last_commit.id' }, { body: 'checkout_sha' }, { body: 'object_attributes.sha' }],
  conclusion: [{ body: 'object_attributes.status' }],
};

/** https://www.standardwebhooks.com/ ：GitLab 19+ 签名令牌、OpenAI、Anthropic、Supabase 等都用这一种。 */
const STANDARD_SIGNATURE: WebhookHmacSignature = {
  type: 'hmac',
  algorithm: 'sha256',
  header: 'webhook-signature',
  separator: ' ',
  prefix: 'v1,',
  encoding: 'base64',
  payload: '{header:webhook-id}.{header:webhook-timestamp}.{body}',
  secret: 'whsec',
  timestamp: { source: { header: 'webhook-timestamp' }, unit: 's', toleranceSec: 300 },
};

const HUB_SHA256 = (header: string): WebhookHmacSignature => ({
  type: 'hmac',
  algorithm: 'sha256',
  header,
  prefix: 'sha256=',
  encoding: 'hex',
  payload: '{body}',
  secret: 'text',
});

export type ScheduleWebhookPresetId =
  | 'github'
  | 'gitea'
  | 'bitbucket'
  | 'linear'
  | 'gitlab'
  | 'gitlab-token'
  | 'standard-webhooks'
  | 'stripe';

export interface ScheduleWebhookPreset {
  id: ScheduleWebhookPresetId;
  /** 产品名，不翻译。 */
  label: string;
  /** 开启签名时的格式。关闭签名只去掉 signature，事件识别照旧。 */
  format: WebhookFormat;
  /** cindy：Cindy 生成后填到发送方；sender：发送方生成，复制到 Cindy；either：两种都可以。 */
  secretFrom: 'cindy' | 'sender' | 'either';
  /** 发送方设置页里填写或复制密钥的位置，按发送方界面原文显示。 */
  secretField: string;
}

export const SCHEDULE_WEBHOOK_PRESETS: readonly ScheduleWebhookPreset[] = [
  {
    id: 'github',
    label: 'GitHub',
    format: { version: 1, signature: HUB_SHA256('x-hub-signature-256'), fields: GITHUB_FIELDS, ping: ['ping'] },
    secretFrom: 'cindy',
    secretField: 'Secret',
  },
  {
    // Gitea 与 Forgejo 都发 GitHub 兼容的签名头，字段结构也与 GitHub 相同。
    id: 'gitea',
    label: 'Gitea / Forgejo',
    format: {
      version: 1,
      signature: HUB_SHA256('x-hub-signature-256'),
      fields: {
        ...GITHUB_FIELDS,
        event: [{ header: 'x-gitea-event' }, { header: 'x-forgejo-event' }, { header: 'x-github-event' }],
        deliveryId: [{ header: 'x-gitea-delivery' }, { header: 'x-forgejo-delivery' }, { header: 'x-github-delivery' }],
      },
    },
    secretFrom: 'cindy',
    secretField: 'Secret',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket Cloud',
    format: {
      version: 1,
      signature: HUB_SHA256('x-hub-signature'),
      fields: {
        event: [{ header: 'x-event-key' }],
        deliveryId: [{ header: 'x-request-uuid' }],
        repository: [{ body: 'repository.full_name' }],
        number: [{ body: 'pullrequest.id' }],
        sender: [{ body: 'actor.nickname' }],
        headSha: [{ body: 'pullrequest.source.commit.hash' }],
      },
    },
    secretFrom: 'cindy',
    secretField: 'Secret',
  },
  {
    // Linear 会在 1 分钟、1 小时、6 小时后重投失败的请求，重投是否更新时间戳没有文档说明，所以不校验时间戳。
    id: 'linear',
    label: 'Linear',
    format: {
      version: 1,
      signature: { type: 'hmac', algorithm: 'sha256', header: 'linear-signature', encoding: 'hex', payload: '{body}', secret: 'text' },
      fields: {
        event: [{ header: 'linear-event' }],
        deliveryId: [{ header: 'linear-delivery' }],
        action: [{ body: 'action' }],
        number: [{ body: 'data.number' }],
        sender: [{ body: 'actor.name' }],
      },
    },
    secretFrom: 'sender',
    secretField: 'Signing secret',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    format: {
      version: 1,
      signature: STANDARD_SIGNATURE,
      fields: { ...GITLAB_FIELDS, deliveryId: [{ header: 'webhook-id' }, { header: 'idempotency-key' }] },
    },
    secretFrom: 'either',
    secretField: 'Signing token',
  },
  {
    id: 'gitlab-token',
    label: 'GitLab (Secret token)',
    format: {
      version: 1,
      signature: { type: 'token', header: 'x-gitlab-token' },
      fields: { ...GITLAB_FIELDS, deliveryId: [{ header: 'x-gitlab-event-uuid' }, { header: 'idempotency-key' }] },
    },
    secretFrom: 'either',
    secretField: 'Secret token',
  },
  {
    id: 'standard-webhooks',
    label: 'Standard Webhooks',
    format: {
      version: 1,
      signature: STANDARD_SIGNATURE,
      fields: { event: [{ body: 'type' }], deliveryId: [{ header: 'webhook-id' }] },
    },
    secretFrom: 'sender',
    secretField: 'Signing secret',
  },
  {
    id: 'stripe',
    label: 'Stripe',
    format: {
      version: 1,
      signature: {
        type: 'hmac',
        algorithm: 'sha256',
        header: 'stripe-signature',
        separator: ',',
        key: 'v1',
        encoding: 'hex',
        payload: '{param:t}.{body}',
        secret: 'text',
        timestamp: { source: { param: 't' }, unit: 's', toleranceSec: 300 },
      },
      fields: { event: [{ body: 'type' }], deliveryId: [{ body: 'id' }] },
    },
    secretFrom: 'sender',
    secretField: 'Signing secret',
  },
];

export const DEFAULT_SCHEDULE_WEBHOOK_PRESET: ScheduleWebhookPresetId = 'github';

/** Managed App delivery is metadata-only; ordinary GitHub Webhooks keep their own format. */
export const GITHUB_APP_EVENTS = [
  'pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread',
  'issue_comment', 'check_run', 'check_suite', 'status', 'issues', 'push', 'workflow_run', 'release',
] as const;

export function scheduleWebhookPreset(id: string): ScheduleWebhookPreset | undefined {
  return SCHEDULE_WEBHOOK_PRESETS.find((preset) => preset.id === id);
}

/** 任务保存的发送方。缺省等于 GitHub 预设并签名。 */
export type ScheduleWebhookSource =
  | { preset: 'github-app'; repositories: string[] }
  | { preset: ScheduleWebhookPresetId; signed?: boolean }
  | { preset: 'custom'; format: WebhookFormat };

/** Presentation order is not part of a managed subscription's queue identity. */
export function sameGithubAppScope(
  a: { source?: ScheduleWebhookSource; events?: readonly string[] },
  b: { source?: ScheduleWebhookSource; events?: readonly string[] },
): boolean {
  if (a.source?.preset !== 'github-app' || b.source?.preset !== 'github-app') return false;
  const canonical = (repositories: readonly string[], events: readonly string[] = []) => JSON.stringify([
    [...new Set(repositories.map(repo => repo.trim().toLowerCase()))].sort(),
    [...new Set(events.map(event => event.trim()).filter(Boolean))].sort(),
  ]);
  return canonical(a.source.repositories, a.events) === canonical(b.source.repositories, b.events);
}

/**
 * 校验调用方提交的发送方；不合法时抛错，错误信息可直接给用户或 Agent。
 * 未知的预设名不接受：服务器按格式执行，客户端认不出的预设无法转成格式。
 */
export function normalizeScheduleWebhookSource(value: unknown): ScheduleWebhookSource {
  if (!isObject(value) || typeof value.preset !== 'string') throw new Error('invalid webhook source');
  if (value.preset === 'github-app') {
    if (!hasOnlyKeys(value, ['preset', 'repositories']) || !Array.isArray(value.repositories)
      || !value.repositories.length || value.repositories.length > 50 || value.repositories.some(repo =>
        typeof repo !== 'string' || !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repo))) {
      throw new Error('GitHub App requires 1–50 repository names (owner/repository)');
    }
    return { preset: 'github-app', repositories: [...new Set((value.repositories as string[]).map(repo => repo.toLowerCase()))] };
  }
  if (value.preset === 'custom') {
    if (!hasOnlyKeys(value, ['preset', 'format'])) throw new Error('invalid webhook source');
    const format = parseWebhookFormat(value.format);
    if (!format) throw new Error('invalid webhook format');
    return { preset: 'custom', format };
  }
  const preset = scheduleWebhookPreset(value.preset);
  if (!preset || !hasOnlyKeys(value, ['preset'], ['signed'])) throw new Error('invalid webhook source');
  if (value.signed !== undefined && typeof value.signed !== 'boolean') throw new Error('invalid webhook source');
  return value.signed === false ? { preset: preset.id, signed: false } : { preset: preset.id };
}

/** 发给服务器的格式。来自更新版本、本机认不出的预设返回 null，这时不改服务器上的格式。 */
export function resolveScheduleWebhookFormat(source: ScheduleWebhookSource | undefined): WebhookFormat | null {
  if (!source) return scheduleWebhookPreset(DEFAULT_SCHEDULE_WEBHOOK_PRESET)!.format;
  if (source.preset === 'github-app') return null;
  if (source.preset === 'custom') return parseWebhookFormat(source.format);
  const preset = scheduleWebhookPreset(source.preset);
  if (!preset) return null;
  return source.signed === false ? { ...preset.format, signature: null } : preset.format;
}

/** 密钥从哪里来；不签名时为 null。 */
export function scheduleWebhookSecretFrom(source: ScheduleWebhookSource | undefined): 'cindy' | 'sender' | 'either' | null {
  const format = resolveScheduleWebhookFormat(source);
  if (!format?.signature) return null;
  if (source?.preset === 'custom') return 'either';
  return scheduleWebhookPreset(source?.preset ?? DEFAULT_SCHEDULE_WEBHOOK_PRESET)?.secretFrom ?? 'either';
}
