/**
 * 供应商组设置：按账号存在本机(`provider-group-prefs.json`)，不同步到其他电脑。
 * 组只是「这台电脑上这个供应商」的一项设置，没有账号级的组(docs/product-rules/provider-groups.md §3)。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import {
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  type ProviderGroupConfig,
} from '../../shared/providerGroup.js';

interface ProviderGroupFile {
  groups: Record<string, ProviderGroupConfig>;
}

/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_GROUPS = 1024;

function normalize(raw: unknown): ProviderGroupFile {
  const groups = (raw as Partial<ProviderGroupFile> | null)?.groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return { groups: {} };
  const out: Record<string, ProviderGroupConfig> = {};
  for (const [providerId, value] of Object.entries(groups)) {
    if (Object.keys(out).length >= MAX_GROUPS) break;
    if (!isProviderGroupProviderId(providerId)) continue;
    const config = normalizeProviderGroupConfig(value, providerId);
    if (config) out[providerId] = config;
  }
  return { groups: out };
}

const log = desktopMakerLogger.child('provider-group');
const store = createOverrideSettingsFile<ProviderGroupFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-prefs.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { groups: {} },
  normalize,
  log,
  label: 'provider-group',
  maxBytes: 1024 * 1024,
});

export function readProviderGroup(providerId: string): ProviderGroupConfig | null {
  if (!isProviderGroupProviderId(providerId)) return null;
  store.invalidateIfChanged();
  return store.read().groups[providerId] ?? null;
}

export function listProviderGroups(): Record<string, ProviderGroupConfig> {
  store.invalidateIfChanged();
  return store.read().groups;
}

/** 写入一个供应商的组；config 校正后没有组内电脑即删除这个组。返回落盘后的值。 */
export async function writeProviderGroup(
  providerId: string,
  config: unknown,
): Promise<ProviderGroupConfig | null> {
  if (!isProviderGroupProviderId(providerId)) throw new Error('Invalid provider id');
  const normalized = config === null ? null : normalizeProviderGroupConfig(config, providerId);
  const next = await store.updateAtomic(({ value }) => {
    const groups = { ...value.groups };
    if (normalized) groups[providerId] = normalized;
    else delete groups[providerId];
    return { groups };
  });
  return next.groups[providerId] ?? null;
}

export const __testing = { normalize };
