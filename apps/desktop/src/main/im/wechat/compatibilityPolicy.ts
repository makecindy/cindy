import {
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger, maskPath } from '../../logger';

const log = createLogger('im/wechat/compatibility-policy');

export const WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES = 32 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_RULES = 64;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface WechatCompatibilityRule {
  minVersion: string;
  maxVersion: string;
  action: 'disable';
  reason: string;
  helpUrl?: string;
}

export interface WechatCompatibilityManifestPayload {
  schemaVersion: 1;
  sequence: number;
  generatedAt: number;
  expiresAt: number;
  rules: WechatCompatibilityRule[];
}

export interface WechatCompatibilityManifest extends WechatCompatibilityManifestPayload {
  signature: string;
}

export interface WechatCompatibilityDecision {
  disabled: boolean;
  sequence?: number;
  reasonCode?: string;
  helpUrl?: string;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchLike = (
  input: string,
  init: {
    method: 'GET';
    cache: 'no-store';
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<ResponseLike>;

export interface WechatCompatibilityPolicyOptions {
  manifestUrl: string | null;
  publicKeySpkiBase64: string | null;
  trustedHelpUrlPrefixes: readonly string[];
  cachePath(): string;
  appVersion(): string;
  fetch: FetchLike;
  now?: () => number;
  refreshIntervalMs?: number;
  fetchTimeoutMs?: number;
}

/**
 * Production values intentionally live in source instead of environment or
 * remote endpoint configuration. A release may populate these only after the
 * independent signing key and immutable HTTPS location have been provisioned.
 */
export const WECHAT_COMPATIBILITY_POLICY_PRODUCTION_CONFIG = Object.freeze({
  manifestUrl: null,
  publicKeySpkiBase64: null,
  trustedHelpUrlPrefixes: [] as readonly string[],
});

export class WechatCompatibilityPolicyService {
  readonly #options: Required<
    Pick<WechatCompatibilityPolicyOptions, 'now' | 'refreshIntervalMs' | 'fetchTimeoutMs'>
  > &
    Omit<WechatCompatibilityPolicyOptions, 'now' | 'refreshIntervalMs' | 'fetchTimeoutMs'>;
  readonly #listeners = new Set<(decision: WechatCompatibilityDecision) => void>();
  #decision: WechatCompatibilityDecision = { disabled: false };
  #lastSequence = 0;
  #cacheLoaded = false;
  #started = false;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #decisionExpiresAt: number | null = null;
  #refreshInFlight: Promise<void> | null = null;

  constructor(options: WechatCompatibilityPolicyOptions) {
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      refreshIntervalMs: options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#loadCacheOnce();
    this.#scheduleDecisionExpiry();
    void this.refresh();
    if (
      this.#options.manifestUrl &&
      this.#options.publicKeySpkiBase64 &&
      this.#options.refreshIntervalMs > 0
    ) {
      this.#refreshTimer = setInterval(() => void this.refresh(), this.#options.refreshIntervalMs);
      this.#refreshTimer.unref?.();
    }
  }

  stop(): void {
    this.#started = false;
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  getDecision(): WechatCompatibilityDecision {
    return { ...this.#decision };
  }

  isDisabled(): boolean {
    return this.#decision.disabled;
  }

  subscribe(listener: (decision: WechatCompatibilityDecision) => void): () => void {
    this.#listeners.add(listener);
    listener(this.getDecision());
    return () => this.#listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    if (this.#refreshInFlight) return this.#refreshInFlight;
    this.#refreshInFlight = this.#refreshInternal().finally(() => {
      this.#refreshInFlight = null;
    });
    return this.#refreshInFlight;
  }

  #loadCacheOnce(): void {
    if (this.#cacheLoaded) return;
    this.#cacheLoaded = true;
    const publicKey = this.#publicKey();
    if (!publicKey) return;
    const cachePath = this.#options.cachePath();
    try {
      const bytes = fs.readFileSync(cachePath);
      if (bytes.byteLength > WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES) {
        throw new Error('MANIFEST_TOO_LARGE');
      }
      this.#acceptVerifiedBytes(bytes, publicKey, false);
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') {
        log.warn('ignored invalid cached personal WeChat compatibility policy', {
          path: maskPath(cachePath),
          errorCode: safePolicyErrorCode(error),
        });
      }
    }
  }

  async #refreshInternal(): Promise<void> {
    this.#loadCacheOnce();
    const publicKey = this.#publicKey();
    const manifestUrl = normalizeBuiltInManifestUrl(this.#options.manifestUrl);
    if (!publicKey || !manifestUrl) return;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.#options.fetchTimeoutMs);
    try {
      const response = await this.#options.fetch(manifestUrl, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: abort.signal,
      });
      if (!response.ok) throw new Error('HTTP_STATUS_REJECTED');
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'application/json') throw new Error('CONTENT_TYPE_REJECTED');
      const contentLength = parseContentLength(response.headers.get('content-length'));
      if (contentLength !== null && contentLength > WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES) {
        throw new Error('MANIFEST_TOO_LARGE');
      }
      const bytes = await readBoundedResponseBody(
        response,
        WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES,
      );
      this.#acceptVerifiedBytes(bytes, publicKey, true);
    } catch (error) {
      log.warn('personal WeChat compatibility policy refresh failed open', {
        errorCode: safePolicyErrorCode(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #acceptVerifiedBytes(bytes: Uint8Array, publicKey: KeyObject, persist: boolean): void {
    const manifest = parseAndVerifyWechatCompatibilityManifest(
      bytes,
      publicKey,
      this.#options.trustedHelpUrlPrefixes,
      this.#options.now(),
    );
    if (manifest.sequence < this.#lastSequence) throw new Error('SEQUENCE_ROLLBACK');
    this.#lastSequence = manifest.sequence;
    const decision = evaluateWechatCompatibilityManifest(
      manifest,
      this.#options.appVersion(),
      this.#options.now(),
    );
    this.#setDecision(decision);
    this.#decisionExpiresAt = decision.disabled ? manifest.expiresAt : null;
    this.#scheduleDecisionExpiry();
    if (persist) {
      try {
        writeCacheAtomic(this.#options.cachePath(), bytes);
      } catch (error) {
        log.warn('failed to persist personal WeChat compatibility policy cache', {
          errorCode: safePolicyErrorCode(error),
        });
      }
    }
  }

  #publicKey(): KeyObject | null {
    const encoded = this.#options.publicKeySpkiBase64;
    if (!encoded) return null;
    try {
      const key = createPublicKey({
        key: decodeStrictBase64(encoded, 'PUBLIC_KEY_INVALID'),
        format: 'der',
        type: 'spki',
      });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('PUBLIC_KEY_INVALID');
      return key;
    } catch {
      log.error('personal WeChat compatibility policy public key is invalid');
      return null;
    }
  }

  #setDecision(next: WechatCompatibilityDecision): void {
    if (
      next.disabled === this.#decision.disabled &&
      next.sequence === this.#decision.sequence &&
      next.reasonCode === this.#decision.reasonCode &&
      next.helpUrl === this.#decision.helpUrl
    ) {
      return;
    }
    this.#decision = next;
    for (const listener of this.#listeners) listener(this.getDecision());
  }

  #scheduleDecisionExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
    const expiresAt = this.#decisionExpiresAt;
    if (!this.#decision.disabled || expiresAt === null) return;
    const remaining = expiresAt - this.#options.now();
    if (remaining <= 0) {
      this.#decisionExpiresAt = null;
      this.#setDecision({ disabled: false, sequence: this.#decision.sequence });
      return;
    }
    this.#expiryTimer = setTimeout(
      () => {
        this.#expiryTimer = null;
        this.#scheduleDecisionExpiry();
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
    this.#expiryTimer.unref?.();
  }
}

export function parseAndVerifyWechatCompatibilityManifest(
  bytes: Uint8Array,
  publicKey: KeyObject,
  trustedHelpUrlPrefixes: readonly string[],
  now: number,
): WechatCompatibilityManifest {
  if (bytes.byteLength > WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES) {
    throw new Error('MANIFEST_TOO_LARGE');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('PUBLIC_KEY_INVALID');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('MANIFEST_JSON_INVALID');
  }
  const manifest = validateManifest(raw, trustedHelpUrlPrefixes);
  if (manifest.generatedAt > now + MAX_CLOCK_SKEW_MS) throw new Error('GENERATED_AT_IN_FUTURE');
  const signature = decodeStrictBase64(manifest.signature, 'SIGNATURE_INVALID');
  const payload: WechatCompatibilityManifestPayload = {
    schemaVersion: manifest.schemaVersion,
    sequence: manifest.sequence,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    rules: manifest.rules,
  };
  const verified = verifySignature(
    null,
    Buffer.from(canonicalizeWechatCompatibilityManifestPayload(payload), 'utf8'),
    publicKey,
    signature,
  );
  if (!verified) throw new Error('SIGNATURE_INVALID');
  return manifest;
}

export function canonicalizeWechatCompatibilityManifestPayload(
  payload: WechatCompatibilityManifestPayload,
): string {
  return canonicalJson(payload);
}

export function evaluateWechatCompatibilityManifest(
  manifest: WechatCompatibilityManifest,
  appVersion: string,
  now: number,
): WechatCompatibilityDecision {
  if (now >= manifest.expiresAt) return { disabled: false, sequence: manifest.sequence };
  const version = parseSemver(appVersion);
  if (!version) return { disabled: false, sequence: manifest.sequence };
  const matched = manifest.rules.find(
    (rule) =>
      compareSemver(version, parseSemverRequired(rule.minVersion)) >= 0 &&
      compareSemver(version, parseSemverRequired(rule.maxVersion)) <= 0,
  );
  if (!matched) return { disabled: false, sequence: manifest.sequence };
  return {
    disabled: true,
    sequence: manifest.sequence,
    reasonCode: matched.reason,
    ...(matched.helpUrl ? { helpUrl: matched.helpUrl } : {}),
  };
}

function validateManifest(
  raw: unknown,
  trustedHelpUrlPrefixes: readonly string[],
): WechatCompatibilityManifest {
  const input = requireRecord(raw, 'MANIFEST_SHAPE_INVALID');
  requireExactKeys(input, [
    'schemaVersion',
    'sequence',
    'generatedAt',
    'expiresAt',
    'rules',
    'signature',
  ]);
  if (input.schemaVersion !== 1) throw new Error('SCHEMA_VERSION_UNSUPPORTED');
  const sequence = requireSafeInteger(input.sequence, 1, 'SEQUENCE_INVALID');
  const generatedAt = requireSafeInteger(input.generatedAt, 0, 'GENERATED_AT_INVALID');
  const expiresAt = requireSafeInteger(input.expiresAt, 1, 'EXPIRES_AT_INVALID');
  if (expiresAt <= generatedAt) throw new Error('EXPIRY_RANGE_INVALID');
  if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES) {
    throw new Error('RULES_INVALID');
  }
  const rules = input.rules.map((rule) => validateRule(rule, trustedHelpUrlPrefixes));
  if (typeof input.signature !== 'string') throw new Error('SIGNATURE_INVALID');
  return {
    schemaVersion: 1,
    sequence,
    generatedAt,
    expiresAt,
    rules,
    signature: input.signature,
  };
}

function validateRule(
  raw: unknown,
  trustedHelpUrlPrefixes: readonly string[],
): WechatCompatibilityRule {
  const input = requireRecord(raw, 'RULE_INVALID');
  requireExactKeys(input, ['minVersion', 'maxVersion', 'action', 'reason', 'helpUrl'], true);
  if (typeof input.minVersion !== 'string' || typeof input.maxVersion !== 'string') {
    throw new Error('VERSION_RANGE_INVALID');
  }
  const minVersion = parseSemver(input.minVersion);
  const maxVersion = parseSemver(input.maxVersion);
  if (!minVersion || !maxVersion || compareSemver(minVersion, maxVersion) > 0) {
    throw new Error('VERSION_RANGE_INVALID');
  }
  if (input.action !== 'disable') throw new Error('ACTION_INVALID');
  if (
    typeof input.reason !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(input.reason)
  ) {
    throw new Error('REASON_INVALID');
  }
  let helpUrl: string | undefined;
  if (input.helpUrl !== undefined) {
    if (
      typeof input.helpUrl !== 'string' ||
      !isTrustedHelpUrl(input.helpUrl, trustedHelpUrlPrefixes)
    ) {
      throw new Error('HELP_URL_INVALID');
    }
    helpUrl = input.helpUrl;
  }
  return {
    minVersion: input.minVersion,
    maxVersion: input.maxVersion,
    action: 'disable',
    reason: input.reason,
    ...(helpUrl ? { helpUrl } : {}),
  };
}

function normalizeBuiltInManifestUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !url.pathname.endsWith('.json')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isTrustedHelpUrl(value: string, prefixes: readonly string[]): boolean {
  try {
    const candidate = new URL(value);
    if (
      candidate.protocol !== 'https:' ||
      candidate.username ||
      candidate.password ||
      candidate.hash ||
      candidate.search
    ) {
      return false;
    }
    if (/%(?:2f|5c)/i.test(candidate.pathname)) return false;
    return prefixes.some((prefix) => {
      const trusted = new URL(prefix);
      if (
        trusted.protocol !== 'https:' ||
        trusted.username ||
        trusted.password ||
        trusted.hash ||
        trusted.search ||
        /%(?:2f|5c)/i.test(trusted.pathname)
      ) {
        return false;
      }
      const trustedPath = trusted.pathname.endsWith('/')
        ? trusted.pathname
        : `${trusted.pathname}/`;
      return (
        candidate.origin === trusted.origin &&
        (candidate.pathname === trusted.pathname || candidate.pathname.startsWith(trustedPath))
      );
    });
  } catch {
    return false;
  }
}

async function readBoundedResponseBody(
  response: ResponseLike,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('MANIFEST_TOO_LARGE');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('MANIFEST_TOO_LARGE');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function writeCacheAtomic(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('CANONICAL_NUMBER_INVALID');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input)
      .filter((key) => input[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(',')}}`;
  }
  throw new Error('CANONICAL_VALUE_INVALID');
}

interface ParsedSemver {
  core: readonly [number, number, number];
  prerelease: readonly (number | string)[];
}

function parseSemver(value: string): ParsedSemver | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => {
        if (/^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part)) {
          return Number.NaN;
        }
        if (/^(0|[1-9]\d*)$/.test(part)) {
          const numeric = Number(part);
          return Number.isSafeInteger(numeric) ? numeric : part;
        }
        return part;
      })
    : [];
  if (prerelease.some((part) => typeof part === 'number' && !Number.isSafeInteger(part))) {
    return null;
  }
  return { core, prerelease };
}

function parseSemverRequired(value: string): ParsedSemver {
  const parsed = parseSemver(value);
  if (!parsed) throw new Error('VERSION_RANGE_INVALID');
  return parsed;
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'string') return -1;
    if (typeof a === 'string' && typeof b === 'number') return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  optionalHelpUrl = false,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) throw new Error('UNKNOWN_FIELD');
  for (const key of allowed) {
    if (optionalHelpUrl && key === 'helpUrl') continue;
    if (!(key in input)) throw new Error('MISSING_FIELD');
  }
}

function requireSafeInteger(value: unknown, minimum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(code);
  return value as number;
}

function decodeStrictBase64(value: string, code: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(code);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(code);
  return decoded;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('CONTENT_LENGTH_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('CONTENT_LENGTH_INVALID');
  return parsed;
}

function nodeErrorCode(error: unknown): string | null {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  return code && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null;
}

function safePolicyErrorCode(error: unknown): string {
  const code = nodeErrorCode(error);
  if (code) return code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) {
    return error.message;
  }
  return 'POLICY_REFRESH_FAILED';
}

export const __testing = {
  compareSemver,
  isTrustedHelpUrl,
  normalizeBuiltInManifestUrl,
  parseSemver,
  readBoundedResponseBody,
};
