/**
 * feishu/storage.ts
 * ---------------------------------------------------------------------------
 * Encrypted persistence for the bot's app credentials + TOFU owner. Each key
 * is one entry in `host.secrets` (electron.safeStorage / OS keychain / etc).
 *
 * Three keys:
 *   - feishu_bot_app_id          plain ID (encrypted for consistency)
 *   - feishu_bot_app_secret      app secret (MUST be encrypted)
 *   - feishu_bot_owner_open_id   owner open_id, set TOFU on first p2p message
 *                                (per-bot-app — the open_id this bot's app
 *                                sees, not the user's xdt account openId)
 *
 * Read/write are SYNCHRONOUS through the host adapter; we don't round-trip
 * through IPC because the bot needs them on every incoming message.
 */

import { getHost, getLog, getScope } from './moduleScope.js';
import type { BotCredentials, FeishuService } from './internal-types.js';

const KEY_APP_ID = 'feishu_bot_app_id';
const KEY_APP_SECRET = 'feishu_bot_app_secret';
const KEY_SERVICE = 'feishu_bot_service';
const KEY_OWNER_OPEN_ID = 'feishu_bot_owner_open_id';
const KEY_LIFECYCLE_ANNOUNCEMENT = 'feishu_bot_lifecycle_announcement';

/** 本实例的键名: 伙伴自有连接按连接 id 前缀隔离, 设置页那份前缀为空(历史键名不变)。 */
function K(base: string): string {
  return `${getScope().secretKeyPrefix}${base}`;
}

function maskTail(s: string | null | undefined, tail = 4): string {
  if (!s) return '<null>';
  if (s.length <= tail) return `***(len=${s.length})`;
  return `***${s.slice(-tail)}(len=${s.length})`;
}

export function readCredentials(): BotCredentials | null {
  const secrets = getHost().secrets;
  const appId = secrets.read(K(KEY_APP_ID));
  const appSecret = secrets.read(K(KEY_APP_SECRET));
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    service: normalizeService(secrets.read(K(KEY_SERVICE))),
  };
}

export function writeCredentials(creds: BotCredentials): boolean {
  const log = getLog();
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) {
    log.warn('[feishu/storage] secrets unavailable; refuse to write');
    return false;
  }
  const previous = {
    appId: secrets.read(K(KEY_APP_ID)),
    appSecret: secrets.read(K(KEY_APP_SECRET)),
    service: secrets.read(K(KEY_SERVICE)),
  };
  if (
    !secrets.write(K(KEY_SERVICE), creds.service) ||
    !secrets.write(K(KEY_APP_ID), creds.appId) ||
    !secrets.write(K(KEY_APP_SECRET), creds.appSecret)
  ) {
    restoreSecret(K(KEY_SERVICE), previous.service);
    restoreSecret(K(KEY_APP_ID), previous.appId);
    restoreSecret(K(KEY_APP_SECRET), previous.appSecret);
    return false;
  }
  log.info(
    `[feishu/storage] wrote credentials service=${creds.service} appId=${maskTail(creds.appId)} appSecret=${maskTail(creds.appSecret)}`,
  );
  return true;
}

export function clearAll(): void {
  const secrets = getHost().secrets;
  secrets.remove(K(KEY_APP_ID));
  secrets.remove(K(KEY_APP_SECRET));
  secrets.remove(K(KEY_SERVICE));
  secrets.remove(K(KEY_OWNER_OPEN_ID));
}

export function readAppId(): string | null {
  return getHost().secrets.read(K(KEY_APP_ID));
}

// ── owner (TOFU) ────────────────────────────────────────────────────────────

export function readOwnerOpenId(): string | null {
  return getHost().secrets.read(K(KEY_OWNER_OPEN_ID));
}

export function writeOwnerOpenId(openId: string): boolean {
  const log = getLog();
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) {
    log.warn('[feishu/storage] secrets unavailable; refuse to write owner');
    return false;
  }
  const ok = secrets.write(K(KEY_OWNER_OPEN_ID), openId);
  if (ok) log.info(`[feishu/storage] wrote owner ...${openId.slice(-8)}`);
  return ok;
}

export function clearOwnerOpenId(): void {
  getHost().secrets.remove(K(KEY_OWNER_OPEN_ID));
}

// ── lifecycle announcement preference ────────────────────────────────────

export function readLifecycleAnnouncement(): boolean {
  const raw = getHost().secrets.read(K(KEY_LIFECYCLE_ANNOUNCEMENT));
  return raw !== 'false';
}

export function writeLifecycleAnnouncement(enabled: boolean): void {
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) return;
  secrets.write(K(KEY_LIFECYCLE_ANNOUNCEMENT), String(enabled));
}

function normalizeService(value: string | null): FeishuService {
  return value === 'lark' ? 'lark' : 'feishu';
}

function restoreSecret(key: string, value: string | null): void {
  const secrets = getHost().secrets;
  if (value === null) {
    secrets.remove(key);
    return;
  }
  secrets.write(key, value);
}
