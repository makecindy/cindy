import { MAGPIE_PRESET_ID, type ProviderView } from '@cindy/model-providers';

/**
 * A Magpie connection is an ordinary custom provider whose runtime carries the
 * preset marker. Every projected model keeps it, so the settings detail can
 * recognize the connection even when discovery produced only manual entries.
 */
export function isMagpieProvider(provider: Pick<ProviderView, 'id' | 'models'>): boolean {
  // The id fallback covers a connection whose first discovery produced no
  // models; the model marker covers renamed connections and imported copies.
  if (provider.id === MAGPIE_PRESET_ID || provider.id.startsWith(`${MAGPIE_PRESET_ID}-`)) {
    return true;
  }
  return Object.values(provider.models).some((models) =>
    models?.some((model) => model.catalogPresetId === MAGPIE_PRESET_ID),
  );
}
