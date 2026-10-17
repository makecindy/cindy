/**
 * 供应商组设置：按账号存在本机(`provider-group-prefs.json`)，不同步到其他电脑。
 * 组只是「这台电脑上这个供应商」的一项设置，没有账号级的组(docs/product-rules/provider-groups.md §3)。
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureProviderManagementScope, withProviderGroupMutation } from './managementScope.js';
import {
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  type ProviderGroupConfig,
} from '../../shared/providerGroup.js';

interface ProviderGroupFile {
  groups: Record<string, ProviderGroupConfig>;
  /** 组修改已提交但绑定可能尚未解除；重新加入也不能撤销这次清理。 */
  bindingCleanups?: Record<string, ProviderGroupBindingCleanup>;
  /** 分享来的电脑离开全部组后，等空名单确认再删除；代次防止迟到确认吞掉再次移出的清理。 */
  reshareCleanups?: Record<string, string>;
}

export interface ProviderGroupBindingCleanup {
  token: string;
  /** 多次移出取交集，null 表示整组删除；不能被后续重新加入覆盖。 */
  keepMemberKeys: string[] | null;
  at: number;
}

/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_GROUPS = 1024;

function normalize(raw: unknown): ProviderGroupFile {
  const source = raw as Partial<ProviderGroupFile> | null;
  const groups = source?.groups;
  const out: Record<string, ProviderGroupConfig> = {};
  for (const [providerId, value] of Object.entries(groups && typeof groups === 'object' && !Array.isArray(groups) ? groups : {})) {
    if (Object.keys(out).length >= MAX_GROUPS) break;
    if (!isProviderGroupProviderId(providerId)) continue;
    const config = normalizeProviderGroupConfig(value, providerId);
    if (config) out[providerId] = config;
  }
  const reshareCleanups: Record<string, string> = {};
  if (source?.reshareCleanups && typeof source.reshareCleanups === 'object' && !Array.isArray(source.reshareCleanups)) {
    for (const [device, token] of Object.entries(source.reshareCleanups)) {
      if (/^share:[A-Za-z0-9_.:-]{1,128}$/.test(device) && typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token)) {
        reshareCleanups[device] = token;
      }
    }
  }
  const bindingCleanups: Record<string, ProviderGroupBindingCleanup> = {};
  if (source?.bindingCleanups && typeof source.bindingCleanups === 'object' && !Array.isArray(source.bindingCleanups)) {
    for (const [providerId, cleanup] of Object.entries(source.bindingCleanups)) {
      if (!isProviderGroupProviderId(providerId) || !cleanup || typeof cleanup !== 'object') continue;
      const { token, keepMemberKeys, at } = cleanup;
      if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) continue;
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
      if (keepMemberKeys !== null && (!Array.isArray(keepMemberKeys)
        || !keepMemberKeys.every((key) => typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,300}$/.test(key)))) continue;
      bindingCleanups[providerId] = { token, keepMemberKeys, at };
    }
  }
  return {
    groups: out,
    ...(Object.keys(reshareCleanups).length > 0 ? { reshareCleanups } : {}),
    ...(Object.keys(bindingCleanups).length > 0 ? { bindingCleanups } : {}),
  };
}

/** 同一分享可能同时加入几个组；最后一个引用移出时才清空这台电脑的转分享名单。 */
function sharedDevices(groups: Record<string, ProviderGroupConfig>): Set<string> {
  return new Set(Object.values(groups).flatMap((config) => config.members
    .filter((member) => member.kind === 'share' && member.agentDeviceId)
    .map((member) => member.agentDeviceId!)));
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
  preserveUnreadableFile: true,
  logLoadedValue: false,
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
  expectedConfig?: ProviderGroupConfig | null,
): Promise<ProviderGroupConfig | null> {
  const assertCurrent = captureProviderManagementScope();
  if (!isProviderGroupProviderId(providerId)) throw new Error('Invalid provider id');
  const normalized = config === null ? null : normalizeProviderGroupConfig(config, providerId);
  const expected = expectedConfig === undefined ? undefined : normalizeProviderGroupConfig(expectedConfig, providerId);
  const next = await withProviderGroupMutation(() => store.updateAtomic(({ value }) => {
    assertCurrent();
    // 必须在已有跨进程写锁内重读并比较，不能在等待目录或写锁前检查后再无条件覆盖。
    if (expected !== undefined && !isDeepStrictEqual(value.groups[providerId] ?? null, expected)) {
      throwIpcError('PROVIDER_GROUP_CHANGED', 'The provider group changed while it was being edited');
    }
    const groups = { ...value.groups };
    if (normalized) groups[providerId] = normalized;
    else delete groups[providerId];
    const remaining = sharedDevices(groups);
    const reshareCleanups = { ...value.reshareCleanups };
    for (const device of sharedDevices(value.groups)) {
      if (!remaining.has(device)) reshareCleanups[device] = randomUUID();
    }
    const bindingCleanups = { ...value.bindingCleanups };
    const keep = normalized?.members.map((member) => member.key) ?? null;
    if (keep === null || value.groups[providerId]?.members.some((member) => !keep.includes(member.key))) {
      const previousKeep = bindingCleanups[providerId]?.keepMemberKeys;
      bindingCleanups[providerId] = {
        token: randomUUID(),
        keepMemberKeys: previousKeep === null || keep === null
          ? null
          : previousKeep === undefined ? keep : keep.filter((key) => previousKeep.includes(key)),
        at: Date.now(),
      };
    }
    // 与移出组同一把锁、同一次原子替换：崩溃、离线、重新加入都不能丢掉清空旧同意的意图。
    return { groups, reshareCleanups, bindingCleanups };
  }));
  assertCurrent();
  return next.groups[providerId] ?? null;
}

export function listProviderGroupBindingCleanups(): Readonly<Record<string, ProviderGroupBindingCleanup>> {
  store.invalidateIfChanged();
  return store.read().bindingCleanups ?? {};
}

/** 绑定与解除记录已经原子提交，只确认本次清理；迟到回执不清掉下一次移出的意图。 */
export async function completeProviderGroupBindingCleanup(providerId: string, token: string): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  await store.updateAtomic(({ value }) => {
    assertCurrent();
    if (value.bindingCleanups?.[providerId]?.token !== token) return {};
    const bindingCleanups = { ...value.bindingCleanups };
    delete bindingCleanups[providerId];
    return { bindingCleanups };
  });
  assertCurrent();
}

/** 在同一把写锁内基于最新组配置做最小更新；更新器返回 undefined 表示放弃写入。 */
export async function updateProviderGroup(
  providerId: string,
  updater: (current: ProviderGroupConfig | null) => ProviderGroupConfig | null | undefined,
): Promise<ProviderGroupConfig | null> {
  if (!isProviderGroupProviderId(providerId)) throw new Error('Invalid provider id');
  const next = await store.updateAtomic(({ value }) => {
    const current = value.groups[providerId] ?? null;
    const updated = updater(current);
    if (updated === undefined) return {};
    const normalized = updated === null ? null : normalizeProviderGroupConfig(updated, providerId);
    if (updated !== null && !normalized) throw new Error('Invalid provider group config');
    const groups = { ...value.groups };
    if (normalized) groups[providerId] = normalized;
    else delete groups[providerId];
    const remaining = sharedDevices(groups);
    const reshareCleanups = { ...value.reshareCleanups };
    for (const device of sharedDevices(value.groups)) {
      if (!remaining.has(device)) reshareCleanups[device] = randomUUID();
    }
    return { groups, reshareCleanups };
  });
  return next.groups[providerId] ?? null;
}

export function listProviderGroupReshareCleanups(): Readonly<Record<string, string>> {
  store.invalidateIfChanged();
  return store.read().reshareCleanups ?? {};
}

/** 空名单已被对端确认，只确认这次清理，保留报告期间新生成的代次。 */
export async function completeProviderGroupReshareCleanup(agentDeviceId: string, token: string): Promise<void> {
  await store.updateAtomic(({ value }) => {
    if (value.reshareCleanups?.[agentDeviceId] !== token) return {};
    const reshareCleanups = { ...value.reshareCleanups };
    delete reshareCleanups[agentDeviceId];
    return { reshareCleanups };
  });
}

export const __testing = { normalize };
