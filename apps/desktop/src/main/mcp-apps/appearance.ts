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
let restoreRequested = false;

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
    // Only selected wallpaper metadata can require a service on cold startup.
    // Registry refreshes never read or decode appearance media for an unused capability.
    const { customWallpaperStore } = await import('../custom-wallpaper-settings.js');
    if (!sourcesAvailable()) return;
    const source = customWallpaperStore.read().pluginSource;
    if (source && (!released || source.instanceId === released))
      await (await getPluginAppearanceService()).reconcile(released);
  }
  if (restoreRequested) await restorePluginAppearanceIcon();
}

/** Heavy resource code is loaded only for selected appearance data or explicit calls. */
export async function getPluginAppearanceService(): Promise<PluginAppearanceService> {
  if (service) return service;
  if (preparing) return preparing;
  preparing = (async () => {
    if (!files) throw new Error('MCP_APP_HOST_NOT_READY');
    const [{ PluginAppearanceService }, settings, owner, wallpaper, icons] = await Promise.all([
      import('../cindy-brain/pluginAppearanceService.js'), import('../appearance-settings-store.js'),
      import('../appearance-settings-ipc.js'), import('../custom-wallpaper.js'), import('../app-icon.js'),
    ]);
    service = new PluginAppearanceService({
      ready: () => !!files && sourcesAvailable(),
      current(instance) {
        const source = resolveSource(instance);
        if (!source || !source.host.capabilities?.some(cap => cap === 'appearance' || cap === 'app-icon')) return null;
        try { source.config.plugin?.assertCurrent(); } catch { return null; }
        const key = createHash('sha256').update(`${source.owner}:${source.fingerprint}`).digest('hex');
        const fields = (source.host.appearance?.fields ?? PLUGIN_APPEARANCE_FIELDS).filter(field => field === 'appIcon'
          ? source.host.capabilities?.includes('app-icon') : source.host.capabilities?.includes('appearance'));
        return { id: instance, token: key, key, dir: source.ghost.dir,
          appearance: { fields: [...fields], resources: source.host.appearance?.resources } };
      },
      files: files!, read: settings.readAppearanceSettings, update: settings.updateAppearanceSettingsAtomic,
      saveWallpaper: wallpaper.savePluginWallpaper, revokeWallpaper: wallpaper.revokePluginWallpaper,
      publish: owner.publishAppearanceFromOwner, apply: snapshot => apply(snapshot), applyAppIcon: icons.applyPluginAppIcon,
    });
    return service;
  })();
  try { return await preparing; } finally { preparing = undefined; }
}

export async function restorePluginAppearanceIcon(): Promise<void> {
  restoreRequested = true;
  if (!files || !sourcesAvailable()) return;
  const { readAppearanceSettings } = await import('../appearance-settings-store.js');
  const resource = readAppearanceSettings().appIconResource;
  if (!resource || !resolveSource(resource.source.instanceId)) return;
  restoreRequested = false;
  await (await getPluginAppearanceService()).restoreAppIcon();
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
