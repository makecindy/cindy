import { migrateLocalConnectProvider } from '../../shared/localConnectHarness.js';
import {
  listCustomProviders,
  updateCustomProvider,
} from '../maker-host/custom-provider-store.js';

/** Catalog 加载时把旧本机预设补上现在的 harness。 */
export async function migrateLocalConnectPresetsOnCatalogLoad(
  stillCurrent: () => boolean = () => true,
): Promise<number> {
  if (!stillCurrent()) return 0;
  const existing = await listCustomProviders();
  let updated = 0;
  for (const provider of existing) {
    if (!stillCurrent()) return updated;
    const next = migrateLocalConnectProvider(provider);
    if (!next || JSON.stringify(next.runtimes) === JSON.stringify(provider.runtimes)) {
      continue;
    }
    if (!stillCurrent()) return updated;
    if (await updateCustomProvider(provider.id, next)) updated += 1;
  }
  return updated;
}
