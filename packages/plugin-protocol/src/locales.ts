/** Locale resources are optional; existing packages keep their English fallback. */
export const GHOST_LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt-PT', 'pt-BR'] as const;
export type GhostLocale = (typeof GHOST_LOCALES)[number];
