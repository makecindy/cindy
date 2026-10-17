/**
 * partner-bridge/sessionStore.ts
 * ---------------------------------------------------------------------------
 * 外部调用 key → 伙伴会话 id 的持久映射。
 *
 * File: <userData>/owners/<owner>/partner-bridge-state.json
 * 形态:{ sessions: { "<key>": "<sessionId>" } }
 *
 * 为什么复用 createOverrideSettingsFile:它带 owner 作用域、原子写与 mtime 守卫
 * (手改文件即生效),与 ghost-errand-prefs.json 同一套落盘契约。映射丢失的后果
 * 只是下次重建一间会话,不值得动 sessions schema。
 */

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('partner-bridge-store');

interface PartnerBridgeState {
  sessions: Record<string, string>;
}

const MAX_KEY_CHARS = 200;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULTS: PartnerBridgeState = { sessions: {} };

function normalize(raw: unknown): PartnerBridgeState {
  const sessions: Record<string, string> = {};
  const rawSessions =
    raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined;
  if (rawSessions && typeof rawSessions === 'object') {
    for (const [key, value] of Object.entries(rawSessions as Record<string, unknown>)) {
      if (key.length === 0 || key.length > MAX_KEY_CHARS) continue;
      if (typeof value === 'string' && SESSION_ID_PATTERN.test(value)) sessions[key] = value;
    }
  }
  return { sessions };
}

const store = createOverrideSettingsFile<PartnerBridgeState>({
  filePath: () => ownerScopedUserDataPath('partner-bridge-state.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'partner-bridge-state',
});

export function readPartnerSessionId(key: string): string | null {
  store.invalidateIfChanged();
  return store.read().sessions[key] ?? null;
}

/** 写/清某 key 的会话映射(null 即清除;会话失效重建时更新)。 */
export function writePartnerSessionId(key: string, sessionId: string | null): void {
  store.invalidateIfChanged();
  const sessions = { ...store.read().sessions };
  if (sessionId === null) delete sessions[key];
  else sessions[key] = sessionId;
  store.writePatch({ sessions });
  log.info('partner session mapping written', { key, sessionId });
}

export const __testing = { normalize };
