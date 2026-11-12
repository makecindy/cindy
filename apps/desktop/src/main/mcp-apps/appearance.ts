import { createHash } from 'node:crypto';
import { PLUGIN_APPEARANCE_FIELDS, type PluginAppearanceResult } from '@cindy/plugin-protocol/appearance';
import type { GhostHostUi } from '@cindy/plugin-protocol';
import type { PluginFileAccess } from './pluginFiles.js';
import type { PluginAppearanceService } from '../cindy-brain/pluginAppearanceService.js';

interface Source { host: GhostHostUi; ghost: { dir: string }; owner: string; fingerprint: string;
  config: { plugin?: { assertCurrent(sessionId?: string): void } } }
let resolveSource: (instance: string) => Source | undefined = () => undefined;
let sourcesAvailable: () => boolean = () => false;
let files: PluginFileAccess | undefined;
let service: PluginAppearanceService | undefined;
let preparing: Promise<PluginAppearanceService> | undefined;
let apply: (settings: import('../../shared/appearanceSettings.js').AppearanceSettings) => Promise<PluginAppearanceResult['application']> =
  async () => ({ status: 'saved', reason: 'NO_VIEWING_WINDOW' });

export function configurePluginAppearanceFiles(access: PluginFileAccess): PluginFileAccess {
  files = access;
  void reconcileAppearance().catch(() => {});
  return access;
}

export function configurePluginAppearanceApply(next: typeof apply): void { apply = next; }
export function reconcilePluginAppearanceSources(resolve: typeof resolveSource, available: () => boolean): Promise<void> {
  resolveSource = resolve;
  sourcesAvailable = available;
  return reconcileAppearance();
}

async function reconcileAppearance(released?: string): Promise<void> {
  if (service) await service.reconcile(released);
  else if (files && sourcesAvailable()) {
    // Only explicitly selected resource metadata can require a service on cold startup.
    // Registry refreshes never read or decode appearance media for an unused capability.
    const [{ customWallpaperStore }, { readAppearanceSettings }] = await Promise.all([
      import('../custom-wallpaper-settings.js'), import('../appearance-settings-store.js'),
    ]);
    if (!sourcesAvailable()) return;
    const settings = readAppearanceSettings();
    const sources = [customWallpaperStore.read().pluginSource, settings.uiFontResource?.source,
      settings.codeFontResource?.source, settings.bodyFontResource?.source];
    if (sources.some(source => source && 'instanceId' in source && (!released || source.instanceId === released)))
      await (await getPluginAppearanceService()).reconcile(released);
  }
}

/** Heavy resource code is loaded only for selected appearance data or explicit calls. */
export async function getPluginAppearanceService(): Promise<PluginAppearanceService> {
  if (service) return service;
  if (preparing) return preparing;
  preparing = (async () => {
    if (!files) throw new Error('MCP_APP_HOST_NOT_READY');
    const [{ PluginAppearanceService }, settings, owner, wallpaper] = await Promise.all([
      import('../cindy-brain/pluginAppearanceService.js'), import('../appearance-settings-store.js'),
      import('../appearance-settings-ipc.js'), import('../custom-wallpaper.js'),
    ]);
    service = new PluginAppearanceService({
      ready: () => !!files && sourcesAvailable(),
      current(instance) {
        const source = resolveSource(instance);
        if (!source || !source.host.capabilities?.includes('appearance')) return null;
        try { source.config.plugin?.assertCurrent(); } catch { return null; }
        const key = createHash('sha256').update(`${source.owner}:${source.fingerprint}`).digest('hex');
        const fields = source.host.appearance?.fields ?? PLUGIN_APPEARANCE_FIELDS;
        return { id: instance, token: key, key, dir: source.ghost.dir,
          appearance: { fields: [...fields], resources: source.host.appearance?.resources } };
      },
      files: files!, read: settings.readAppearanceSettings, update: settings.updateAppearanceSettingsAtomic,
      saveWallpaper: wallpaper.savePluginWallpaper, revokeWallpaper: wallpaper.revokePluginWallpaper,
      publish: owner.publishAppearanceFromOwner, apply: snapshot => apply(snapshot),
    });
    return service;
  })();
  try { return await preparing; } finally { preparing = undefined; }
}

export function releasePluginAppearance(instance: string): void {
  void reconcileAppearance(instance).catch(() => {});
}

export async function readSelectedPluginFont(role: string) {
  return (await getPluginAppearanceService()).font(role);
}

export async function editPluginAppearance(instance: string, request: unknown, assertCurrent: () => void) {
  const reply = await (await getPluginAppearanceService()).handle(instance, request, assertCurrent) as
    { ok: boolean; data?: unknown; error?: { code: string } };
  if (!reply.ok) throw new Error(`MCP_APP_${reply.error?.code ?? 'APPEARANCE_FAILED'}`);
  return reply.data;
}
