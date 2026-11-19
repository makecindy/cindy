import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  emptyBuddySets,
  normalizeBuddySets,
  parseBuddySets,
  serializeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';

/**
 * 「伙伴集」是纯本机展示偏好:按账号存在这台手机上,不跨电脑同步、不进伙伴资料。
 * 只持久化用户 override(稀疏记录):空状态删 key,不把默认配置复制进用户配置
 * (docs/dev-rules/configuration-and-overrides.md §2)。
 */
const BUDDY_SETS_PREFIX = 'cindy.mobile.home.buddySets.v1.';

// 与 homeViewPreferenceStore 同口径:读 → 合并 → 写串行化,避免并发写互相覆盖。
let writeChain: Promise<void> = Promise.resolve();

export async function readBuddySets(owner: string): Promise<BuddySetsState> {
  if (!owner) return emptyBuddySets();
  // 读失败必须 reject,不能当成空记录回头覆盖仍然有效的 blob。
  const raw = await AsyncStorage.getItem(BUDDY_SETS_PREFIX + encodeURIComponent(owner));
  return parseBuddySets(raw);
}

export function saveBuddySets(owner: string, state: BuddySetsState): Promise<void> {
  if (!owner) return Promise.resolve();
  const next = normalizeBuddySets(state);
  const serialized = serializeBuddySets(next);
  const run = writeChain.then(async () => {
    const key = BUDDY_SETS_PREFIX + encodeURIComponent(owner);
    // 空状态 = 没有 override:删 key,而不是落一份默认配置。
    if (!serialized) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, serialized);
  });
  writeChain = run.catch(() => undefined);
  return run;
}

export const __testing = { prefix: BUDDY_SETS_PREFIX };
