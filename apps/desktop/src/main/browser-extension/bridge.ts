/**
 * 浏览器扩展桥接(宿主侧):在 127.0.0.1 的一段固定端口上承接随包浏览器扩展的
 * 长轮询连接,负责配对、身份绑定、作业分发、结果脱敏,以及把
 * 扩展发起的转交请求(翻译、字幕等)交给声明 browserExtension 的插件处理。
 *
 * 线协议 `cindy-browser-extension/3`(协议号 3,签名线合同 0.4.13)原样沿用插件
 * 时期的合同,已装扩展不需要更新即可连到宿主:
 *
 *   GET  /health                 握手:身份、版本、挑战/证明、会话
 *   GET  /poll                   长轮询取作业(20 秒)
 *   POST /ack /authorize /result 作业生命周期(已送达 → 已确认 → 已授权 → 结果)
 *   GET  /learning/challenge     转交请求的一次性挑战
 *   POST /learning/start|result|cancel  扩展发起、查询、取消转交请求
 *   POST /native/bind            Native Messaging host 代为绑定官方扩展身份
 *
 * 安全不变量(与插件时期逐条相同):
 * - 只有扩展 origin 能连:自定义头 + 无 CORS,网页、预检、改绑 Host 一律 403;
 * - 官方扩展 id 首次出现必须经 native host 绑定公钥,HTTP 调用方不能自称官方;
 * - 作业一次送达绝不重投;已确认未完成的作业只能是 unknown,不能按成功或未执行报告;
 * - 不设站点名单(2026-10-30 决定):安全交给任务的权限档位与自动审核;旧扩展与旧插件仍收发
 *   的 policy 字段只作兼容,恒为「全部允许」;
 * - Agent 读到的地址与链接原样返回(2026-10-30);转交给插件的翻译请求来源地址仍经 redactBrowserUrl;
 *   读取结果标 untrusted_content。
 */

import http from 'node:http';
import crypto from 'node:crypto';

import {
  checkBrowserExtensionTarget,
  defaultBrowserExtensionPolicy,
  isBrowserExtensionInteractAction,
  isBrowserExtensionReadAction,
  redactBrowserUrl,
  validateBrowserExtensionJob,
  type BrowserExtensionAction,
  type BrowserExtensionJobPayload,
  type BrowserExtensionPolicy,
} from './policy.js';
import {
  RELAY_PROGRESS_STAGES,
  RELAY_TIMING,
  relayRequestTimeout,
  validateRelayRequest,
  type RelayRequest,
} from './relay-protocol.js';

export const BROWSER_EXTENSION_PROTOCOL_NUMBER = 3;
/** 签名线合同版本;扩展与宿主各自发布不改变认证合同。 */
export const BROWSER_EXTENSION_WIRE_VERSION = '0.4.13';
/** 兼容的扩展端口段:0.3.x / 0.4.x 扩展只扫 18810–18819(新扩展再扫到 18909)。 */
export const BROWSER_EXTENSION_DEFAULT_PORTS: readonly number[] = Array.from(
  { length: 10 },
  (_, i) => 18810 + i,
);

const LEGACY_WIRE_VERSIONS = [
  '0.4.0',
  '0.4.1',
  '0.4.2',
  '0.4.3',
  '0.4.4',
  '0.4.5',
  '0.4.6',
  '0.4.7',
  '0.4.8',
  '0.4.9',
  '0.4.10',
  '0.4.11',
  '0.4.12',
];

export type BrowserExtensionExecution = 'not_executed' | 'executed' | 'unknown';

export interface BrowserExtensionFailure {
  ok: false;
  error: string;
  message: string;
  execution: BrowserExtensionExecution;
  [key: string]: unknown;
}

export type BrowserExtensionJobResult = { ok: boolean; [key: string]: unknown };

export interface BrowserExtensionTrustedClient {
  id: string;
  origin: string;
  extensionId: string;
  publicKey?: string;
}

export interface BrowserExtensionClientInfo {
  id: string;
  browser: 'chrome' | 'edge' | 'safari';
  version: string | null;
  protocolVersion: string;
  connected: boolean;
  trusted: boolean;
  identitySupported: boolean;
  nativeBindingRequired: boolean;
  origin: string;
  extensionId: string;
  publicKey?: string;
  /** Changes when the browser restarts (tab ids start over); absent from older extensions. */
  boot?: string;
}

export interface BrowserExtensionBridgeStatus {
  ok: true;
  version: string;
  protocol: number;
  port: number;
  extension_connected: boolean;
  extension_ids: string[];
  policy: BrowserExtensionPolicy;
  pending: number;
  clients: BrowserExtensionClientInfo[];
}

export interface BrowserExtensionRelayNotice {
  id: string;
  clientId: string;
  request: RelayRequest;
}

export interface BrowserExtensionBridgeOptions {
  /** 声明本能力的插件 id;/health 的 plugin 字段(扩展据此确认连对了宿主)。 */
  ghostId: string;
  /** 插件版本;/health 的 installedVersion(扩展设置页展示)。 */
  installedVersion: string;
  /** 允许连接的扩展 id(身份卡 browserExtension.extensionIds)。 */
  extensionIds: readonly string[];
  /** Native Messaging host 的私有授权令牌(64 位 hex);缺省表示没有 native 绑定。 */
  nativeToken?: string;
  /** 扩展发起的转交请求到达时回调(宿主转交给插件)。 */
  onRelay?: (notice: BrowserExtensionRelayNotice) => void;
  ports?: readonly number[];
  pollTimeout?: number;
  connectWait?: number;
  jobTimeout?: number;
  now?: () => number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface Client {
  id: string;
  origin: string;
  extensionId: string;
  browser: 'chrome' | 'edge' | 'safari';
  version: string;
  installedVersion: string | null;
  seen: number;
  publicKey: string | null;
  authenticated: boolean;
  challenge: { value: string; expires: number; publicKey: string } | null;
  session: string | null;
  trusted: boolean;
  boot?: string;
}

type JobState = 'queued' | 'delivered' | 'acknowledged';

interface Job {
  id: string;
  action: BrowserExtensionAction;
  payload: BrowserExtensionJobPayload;
  clientId: string;
  state: JobState;
  resolve: (result: BrowserExtensionJobResult) => void;
  created: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface RelayItem {
  id: string;
  clientId: string;
  payload: RelayRequest;
  created: number;
  expiresAt: number;
  result: unknown;
  retired?: boolean;
  progress: {
    stage: string;
    attempt: number;
    receivedChars?: number;
    startedAt: number;
    updatedAt: number;
  };
}

const failure = (
  error: string,
  message: string,
  execution: BrowserExtensionExecution = 'not_executed',
): BrowserExtensionFailure => ({ ok: false, error, message, execution });

const isHttp = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value);
const FIELD_VALUE_MAX = 4000;
/** Per-result backstops for list-shaped reads (see boundResult). */
const LIST_ENTRY_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['requests', 1000],
  ['messages', 1000],
  ['links', 1000],
  ['events', 5000],
];
const ENTRY_STRING_MAX = 8192;
/** Largest plugin answer to a relayed extension request (translations and subtitles included). */
const RELAY_RESULT_MAX_CHARS = 8_000_000;
const TEXT_RESULT_MAX = 400_000;

export class BrowserExtensionBridge {
  /** Wire compatibility only: extensions and plugins of the site-list era still read it. */
  private readonly policy: BrowserExtensionPolicy = defaultBrowserExtensionPolicy();
  private pins: BrowserExtensionTrustedClient[] = [];
  private readonly nativeBindings = new Map<string, string>();
  private server: http.Server | null = null;
  private starting: Promise<void> | null = null;
  private port = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly clients = new Map<string, Client>();
  private readonly waiting = new Map<string, () => void>();
  private readonly relays = new Map<string, RelayItem>();
  private readonly relayChallenges = new Map<string, { clientId: string; expiresAt: number }>();
  private readonly knownIds: Set<string>;
  private readonly now: () => number;

  private closed = false;

  constructor(private readonly options: BrowserExtensionBridgeOptions) {
    this.knownIds = new Set(options.extensionIds);
    this.now = options.now ?? Date.now;
  }

  private gate(action: unknown, url: unknown): ReturnType<typeof checkBrowserExtensionTarget> {
    return checkBrowserExtensionTarget(action, url);
  }

  get listeningPort(): number {
    return this.port;
  }

  // ── 身份判据 ────────────────────────────────────────────────────────────

  private compatible(version: string): boolean {
    return (
      version === BROWSER_EXTENSION_WIRE_VERSION ||
      LEGACY_WIRE_VERSIONS.includes(version) ||
      /^0\.3\.\d+$/.test(version)
    );
  }

  private live(c: Client): boolean {
    return this.now() - c.seen < 35000;
  }

  private sameIdentity(p: BrowserExtensionTrustedClient | undefined, c: Client): boolean {
    return !!p && p.id === c.id && p.origin === c.origin && p.extensionId === c.extensionId;
  }

  private pairedCredential(c: Client): boolean {
    return this.pins.some(
      (p) => this.sameIdentity(p, c) && !!c.publicKey && p.publicKey === c.publicKey,
    );
  }

  private official(c: Client): boolean {
    return c.origin === 'chrome-extension://' + c.extensionId && this.knownIds.has(c.extensionId);
  }

  private approved(c: Client): boolean {
    return this.official(c) || this.pins.some((p) => this.sameIdentity(p, c));
  }

  /** 新官方身份需要 native 绑定 + 证明;已保存的配对身份无需 native host 或重新批准。 */
  private boundCredential(c: Client): boolean {
    return (
      this.pairedCredential(c) ||
      (this.official(c) && this.nativeBindings.get(c.id) === c.publicKey)
    );
  }

  private authenticatedCredential(c: Client): boolean {
    return !!c.publicKey && c.authenticated && this.boundCredential(c);
  }

  private sessionReady(c: Client): boolean {
    return (
      c.trusted &&
      (c.version !== BROWSER_EXTENSION_WIRE_VERSION
        ? this.pins.some((p) => this.sameIdentity(p, c))
        : this.authenticatedCredential(c))
    );
  }

  private connected(): Client[] {
    return [...this.clients.values()].filter(
      (c) => this.sessionReady(c) && this.live(c) && this.compatible(c.version),
    );
  }

  private publicClient(c: Client): BrowserExtensionClientInfo {
    return {
      id: c.id,
      browser: c.browser,
      version: c.installedVersion,
      protocolVersion: c.version,
      connected: this.sessionReady(c) && this.live(c) && this.compatible(c.version),
      trusted: this.sessionReady(c),
      identitySupported: this.approved(c),
      nativeBindingRequired: this.official(c) && !this.boundCredential(c),
      origin: c.origin,
      extensionId: c.extensionId,
      ...(c.publicKey ? { publicKey: c.publicKey } : {}),
      ...(c.boot ? { boot: c.boot } : {}),
    };
  }

  private normalizePublicKey(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      > | null;
      if (
        decoded?.kty !== 'EC' ||
        decoded?.crv !== 'P-256' ||
        typeof decoded.x !== 'string' ||
        typeof decoded.y !== 'string' ||
        Object.keys(decoded).some((k) => !['kty', 'crv', 'x', 'y', 'ext'].includes(k))
      ) {
        return null;
      }
      return JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: decoded.x,
        y: decoded.y,
        ext: decoded.ext !== false,
      });
    } catch {
      return null;
    }
  }

  private verifyProof(publicKey: string | null, challenge: unknown, proof: unknown): boolean {
    if (
      !publicKey ||
      typeof challenge !== 'string' ||
      typeof proof !== 'string' ||
      proof.length > 256
    )
      return false;
    try {
      const key = crypto.createPublicKey({ key: JSON.parse(publicKey), format: 'jwk' });
      return crypto.verify(
        'sha256',
        Buffer.from(challenge),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(proof, 'base64url'),
      );
    } catch {
      return false;
    }
  }

  // ── 结果脱敏 ────────────────────────────────────────────────────────────

  /**
   * 交给模型前按预算截断。链接与地址原样返回(2026-10-30 决定:与专用浏览器一致,Agent 能用页面里的
   * 魔法链接、签名地址;安全交给任务的权限档位与自动审核)。
   */
  private boundResult(result: Record<string, unknown>, maxChars = 6000): Record<string, unknown> {
    const out: Record<string, unknown> = { ...result };
    let remaining = maxChars;
    const boundRecord = (entry: unknown): unknown => {
      if (!entry || typeof entry !== 'object') return entry;
      let truncated = false;
      const bounded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        let finalValue: unknown = value;
        if (typeof value === 'string') {
          const limit = Math.min(remaining, FIELD_VALUE_MAX);
          if (value.length > limit) {
            // A URL cut mid-way would still be a URL to the model; drop it instead.
            finalValue = /^https?:\/\//i.test(value) ? null : value.slice(0, limit);
            truncated = true;
          }
          remaining -= (finalValue as string | null)?.length || 0;
        }
        // 字段名由调用方控制,包括 "__proto__":按自有属性写入,不污染原型。
        Object.defineProperty(bounded, key, {
          value: finalValue,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (truncated) out.truncated = true;
      return bounded;
    };
    if (Array.isArray(out.records)) out.records = out.records.map(boundRecord);
    if (out.record) out.record = boundRecord(out.record);
    // Backstop for every other read result: a result is accepted up to ~32 MB and 16 jobs can be in
    // flight, so an extension (or a corrupted one) must not make Main hold and forward all of it. Entry
    // counts and string sizes are capped; a cut is reported in `truncated`.
    for (const [key, max] of LIST_ENTRY_CAPS) {
      const list = out[key];
      if (!Array.isArray(list)) continue;
      const capped = list.length > max ? list.slice(0, max) : list;
      if (capped !== list) out.truncated = true;
      out[key] = capped.map((entry) => {
        // Tuples ([method, params] debugger events) keep their array shape; only the count is capped.
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const row: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
        for (const [field, value] of Object.entries(row)) {
          if (typeof value === 'string' && value.length > ENTRY_STRING_MAX) {
            row[field] = /^https?:\/\//i.test(value) ? null : value.slice(0, ENTRY_STRING_MAX);
            out.truncated = true;
          }
        }
        return row;
      });
    }
    for (const key of ['text', 'html', 'markdown'] as const) {
      const value = out[key];
      if (typeof value === 'string' && value.length > TEXT_RESULT_MAX) {
        out[key] = value.slice(0, TEXT_RESULT_MAX);
        out.truncated = true;
      }
    }
    return out;
  }

  // ── 作业生命周期 ────────────────────────────────────────────────────────

  private finish(job: Job, result: Record<string, unknown>): void {
    if (!this.jobs.has(job.id)) return;
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    const safe = this.boundResult(result, job.payload.maxChars || 6000);
    const timing = (safe.timing && typeof safe.timing === 'object' ? safe.timing : {}) as Record<
      string,
      unknown
    >;
    job.resolve({
      ...safe,
      ok: safe.ok === true,
      browser: job.clientId,
      timing: { ...timing, totalMs: this.now() - job.created },
      ...(isBrowserExtensionReadAction(job.action) && job.action !== 'tabs'
        ? { untrusted_content: true }
        : {}),
    });
  }

  private endJobsOf(clientId: string): void {
    for (const job of [...this.jobs.values()])
      if (job.clientId === clientId)
        this.finish(
          job,
          this.jobFailure(
            job,
            'BROWSER_RESTARTED',
            'The browser restarted before this finished. Check its tabs again before retrying.',
          ),
        );
  }

  private jobFailure(job: Job, error: string, message: string): BrowserExtensionFailure {
    return failure(
      error,
      message,
      job.state === 'acknowledged' && job.action !== 'tabs' ? 'unknown' : 'not_executed',
    );
  }

  private take(
    clientId: string,
  ): { id: string; action: string; payload: BrowserExtensionJobPayload } | null {
    for (const job of this.jobs.values()) {
      if (job.state !== 'queued' || job.clientId !== clientId) continue;
      const gate = this.gate(job.action, job.payload.url);
      if (!gate.ok) {
        this.finish(job, gate as unknown as Record<string, unknown>);
        continue;
      }
      job.state = 'delivered'; // 丢失的作业绝不重投。
      return { id: job.id, action: job.action, payload: job.payload };
    }
    return null;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private send(res: http.ServerResponse, value: unknown, status = 200): void {
    if (res.destroyed || res.writableEnded) return;
    const data = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(data),
    });
    res.end(data);
  }

  private async readBody(
    req: http.IncomingMessage,
    maxBytes = 512000,
  ): Promise<{ raw: string; value: Record<string, unknown> }> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const c of req) {
      const chunk = c as Buffer;
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Too large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const value = JSON.parse(raw || '{}') as unknown;
    return {
      raw,
      value:
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
    };
  }

  private header(req: http.IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return typeof value === 'string' ? value : undefined;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 自定义头在网页上会触发预检;永不开启 CORS,/health 也不例外。
    const hostHeader = req.headers.host;
    if (req.url === '/native/bind') {
      // 这份授权只存在于 native host 的私有连接文件里,不是浏览器头、公开清单值或 /health 结果。
      const expected = this.options.nativeToken;
      const supplied = this.header(req, 'authorization');
      if (
        req.method !== 'POST' ||
        hostHeader !== '127.0.0.1:' + this.port ||
        req.headers.origin ||
        typeof expected !== 'string' ||
        expected.length !== 64 ||
        typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== 71 ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from('Bearer ' + expected))
      ) {
        return this.send(res, failure('FORBIDDEN', 'Native binding required.'), 403);
      }
      const b = (await this.readBody(req)).value;
      const c = this.clients.get(String(b.clientId));
      if (
        !c ||
        !this.official(c) ||
        !c.authenticated ||
        c.origin !== b.origin ||
        this.normalizePublicKey(b.publicKey) !== c.publicKey
      ) {
        return this.send(
          res,
          failure('FORBIDDEN', 'Binding does not match the authenticated profile.'),
          403,
        );
      }
      this.nativeBindings.set(c.id, c.publicKey as string);
      return this.send(res, { ok: true });
    }
    const extensionId = this.header(req, 'x-my-browser-extension');
    const origin = this.header(req, 'x-my-browser-origin') || 'chrome-extension://' + extensionId;
    const id = this.header(req, 'x-my-browser-client');
    if (
      hostHeader !== '127.0.0.1:' + this.port ||
      req.method === 'OPTIONS' ||
      !/^[a-zA-Z0-9._-]{1,200}$/.test(extensionId || '') ||
      !/^[a-f0-9-]{36}$/.test(id || '') ||
      !(
        origin === 'chrome-extension://' + extensionId ||
        /^safari-web-extension:\/\/[a-zA-Z0-9.-]+$/.test(origin)
      ) ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      return this.send(res, failure('FORBIDDEN', 'Only an extension origin can connect.'), 403);
    }
    const clientId = id as string;
    let client = this.clients.get(clientId);
    if (client && (client.origin !== origin || client.extensionId !== extensionId)) {
      return this.send(
        res,
        failure('IDENTITY_CHANGED', 'Reconnect with the correct browser profile.'),
        403,
      );
    }
    if (req.method === 'GET' && req.url === '/health') {
      for (const [key, c] of this.clients) {
        if (
          this.now() - c.seen > 180000 &&
          ![...this.jobs.values()].some((j) => j.clientId === key)
        ) {
          this.clients.delete(key);
          this.nativeBindings.delete(key);
        }
      }
      if (!client && this.clients.size >= 16)
        return this.send(
          res,
          failure('TOO_MANY_BROWSERS', 'Close unused browser connections.'),
          429,
        );
      const keyHeader = this.header(req, 'x-my-browser-key');
      const publicKey =
        keyHeader === undefined ? client?.publicKey || null : this.normalizePublicKey(keyHeader);
      const proof = this.header(req, 'x-my-browser-proof') ?? null;
      const familyHeader = this.header(req, 'x-my-browser-family');
      const family = (['chrome', 'edge', 'safari'] as const).find((f) => f === familyHeader);
      const installedHeader = this.header(req, 'x-my-browser-installed-version') || '';
      const installedVersion = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(installedHeader)
        ? installedHeader
        : null;
      if (!client) {
        client = {
          id: clientId,
          origin,
          extensionId: extensionId as string,
          browser: family ?? 'chrome',
          version: '',
          installedVersion,
          seen: this.now(),
          publicKey: null,
          authenticated: false,
          challenge: null,
          session: null,
          trusted: false,
        };
      }
      client.browser = family ?? client.browser;
      client.version = String(this.header(req, 'x-my-browser-version') || '').slice(0, 30);
      const boot = this.header(req, 'x-my-browser-boot');
      if (typeof boot === 'string' && /^[0-9a-f-]{36}$/i.test(boot)) {
        // The browser restarted: tab ids start over, so jobs aimed at the old tabs must not reach
        // whatever tab now has the same number.
        if (client.boot && client.boot !== boot) this.endJobsOf(client.id);
        client.boot = boot;
      }
      client.installedVersion = installedVersion;
      client.seen = this.now();
      if (keyHeader !== undefined && publicKey !== client.publicKey) {
        client.publicKey = publicKey;
        client.authenticated = false;
        client.challenge = null;
        client.session = null;
      }
      if (
        publicKey &&
        client.challenge &&
        client.challenge.expires > this.now() &&
        client.challenge.publicKey === publicKey &&
        this.verifyProof(publicKey, client.challenge.value, proof)
      ) {
        client.authenticated = true;
      }
      client.challenge = publicKey
        ? {
            value: crypto.randomBytes(32).toString('base64url'),
            expires: this.now() + 10000,
            publicKey,
          }
        : null;
      client.trusted = this.approved(client);
      this.clients.set(clientId, client);
      const authRequired = client.version === BROWSER_EXTENSION_WIRE_VERSION;
      const sessionAllowed = this.sessionReady(client);
      const nativeRequired = this.official(client) && authRequired && !this.boundCredential(client);
      if (sessionAllowed && !client.session) client.session = crypto.randomUUID();
      return this.send(res, {
        ok: true,
        plugin: this.options.ghostId,
        protocol: BROWSER_EXTENSION_PROTOCOL_NUMBER,
        version: this.compatible(client.version) ? client.version : BROWSER_EXTENSION_WIRE_VERSION,
        installedVersion: this.options.installedVersion,
        extensionId,
        clientId,
        pairing_required: !sessionAllowed,
        native_binding_required: nativeRequired,
        auth_required: authRequired,
        capabilities: sessionAllowed && authRequired ? ['learning-v1', 'learning-auth-v2'] : [],
        ...(client.challenge ? { challenge: client.challenge.value } : {}),
        ...(sessionAllowed ? { session: client.session } : {}),
      });
    }
    if (
      !client ||
      !this.sessionReady(client) ||
      !client.session ||
      !this.live(client) ||
      !this.compatible(client.version) ||
      this.header(req, 'x-my-browser-session') !== client.session
    ) {
      return this.send(
        res,
        failure('SESSION_CHANGED', 'Reconnect the Cindy browser extension.'),
        409,
      );
    }
    client.seen = this.now();
    if (req.url === '/learning/challenge' && req.method === 'GET') {
      if (!this.authenticatedCredential(client))
        return this.send(
          res,
          failure(
            'PAIRING_REQUIRED',
            'Reconnect the Cindy browser extension before starting learning.',
          ),
          403,
        );
      for (const [key, item] of this.relayChallenges)
        if (this.now() > item.expiresAt) this.relayChallenges.delete(key);
      const value = crypto.randomBytes(32).toString('base64url');
      this.relayChallenges.set(value, { clientId, expiresAt: this.now() + 10000 });
      return this.send(res, { ok: true, challenge: value });
    }
    let relayBody: Record<string, unknown> = {};
    let relayRaw = '';
    if (req.method === 'POST' && req.url?.startsWith('/learning/')) {
      const parsed = await this.readBody(req);
      relayBody = parsed.value;
      relayRaw = parsed.raw;
    }
    if (req.url?.startsWith('/learning/')) {
      const challenge = this.header(req, 'x-my-browser-learning-challenge') ?? '';
      const proof = this.header(req, 'x-my-browser-proof') ?? '';
      const pending = this.relayChallenges.get(challenge);
      const bodyDigest = crypto.createHash('sha256').update(relayRaw).digest('base64url');
      const payload = challenge + '\\n' + req.method + '\\n' + req.url + '\\n' + bodyDigest;
      const valid =
        pending?.clientId === clientId &&
        pending.expiresAt > this.now() &&
        this.authenticatedCredential(client) &&
        this.normalizePublicKey(this.header(req, 'x-my-browser-key')) === client.publicKey &&
        this.verifyProof(client.publicKey, payload, proof);
      if (!valid) {
        this.options.log?.warn('browser extension relay signature rejected', {
          url: req.url,
          method: req.method,
          clientId: clientId.slice(0, 8),
          pending: !!pending,
          authenticated: this.authenticatedCredential(client),
        });
        return this.send(
          res,
          failure(
            'PAIRING_REQUIRED',
            'Reconnect the Cindy browser extension before starting learning.',
          ),
          403,
        );
      }
      this.relayChallenges.delete(challenge);
    }
    if (req.method === 'POST' && req.url === '/learning/start') {
      const b = relayBody;
      if (typeof b.id !== 'string' || !/^[a-f0-9-]{36}$/.test(b.id))
        return this.send(res, failure('INVALID_ID', 'Invalid request.'), 400);
      for (const [key, item] of this.relays)
        if (this.now() > item.expiresAt) this.relays.delete(key);
      const previous = this.relays.get(b.id);
      if (previous?.clientId === clientId && previous.retired)
        return this.send(
          res,
          failure('REQUEST_EXPIRED', 'The completed result is no longer retained.'),
          404,
        );
      if (previous) {
        return this.send(
          res,
          previous.clientId === clientId
            ? { ok: true, id: b.id }
            : failure('INVALID_ID', 'Request belongs to another profile.'),
          previous.clientId === clientId ? 200 : 403,
        );
      }
      const running = [...this.relays.values()].filter((x) => !x.result);
      if (
        this.relays.size >= 4096 ||
        running.length >= 64 ||
        running.filter((x) => x.clientId === clientId).length >= 4
      ) {
        return this.send(res, failure('BUSY', 'Wait for the current requests.'), 429);
      }
      let payload: RelayRequest;
      try {
        payload = validateRelayRequest(b.request);
      } catch {
        return this.send(res, failure('INVALID_INPUT', 'Check the selected text or file.'), 400);
      }
      if (payload.source.url) {
        const gate = this.gate('text', payload.source.url);
        if (!gate.ok) return this.send(res, gate, 403);
        payload.source.url = redactBrowserUrl(payload.source.url);
      }
      // 已完成的结果另计上限;淘汰时留一张小回执,重放旧 id 绝不重新提交模型。
      const completed = [...this.relays.values()].filter((x) => x.result && !x.retired);
      while (completed.length >= 64) {
        const old = completed.shift() as RelayItem;
        old.retired = true;
        old.payload = { op: old.payload.op, source: old.payload.source };
        old.result = { ok: false, error: 'REQUEST_EXPIRED' };
      }
      const created = this.now();
      const item: RelayItem = {
        id: b.id,
        clientId,
        payload,
        created,
        expiresAt: created + relayRequestTimeout(payload) + RELAY_TIMING.transport,
        result: null,
        progress: { stage: 'accepted', startedAt: created, updatedAt: created, attempt: 1 },
      };
      this.relays.set(b.id, item);
      this.options.log?.info('browser extension relay accepted', {
        id: b.id,
        op: payload.op,
        clientId: clientId.slice(0, 8),
      });
      try {
        this.options.onRelay?.({ id: b.id, clientId, request: payload });
      } catch (err) {
        this.options.log?.warn('browser extension relay handler threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return this.send(res, { ok: true, id: b.id });
    }
    if (
      req.method === 'POST' &&
      (req.url === '/learning/result' || req.url === '/learning/cancel')
    ) {
      const b = relayBody;
      const item = this.relays.get(String(b.id));
      if (!item || item.clientId !== clientId)
        return this.send(
          res,
          failure('REQUEST_EXPIRED', 'Request expired. Check the page before trying again.'),
          404,
        );
      if (req.url === '/learning/cancel') {
        this.options.log?.info('browser extension relay cancelled', { id: item.id });
        this.relays.delete(item.id);
        return this.send(res, { ok: true });
      }
      const gate = item.payload.source.url
        ? this.gate('text', item.payload.source.url)
        : { ok: true as const };
      if (!gate.ok) {
        this.relays.delete(item.id);
        return this.send(res, gate, 403);
      }
      return this.send(
        res,
        item.result
          ? { ok: true, done: true, result: item.result }
          : { ok: true, done: false, progress: item.progress },
      );
    }
    if (req.method === 'GET' && req.url === '/poll') {
      const job = this.take(clientId);
      if (job) return this.send(res, { job });
      if (this.waiting.has(clientId))
        return this.send(res, failure('BUSY', 'This profile is already polling.'), 429);
      const cleanup = () => {
        clearTimeout(timer);
        if (this.waiting.get(clientId) === waiter) this.waiting.delete(clientId);
      };
      const waiter = () => {
        cleanup();
        this.send(res, { job: this.take(clientId) });
      };
      const timer = setTimeout(waiter, this.options.pollTimeout ?? 20000);
      this.waiting.set(clientId, waiter);
      res.on('close', cleanup);
      return;
    }
    if (req.method !== 'POST' || !['/ack', '/authorize', '/result'].includes(req.url ?? '')) {
      return this.send(res, failure('NOT_FOUND', 'Unknown endpoint.'), 404);
    }
    // Screenshots come back as base64 images, well beyond the default request budget.
    const b = (await this.readBody(req, req.url === '/result' ? 32_000_000 : 512000)).value;
    const jobId = String(b.id);
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.clientId !== clientId ||
      job.state !== (req.url === '/ack' ? 'delivered' : 'acknowledged')
    ) {
      return this.send(res, failure('JOB_EXPIRED', 'Do not execute this job.'), 409);
    }
    if (req.url === '/ack' || req.url === '/authorize') {
      const gate = this.gate(
        job.action,
        req.url === '/authorize' ? b.url : job.payload.url,
      );
      if (!gate.ok) {
        const result = this.jobFailure(job, gate.error, gate.message);
        this.finish(job, result);
        return this.send(res, result, 403);
      }
      // /authorize only re-validates the address the extension is about to touch (older extensions
      // call it before every page action); there is no site list to revoke against.
      if (req.url === '/ack') job.state = 'acknowledged';
      return this.send(res, { ok: true, policy: this.policy });
    }
    let result = b.result as Record<string, unknown>;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      result = this.jobFailure(
        job,
        'INVALID_RESULT',
        'Invalid browser result. Verify before retrying.',
      );
    }
    if (job.action === 'tabs' && !result.error) {
      const tabs = (Array.isArray(result.tabs) ? result.tabs : []).slice(0, 100) as Array<
        Record<string, unknown>
      >;
      result = {
        ...result,
        ok: true,
        tabs: tabs.map((t) => {
          if (this.gate('text', t.url).ok) return t;
          const row: Record<string, unknown> = { id: t.id, redacted: true };
          if (['loading', 'complete', 'unloaded'].includes(t.status as string))
            row.status = t.status;
          if (['ADDRESS_UNVERIFIED', 'TAB_ACCESS_FAILED'].includes(t.error as string))
            row.error = t.error;
          if (
            t.error === 'ADDRESS_UNVERIFIED' &&
            [
              'LOCAL_ADDRESS',
              'NAVIGATION_UNOBSERVED',
              'RESPONSE_UNOBSERVED',
              'PEER_ADDRESS_MISSING',
              'PEER_NOT_PUBLIC',
              'DOCUMENT_CHANGED',
              'DOCUMENT_UNAVAILABLE',
            ].includes(t.reason as string)
          ) {
            row.reason = t.reason;
          }
          return row;
        }),
      };
    } else if (
      !result.error &&
      result.url &&
      !this.gate(job.action, result.url).ok
    ) {
      result = this.jobFailure(
        job,
        'REDIRECT_BLOCKED',
        'No content returned from a blocked destination.',
      );
    }
    if (
      result.error &&
      !['not_executed', 'executed', 'unknown'].includes(result.execution as string)
    ) {
      result = { ...result, execution: this.jobFailure(job, '', '').execution };
    }
    this.finish(job, result);
    return this.send(res, { ok: true });
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // A closed bridge stays closed: a caller still holding it must not reopen an ownerless
    // listener that the extension could connect to after the plugin was disabled or replaced.
    if (this.closed) throw new Error('BRIDGE_STOPPED');
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // 保持监听在兼容扩展扫描的十个端口内:绑到段外会让旧扩展在插件/扩展交错更新期间永久断连。
      for (const candidate of this.options.ports ?? BROWSER_EXTENSION_DEFAULT_PORTS) {
        const srv = http.createServer((req, res) => {
          this.route(req, res).catch(() =>
            this.send(res, failure('INVALID_REQUEST', 'Invalid bridge request.'), 400),
          );
        });
        srv.requestTimeout = 30000;
        srv.headersTimeout = 10000;
        try {
          await new Promise<void>((resolve, reject) => {
            srv.once('error', reject);
            srv.listen(candidate, '127.0.0.1', resolve);
          });
          // close() ran while this listen was pending: do not keep an ownerless listener.
          if (this.closed) {
            srv.closeAllConnections();
            await new Promise<void>((r) => srv.close(() => r()));
            throw new Error('BRIDGE_STOPPED');
          }
          this.server = srv;
          const address = srv.address();
          this.port = typeof address === 'object' && address ? address.port : candidate;
          this.options.log?.info('browser extension bridge listening', {
            port: this.port,
            ghostId: this.options.ghostId,
          });
          return;
        } catch (e) {
          srv.close();
          if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
        }
      }
      throw Object.assign(new Error('All browser extension loopback ports are occupied.'), {
        code: 'BRIDGE_PORTS_BUSY',
      });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private startFailure(e: unknown): BrowserExtensionFailure {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (this.closed) return failure('BRIDGE_STOPPED', 'This browser connection was closed. Check Cindy Chrome is enabled.');
    return failure(
      code === 'BRIDGE_PORTS_BUSY'
        ? 'BRIDGE_PORTS_BUSY'
        : code === 'EACCES' || code === 'EPERM'
          ? 'BRIDGE_LISTEN_DENIED'
          : 'BRIDGE_START_FAILED',
      e instanceof Error ? e.message : String(e),
    );
  }

  /**
   * Plugins of the site-list era still push their lists; they are acknowledged and ignored (site lists
   * were removed on 2026-10-30, safety is the task's permission mode and review).
   */
  setPolicy(_input?: unknown): { ok: true; policy: BrowserExtensionPolicy } {
    return { ok: true, policy: this.policy };
  }

  getPolicy(): BrowserExtensionPolicy {
    return this.policy;
  }

  setTrustedClients(clients: unknown): { ok: true } {
    if (!Array.isArray(clients) || clients.length > 16) throw new Error('Invalid paired browsers.');
    this.pins = clients.filter(
      (c): c is BrowserExtensionTrustedClient =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as BrowserExtensionTrustedClient).id === 'string' &&
        typeof (c as BrowserExtensionTrustedClient).origin === 'string' &&
        typeof (c as BrowserExtensionTrustedClient).extensionId === 'string' &&
        // A Chromium extension must be one the user was shown at install, whatever the plugin pushes.
        // (Safari extensions are paired explicitly by the user and carry their own identifiers.)
        (!(c as BrowserExtensionTrustedClient).origin.startsWith('chrome-extension://') ||
          this.knownIds.has((c as BrowserExtensionTrustedClient).extensionId)),
    );
    for (const c of this.clients.values()) c.trusted = this.approved(c);
    return { ok: true };
  }

  private relayItem(id: string): { item: RelayItem; valid: boolean } | null {
    const item = this.relays.get(id);
    if (!item) return null;
    const client = this.clients.get(item.clientId);
    const valid =
      !!client?.trusted &&
      this.now() <= item.expiresAt &&
      (!item.payload.source.url ||
        this.gate('text', item.payload.source.url).ok);
    return { item, valid };
  }

  relayActive(id: string): { ok: true; active: boolean } {
    const found = this.relayItem(id);
    return { ok: true, active: !!found && found.valid && !found.item.result };
  }

  relayProgress(id: string, progress: unknown): { ok: true } | BrowserExtensionFailure {
    const found = this.relayItem(id);
    if (!found || !found.valid) return failure('REQUEST_CANCELLED', 'Request no longer active.');
    const item = found.item;
    const p = (progress && typeof progress === 'object' ? progress : {}) as {
      stage?: unknown;
      attempt?: unknown;
      receivedChars?: unknown;
    };
    if (!item.result && (RELAY_PROGRESS_STAGES as readonly unknown[]).includes(p.stage)) {
      const previous = item.progress;
      const attempt = Number.isInteger(p.attempt)
        ? Math.min(3, Math.max(1, p.attempt as number))
        : previous.attempt || 1;
      const stage = p.stage as string;
      item.progress = {
        stage,
        attempt,
        ...(Number.isSafeInteger(p.receivedChars) && (p.receivedChars as number) >= 0
          ? { receivedChars: p.receivedChars as number }
          : {}),
        startedAt: previous.startedAt || item.created,
        updatedAt:
          previous.stage === stage && previous.attempt === attempt
            ? previous.updatedAt
            : this.now(),
      };
    }
    return { ok: true };
  }

  relayResult(id: string, result: unknown): { ok: true } | BrowserExtensionFailure {
    const found = this.relayItem(id);
    if (!found || !found.valid) return failure('REQUEST_CANCELLED', 'Request no longer active.');
    if (!found.item.result) {
      // The plugin's answer is held for minutes and serialized again for each poll; bound its size so a
      // faulty or hostile plugin cannot fill Main's memory. Over the bound it becomes a structured failure.
      let size = Number.POSITIVE_INFINITY;
      try {
        size = JSON.stringify(result)?.length ?? 0;
      } catch {
        // Not serializable: treated as too large.
      }
      if (size > RELAY_RESULT_MAX_CHARS)
        result = { ok: false, error: 'RESULT_TOO_LARGE', message: 'The plugin result is too large.' };
      found.item.result = result;
      found.item.expiresAt = this.now() + RELAY_TIMING.resultRetention;
      this.options.log?.info('browser extension relay answered', {
        id,
        ok: (result as { ok?: unknown } | null)?.ok === true,
      });
    }
    return { ok: true };
  }

  async status(): Promise<BrowserExtensionBridgeStatus | BrowserExtensionFailure> {
    try {
      await this.start();
    } catch (e) {
      return this.startFailure(e);
    }
    return {
      ok: true,
      version: this.options.installedVersion,
      protocol: BROWSER_EXTENSION_PROTOCOL_NUMBER,
      port: this.port,
      extension_connected: this.connected().length > 0,
      extension_ids: [...this.knownIds],
      policy: this.policy,
      pending: this.jobs.size,
      clients: [...this.clients.values()]
        .filter((c) => this.live(c))
        .map((c) => this.publicClient(c)),
    };
  }

  /** 当前已连接(会话就绪、存活、协议兼容)的扩展连接。 */
  connectedClients(): BrowserExtensionClientInfo[] {
    return this.connected().map((c) => this.publicClient(c));
  }

  /** 向扩展投递一个页面作业;按策略守门、绑定连接、一次送达、超时即 unknown。 */
  async act(action: unknown, payloadInput: unknown = {}): Promise<BrowserExtensionJobResult> {
    try {
      await this.start();
    } catch (e) {
      return this.startFailure(e);
    }
    let payload: BrowserExtensionJobPayload;
    try {
      payload = validateBrowserExtensionJob(action, payloadInput);
    } catch (e) {
      return failure('INVALID_ARGS', e instanceof Error ? e.message : 'Invalid browser action.');
    }
    const kind = action as BrowserExtensionAction;
    const gate = this.gate(kind, payload.url);
    if (!gate.ok) return { ...gate };
    const until = this.now() + (this.options.connectWait ?? 6000);
    while (!this.connected().length && this.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    const candidates = this.connected();
    const client = payload.browser
      ? candidates.find((c) => c.id === payload.browser)
      : candidates.length === 1
        ? candidates[0]
        : null;
    if (!client) {
      return {
        ...failure(
          candidates.length > 1 && !payload.browser ? 'BROWSER_REQUIRED' : 'EXTENSION_DISCONNECTED',
          candidates.length > 1
            ? 'Choose a browser connection id; never guess the account/profile.'
            : 'Open Cindy Chrome settings to install, enable or reconnect the extension.',
        ),
        clients: candidates.map((c) => this.publicClient(c)),
      };
    }
    if (this.jobs.size >= 16) return failure('BRIDGE_BUSY', 'Wait for browser tasks to finish.');
    return new Promise((resolve) => {
      const job: Job = {
        id: crypto.randomUUID(),
        action: kind,
        payload,
        clientId: client.id,
        state: 'queued',
        resolve,
        created: this.now(),
      };
      job.timer = setTimeout(
        () =>
          this.finish(
            job,
            this.jobFailure(
              job,
              'BROWSER_TIMEOUT',
              'Verify an unknown operation; it will not be replayed.',
            ),
          ),
        // A wait may legitimately run up to its own timeout; give it room beyond the default.
        Math.max(
          this.options.jobTimeout ?? 45000,
          kind === 'wait'
            ? (Number(payload.timeMs) || 0) + (typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 30000) + 15000
            : 0,
        ),
      );
      this.jobs.set(job.id, job);
      this.waiting.get(client.id)?.();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.relays.clear();
    for (const job of [...this.jobs.values()])
      this.finish(
        job,
        this.jobFailure(
          job,
          'BRIDGE_STOPPED',
          'Check the page before repeating an interrupted action.',
        ),
      );
    for (const waiter of [...this.waiting.values()]) waiter();
    if (this.server) {
      const s = this.server;
      this.server = null;
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
      this.port = 0;
    }
  }
}

/** 一个插件只能有一份桥接;动作是否为交互由线协议判定(用于 execution 归类)。 */
export const isBrowserExtensionInteraction = isBrowserExtensionInteractAction;
