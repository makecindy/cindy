import { useCallback, useEffect, useRef } from 'react';
import { getWallpaperVisibility, normalizeAppearanceSettings, type AppearanceSettings } from '@/../shared/appearanceSettings';
import type { PluginAppearanceColor } from '@cindy/plugin-protocol/appearance';
import { themeService } from '../themes/theme-service';
import type { Theme } from '../themes/types';
import { SCALABLE_APPEARANCE_TOKENS } from '../styles/generated/token-mappings';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes';
import type { ThemeSelection } from '../../shared/appearanceDefinition';

let packageSelection: ThemeSelection | undefined;

function packageThemeSelection(theme: Theme): ThemeSelection | undefined {
  return theme.packageSha256 && theme.appearance ? {
    mode: theme.type,
    familyId: theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id,
  } : undefined;
}

/** Explicit package choices prepare before committing browser storage or palette. */
export function prepareThemeSelection(theme: Theme, commit: () => void, current: () => boolean = () => true): Promise<boolean> | undefined {
  const value = packageThemeSelection(theme);
  if (!value) {
    // Even choosing the current builtin cancels an in-flight package choice.
    if (packageSelection) {
      packageSelection = undefined;
      void window.electronAPI?.appearanceSettings?.selectTheme?.(null).catch(() => {
        if (!packageSelection) notifyThemeAppearanceFailure();
      });
    }
    return;
  }
  const requested = packageSelection = value;
  const bridge = window.electronAPI?.appearanceSettings;
  if (!bridge?.selectTheme) { notifyThemeAppearanceFailure(); return Promise.resolve(false); }
  return bridge.selectTheme(value).then(() => {
    if (packageSelection !== requested) return false;
    if (!current()) {
      // An expired Agent request never becomes the saved choice. Rebuild only
      // the Host defaults from the palette that is still selected.
      const active = themeService.getCurrentTheme();
      if (active) presentTheme(active, false);
      return false;
    }
    commit();
    return true;
  }).catch(() => {
    if (packageSelection === requested && current()) notifyThemeAppearanceFailure();
    return false;
  });
}

/** Preserve synchronous palette application; only packages prepare extra defaults. */
export function presentTheme(theme: Theme, notifyFailure = true, prepare = true): void {
  const previous = packageSelection;
  const value = packageThemeSelection(theme);
  themeService.applyTheme(theme);
  packageSelection = value;
  if (!prepare) return;
  if (!packageSelection && !previous) return;
  const bridge = window.electronAPI?.appearanceSettings;
  if (!bridge?.selectTheme) return;
  const requested = packageSelection;
  void bridge.selectTheme(value ?? null)
    .catch(() => {
      if (packageSelection !== requested) return;
      if (notifyFailure) notifyThemeAppearanceFailure();
      else window.electronAPI?.logToMain?.('warn', 'renderer/appearance', 'Theme package restore failed; saved selection retained');
    });
}

/** Errors use the existing toast; translation/notice modules stay off the default path. */
export function notifyThemeAppearanceFailure(font = false): void {
  void Promise.all([import('../lib/toast'), import('../i18n')]).then(([{ toast }, { default: i18n }]) => {
    toast.error(i18n.t(font ? 'settings.appearance.themeFontFailed' : 'settings.appearance.themeApplyFailed'));
  }).catch(() => {});
}

type Bridge = typeof window.electronAPI.appearanceSettings;
type Faces = Map<string, { key: string; face: FontFace }>;
type PendingFont = { key: string; promise: Promise<FontFace | undefined>; current(): boolean };
type PendingFonts = Map<string, PendingFont>;
const region = '[data-plugin-appearance-region]';
const colorVariables: Record<PluginAppearanceColor, string[]> = {
  text: ['--text-primary', '--msg-assistant-text'],
  secondaryText: ['--text-secondary', '--text-secondary-mid'],
  surface: ['--surface-elevated', '--msg-code-block-bg'], border: ['--border-default', '--msg-user-border', '--msg-code-block-border'],
  userBubble: ['--msg-user-bg'], userText: ['--msg-user-text'], assistantBubble: [],
};

// Consume the generated values, not OS-reduced computed durations or already
// scaled document values. Restoring motion/density must never compound scales.
function css(settings: AppearanceSettings, dark: boolean): string {
  const declarations: string[] = [], rules: string[] = [];
  const spacing: string[] = [], motion: string[] = [];
  if (settings.density !== 1 || settings.motion !== 1) {
    for (const [key, { value, unit }] of Object.entries(SCALABLE_APPEARANCE_TOKENS)) {
      if (key.startsWith('--space-') && settings.density !== 1) spacing.push(`${key}:${value * settings.density}${unit}`);
      if (key.startsWith('--motion-') && settings.motion !== 1) motion.push(`${key}:${value * settings.motion}${unit}`);
    }
  }
  if (spacing.length) rules.push(`:root{${spacing.join(';')}}`);
  if (motion.length) rules.push(`@media (prefers-reduced-motion:no-preference){:root{${motion.join(';')}}}`);
  if (settings.motion === 0) rules.push(':root[data-cindy-reduced-motion="true"] :is(*,*::before,*::after){animation-duration:0ms!important;animation-iteration-count:1!important;transition-duration:0ms!important;scroll-behavior:auto!important}');
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
export async function applyAppearance(settings: AppearanceSettings, options: {
  bridge: Bridge; style: HTMLStyleElement; faces: Faces; pending: PendingFonts; dark(): boolean; current(): boolean; applyFonts(settings: AppearanceSettings): void;
}): Promise<'applied' | 'saved' | 'failed'> {
  const { faces, pending, bridge } = options;
  if (!options.current()) return 'saved';
  let fontFailed = false;
  for (const role of ['uiFont', 'codeFont', 'bodyFont', 'terminalFont'] as const) {
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
      const entry: PendingFont = { key: resourceKey, current: options.current, promise: Promise.resolve(bridge.loadPluginFont?.(role)).then(async loaded => {
        // A reset, new resource or unmount cancels decoding of the superseded read.
        if (pending.get(role) !== entry || !entry.current() || !loaded || loaded.family !== resource.family) return undefined;
        try { return await new FontFace(resource.family, loaded.bytes).load(); }
        catch (error) {
          if (entry.current() && 'themeId' in resource.source) {
            const previous = faces.get(role);
            if (previous) { document.fonts.delete(previous.face); faces.delete(role); }
            notifyThemeAppearanceFailure(true);
            return undefined;
          }
          throw error;
        }
      }) };
      entry.promise = entry.promise.finally(() => { if (pending.get(role) === entry) pending.delete(role); });
      pending.set(role, entry); loading = entry;
    }
    loading.current = options.current;
    let face: FontFace | undefined;
    try { face = await loading.promise; }
    catch (error) {
      if (!options.current()) return 'saved';
      if (!('themeId' in resource.source)) throw error;
      // A resource read failure retains the current appearance. Decoder failures
      // are handled per role above, so the remaining theme can still apply.
      return 'failed';
    }
    if (!options.current()) return 'saved';
    if (!face) { fontFailed = true; continue; }
    const previous = faces.get(role);
    if (previous?.face !== face) {
      if (previous) document.fonts.delete(previous.face);
      document.fonts.add(face); faces.set(role, { key: resourceKey, face });
    }
  }
  if (!options.current()) return 'saved';
  options.applyFonts(settings);
  const nextCss = css(settings, options.dark());
  if (options.style.textContent !== nextCss) options.style.textContent = nextCss;
  return fontFailed ? 'failed' : wallpaperApplicationStatus(settings, options.dark);
}


let applyInWindow: ((settings: AppearanceSettings) => Promise<'applied' | 'saved' | 'failed'>) | undefined;
export async function applyAppearanceInWindow(settings: AppearanceSettings) {
  const latest = window.electronAPI?.appearanceSettings?.getSync?.();
  if (latest && JSON.stringify(normalizeAppearanceSettings(latest)) !== JSON.stringify(normalizeAppearanceSettings(settings))) return { status: 'saved' as const };
  return { status: applyInWindow ? await applyInWindow(settings) : 'saved' as const };
}

/** Forward an existing settings subscription without installing a second one. */
export function presentAppearance(settings: AppearanceSettings): void {
  void applyInWindow?.(settings);
}

let disposePresenter: (() => void) | undefined;
let presenterUsers = 0;
let fontInWindow: { ready(role: string, family: string): boolean; wait(role: string, family: string): Promise<boolean> } | undefined;
export function isAppearanceFontReady(role: string, family: string): boolean {
  return fontInWindow?.ready(role, family) ?? false;
}
export async function waitForAppearanceFont(role: string, family: string): Promise<boolean> {
  return fontInWindow?.wait(role, family) ?? false;
}
function releasePresenter(): () => void {
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    if (--presenterUsers === 0) { const dispose = disposePresenter; disposePresenter = undefined; dispose?.(); }
  };
}

/** One runtime per document, shared by startup, React views and fixed-capability receipts. */
export function installAppearancePresenter(applyFonts: (settings: AppearanceSettings) => void, follow = true, initial?: AppearanceSettings): () => void {
  if (disposePresenter) { presenterUsers++; return releasePresenter(); }
  const bridge = window.electronAPI?.appearanceSettings;
  if (!bridge?.onChanged) return () => {};
  presenterUsers = 1;
  const faces: Faces = new Map();
  const pending: PendingFonts = new Map();
  let style: HTMLStyleElement | null = null, observer: MutationObserver | undefined;
  let latest: AppearanceSettings | undefined, generation = 0, live = true;
  let applying: { key: string; promise: Promise<'applied' | 'saved' | 'failed'> } | undefined;
  const loadedFonts = {
    ready: (role: string, family: string) => live && faces.get(role)?.face.family === family,
    async wait(role: string, family: string) {
      let observed: typeof applying;
      do { observed = applying; await observed?.promise; } while (live && observed !== applying);
      return loadedFonts.ready(role, family);
    },
  };
  fontInWindow = loadedFonts;
  const fontKey = (settings: AppearanceSettings) => JSON.stringify([settings.uiFamily, settings.codeFamily, settings.uiSize, settings.codeSize]);
  let lastFonts = fontKey(normalizeAppearanceSettings({}));
  let appliedUiFace: FontFace | undefined, appliedCodeFace: FontFace | undefined;
  const applyBaseFonts = (settings: AppearanceSettings) => {
    const key = fontKey(settings);
    const uiFace = faces.get('uiFont')?.face, codeFace = faces.get('codeFont')?.face;
    if (key === lastFonts && uiFace === appliedUiFace && codeFace === appliedCodeFace) return;
    lastFonts = key; appliedUiFace = uiFace; appliedCodeFace = codeFace;
    applyFonts(settings);
  };
  const dark = () => document.documentElement.classList.contains('dark');
  let appliedDark = dark();
  const clearStyle = () => { observer?.disconnect(); observer = undefined; style?.remove(); style = null; };
  const apply = (raw: AppearanceSettings): Promise<'applied' | 'saved' | 'failed'> => {
    const settings = normalizeAppearanceSettings(raw);
    if (settings.motion === 0) document.documentElement.dataset.cindyReducedMotion = 'true';
    else delete document.documentElement.dataset.cindyReducedMotion;
    const extended = settings.bodyFont || settings.reading || settings.contentStyle || settings.themeColors ||
      settings.uiFontTraits || settings.codeFontTraits || settings.uiFontResource || settings.codeFontResource || settings.bodyFontResource || settings.terminalFontResource || settings.density !== 1 || settings.motion !== 1;
    if (!extended && !style && !faces.size) { applyBaseFonts(settings); return Promise.resolve(wallpaperApplicationStatus(settings, dark)); }
    const key = JSON.stringify(settings);
    if (applying?.key === key) return applying.promise;
    const currentGeneration = ++generation; latest = settings;
    appliedDark = dark();
    if (!style) { style = document.createElement('style'); style.dataset.cindyAppearance = 'true'; document.head.append(style); }
    if (!observer) {
      observer = new MutationObserver(() => {
        const nextDark = dark();
        if (style && latest && nextDark !== appliedDark) {
          appliedDark = nextDark;
          style.textContent = css(latest, nextDark);
        }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
    const promise = applyAppearance(settings, { bridge, style, faces, pending, dark, applyFonts: applyBaseFonts,
      current: () => live && currentGeneration === generation }).then(status => {
        if (!extended && live && generation === currentGeneration) clearStyle();
        return status;
      }).catch(() => 'failed' as const);
    applying = { key, promise };
    return promise;
  };
  applyInWindow = apply;
  const snapshot = initial ?? bridge.getSync(); // Cached preload snapshot, no IPC.
  if (snapshot) void apply(snapshot);
  // Main views reuse FontSettingsProvider's existing fan-out; utility windows
  // have no provider and follow the same presenter directly.
  const stop = follow ? bridge.onChanged(next => { void apply(next); }) : () => {};
  disposePresenter = () => {
    live = false; generation++; stop(); clearStyle();
    if (applyInWindow === apply) applyInWindow = undefined;
    if (fontInWindow === loadedFonts) fontInWindow = undefined;
    for (const { face } of faces.values()) document.fonts.delete(face);
    faces.clear(); pending.clear();
    delete document.documentElement.dataset.cindyReducedMotion;
  };
  return releasePresenter();
}

export function useAppearancePresenter(applyFonts: (settings: AppearanceSettings) => void, initial?: AppearanceSettings): (settings: AppearanceSettings) => void {
  const initialRef = useRef(initial);
  useEffect(() => installAppearancePresenter(applyFonts, false, initialRef.current), [applyFonts]);
  return useCallback(presentAppearance, []);
}
