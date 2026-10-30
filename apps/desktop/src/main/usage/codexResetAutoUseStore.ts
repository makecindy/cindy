import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodexResetAutoUseSettings, CodexResetAutoUseState } from '@cindy/maker-shared/device-link-contract';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { DEFAULT_CODEX_RESET_AUTO_USE, parseCodexResetAutoUse } from './codexResetAutoUse.js';

type AccountEntry = { accountKey: string; overrides: Partial<CodexResetAutoUseSettings>; lastUsedAt: number | null };
type SettingsFile = Record<string, AccountEntry>;
const log = desktopMakerLogger.child('codex-reset-auto-use');

export function codexResetAccountKey(email: string | null, accountId: string | null): string {
  return email && accountId ? createHash('sha256').update(JSON.stringify([email, accountId])).digest('hex') : '';
}
function normalize(raw: unknown): SettingsFile {
  const result: SettingsFile = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [provider, entry] of Object.entries(raw).slice(0, 128)) {
    if (!entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.accountKey ?? '')) continue;
    try {
      parseCodexResetAutoUse({ ...DEFAULT_CODEX_RESET_AUTO_USE, ...entry.overrides });
      const overrides: Partial<CodexResetAutoUseSettings> = {};
      for (const key of Object.keys(DEFAULT_CODEX_RESET_AUTO_USE) as (keyof CodexResetAutoUseSettings)[]) {
        if (Object.hasOwn(entry.overrides ?? {}, key)) Object.assign(overrides, { [key]: entry.overrides[key] });
      }
      result[provider] = { accountKey: entry.accountKey, overrides,
        lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : null };
    } catch { /* Invalid settings never authorize a redemption. */ }
  }
  return result;
}

/** Owner-scoped local overrides; no credentials or full account identifiers are persisted. */
export function createCodexResetAutoUseStore(filePath: () => string, scopeKey = activeOwnerScopeKey) {
  const file = createOverrideSettingsFile<SettingsFile>({
    filePath, defaults: {}, normalize, log, label: 'codex-reset-auto-use', scopeKey,
    maxBytes: 128 * 1024, preserveUnreadableFile: true, logLoadedValue: false, logReadErrorDetails: false,
  });
  const entries = () => { file.invalidateIfChanged(); return file.read(); };
  const read = (provider: string, accountKey: string): CodexResetAutoUseState => {
    const record = entries()[provider];
    const entry = record?.accountKey === accountKey ? record : undefined;
    return { accountKey, settings: { ...DEFAULT_CODEX_RESET_AUTO_USE, ...entry?.overrides },
      customized: Boolean(entry && Object.keys(entry.overrides).length), lastUsedAt: entry?.lastUsedAt ?? null };
  };
  return {
    read,
    providers: () => Object.entries(entries()).filter(([, e]) => e.overrides.enabled === true).map(([id]) => id),
    async write(provider: string, accountKey: string, settings: Partial<CodexResetAutoUseSettings> | null) {
      if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new Error('ChatGPT account unavailable');
      if (settings !== null) parseCodexResetAutoUse({ ...read(provider, accountKey).settings, ...settings });
      await file.updateAtomic(current => {
        const previous = current.value[provider];
        const overrides = settings === null ? {} : { ...(previous?.accountKey === accountKey ? previous.overrides : {}), ...settings };
        parseCodexResetAutoUse({ ...DEFAULT_CODEX_RESET_AUTO_USE, ...overrides });
        return { [provider]: { accountKey, overrides,
          lastUsedAt: previous?.accountKey === accountKey ? previous.lastUsedAt : null } };
      });
      return read(provider, accountKey);
    },
    async record(provider: string, accountKey: string, at: number) {
      await file.updateAtomic(current => {
        const entry = current.value[provider];
        return entry?.accountKey === accountKey ? { [provider]: { ...entry, lastUsedAt: at } } : {};
      });
    },
  };
}

export const codexResetAutoUseStore = createCodexResetAutoUseStore(() =>
  path.join(ownerScopedUserDataPath(), 'codex-reset-auto-use.json'));
