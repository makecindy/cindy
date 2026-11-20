import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { resolveSystemLocale } from '../../../../shared/locale';

const scheduled = new Set<string>();

/** Main window only; the caller also gates this on AuthContext.canEnterApp. */
export function schedulePluginCatalogPrewarm(input: {
  mode: 'signed-out' | 'local' | 'cloud'; ownerId: string | null; generation: number; locale: string;
}) {
  const owner = getDataOwnerGeneration();
  if (owner.dataOwnerId !== input.ownerId || owner.generation !== input.generation) return;
  const key = JSON.stringify([owner, input.locale]);
  if (scheduled.has(key)) return;
  let cancelled = false;
  const run = () => {
    if (cancelled || !isDataOwnerGenerationCurrent(owner) || scheduled.has(key)) return;
    scheduled.add(key);
    void import('./pluginCatalogMemory').then(async module => {
      if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
      const ownerKey = module.pluginCatalogOwnerKey(input.mode, input.ownerId, input.generation, input.locale);
      const memory = module.pluginCatalogMemory(ownerKey, 'local');
      const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
      await window.electronAPI.setApplicationMenuLocale(resolveSystemLocale(input.locale));
      if (!current()) return;
      memory.localeReady = true;
      const snapshot = module.readLocalPluginSnapshot(memory).then(value => { if (current()) memory.snapshot = value; });
      const recommendations = module.readPluginRecommendations(memory).then(items => {
        if (current()) { memory.todayPool = items; memory.todayLoaded = true; }
      });
      await Promise.allSettled([snapshot, recommendations]);
    }).catch(() => undefined);
  };
  const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 2_000 }) : null;
  const timer = idle === null ? setTimeout(run, 300) : null;
  return () => { cancelled = true; if (idle !== null) cancelIdleCallback(idle); if (timer !== null) clearTimeout(timer); };
}
