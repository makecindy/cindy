/**
 * useSkillSync.ts — 进入 /skillhub/* 触发批量 sync (R1)
 *
 * - useSkillSync(skills): useEffect 每次 skills 变化都按 slug 打 sync,通过 useSkillhub store 写 syncResults
 * - triggerIncrementalSync(slugs): publish 成功后增量刷新
 */

import { useEffect, useRef } from 'react';
import { skillhubCatalogKey } from '../../../../shared/skillhubCatalog';

/**
 * Store setter injected by useSkillhub at startup.
 * Avoids circular import: useSkillhub.ts imports this file's `registerSetters`,
 * this file calls the setters without importing useSkillhub.ts.
 */
type SyncSetters = {
  setSyncResults: (results: SkillhubSyncResult[], availableUninstalledCount?: number) => void;
  mergeSyncResults: (results: SkillhubSyncResult[]) => void;
  setSyncError: (err: string | null) => void;
};

let storeSetters: SyncSetters | null = null;
let fullSyncRequestId = 0;
let incrementalSyncRequestId = 0;

/** Invalidate all in-flight requests when the active data owner changes. */
export function invalidateSkillSyncRequests(): void {
  fullSyncRequestId += 1;
  incrementalSyncRequestId += 1;
}

export function registerSyncStoreSetters(setters: SyncSetters): void {
  storeSetters = setters;
}

function uniqueSkillRefs(skills: SkillhubSkill[]): Array<{ slug: string; catalogScope?: 'market' | 'team' }> {
  const byKey = new Map<string, { slug: string; catalogScope?: 'market' | 'team' }>();
  for (const skill of skills) {
    if (skill.kind !== 'skill') continue;
    const catalogScope = skill.registryEntry?.catalogScope;
    byKey.set(skillhubCatalogKey(skill.name, catalogScope), {
      slug: skill.name,
      ...(catalogScope ? { catalogScope } : {}),
    });
  }
  return [...byKey.values()];
}

export function globalInstalledSkills(skills: SkillhubSkill[]): Array<{ slug: string; version: string }> {
  const bySlug = new Map<string, string>();
  for (const skill of skills) {
    if (skill.kind !== 'skill') continue;
    if (skill.scope !== 'global') continue;
    const frontmatterVersion = typeof skill.frontmatter?.version === 'string'
      ? skill.frontmatter.version.trim()
      : '';
    const version = skill.registryEntry?.version?.trim() || frontmatterVersion;
    bySlug.set(skill.name, version);
  }
  return [...bySlug.entries()].map(([slug, version]) => ({ slug, version }));
}

async function doSync(skills: SkillhubSkill[]): Promise<void> {
  const requestId = ++fullSyncRequestId;
  try {
    const res = await window.electronAPI.skillhub.sync({
      skills: uniqueSkillRefs(skills),
    });
    if (requestId !== fullSyncRequestId) return;
    if (res.success && res.results) {
      storeSetters?.setSyncResults(res.results, res.availableUninstalledCount);
    } else {
      storeSetters?.setSyncError(res.error ?? 'sync failed');
    }
  } catch (err) {
    if (requestId !== fullSyncRequestId) return;
    storeSetters?.setSyncError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Mount effect in SkillhubFeatureLayout.
 * 每次 skills 列表引用变化都重新拉一次,即便本地 0 个 skill 也要打 sync。
 * 这里只同步本地 skill 对应的 Hub 详情状态；可获取列表单独走 listMarket。
 */
export function useSkillSync(skills: SkillhubSkill[], enabled = true): void {
  const skillsRef = useRef<SkillhubSkill[]>(skills);
  skillsRef.current = skills;

  useEffect(() => {
    if (!enabled) return;
    void doSync(skillsRef.current);
  }, [enabled, skills]);
}

/**
 * Trigger an incremental sync for specific skills after publish success.
 */
export async function triggerIncrementalSync(
  slugs: string[],
): Promise<void> {
  const requestId = ++incrementalSyncRequestId;
  try {
    const res = await window.electronAPI.skillhub.sync({
      skills: [...new Set(slugs)].map((slug) => ({ slug })),
    });
    if (requestId !== incrementalSyncRequestId) return;
    if (res.success && res.results) {
      storeSetters?.mergeSyncResults(res.results);
    }
  } catch {
    // incremental sync failure is non-fatal
  }
}
