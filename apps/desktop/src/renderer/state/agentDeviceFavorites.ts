import { useMemo } from 'react';
import {
  agentDeviceFavoriteSource,
  parseAgentDeviceFavoriteSource,
  type AgentDeviceFavoriteSource,
} from '@cindy/device-link';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';
import {
  addModelFavorite,
  getModelFavorite,
  removeModelFavorite,
  updateModelFavorite,
  type ModelFavoriteItem,
} from './modelFavorites';
import type { FavoriteStore } from './useRemoteModelFavorites';

/**
 * 远程 Agent 的收藏(model-selector-unified §1.5「远程收藏按被控电脑共享」):收藏仍存在任务所在电脑
 * (home)那一份列表里,「在同账号另一台电脑上运行」的那台编进 providerId(编码见
 * `@cindy/device-link` 的 agentDeviceFavoriteSource)。这里只做投影:浏览那台电脑的目录时把它的
 * 条目还原成那台的真实 providerId,写入时再编码回去存进 home 列表。
 *
 * 编码后的 providerId 只用于存储与匹配,绝不作为模型请求的 providerId。分享来的供应商
 * (`share:` 开头)有自己的存储键(providerShareFavorites),不经过这里。
 */

/** 本机那一份收藏的读写口(与 useUnifiedRowActions 缺省的本机 store 同一组函数)。 */
export const LOCAL_MODEL_FAVORITE_STORE: FavoriteStore = {
  get: getModelFavorite,
  add: (config) => {
    addModelFavorite(config);
  },
  update: updateModelFavorite,
  remove: removeModelFavorite,
};

/**
 * 这条收藏是不是「在另一台电脑上运行」的。编码里的电脑就是任务所在电脑时按普通收藏处理
 * (返回 null);分享的设备 id 不认(那是分享收藏的存储键,不该出现在这种编码里)。
 */
export function agentDeviceOfFavorite(
  providerId: string,
  homeDeviceId: string | null,
): AgentDeviceFavoriteSource | null {
  const source = parseAgentDeviceFavoriteSource(providerId);
  if (!source || source.deviceId === homeDeviceId || isProviderShareAgentDeviceId(source.deviceId))
    return null;
  return source;
}

/** 编码里的电脑就是任务所在电脑:还原成真实 providerId,当普通收藏用。 */
function homeProjection(item: ModelFavoriteItem, homeDeviceId: string | null): ModelFavoriteItem {
  if (!homeDeviceId) return item;
  const source = parseAgentDeviceFavoriteSource(item.providerId);
  return source && source.deviceId === homeDeviceId
    ? { ...item, providerId: source.providerId }
    : item;
}

/**
 * 按「正在浏览哪台电脑的目录」投影 home 收藏。
 *
 * - `deviceId` 为空(浏览任务所在电脑):列表**保持 home 的原顺序与全部条目**,只把编码成 home 自己的
 *   条目还原;其他电脑的条目原样留着(目录里匹配不到,由面板按那台的目录另行解析)。写入走 home。
 * - `deviceId` 为另一台电脑:只列编码成那台的条目并还原 providerId;新增时编码后写进 home,编辑 / 删除
 *   先核对锚点确实属于那台再交给 home(防止拿别处的 uid 改到不相干的条目)。
 */
export function useAgentDeviceFavorites(args: {
  deviceId: string | undefined;
  homeDeviceId: string | null;
  home: { items: readonly ModelFavoriteItem[]; store: FavoriteStore };
}): { items: readonly ModelFavoriteItem[]; store: FavoriteStore } {
  const { deviceId, homeDeviceId, home } = args;
  const target =
    deviceId && deviceId !== homeDeviceId && !isProviderShareAgentDeviceId(deviceId)
      ? deviceId
      : null;
  const items = useMemo(() => {
    if (!target)
      return homeDeviceId
        ? home.items.map((item) => homeProjection(item, homeDeviceId))
        : home.items;
    return home.items.flatMap((item) => {
      const source = parseAgentDeviceFavoriteSource(item.providerId);
      return source && source.deviceId === target
        ? [{ ...item, providerId: source.providerId }]
        : [];
    });
  }, [home.items, target, homeDeviceId]);
  const store = useMemo<FavoriteStore>(() => {
    if (!target) {
      return {
        get: (uid) => {
          const item = home.store.get(uid);
          return item ? homeProjection(item, homeDeviceId) : undefined;
        },
        add: (config) => home.store.add(config),
        update: (uid, patch) => home.store.update(uid, patch),
        remove: (uid) => home.store.remove(uid),
      };
    }
    const owned = (uid: string): ModelFavoriteItem | undefined => {
      const item = home.store.get(uid);
      const source = item ? parseAgentDeviceFavoriteSource(item.providerId) : null;
      return item && source?.deviceId === target
        ? { ...item, providerId: source.providerId }
        : undefined;
    };
    const expectOwned = (uid: string) => {
      if (!owned(uid)) throw new Error('Agent device favorite unavailable');
    };
    return {
      get: owned,
      add: (config) =>
        home.store.add({
          ...config,
          providerId: agentDeviceFavoriteSource({
            deviceId: target,
            providerId: config.providerId,
          }),
        }),
      update: (uid, patch) => {
        expectOwned(uid);
        return home.store.update(uid, patch);
      },
      remove: (uid) => {
        expectOwned(uid);
        return home.store.remove(uid);
      },
    };
  }, [home.store, target, homeDeviceId]);
  return { items, store };
}
