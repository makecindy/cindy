import { createHash } from 'node:crypto';
import { parseGhostNativeUi } from '@cindy/plugin-protocol';
import { parsePluginAppearancePatch, PLUGIN_APPEARANCE_FIELDS, pluginUiRecord } from '@cindy/maker-shared';
import type { PluginAppearancePatch, PluginAppearanceField, PluginAppearanceResult, PluginAppearanceSnapshot } from '@cindy/maker-shared/plugin-ui';
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings, type AppearanceOverrides } from '../../shared/appearanceSettings.js';
import type { PluginAppearanceSource, PluginFontResource } from '../../shared/pluginAppearance.js';
import type { PluginFileAccess } from '../mcp-apps/pluginFiles.js';
import { loadPluginAppearanceResource, type LoadedPluginAppearanceResource } from './pluginAppearanceResources.js';

interface Instance { id: string; token: string; key: string; dir: string; ui: unknown }
interface Dependencies {
  ready(): boolean;
  current(id: string): Instance | null;
  files: PluginFileAccess;
  read(): AppearanceSettings;
  update(updater: (current: AppearanceSettings) => AppearanceOverrides): Promise<AppearanceSettings>;
  saveWallpaper(bytes: Buffer, options: { fallback?: Buffer; pluginSource: PluginAppearanceSource; assertCurrent(): void }): Promise<{ url: string; fallbackUrl?: string }>;
  revokeWallpaper(isCurrent: (source: PluginAppearanceSource) => boolean): Promise<boolean>;
  publish(settings: AppearanceSettings): void;
  apply(settings: AppearanceSettings): Promise<PluginAppearanceResult['application']>;
  applyAppIcon(bytes: Buffer | null): void;
}
const revision = (value: AppearanceSettings) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scalarRevision = ({ customWallpaperUrl: _url, customWallpaperFallbackUrl: _fallback, ...settings }: AppearanceSettings) => {
  void _url; void _fallback; return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
};
const fontRoles = ['uiFont', 'codeFont', 'bodyFont'] as const;
const iconIdentity = (resource: AppearanceSettings['appIconResource']) => resource &&
  JSON.stringify([resource.source.instanceId, resource.source.key, resource.reference, resource.hash]);

/** Thin adapter to the existing profile settings owner. No plugin preference store. */
export class PluginAppearanceService {
  private mutations = 0;
  constructor(private readonly deps: Dependencies) {}

  private access(id: string, assertCaller: () => void = () => {}) {
    assertCaller();
    const instance = this.deps.current(id);
    const ui = instance && parseGhostNativeUi(instance.ui);
    if (!instance || ui?.version !== 1 || !ui.appearance) throw new Error('APPEARANCE_UNAVAILABLE');
    const fields = ui.appearance.fields.filter((field): field is PluginAppearanceField => PLUGIN_APPEARANCE_FIELDS.includes(field as PluginAppearanceField));
    const assertCurrent = () => { assertCaller(); if (this.deps.current(id)?.token !== instance.token) throw new Error('CONTEXT_CHANGED'); };
    return { instance, fields, assertCurrent };
  }

  read(id: string, assertCaller?: () => void): PluginAppearanceSnapshot {
    const { fields, assertCurrent } = this.access(id, assertCaller);
    const s = this.deps.read(), values: PluginAppearancePatch = {};
    for (const field of fields) {
      if (field === 'uiFont' || field === 'codeFont') {
        const resource = s[field === 'uiFont' ? 'uiFontResource' : 'codeFontResource'];
        values[field] = { ...(resource?.source.instanceId === id ? { resource: resource.reference } : { family: s[field === 'uiFont' ? 'uiFamily' : 'codeFamily'] }), size: s[field === 'uiFont' ? 'uiSize' : 'codeSize'],
          ...s[field === 'uiFont' ? 'uiFontTraits' : 'codeFontTraits'],
        };
      } else if (field === 'bodyFont' && (s.bodyFont || s.bodyFontResource?.source.instanceId === id)) {
        const { family, ...traits } = s.bodyFont ?? {};
        values.bodyFont = s.bodyFontResource?.source.instanceId === id ? { ...traits, resource: s.bodyFontResource.reference } : { ...traits, ...(family ? { family } : {}) };
      }
      else if (field === 'wallpaper') values.wallpaper = { visibility: s.wallpaperVisibility ?? undefined,
        blur: s.wallpaperBlur ?? undefined, motion: s.wallpaperMotion };
      else if (field === 'theme' && s.themeColors) values.theme = s.themeColors;
      else if (field === 'reading' && s.reading) values.reading = s.reading;
      else if (field === 'contentStyle' && s.contentStyle) values.contentStyle = s.contentStyle;
      else if (field === 'appIcon' && s.appIconResource?.source.instanceId === id) values.appIcon = { resource: s.appIconResource.reference };
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
    const expectedScalars = scalarRevision(this.deps.read());
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
    const icon = patch.appIcon ? await loadPluginAppearanceResource(resourceSource, patch.appIcon.resource, 'icon') : undefined;
    assertCurrent(); this.assertRevision(expected);
    const media = wallpaper ? await this.deps.saveWallpaper(wallpaper.bytes, { fallback, pluginSource: source,
      assertCurrent: () => { assertCurrent(); this.assertRevision(expected); } }) : undefined;
    const settings = await this.deps.update(current => {
      assertCurrent();
      const latest = this.deps.read();
      if (expected && (media ? scalarRevision(latest) !== expectedScalars : revision(latest) !== expected)) throw new Error('APPEARANCE_CHANGED');
      if (media && (latest.customWallpaperUrl !== media.url || latest.customWallpaperFallbackUrl !== media.fallbackUrl)) throw new Error('APPEARANCE_CHANGED');
      const next: AppearanceOverrides = {};
      if (icon && patch.appIcon) next.appIconResource = { source, reference: patch.appIcon.resource, hash: icon.hash };
      for (const role of fontRoles) {
        const font = patch[role]; if (!font) continue;
        const { resource: _reference, ...traits } = font; void _reference;
        const asset = assets[role];
        if (role === 'bodyFont') {
          next.bodyFont = { ...current.bodyFont, ...traits, ...(asset ? { family: asset.family } : {}) };
          if (asset || font.family !== undefined) next.bodyFontResource = asset;
        } else {
          const familyKey = role === 'uiFont' ? 'uiFamily' : 'codeFamily', sizeKey = role === 'uiFont' ? 'uiSize' : 'codeSize';
          const resourceKey = role === 'uiFont' ? 'uiFontResource' : 'codeFontResource', traitsKey = role === 'uiFont' ? 'uiFontTraits' : 'codeFontTraits';
          if (asset || font.family !== undefined) { next[familyKey] = asset?.family ?? font.family!; next[resourceKey] = asset; }
          if (font.size !== undefined) next[sizeKey] = font.size;
          if (font.weight !== undefined || font.style !== undefined) next[traitsKey] = { ...current[traitsKey],
            ...(font.weight !== undefined ? { weight: font.weight } : {}), ...(font.style ? { style: font.style } : {}) };
        }
      }
      if (patch.theme) next.themeColors = { ...current.themeColors,
        ...(patch.theme.light ? { light: { ...current.themeColors?.light, ...patch.theme.light } } : {}),
        ...(patch.theme.dark ? { dark: { ...current.themeColors?.dark, ...patch.theme.dark } } : {}) };
      if (patch.reading) next.reading = { ...current.reading, ...patch.reading };
      if (patch.contentStyle) next.contentStyle = { ...current.contentStyle, ...patch.contentStyle };
      if (patch.wallpaper) {
        if (wallpaper) next.wallpaperId = 'custom';
        if (patch.wallpaper.visibility !== undefined) next.wallpaperVisibility = patch.wallpaper.visibility;
        if (patch.wallpaper.blur !== undefined) next.wallpaperBlur = patch.wallpaper.blur;
        if (patch.wallpaper.motion !== undefined) next.wallpaperMotion = patch.wallpaper.motion;
      }
      return next;
    });
    return this.finish(id, settings, assertCurrent, Object.keys(patch), icon);
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
      const next: AppearanceOverrides = {};
      for (const field of raw as PluginAppearanceField[]) {
        if (field === 'uiFont') Object.assign(next, { uiFamily: '', uiSize: DEFAULT_APPEARANCE_SETTINGS.uiSize, uiFontResource: undefined, uiFontTraits: undefined });
        else if (field === 'codeFont') Object.assign(next, { codeFamily: '', codeSize: DEFAULT_APPEARANCE_SETTINGS.codeSize, codeFontResource: undefined, codeFontTraits: undefined });
        else if (field === 'bodyFont') Object.assign(next, { bodyFont: undefined, bodyFontResource: undefined });
        else if (field === 'wallpaper') Object.assign(next, { wallpaperId: 'none', wallpaperMotion: 'static', wallpaperOverlay: DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay,
          wallpaperVisibility: undefined, wallpaperBlur: undefined });
        else if (field === 'theme') next.themeColors = undefined;
        else if (field === 'reading') next.reading = undefined;
        else if (field === 'appIcon') next.appIconResource = undefined;
        else next.contentStyle = undefined;
      }
      return next;
    });
    return this.finish(id, settings, assertCurrent, raw as PluginAppearanceField[]);
  }

  private async finish(id: string, settings: AppearanceSettings, assertCurrent: () => void,
    fields: readonly string[], icon?: LoadedPluginAppearanceResource): Promise<PluginAppearanceResult> {
    this.deps.publish(settings);
    const native = fields.includes('appIcon') ? await this.applyIcon(settings, icon)
      .catch(() => ({ status: 'failed' as const, reason: 'APP_ICON_APPLICATION_FAILED' })) : undefined;
    let application = fields.every(field => field === 'appIcon') ? native! :
      await this.deps.apply(settings).catch(() => ({ status: 'failed' as const, reason: 'APPLICATION_FAILED' }));
    if (native?.status === 'failed' || native?.status === 'saved' && application.status !== 'failed') application = native;
    assertCurrent();
    const snapshot = this.read(id, assertCurrent);
    if (snapshot.revision !== revision(settings)) application = { status: 'saved', reason: 'SUPERSEDED' };
    return { ...snapshot, application };
  }

  private async applyIcon(settings: AppearanceSettings, prepared?: LoadedPluginAppearanceResource): Promise<PluginAppearanceResult['application']> {
    const resource = settings.appIconResource;
    const isSelected = () => iconIdentity(this.deps.read().appIconResource) === iconIdentity(resource);
    if (!isSelected()) return { status: 'saved', reason: 'SUPERSEDED' };
    if (!resource) { this.deps.applyAppIcon(null); return { status: 'applied' }; }
    const { instance, fields, assertCurrent } = this.access(resource.source.instanceId);
    if (!fields.includes('appIcon') || instance.key !== resource.source.key) throw new Error('RESOURCE_UNAVAILABLE');
    const loaded = prepared ?? await loadPluginAppearanceResource({ instanceId: instance.id, ghost: instance,
      files: this.deps.files, assertCurrent }, resource.reference, 'icon');
    assertCurrent();
    if (loaded.hash !== resource.hash) throw new Error('RESOURCE_UNAVAILABLE');
    if (!isSelected()) return { status: 'saved', reason: 'SUPERSEDED' };
    this.deps.applyAppIcon(loaded.bytes);
    return { status: 'applied' };
  }

  async restoreAppIcon(): Promise<void> {
    if (this.deps.ready()) await this.applyIcon(this.deps.read());
  }

  async font(role: string): Promise<{ family: string; base64: string }> {
    if (!fontRoles.includes(role as typeof fontRoles[number])) throw new Error('INVALID_PARAMS');
    const resource = this.deps.read()[`${role}Resource` as 'uiFontResource'];
    if (!resource) throw new Error('RESOURCE_UNAVAILABLE');
    const { instance, fields, assertCurrent } = this.access(resource.source.instanceId);
    if (!fields.includes(role as PluginAppearanceField) || instance.key !== resource.source.key) throw new Error('RESOURCE_UNAVAILABLE');
    const loaded = await loadPluginAppearanceResource({ instanceId: instance.id, ghost: instance, files: this.deps.files, assertCurrent }, resource.reference, 'font');
    if (loaded.hash !== resource.hash) throw new Error('RESOURCE_UNAVAILABLE');
    return { family: resource.family, base64: loaded.bytes.toString('base64') };
  }

  async reconcile(): Promise<void> {
    if (!this.deps.ready()) { this.deps.applyAppIcon(null); return; }
    const isCurrent = (source: PluginAppearanceSource) => !this.deps.ready() || this.deps.current(source.instanceId)?.key === source.key;
    const before = this.deps.read();
    const stale = fontRoles.filter(role => {
      const resource = before[`${role}Resource` as 'uiFontResource']; return resource && !isCurrent(resource.source);
    });
    const wallpaperRemoved = await this.deps.revokeWallpaper(isCurrent);
    const staleIcon = before.appIconResource && !isCurrent(before.appIconResource.source);
    const settings = !stale.length && !wallpaperRemoved && !staleIcon ? this.deps.read() : await this.deps.update(current => {
      if (!this.deps.ready()) return {};
      const patch: AppearanceOverrides = {};
      for (const role of stale) {
        const key = `${role}Resource` as 'uiFontResource', resource = current[key];
        if (!resource || isCurrent(resource.source)) continue;
        patch[key] = undefined;
        if (role === 'bodyFont') {
          if (current.bodyFont?.family === resource.family) { const { family: _family, ...font } = current.bodyFont; void _family; patch.bodyFont = Object.keys(font).length ? font : undefined; }
        } else { const family = role === 'uiFont' ? 'uiFamily' : 'codeFamily'; if (current[family] === resource.family) patch[family] = ''; }
      }
      if (wallpaperRemoved && current.wallpaperId === 'custom' && !this.deps.read().customWallpaperUrl) patch.wallpaperId = 'none';
      if (current.appIconResource && !isCurrent(current.appIconResource.source)) patch.appIconResource = undefined;
      return patch;
    });
    if (stale.length || wallpaperRemoved || staleIcon) this.deps.publish(settings);
    try { await this.applyIcon(settings); }
    catch (error) {
      if (iconIdentity(this.deps.read().appIconResource) === iconIdentity(settings.appIconResource)) this.deps.applyAppIcon(null);
      throw error;
    }
  }
}
