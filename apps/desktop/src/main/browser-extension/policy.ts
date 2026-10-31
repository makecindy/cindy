/**
 * 浏览器扩展作业的地址与载荷校验(宿主侧实现)。
 *
 * 不设站点名单(2026-10-30 决定):AI 本身权限已经很高,安全交给任务的权限档位与自动审核,
 * 与 Cindy 专用浏览器一致。线上的 policy 字段只为兼容旧扩展与旧插件保留,恒为「全部允许」。
 *
 * - 只接受无内嵌凭证的 http(s) URL;本机与私网地址同样允许(2026-10-28 决定);
 * - Agent 读到的地址与链接原样返回(2026-10-30 决定);只有转交给插件的翻译来源地址仍过
 *   redactUrl(bridge.ts),OAuth code、重置令牌与 Basic Auth userinfo 不随它离开本机。
 */

export const BROWSER_EXTENSION_READ_ACTIONS = [
  'tabs',
  'navigate',
  'open',
  'snapshot',
  'extract',
  'text',
  'content',
  'screenshot',
  'console',
  'requests',
  'responseBody',
  'wait',
  'pdf',
  'debuggerAccess',
  'unmark',
] as const;
export const BROWSER_EXTENSION_INTERACT_ACTIONS = [
  'click',
  'type',
  'press',
  'select',
  'hover',
  'scroll',
  'focus',
  'close',
  'upload',
  'evaluate',
  'clickCoords',
  'drag',
  'dialog',
  'resize',
  'cdp',
] as const;
/** Actions that address no page: listing tabs, and checking or granting the on-demand debugger. */
const UNADDRESSED_ACTIONS: readonly unknown[] = ['tabs', 'debuggerAccess', 'unmark'];
/** Any attribute may be extracted, as in Cindy's own browser (2026-10-30); only the name is checked. */
const EXTRACT_ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,99}$/;

export type BrowserExtensionReadAction = (typeof BROWSER_EXTENSION_READ_ACTIONS)[number];
export type BrowserExtensionInteractAction = (typeof BROWSER_EXTENSION_INTERACT_ACTIONS)[number];
export type BrowserExtensionAction = BrowserExtensionReadAction | BrowserExtensionInteractAction;

/** Wire shape kept for extensions and plugins of the site-list era; always the permissive default now. */
export interface BrowserExtensionPolicy {
  read: { block: string[] };
  interact: { allow: string[]; block: string[] };
}

export interface BrowserExtensionPolicyDenial {
  ok: false;
  error: string;
  message: string;
  host?: string;
  execution: 'not_executed';
}

export type BrowserExtensionPolicyVerdict =
  { ok: true; host?: string } | BrowserExtensionPolicyDenial;

export function isBrowserExtensionReadAction(
  action: unknown,
): action is BrowserExtensionReadAction {
  return (BROWSER_EXTENSION_READ_ACTIONS as readonly unknown[]).includes(action);
}

export function isBrowserExtensionInteractAction(
  action: unknown,
): action is BrowserExtensionInteractAction {
  return (BROWSER_EXTENSION_INTERACT_ACTIONS as readonly unknown[]).includes(action);
}

export function defaultBrowserExtensionPolicy(): BrowserExtensionPolicy {
  return { read: { block: [] }, interact: { allow: ['*'], block: [] } };
}

export function normalizeBrowserExtensionHost(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a domain, for example example.test.');
  const text = value.trim().toLowerCase();
  const exact = text.startsWith('=');
  const raw = exact ? text.slice(1) : text.replace(/^\*\./, '');
  if (/^\[[0-9a-f:.]+\]$/.test(raw)) {
      const host = new URL('https://' + raw).hostname;
    return (exact ? '=' : '') + host;
  }
  if (!raw || /[\s/@:?#\\]/.test(raw))
    throw new Error('Enter a domain only, without a URL, port or path.');
  const host = new URL('https://' + raw).hostname;
  // eslint-disable-next-line no-control-regex
  if (host !== raw && !/[^\x00-\x7f]/.test(raw)) throw new Error('Invalid domain.');
  if (
    // Single-label intranet names (jira, localhost) are valid entries.
    host.length > 253 ||
    host.endsWith('.') ||
    host.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  ) {
    throw new Error('Invalid domain.');
  }
  return (exact ? '=' : '') + host;
}

/**
 * The address checks every job still gets: a supported action and a plain HTTP(S) URL without embedded
 * credentials. There are no site lists (removed 2026-10-30): safety is the task's permission mode and review.
 */
export function checkBrowserExtensionTarget(
  action: unknown,
  url: unknown,
): BrowserExtensionPolicyVerdict {
  const deny = (error: string, message: string): BrowserExtensionPolicyDenial => ({
    ok: false,
    error,
    message,
    execution: 'not_executed',
  });
  if (!isBrowserExtensionReadAction(action) && !isBrowserExtensionInteractAction(action)) {
    return deny('INVALID_ACTION', 'Choose a supported browser action.');
  }
  if (UNADDRESSED_ACTIONS.includes(action)) return { ok: true };
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return deny('INVALID_URL', 'Provide a full HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    return deny('URL_NOT_ALLOWED', 'Only HTTP/HTTPS URLs without embedded credentials are supported.');
  }
  return { ok: true, host: u.hostname.toLowerCase().replace(/\.$/, '') };
}

export interface BrowserExtensionJobPayload {
  url?: string;
  browser?: string;
  limit?: number;
  maxChars?: number;
  waitMs?: number;
  host?: string;
  selector?: string;
  from?: string;
  ref?: string;
  text?: string;
  key?: string;
  waitFor?: string;
  emptySelector?: string;
  after?: string;
  values?: string[];
  fields?: Record<string, string | { selector: string; attr?: string }>;
  multiple?: boolean;
  submit?: boolean;
  /** Tab addressed by id (from tabs / open); the extension resolves the tab's current URL itself. */
  tabId?: number;
  [key: string]: unknown;
}

const TAB_ADDRESSED_ACTIONS = [
  'focus', 'close', 'screenshot', 'console', 'requests', 'responseBody',
  'evaluate', 'clickCoords', 'drag', 'dialog', 'resize', 'wait', 'pdf', 'cdp', 'unmark',
];

/** 与扩展侧同判据:对齐专用浏览器后新增动作的参数。 */
function validateParityPayload(action: string, payload: BrowserExtensionJobPayload): void {
  const finite = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  if (payload.tabId != null && (!Number.isInteger(payload.tabId) || (payload.tabId as number) < 0))
    throw new Error('Invalid tab id.');
  if (TAB_ADDRESSED_ACTIONS.includes(action) && payload.tabId == null)
    throw new Error('This action needs the tab id from tabs or open.');
  if (
    action === 'clickCoords' &&
    !payload.ref &&
    !payload.selector &&
    (!finite(payload.x, 0, 100000) || !finite(payload.y, 0, 100000))
  )
    throw new Error('clickCoords needs x and y in CSS pixels, or a ref or selector.');
  if (
    payload.modifiers != null &&
    (!Array.isArray(payload.modifiers) ||
      payload.modifiers.length > 4 ||
      payload.modifiers.some((m) => !['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'].includes(m as string)))
  )
    throw new Error('modifiers must be Alt, Control, ControlOrMeta, Meta or Shift.');
  if (action === 'drag') {
    const end = (ref: unknown, selector: unknown, x: unknown, y: unknown) =>
      !!ref || !!selector || (finite(x, 0, 100000) && finite(y, 0, 100000));
    if (!end(payload.startRef, payload.startSelector, payload.startX, payload.startY))
      throw new Error('drag needs a start ref, selector or coordinates.');
    if (!end(payload.endRef, payload.endSelector, payload.endX, payload.endY))
      throw new Error('drag needs an end ref, selector or coordinates.');
  }
  if (action === 'resize' && (!finite(payload.width, 200, 10000) || !finite(payload.height, 200, 10000)))
    throw new Error('resize needs width and height of 200–10000.');
  if (action === 'evaluate' && (typeof payload.fn !== 'string' || !payload.fn.trim() || payload.fn.length > 200000))
    throw new Error('evaluate needs fn source of at most 200000 characters.');
  if (action === 'responseBody' && !str(payload.requestUrl, 8192))
    throw new Error('responseBody needs the request URL.');
  if (action === 'dialog' && payload.promptText != null && !str(payload.promptText, 16000))
    throw new Error('Invalid promptText.');
  if (action === 'upload') {
    // Paths let Chrome read the files itself through the debugger (no size bound from the transfer);
    // bytes are the fallback when the debugger is not allowed. At least one, for the same files.
    const files = payload.files as Array<{ name?: unknown; data?: unknown; mimeType?: unknown }> | undefined;
    const paths = payload.paths as unknown[] | undefined;
    if (files == null && paths == null) throw new Error('upload needs files or paths.');
    if (
      files != null &&
      (!Array.isArray(files) ||
        !files.length ||
        files.length > 20 ||
        files.some((f) => !f || !str(f.name, 255) || !f.name || typeof f.data !== 'string' || (f.mimeType != null && !str(f.mimeType, 200))))
    )
      throw new Error('upload needs 1–20 files with name and base64 data.');
    if (files != null && files.reduce((n, f) => n + (f.data as string).length, 0) > 40_000_000)
      throw new Error('Upload files must total at most about 30 MB.');
    if (
      paths != null &&
      (!Array.isArray(paths) ||
        !paths.length ||
        paths.length > 20 ||
        paths.some((p) => !str(p, 4096) || !p || !(/^\//.test(p as string) || /^[A-Za-z]:[\\/]/.test(p as string) || /^\\\\[^\\/]/.test(p as string))) ||
        (files != null && files.length !== paths.length))
    )
      throw new Error('upload paths must be 1–20 absolute file paths, one per file.');
  }
  if (action === 'cdp') {
    if (!['begin', 'end', 'events', 'command'].includes(payload.op as string))
      throw new Error('cdp op must be begin, end, events or command.');
    if (payload.op === 'command' && (typeof payload.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(payload.method)))
      throw new Error('cdp command needs a protocol method such as Network.getCookies.');
    if (
      payload.params != null &&
      (typeof payload.params !== 'object' || Array.isArray(payload.params) || JSON.stringify(payload.params).length > 1_000_000)
    )
      throw new Error('cdp params must be an object of at most 1 MB.');
  }
  for (const key of ['timeMs', 'timeoutMs'] as const)
    if (payload[key] != null && !finite(payload[key], 0, 120000)) throw new Error(key + ' must be 0–120000.');
  if (payload.loadState != null && !['load', 'domcontentloaded', 'networkidle'].includes(payload.loadState as string))
    throw new Error('loadState must be load, domcontentloaded or networkidle.');
  for (const key of ['textGone', 'urlIncludes', 'filter', 'startRef', 'endRef', 'startSelector', 'endSelector', 'button'] as const)
    if (payload[key] != null && !str(payload[key], 8192)) throw new Error('Invalid ' + key + '.');
}

/** 校验一个作业载荷(与扩展侧 validate 同判据);非法时抛出人话错误。 */
export function validateBrowserExtensionJob(
  action: unknown,
  input: unknown = {},
): BrowserExtensionJobPayload {
  if (!isBrowserExtensionReadAction(action) && !isBrowserExtensionInteractAction(action)) {
    throw new Error('Unsupported browser action.');
  }
  const payload = (
    input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  ) as BrowserExtensionJobPayload;
  if (!UNADDRESSED_ACTIONS.includes(action) && (typeof payload.url !== 'string' || payload.url.length > 8192)) {
    throw new Error('Provide a full URL of at most 8192 characters.');
  }
  if (
    payload.browser != null &&
    (typeof payload.browser !== 'string' || payload.browser.length > 128)
  ) {
    throw new Error('Invalid browser connection id.');
  }
  if (
    payload.limit != null &&
    (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 100)
  ) {
    throw new Error('Limit must be 1–100.');
  }
  if (
    payload.maxChars != null &&
    (!Number.isInteger(payload.maxChars) || payload.maxChars < 256 || payload.maxChars > 30000)
  ) {
    throw new Error('maxChars must be 256–30000.');
  }
  if (
    payload.waitMs != null &&
    (!Number.isInteger(payload.waitMs) || payload.waitMs < 0 || payload.waitMs > 15000)
  ) {
    throw new Error('waitMs must be 0–15000.');
  }
  if (payload.host != null) normalizeBrowserExtensionHost(payload.host);
  for (const key of [
    'selector',
    'from',
    'ref',
    'text',
    'key',
    'waitFor',
    'emptySelector',
    'after',
  ] as const) {
    const value = payload[key];
    if (
      value != null &&
      (typeof value !== 'string' || value.length > (key === 'text' ? 16000 : 2000))
    ) {
      throw new Error('Invalid ' + key + '.');
    }
  }
  validateParityPayload(action as string, payload);
  if (
    ['click', 'type', 'select', 'hover', 'upload'].includes(action as string) &&
    !payload.ref &&
    !payload.selector
  ) {
    throw new Error('Provide a fresh snapshot ref or CSS selector.');
  }
  if (action === 'type' && typeof payload.text !== 'string') {
    throw new Error('Typing requires text (an empty string clears the field).');
  }
  if (action === 'press' && !payload.key) throw new Error('Provide the key to press.');
  if (
    action === 'select' &&
    (!Array.isArray(payload.values) ||
      payload.values.length > 100 ||
      payload.values.some((v) => typeof v !== 'string' || v.length > 2000))
  ) {
    throw new Error('Provide an array of option values.');
  }
  if (action === 'extract') {
    const fields = payload.fields;
    if (
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      !Object.keys(fields).length ||
      Object.keys(fields).length > 30
    ) {
      throw new Error('Extract requires 1–30 fields.');
    }
    // 与扩展侧同判据:字段名不得含控制字符。
    // eslint-disable-next-line no-control-regex
    if (Object.keys(fields).some((k) => !k || k.length > 32 || /[\x00-\x1f]/.test(k))) {
      throw new Error('Field names must contain 1–32 printable characters.');
    }
    for (const spec of Object.values(fields)) {
      const invalid =
        typeof spec === 'string'
          ? !spec || spec.length > 2000
          : !spec ||
            typeof spec.selector !== 'string' ||
            !spec.selector ||
            spec.selector.length > 2000 ||
            (spec.attr != null &&
              (typeof spec.attr !== 'string' || !EXTRACT_ATTRIBUTE_NAME.test(spec.attr)));
      if (invalid) {
        throw new Error('Each field needs a CSS selector; attr must be an attribute name.');
      }
    }
    if (payload.after != null && !payload.multiple)
      throw new Error('after requires multiple records.');
  }
  return payload;
}

// ── URL 脱敏(与扩展侧逐字同判据)──────────────────────────────────────────

const CREDENTIAL_WORDS = new Set([
  'code',
  'token',
  'secret',
  'key',
  'apikey',
  'password',
  'passwd',
  'pwd',
  'pass',
  'session',
  'sessionid',
  'sid',
  'state',
  'nonce',
  'auth',
  'authorization',
  'signature',
  'sig',
  'otp',
  'pin',
  'ticket',
  'assertion',
  'saml',
  'sso',
  'reset',
  'invite',
  'verifier',
  'challenge',
  'access',
  'refresh',
  'bearer',
  'unlock',
  'recover',
  'recovery',
  'magic',
  'invitation',
  'activation',
  'verification',
  'credential',
  'credentials',
]);
const CONTEXT_WORDS = new Set([
  'reset',
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activate',
  'activation',
  'invite',
  'magic',
  'auth',
  'authenticate',
  'authorize',
  'unlock',
  'recover',
  'recovery',
  'password',
  'passcode',
  'signin',
  'signup',
  'login',
  'callback',
  'redirect',
  'token',
]);
const MAX_DECODE_PASSES = 4;
const CREDENTIAL_MIN_LENGTH = 16;

function normalizeEncoding(text: string): string {
  let current = text;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const credentialKey = (key: string): boolean => {
  const decoded = normalizeEncoding(key);
  const parts = words(decoded.replace(/([a-z])([0-9])/g, '$1 $2'));
  return parts.length > 0 && parts.some((word) => CREDENTIAL_WORDS.has(word));
};

const opaque = (value: string): boolean =>
  value.length >= 32 && /^[A-Za-z0-9._~+/=-]+$/.test(value);

function redactSegments(path: string): string {
  const segments = path.split('/');
  let context = false;
  let changed = false;
  for (let i = 0; i < segments.length; i++) {
    const decoded = normalizeEncoding(segments[i]);
    const parts = words(decoded);
    if (parts.some((word) => CONTEXT_WORDS.has(word))) {
      context = true;
      const remainder = parts.filter((word) => !CONTEXT_WORDS.has(word)).join('');
      if (remainder.length >= CREDENTIAL_MIN_LENGTH) {
        segments[i] = 'REDACTED';
        changed = true;
      }
      continue;
    }
    if (context && decoded.length >= CREDENTIAL_MIN_LENGTH) {
      segments[i] = 'REDACTED';
      changed = true;
    }
  }
  return changed ? segments.join('/') : path;
}

function sanitizeNested(decoded: string): string {
  if (/^https?:\/\//i.test(decoded)) return redactBrowserUrl(decoded);
  if (decoded.startsWith('/')) return redactSegments(decoded);
  return decoded;
}

/** 交给模型前的最后一道门:页面 URL、标签页 URL、链接与提取字段里的凭证都在这里抹掉。 */
export function redactBrowserUrl<T>(raw: T): T;
export function redactBrowserUrl(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  let changed = false;
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    changed = true;
  }
  for (const [key, value] of [...u.searchParams]) {
    const decoded = normalizeEncoding(value);
    if (credentialKey(key) || opaque(decoded)) {
      u.searchParams.set(key, 'REDACTED');
      changed = true;
      continue;
    }
    const nested = sanitizeNested(decoded);
    if (nested !== decoded) {
      u.searchParams.set(key, nested);
      changed = true;
    }
  }
  const fragment = u.hash ? u.hash.slice(1) : '';
  if (fragment && normalizeEncoding(fragment).includes('=')) {
    u.hash = '#REDACTED';
    changed = true;
  } else if (fragment) {
    const redacted = redactSegments(fragment);
    if (redacted !== fragment) {
      u.hash = '#' + redacted;
      changed = true;
    }
  }
  const redactedPath = redactSegments(u.pathname);
  if (redactedPath !== u.pathname) {
    u.pathname = redactedPath;
    changed = true;
  }
  return changed ? u.href : raw;
}
