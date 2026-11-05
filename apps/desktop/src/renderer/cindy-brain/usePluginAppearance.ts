import { useEffect, useRef } from 'react';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { getWallpaperVisibility, normalizeAppearanceSettings, type AppearanceSettings } from '@/../shared/appearanceSettings';
import type { PluginAppearanceColor } from '@cindy/maker-shared/plugin-ui';

type Bridge = typeof window.electronAPI.appearanceSettings;
type Faces = Map<string, { key: string; face: FontFace }>;
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

/** Only font bytes and the closed appearance model reach this consumer. */
export async function applyPluginAppearance(settings: AppearanceSettings, options: {
  bridge: Bridge; style: HTMLStyleElement; faces: Faces; dark(): boolean; current(): boolean; applyFonts(settings: AppearanceSettings): void;
}): Promise<'applied' | 'saved' | 'failed'> {
  const { faces, bridge } = options;
  for (const role of ['uiFont', 'codeFont', 'bodyFont'] as const) {
    const resource = settings[`${role}Resource` as 'uiFontResource'];
    const existing = faces.get(role);
    if (!resource) {
      if (existing && options.current()) { document.fonts.delete(existing.face); faces.delete(role); }
      continue;
    }
    // The Host rechecks the current instance even when a decoded face is cached.
    const loaded = await bridge.loadPluginFont?.(role);
    if (!options.current()) return 'saved';
    if (!loaded || loaded.family !== resource.family) return 'failed';
    if (existing?.key === resource.hash) continue;
    const bytes = Uint8Array.from(atob(loaded.base64), char => char.charCodeAt(0));
    const face = await new FontFace(resource.family, bytes).load();
    if (!options.current()) return 'saved';
    if (existing) document.fonts.delete(existing.face);
    document.fonts.add(face); faces.set(role, { key: resource.hash, face });
  }
  if (!options.current()) return 'saved';
  options.applyFonts(settings);
  options.style.textContent = css(settings, options.dark());
  if (settings.wallpaperId === 'none' && document.documentElement.dataset.wallpaperActive === 'true') return 'saved';
  if (settings.wallpaperId === 'custom') {
    const url = settings.customWallpaperUrl;
    if (!url) return 'saved';
    if (url.endsWith('.mp4')) {
      const player = [...document.querySelectorAll('video')].find(video => video.src === url || video.currentSrc === url);
      if (!player || player.readyState < 2 || player.error) return player?.error ? 'failed' : 'saved';
    } else if (!document.documentElement.style.getPropertyValue('--app-wallpaper-image').includes(url)) return 'saved';
    const veil = `${100 - getWallpaperVisibility(settings, options.dark()) * 100}%`;
    if (document.documentElement.style.getPropertyValue('--app-wallpaper-veil') !== veil) return 'saved';
  }
  return 'applied';
}

/** Ephemeral resource lifetime and application acknowledgement; values remain in Main. */
export function usePluginAppearance(applyFonts: (settings: AppearanceSettings) => void): void {
  const dark = useIsDarkMode(), darkRef = useRef(dark); darkRef.current = dark;
  const styleRef = useRef<HTMLStyleElement | null>(null), latest = useRef<AppearanceSettings | null>(null);
  useEffect(() => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge?.onPluginApply) return;
    const style = document.createElement('style'); style.dataset.cindyPluginAppearance = 'true';
    document.head.appendChild(style); styleRef.current = style;
    const faces: Faces = new Map(); let generation = 0, live = true;
    let applying: { key: string; promise: Promise<'applied' | 'saved' | 'failed'> } | null = null;
    const apply = (raw: AppearanceSettings) => {
      const settings = normalizeAppearanceSettings(raw), key = JSON.stringify(settings);
      if (applying?.key === key) return applying.promise;
      const currentGeneration = ++generation; latest.current = settings;
      const promise = applyPluginAppearance(settings, { bridge, style, faces, dark: () => darkRef.current, applyFonts,
        current: () => live && generation === currentGeneration }).catch(() => 'failed' as const);
      applying = { key, promise }; return promise;
    };
    void apply(bridge.getSync() ?? normalizeAppearanceSettings(null));
    const unsubscribe = bridge.onChanged(next => { void apply(next); });
    const stopRequests = bridge.onPluginApply?.(request => {
      void apply(request.settings).then(status => {
        if (live) void bridge.pluginApplied?.(request.requestId, status).catch(() => {});
      });
    });
    return () => { live = false; generation++; unsubscribe(); stopRequests?.(); style.remove(); styleRef.current = null;
      for (const { face } of faces.values()) document.fonts.delete(face); faces.clear(); };
  }, [applyFonts]);
  useEffect(() => { if (styleRef.current && latest.current) styleRef.current.textContent = css(latest.current, dark); }, [dark]);
}
