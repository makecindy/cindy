/** Internal runtime snapshot, shared by Bot prompts and MCP descriptions. */
export const PROMPT_LOCALE_KEY = 'cindyPromptLocale';

export function readPromptLocale(vendorOptions?: Record<string, unknown>): string | undefined {
  const locale = vendorOptions?.[PROMPT_LOCALE_KEY];
  return typeof locale === 'string' ? locale : undefined;
}

/** Call only at instance creation, never in a tool handler or a turn refresh. */
export function capturePromptLocale(
  opts: { vendorOptions?: Record<string, unknown> },
  locale: string,
): void {
  opts.vendorOptions = {
    ...opts.vendorOptions,
    [PROMPT_LOCALE_KEY]: /^zh(?:[-_]|$)/i.test(locale) ? 'zh-CN' : 'en',
  };
}
