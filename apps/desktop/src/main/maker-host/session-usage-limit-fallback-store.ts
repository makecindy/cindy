import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';
import type { SessionUsageLimitFallback } from '../maker-ipc/sessionUsageLimitFallback.js';

interface Settings {
  policies: Record<string, SessionUsageLimitFallback>;
}

/**
 * 任务级的额度备用路线，按 session id 保存到当前 Cindy 数据所有者。
 * 只存用户显式配置的任务；没有条目 = 沿用既有「等额度重置后自动继续」行为。
 */
const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath('session-usage-limit-fallbacks.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { policies: {} },
  normalize: (raw) => {
    const policies: Settings['policies'] = {};
    const entries = (raw as Partial<Settings> | null)?.policies;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const [sessionId, policy] of Object.entries(entries)) {
        if (!policy || typeof policy !== 'object') continue;
        const { source, target } = policy as Partial<SessionUsageLimitFallback>;
        if (
          !source ||
          !target ||
          (source.agentKind !== 'codex' && source.agentKind !== 'claude-code' && source.agentKind !== 'pi') ||
          typeof source.model !== 'string' ||
          typeof target.providerId !== 'string' ||
          !target.providerId ||
          typeof target.model !== 'string' ||
          !target.model
        ) {
          continue;
        }
        policies[sessionId] = {
          source: {
            agentKind: source.agentKind,
            model: source.model,
            providerId: typeof source.providerId === 'string' ? source.providerId : null,
            effort: source.effort ?? null,
            fastMode: source.fastMode ?? false,
            agentDeviceId: source.agentDeviceId ?? null,
          },
          target: { providerId: target.providerId, model: target.model },
        };
      }
    }
    return { policies };
  },
  maxBytes: 2 * 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  log: desktopMakerLogger.child('session-usage-limit-fallback-store'),
  label: 'session usage limit fallback',
});

export function readSessionUsageLimitFallback(sessionId: string): SessionUsageLimitFallback | null {
  store.invalidateIfChanged();
  return store.read().policies[sessionId] ?? null;
}

export async function writeSessionUsageLimitFallback(
  sessionId: string,
  policy: SessionUsageLimitFallback | null,
): Promise<void> {
  await store.updateAtomic(({ value }) => {
    const policies = { ...value.policies };
    if (policy) policies[sessionId] = policy;
    else delete policies[sessionId];
    return { policies };
  });
}
