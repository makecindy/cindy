/**
 * releaseNotesService.ts
 * ---------------------------------------------------------------------------
 * Fetches per-version release notes from the CDN, plus a version-index so the
 * renderer can show every unread notice at once after a cross-version upgrade.
 *
 * URL shapes:
 *   per-version:   {CDN_BASE}/notice/{platformKey}/{version}.json
 *   version index: {CDN_BASE}/notice/{platformKey}/index.json
 *     e.g. https://cdn.example.com/app/notice/darwin-arm64/index.json
 *          → ["0.0.31", "0.0.78", ..., "0.0.124"]  (sorted ascending)
 *
 * The platform key is the SAME `${process.platform}-${process.arch}` value
 * used by manifestService — release notes and hot-update manifests share the
 * platform-axis convention so they can live next to each other on the CDN.
 *
 * The renderer should never hit the CDN directly — base URL stays in main and
 * CORS is bypassed by routing through net.request.
 *
 * Returns null on any failure (404, network, parse) so the caller can decide
 * whether to surface an error toast.
 *
 * Successful fetches are cached in-memory (platform is constant for the life
 * of the process) to avoid hammering CDN when the user re-opens the dialog
 * from the sidebar.
 */

import { StringDecoder } from 'node:string_decoder';

import { net } from 'electron';

import {
  hasRenderableContent,
  type RawReleaseNotes,
} from '../shared/releaseNotesContent';

import { getBaseUrl, getPlatformKey } from './manifestService';

import { createLogger } from './logger';

const log = createLogger('releaseNotesService');

// ── Types ──────────────────────────────────────────────────────────────────

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

// ── State ──────────────────────────────────────────────────────────────────

const cache = new Map<string, RawReleaseNotes>();
const inFlight = new Map<string, Promise<RawReleaseNotes | null>>();

// Sorted ascending list of every version that has a notice JSON on the CDN
// for this platform. Cached on success only — a failed fetch falls through so
// a subsequent call can retry.
let indexCache: string[] | null = null;

// ── Core ───────────────────────────────────────────────────────────────────

/**
 * Result of a single CDN fetch attempt.
 * - `ok` + `data`: HTTP 200 + valid JSON.
 * - `null`: non-retryable failure (HTTP non-200, JSON parse error).
 * - `retryable` error: network error / timeout — caller can retry.
 */
type FetchAttempt<T> =
  | { ok: true; data: T }
  | { ok: false; retryable: boolean };

/**
 * Single attempt at fetching a JSON document from the CDN.
 * Resolves with structured result so the retry wrapper can decide whether to
 * back off and retry or give up immediately.
 */
function fetchCdnJsonOnce<T>(url: string): Promise<FetchAttempt<T>> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      const decoder = new StringDecoder('utf8');
      let body = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          request.abort();
          log.info('Timeout: %s', url);
          resolve({ ok: false, retryable: true });
        }
      }, REQUEST_TIMEOUT_MS);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log.info('HTTP %d for %s', response.statusCode, url);
          clearTimeout(timeout);
          settled = true;
          resolve({ ok: false, retryable: false });
          return;
        }

        response.on('data', (chunk) => {
          body += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          try {
            body += decoder.end();
            resolve({ ok: true, data: JSON.parse(body) as T });
          } catch (err) {
            log.error('JSON parse failed for %s:', url, err);
            resolve({ ok: false, retryable: false });
          }
        });
        response.on('error', (err) => {
          log.error('Response error for %s:', url, err);
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            resolve({ ok: false, retryable: true });
          }
        });
      });

      request.on('error', (err) => {
        log.error('Request error for %s:', url, err);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve({ ok: false, retryable: true });
        }
      });

      request.end();
    } catch (err) {
      log.error('Unexpected error for %s:', url, err);
      resolve({ ok: false, retryable: true });
    }
  });
}

/**
 * Fetch a JSON document from the CDN with retries for transient failures.
 *
 * Retryable (network error / timeout): up to MAX_RETRIES attempts with
 * exponential backoff (1s → 2s → 4s). Non-retryable (HTTP non-200, JSON parse
 * error): returns null immediately — no point re-fetching a definitive answer.
 *
 * Returns the parsed value on 200, null on any failure. Silent — caller decides
 * UX.
 */
async function fetchCdnJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      log.info('Retry %d/%d for %s in %dms', attempt, MAX_RETRIES, url, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const result = await fetchCdnJsonOnce<T>(url);
    if (result.ok) return result.data;
    if (!result.retryable) return null;
  }

  log.info('All retries exhausted for %s', url);
  return null;
}

/**
 * Fetch release notes JSON for a given version from CDN.
 * Platform is resolved internally via `getPlatformKey()` (same axis as the
 * hot-update manifest), so callers never need to pass it.
 * Returns null on 404 / network error / parse error (silent — caller decides UX).
 */
export async function fetchReleaseNotes(version: string): Promise<RawReleaseNotes | null> {
  const hit = cache.get(version);
  if (hit) return hit;

  const pending = inFlight.get(version);
  if (pending) return pending;

  const request = (async () => {
    const platform = getPlatformKey();
    // Cache-bust to dodge stale CDN edges
    const url = `${getBaseUrl()}/notice/${platform}/${version}.json?t=${Date.now()}`;
    const json = await fetchCdnJson<RawReleaseNotes>(url);
    if (!json) return null;
    // A 200 payload with nothing renderable (e.g. a v2 document whose topics
    // are all malformed) is treated as a failed fetch and NOT cached — the
    // process-lifetime cache would otherwise keep serving the bad document
    // even after the CDN is corrected, and the renderer would reject it anyway.
    if (!hasRenderableContent(json)) {
      log.warn('Payload has no renderable content, treating as failure: version=%s', version);
      return null;
    }
    cache.set(version, json);
    log.info('Fetched OK: version=%s, sections=%d', json.version, json.sections?.length ?? 0);
    return json;
  })();
  inFlight.set(version, request);

  try {
    return await request;
  } finally {
    if (inFlight.get(version) === request) inFlight.delete(version);
  }
}

/**
 * Fetch the sorted list of every version that has a notice JSON on the CDN
 * for this platform. Used by the renderer to compute the range of unread
 * versions when a user upgrades across several releases and needs to see all
 * intermediate release notes at once.
 *
 * Payload: `["0.0.31", "0.0.78", ..., "0.0.124"]` — sorted ascending, no
 * duplicates. Anything unexpected (non-array / non-string entries) is
 * defensively filtered to keep bad CDN edges from crashing renderer code.
 *
 * Returns null on 404 / network / parse error. Successful results are cached
 * for the process lifetime.
 */
export async function fetchReleaseNotesIndex(): Promise<string[] | null> {
  if (indexCache) return indexCache;

  const platform = getPlatformKey();
  const url = `${getBaseUrl()}/notice/${platform}/index.json?t=${Date.now()}`;
  const json = await fetchCdnJson<unknown>(url);
  if (!Array.isArray(json)) {
    if (json !== null) log.warn('index.json is not an array; ignoring');
    return null;
  }
  const versions = json.filter((v): v is string => typeof v === 'string');
  indexCache = versions;
  log.info('Fetched index OK: %d versions', versions.length);
  return versions;
}
