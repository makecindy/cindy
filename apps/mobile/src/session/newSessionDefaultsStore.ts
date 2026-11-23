import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from '@/auth/authOwnerGeneration';
import {
  createDefaultNewSessionDefaults,
  normalizeNewSessionDefaults,
  type NewSessionDefaults,
} from './newSessionDefaults';

/**
 * 新建任务默认（电脑 / 工作区）。按登录账号分开存，退登时由 AuthContext 清掉
 * 当前账号这一份；不跨手机同步。
 */
const STORAGE_KEY = 'xdt-maker.mobile.new-session.defaults.v1';

export function newSessionDefaultsStorageKey(accountKey: string): string {
  return `${STORAGE_KEY}.${encodeURIComponent(accountKey)}`;
}

// 与新建偏好一致：连续修改不同字段时，读改写按操作顺序执行。
let writeChain: Promise<void> = Promise.resolve();

export async function readNewSessionDefaults(): Promise<NewSessionDefaults> {
  const owner = getMobileAuthOwner();
  await writeChain;
  if (!owner.accountKey) return createDefaultNewSessionDefaults();
  const raw = await AsyncStorage.getItem(newSessionDefaultsStorageKey(owner.accountKey)).catch(() => null);
  if (!isMobileAuthOwnerCurrent(owner)) return createDefaultNewSessionDefaults();
  return parseNewSessionDefaults(raw);
}

export function parseNewSessionDefaults(raw: string | null | undefined): NewSessionDefaults {
  if (!raw) return createDefaultNewSessionDefaults();
  try {
    return normalizeNewSessionDefaults(JSON.parse(raw));
  } catch {
    return createDefaultNewSessionDefaults();
  }
}

export function saveNewSessionDefaults(next: NewSessionDefaults): Promise<void> {
  const owner = getMobileAuthOwner();
  const normalized = normalizeNewSessionDefaults(next);
  const run = writeChain.then(async () => {
    if (!owner.accountKey || !isMobileAuthOwnerCurrent(owner)) return;
    await AsyncStorage.setItem(
      newSessionDefaultsStorageKey(owner.accountKey),
      JSON.stringify(normalized),
    ).catch(() => undefined);
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/** 登出 / 终止会话时清掉这次会话所属账号的默认；账号切换保留各自的一份。 */
export async function clearNewSessionDefaultsForAccount(accountKey: string): Promise<void> {
  const key = accountKey.trim();
  if (!key) return;
  // 先等在途写入落完，避免「先删后写」把刚清掉的默认又写回来。
  await writeChain;
  await AsyncStorage.removeItem(newSessionDefaultsStorageKey(key)).catch(() => undefined);
}

export const __testing = { storageKey: STORAGE_KEY };
