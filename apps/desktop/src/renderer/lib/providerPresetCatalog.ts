import { installServerCatalog } from '@cindy/model-providers';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

type Result = Awaited<ReturnType<typeof window.electronAPI.maker.listProviderPresets>>;
let pending: { owner: DataOwnerGeneration; promise: Promise<Result> } | undefined;
/** Renderer adapter lookups and callers accept only the current owner's publication. */
export function loadProviderPresetCatalog(): Promise<Result> {
  if (pending && isDataOwnerGenerationCurrent(pending.owner)) return pending.promise;
  const owner = getDataOwnerGeneration();
  const promise = window.electronAPI.maker.listProviderPresets().then(result => {
    if (!isDataOwnerGenerationCurrent(owner)) throw new Error('Provider catalog data owner changed');
    if (result.catalog) installServerCatalog(result.catalog);
    return result;
  }).finally(() => {
    if (pending?.promise === promise) pending = undefined;
  });
  pending = { owner, promise };
  return promise;
}
