/**
 * infoDedupe.ts — in-flight dedupe + SWR 缓存 for skillhub info requests
 *
 * 三层数据结构:
 *   - inFlight: Map<source:name, Promise>  并发去重,promise resolve 后立即删
 *   - lastResults: Map<source:name, result> SWR 缓存,用于切 skill 时立刻渲染
 *   - lastDeleted: Map<source:name, boolean> 标记 server 是否显式返回 404(已删除)
 *
 * SWR 模式:render 阶段从 lastResults 拿到上次结果立刻渲染,后台异步 getInfo
 * 仍然照跑,新结果回来后再 setState 修正。
 * 网络错误时不覆盖 lastResults/lastDeleted,保留 stale 数据(真正的 SWR 语义)。
 */

import type { SkillhubCatalogScope } from '../../../../shared/skillhubCatalog';

const inFlight = new Map<string, Promise<SkillhubInfoResult | null>>();
const lastResults = new Map<string, SkillhubInfoResult | null>();
const lastDeleted = new Map<string, boolean>();

function cacheKey(name: string, catalogScope?: SkillhubCatalogScope): string {
  return `${catalogScope ?? 'default'}:${name}`;
}

function fetchInfo(name: string, catalogScope?: SkillhubCatalogScope): Promise<SkillhubInfoResult | null> {
  const key = cacheKey(name, catalogScope);
  const p = window.electronAPI.skillhub
    .info(name, catalogScope)
    .then((res) => {
      if (res.success && res.info && 'isMine' in res.info) {
        const info = res.info as SkillhubInfoResult;
        lastResults.set(key, info);
        lastDeleted.set(key, false);
        return info;
      }
      if (res.success && res.deleted) {
        lastResults.set(key, null);
        lastDeleted.set(key, true);
        return null;
      }
      // error (!res.success): preserve stale cache (SWR)
      return lastResults.get(key) ?? null;
    })
    .catch(() => {
      // network error: preserve stale cache
      return lastResults.get(key) ?? null;
    })
    .finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}

export function getInfo(name: string, catalogScope?: SkillhubCatalogScope): Promise<SkillhubInfoResult | null> {
  const existing = inFlight.get(cacheKey(name, catalogScope));
  if (existing) return existing;

  return fetchInfo(name, catalogScope);
}

/** Force one network refresh while keeping stale cache as the failure fallback. */
export function refreshInfo(name: string, catalogScope?: SkillhubCatalogScope): Promise<SkillhubInfoResult | null> {
  return fetchInfo(name, catalogScope);
}

/** 同步读上次拿到的 info(用于 render 阶段 seed state,实现切 skill 不闪)。 */
export function getCachedInfo(name: string, catalogScope?: SkillhubCatalogScope): SkillhubInfoResult | null {
  return lastResults.get(cacheKey(name, catalogScope)) ?? null;
}

/** Server 是否显式返回 404(skill 已从市场删除)。 */
export function isMarketDeleted(name: string, catalogScope?: SkillhubCatalogScope): boolean {
  return lastDeleted.get(cacheKey(name, catalogScope)) ?? false;
}

/** Force re-fetch on next call (e.g. after publish success). */
export function invalidate(name: string, catalogScope?: SkillhubCatalogScope): void {
  const key = cacheKey(name, catalogScope);
  inFlight.delete(key);
  lastResults.delete(key);
  lastDeleted.delete(key);
}
