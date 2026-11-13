import { pluginAppearanceRevision as revision } from './pluginAppearanceRevision.js';
import { parsePluginAppearancePatch, PLUGIN_APPEARANCE_FIELDS, type PluginAppearancePatch, type PluginAppearanceField, type PluginAppearanceResult, type PluginAppearanceSnapshot } from '@cindy/plugin-protocol/appearance';
import type { GhostHostUi } from '@cindy/plugin-protocol';
const pluginUiRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
import { type AppearanceSettings, type AppearanceOverrides } from '../../shared/appearanceSettings.js';
import { isPluginFontResource, type PluginAppearanceSource, type PluginFontResource } from '../../shared/pluginAppearance.js';
import { appearanceDefinitionToOverrides, appearanceResetPatch } from '../appearance/definition.js';
import type { PluginFileAccess } from '../mcp-apps/pluginFiles.js';
import { loadPluginAppearanceResource } from './pluginAppearanceResources.js';

interface Instance { id: string; token: string; key: string; dir: string; appearance: NonNullable<GhostHostUi['appearance']> }
interface Dependencies {
  ready(): boolean;
  current(id: string): Instance | null;
  files: PluginFileAccess;
  read(): AppearanceSettings;
  update(updater: (current: AppearanceSettings, overrides: AppearanceOverrides) => AppearanceOverrides): Promise<AppearanceSettings>;
  saveWallpaper(bytes: Buffer, options: { fallback?: Buffer; pluginSource: PluginAppearanceSource; assertCurrent(): void;
    commit(publish: () => void): Promise<void> }): Promise<{ url: string; fallbackUrl?: string }>;
  revokeWallpaper(isCurrent: (source: PluginAppearanceSource) => boolean): Promise<boolean>;
  publish(settings: AppearanceSettings): void;
  apply(settings: AppearanceSettings): Promise<PluginAppearanceResult['application']>;
}
const fontRoles = ['uiFont', 'codeFont', 'bodyFont'] as const;

/** Thin adapter to the existing profile settings owner. No plugin preference store. */
export class PluginAppearanceService {
  private mutations = 0;
  constructor(private readonly deps: Dependencies) {}

  private access(id: string, assertCaller: () => void = () => {}) {
    assertCaller();
    const instance = this.deps.current(id);
    const appearance = instance?.appearance;
    if (!instance || !appearance) throw new Error('APPEARANCE_UNAVAILABLE');
    const fields = appearance.fields.filter((field): field is PluginAppearanceField => PLUGIN_APPEARANCE_FIELDS.includes(field as PluginAppearanceField));
    const assertCurrent = () => { assertCaller(); if (this.deps.current(id)?.token !== instance.token) throw new Error('CONTEXT_CHANGED'); };
    return { instance, fields, assertCurrent };
  }

  read(id: string, assertCaller?: () => void): PluginAppearanceSnapshot {
    const { fields, assertCurrent } = this.access(id, assertCaller);
    const s = this.deps.read(), values: PluginAppearancePatch = {};
    for (const field of fields) {
      if (field === 'uiFont' || field === 'codeFont') {
        const resource = s[field === 'uiFont' ? 'uiFontResource' : 'codeFontResource'];
        values[field] = { ...(resource && isPluginFontResource(resource) && resource.source.instanceId === id ? { resource: resource.reference } : { family: s[field === 'uiFont' ? 'uiFamily' : 'codeFamily'] }), size: s[field === 'uiFont' ? 'uiSize' : 'codeSize'],
          ...s[field === 'uiFont' ? 'uiFontTraits' : 'codeFontTraits'],
        };
      } else if (field === 'bodyFont' && (s.bodyFont || s.bodyFontResource && isPluginFontResource(s.bodyFontResource) && s.bodyFontResource.source.instanceId === id)) {
        const { family, ...traits } = s.bodyFont ?? {};
        values.bodyFont = s.bodyFontResource && isPluginFontResource(s.bodyFontResource) && s.bodyFontResource.source.instanceId === id ? { ...traits, resource: s.bodyFontResource.reference } : { ...traits, ...(family ? { family } : {}) };
      }
      else if (field === 'wallpaper') values.wallpaper = { visibility: s.wallpaperVisibility ?? undefined,
        blur: s.wallpaperBlur ?? undefined, motion: s.wallpaperMotion };
      else if (field === 'theme' && s.themeColors) values.theme = s.themeColors;
      else if (field === 'reading' && s.reading) values.reading = s.reading;
      else if (field === 'contentStyle' && s.contentStyle) values.contentStyle = s.contentStyle;
    }
    assertCurrent();
    return { revision: revision(s), values };
  }

  async handle(id: string, raw: unknown, assertCaller?: () => void): Promise<unknown> {
    try {
      if (!pluginUiRecord(raw)) throw new Error('INVALID_PARAMS');
      if (raw.kind === 'read') return { ok: true, data: this.read(id, assertCaller) };
      if (raw.kind !== 'set' && raw.kind !== 'reset') throw new Error('INVALID_PARAMS');
      if (raw.ifRevision !== undefined && (typeof raw.ifRevision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.ifRevision))) throw new Error('INVALID_PARAMS');
      // Bound resource preparation as well as receipt waiting. Never queue or replay writes.
      if (this.mutations >= 2) throw new Error('APPEARANCE_BUSY');
      this.mutations++;
      try {
        const data = raw.kind === 'set' ? await this.set(id, raw.patch, raw.ifRevision as string | undefined, assertCaller) :
          await this.reset(id, raw.fields, raw.ifRevision as string | undefined, assertCaller);
        return { ok: true, data };
      } finally { this.mutations--; }
    } catch (error) {
      const code = error instanceof Error && ['INVALID_PARAMS', 'APPEARANCE_UNAVAILABLE', 'FIELD_NOT_DECLARED', 'CONTEXT_CHANGED',
        'APPEARANCE_CHANGED', 'APPEARANCE_BUSY', 'RESOURCE_UNAVAILABLE', 'RESOURCE_TYPE', 'RESOURCE_TOO_LARGE', 'INVALID_FONT'].includes(error.message)
        ? error.message : 'APPEARANCE_FAILED';
      return { ok: false, error: { code, message: code } };
    }
  }

  private async set(id: string, raw: unknown, expected?: string, assertCaller?: () => void): Promise<PluginAppearanceResult> {
    const patch = parsePluginAppearancePatch(raw);
    if (!patch) throw new Error('INVALID_PARAMS');
    const { instance, fields, assertCurrent } = this.access(id, assertCaller);
    if (Object.keys(patch).some(field => !fields.includes(field as PluginAppearanceField))) throw new Error('FIELD_NOT_DECLARED');
    this.assertRevision(expected);
    const source = { instanceId: id, key: instance.key };
    const resourceSource = { instanceId: id, ghost: instance, files: this.deps.files, assertCurrent };
    const assets: Partial<Record<typeof fontRoles[number], PluginFontResource>> = {};
    for (const role of fontRoles) if (patch[role]?.resource) {
      const reference = patch[role]!.resource!;
      const loaded = await loadPluginAppearanceResource(resourceSource, reference, 'font');
      assets[role] = { source, reference, hash: loaded.hash, family: `CindyPlugin_${loaded.hash}` };
    }
    let wallpaper: Awaited<ReturnType<typeof loadPluginAppearanceResource>> | undefined;
    let fallback: Buffer | undefined;
    if (patch.wallpaper?.resource) wallpaper = await loadPluginAppearanceResource(resourceSource, patch.wallpaper.resource, 'wallpaper');
    if (patch.wallpaper?.fallbackResource) fallback = (await loadPluginAppearanceResource(resourceSource, patch.wallpaper.fallbackResource, 'image')).bytes;
    assertCurrent(); this.assertRevision(expected);
    let settings!: AppearanceSettings;
    const commit = async (publishWallpaper?: () => void) => { settings = await this.deps.update((_current, overrides) => {
      assertCurrent();
      this.assertRevision(expected);
      const next = appearanceDefinitionToOverrides(overrides, patch, assets);
      publishWallpaper?.();
      return next;
    }); };
    if (wallpaper) await this.deps.saveWallpaper(wallpaper.bytes, { fallback, pluginSource: source,
      assertCurrent: () => { assertCurrent(); this.assertRevision(expected); }, commit });
    else await commit();
    return this.finish(id, settings, assertCurrent);
  }

  private assertRevision(expected?: string): void {
    if (expected && revision(this.deps.read()) !== expected) throw new Error('APPEARANCE_CHANGED');
  }

  private async reset(id: string, raw: unknown, expected?: string, assertCaller?: () => void): Promise<PluginAppearanceResult> {
    const { fields, assertCurrent } = this.access(id, assertCaller);
    if (!Array.isArray(raw) || !raw.length || raw.length > PLUGIN_APPEARANCE_FIELDS.length || new Set(raw).size !== raw.length ||
        raw.some(field => !PLUGIN_APPEARANCE_FIELDS.includes(field))) throw new Error('INVALID_PARAMS');
    if (raw.some(field => !fields.includes(field))) throw new Error('FIELD_NOT_DECLARED');
    const settings = await this.deps.update(current => {
      assertCurrent(); this.assertRevision(expected);
      return appearanceResetPatch(raw as PluginAppearanceField[]);
    });
    return this.finish(id, settings, assertCurrent);
  }

  private async finish(id: string, settings: AppearanceSettings, assertCurrent: () => void): Promise<PluginAppearanceResult> {
    assertCurrent();
    if (revision(this.deps.read()) !== revision(settings))
      return { ...this.read(id, assertCurrent), application: { status: 'saved', reason: 'SUPERSEDED' } };
    this.deps.publish(settings);
    let application = await this.deps.apply(settings).catch(() => ({ status: 'failed' as const, reason: 'APPLICATION_FAILED' }));
    assertCurrent();
    const snapshot = this.read(id, assertCurrent);
    if (snapshot.revision !== revision(settings)) application = { status: 'saved', reason: 'SUPERSEDED' };
    return { ...snapshot, application };
  }

  async font(role: string): Promise<{ family: string; bytes: ArrayBuffer }> {
    if (!fontRoles.includes(role as typeof fontRoles[number])) throw new Error('INVALID_PARAMS');
    const resource = this.deps.read()[`${role}Resource` as 'uiFontResource'];
    if (!resource || !isPluginFontResource(resource)) throw new Error('RESOURCE_UNAVAILABLE');
    const { instance, fields, assertCurrent } = this.access(resource.source.instanceId);
    if (!fields.includes(role as PluginAppearanceField) || instance.key !== resource.source.key) throw new Error('RESOURCE_UNAVAILABLE');
    const loaded = await loadPluginAppearanceResource({ instanceId: instance.id, ghost: instance, files: this.deps.files, assertCurrent }, resource.reference, 'font');
    if (loaded.hash !== resource.hash) throw new Error('RESOURCE_UNAVAILABLE');
    return { family: resource.family, bytes: new Uint8Array(loaded.bytes).buffer };
  }

  async reconcile(released?: string): Promise<void> {
    if (!this.deps.ready()) return;
    const isCurrent = (source: PluginAppearanceSource) => !this.deps.ready() || source.instanceId !== released && this.deps.current(source.instanceId)?.key === source.key;
    const before = this.deps.read();
    const stale = fontRoles.filter(role => {
      const resource = before[`${role}Resource` as 'uiFontResource']; return resource && isPluginFontResource(resource) && !isCurrent(resource.source);
    });
    const wallpaperRemoved = await this.deps.revokeWallpaper(isCurrent);
    const settings = !stale.length && !wallpaperRemoved ? this.deps.read() : await this.deps.update((current, overrides) => {
      if (!this.deps.ready()) return {};
      const patch: AppearanceOverrides = {};
      for (const role of stale) {
        const key = `${role}Resource` as 'uiFontResource', resource = current[key];
        if (!resource || !isPluginFontResource(resource) || isCurrent(resource.source)) continue;
        patch[key] = undefined;
        if (role === 'bodyFont') {
          if (overrides.bodyFont?.family === resource.family) { const { family: _family, ...font } = overrides.bodyFont; void _family; patch.bodyFont = Object.keys(font).length ? font : undefined; }
        } else { const family = role === 'uiFont' ? 'uiFamily' : 'codeFamily'; if (current[family] === resource.family) patch[family] = undefined; }
      }
      if (wallpaperRemoved && current.wallpaperId === 'custom' && !this.deps.read().customWallpaperUrl) patch.wallpaperId = 'none';
      return patch;
    });
    if (stale.length || wallpaperRemoved) this.deps.publish(settings);
  }
}
