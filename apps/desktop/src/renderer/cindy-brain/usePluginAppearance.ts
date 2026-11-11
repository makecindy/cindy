import { useCallback, useEffect, useRef } from 'react';
import { getWallpaperVisibility, normalizeAppearanceSettings, type AppearanceSettings } from '@/../shared/appearanceSettings';
import type { PluginAppearanceColor } from '@cindy/plugin-protocol/appearance';

type Bridge = typeof window.electronAPI.appearanceSettings;
type Faces = Map<string, { key: string; face: FontFace }>;
type PendingFont = { key: string; promise: Promise<FontFace | undefined>; current(): boolean };
type PendingFonts = Map<string, PendingFont>;
const hasExtendedAppearance = (settings: AppearanceSettings) => Boolean(settings.bodyFont || settings.reading || settings.contentStyle || settings.themeColors ||
  settings.uiFontTraits || settings.codeFontTraits || settings.uiFontResource || settings.codeFontResource || settings.bodyFontResource);
const setCss = (style: HTMLStyleElement, settings: AppearanceSettings, dark: boolean) => {
  const next = css(settings, dark);
  if (style.textContent !== next) style.textContent = next;
};
const region = '[data-plugin-appearance-region]';
const colorVariables: Record<PluginAppearanceColor, string[]> = {
  text: ['--text-primary', '--msg-assistant-text'],
  secondaryText: ['--text-secondary', '--text-secondary-mid'],
  surface: ['--surface-elevated', '--msg-code-block-bg'], border: ['--border-default', '--msg-user-border', '--msg-code-block-border'],
  userBubble: ['--msg-user-bg'], userText: ['--msg-user-text'], assistantBubble: [],
};

function css(settings: AppearanceSettings, dark: boolean): string {
  const declarations: string[] = [], rules: string[] = [];
  for (const [role, color] of Object.entries(settings.themeColors?.[dark ? 'dark' : 'light'] ?? {}))
    for (const variable of colorVariables[role as PluginAppearanceColor] ?? []) declarations.push(`${variable}:${color}`);
  const font = settings.bodyFont;
  if (font?.family) declarations.push(`font-family:${JSON.stringify(font.family)},var(--app-font-ui-default)`);
  if (font?.size !== undefined) {
    declarations.push(`font-size:${font.size}px`);
    rules.push(`${region} .msg-markdown :is(p,li,blockquote){font-size:${font.size}px}`);
  }
  if (font?.weight !== undefined) declarations.push(`font-weight:${font.weight}`);
  if (font?.style) declarations.push(`font-style:${font.style}`);
  if (settings.reading?.bodyLineHeight !== undefined) {
    declarations.push(`line-height:${settings.reading.bodyLineHeight}`);
    rules.push(`${region} .msg-markdown :is(p,li,blockquote){line-height:${settings.reading.bodyLineHeight}}`);
  }
  if (settings.reading?.maxWidth !== undefined) declarations.push(`max-width:min(100%,${settings.reading.maxWidth}px)`);
  if (settings.contentStyle?.messageGap !== undefined) declarations.push(`margin-block:${settings.contentStyle.messageGap}px`);
  if (settings.contentStyle?.messagePadding !== undefined) declarations.push(`padding:${settings.contentStyle.messagePadding}px`);
  if (settings.contentStyle?.messageRadius !== undefined) declarations.push(`border-radius:${settings.contentStyle.messageRadius}px`);
  if (declarations.length) rules.push(`${region}{${declarations.join(';')}}`);
  const code: string[] = [];
  if (settings.codeFontTraits?.weight !== undefined) code.push(`font-weight:${settings.codeFontTraits.weight}`);
  if (settings.codeFontTraits?.style) code.push(`font-style:${settings.codeFontTraits.style}`);
  if (settings.reading?.codeLineHeight !== undefined) code.push(`line-height:${settings.reading.codeLineHeight}`);
  if (code.length) rules.push(`${region} :is(pre,code){${code.join(';')}}`);
  const ui: string[] = [];
  if (settings.uiFontTraits?.weight !== undefined) ui.push(`font-weight:${settings.uiFontTraits.weight}`);
  if (settings.uiFontTraits?.style) ui.push(`font-style:${settings.uiFontTraits.style}`);
  if (ui.length) rules.push(`body{${ui.join(';')}}`);
  if (settings.themeColors?.[dark ? 'dark' : 'light']?.assistantBubble)
    rules.push(`${region}[data-plugin-appearance-speaker="assistant"]{background:${settings.themeColors[dark ? 'dark' : 'light']!.assistantBubble}}`);
  return rules.join('\n');
}

function wallpaperApplicationStatus(settings: AppearanceSettings, dark: () => boolean): 'applied' | 'saved' | 'failed' {
  if (settings.wallpaperId === 'none' && document.documentElement.dataset.wallpaperActive === 'true') return 'saved';
  if (settings.wallpaperId === 'custom') {
    const url = settings.customWallpaperUrl;
    if (!url) return 'saved';
    if (url.endsWith('.mp4')) {
      const player = [...document.querySelectorAll('video')].find(video => video.src === url || video.currentSrc === url);
      if (!player || player.readyState < 2 || player.error) return player?.error ? 'failed' : 'saved';
    } else if (!document.documentElement.style.getPropertyValue('--app-wallpaper-image').includes(url)) return 'saved';
    const veil = `${100 - getWallpaperVisibility(settings, dark()) * 100}%`;
    if (document.documentElement.style.getPropertyValue('--app-wallpaper-veil') !== veil) return 'saved';
  }
  return 'applied';
}

/** Only font bytes and the closed appearance model reach this consumer. */
export async function applyPluginAppearance(settings: AppearanceSettings, options: {
  bridge: Bridge; style: HTMLStyleElement; faces: Faces; pending: PendingFonts; dark(): boolean; current(): boolean; applyFonts(settings: AppearanceSettings): void;
}): Promise<'applied' | 'saved' | 'failed'> {
  const { faces, pending, bridge } = options;
  for (const role of ['uiFont', 'codeFont', 'bodyFont'] as const) {
    const resource = settings[`${role}Resource` as 'uiFontResource'];
    const existing = faces.get(role);
    if (!resource) {
      pending.delete(role);
      if (existing && options.current()) { document.fonts.delete(existing.face); faces.delete(role); }
      continue;
    }
    const resourceKey = JSON.stringify(resource);
    if (existing?.key === resourceKey) continue;
    let loading = pending.get(role);
    if (loading?.key !== resourceKey) {
      const entry: PendingFont = { key: resourceKey, current: options.current, promise: Promise.resolve(bridge.loadPluginFont?.(role)).then(loaded => {
        // A reset, new resource or unmount cancels decoding of the superseded read.
        if (pending.get(role) !== entry || !entry.current() || !loaded || loaded.family !== resource.family) return undefined;
        return new FontFace(resource.family, loaded.bytes).load();
      }) };
      entry.promise = entry.promise.finally(() => { if (pending.get(role) === entry) pending.delete(role); });
      pending.set(role, entry); loading = entry;
    }
    loading.current = options.current;
    const face = await loading.promise;
    if (!options.current()) return 'saved';
    if (!face) return 'failed';
    const previous = faces.get(role);
    if (previous?.face !== face) {
      if (previous) document.fonts.delete(previous.face);
      document.fonts.add(face); faces.set(role, { key: resourceKey, face });
    }
  }
  if (!options.current()) return 'saved';
  options.applyFonts(settings);
  setCss(options.style, settings, options.dark());
  return wallpaperApplicationStatus(settings, options.dark);
}


let applyInWindow: ((settings: AppearanceSettings) => Promise<'applied' | 'saved' | 'failed'>) | undefined;
export async function applyPluginAppearanceInWindow(settings: AppearanceSettings) {
  return { status: applyInWindow ? await applyInWindow(settings) : 'saved' as const };
}

/** Uses the existing preference fan-out; default settings create no style, font request or observer. */
export function usePluginAppearance(applyFonts: (settings: AppearanceSettings) => void, initial?: AppearanceSettings): (settings: AppearanceSettings) => void {
  const passive = useRef<((settings: AppearanceSettings) => void) | undefined>(undefined);
  const initialRef = useRef(initial);
  useEffect(() => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge?.onChanged) return;
    const faces: Faces = new Map();
    const pending: PendingFonts = new Map();
    let appliedUiFace: FontFace | undefined, appliedCodeFace: FontFace | undefined;
    const applyLoadedFonts = (settings: AppearanceSettings) => {
      const uiFace = faces.get('uiFont')?.face, codeFace = faces.get('codeFont')?.face;
      if (uiFace === appliedUiFace && codeFace === appliedCodeFace) return;
      appliedUiFace = uiFace; appliedCodeFace = codeFace;
      applyFonts(settings);
    };
    let style: HTMLStyleElement | null = null, observer: MutationObserver | undefined;
    let latest: AppearanceSettings | undefined, generation = 0, live = true;
    let applying: { key: string; promise: Promise<'applied' | 'saved' | 'failed'> } | undefined;
    const dark = () => document.documentElement.classList.contains('dark');
    const clearStyle = () => { observer?.disconnect(); observer = undefined; style?.remove(); style = null; };
    const apply = (raw: AppearanceSettings): Promise<'applied' | 'saved' | 'failed'> => {
      const settings = normalizeAppearanceSettings(raw);
      const extended = hasExtendedAppearance(settings);
      if (!extended && !style && !faces.size) return Promise.resolve(wallpaperApplicationStatus(settings, dark));
      const key = JSON.stringify(settings);
      if (applying?.key === key) return applying.promise;
      const currentGeneration = ++generation; latest = settings;
      if (!style) { style = document.createElement('style'); style.dataset.cindyPluginAppearance = 'true'; document.head.append(style); }
      if (!observer) {
        observer = new MutationObserver(() => { if (style && latest) setCss(style, latest, dark()); });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      }
      const promise = applyPluginAppearance(settings, { bridge, style, faces, pending, dark, applyFonts: applyLoadedFonts,
        current: () => live && currentGeneration === generation }).then(status => {
          if (!extended && live && generation === currentGeneration) clearStyle();
          return status;
        }).catch(() => 'failed' as const);
      applying = { key, promise };
      return promise;
    };
    applyInWindow = apply;
    const applyPassive = (settings: AppearanceSettings) => {
      if (!hasExtendedAppearance(settings) && !style && !faces.size && !pending.size) return;
      void apply(settings);
    };
    passive.current = applyPassive;
    const snapshot = initialRef.current ?? bridge.getSync(); // Reuses the provider's cached snapshot.
    if (snapshot) applyPassive(snapshot);
    return () => {
      live = false; generation++; passive.current = undefined; clearStyle();
      if (applyInWindow === apply) applyInWindow = undefined;
      for (const { face } of faces.values()) document.fonts.delete(face);
      faces.clear(); pending.clear();
    };
  }, [applyFonts]);
  return useCallback(settings => passive.current?.(settings), []);
}
