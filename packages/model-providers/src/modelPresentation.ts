/** Reviewed product copy, independent of vendor prose and model capabilities. */
export const MODEL_PRESENTATION_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
] as const;
export type ModelPresentation = Partial<
  Record<
    (typeof MODEL_PRESENTATION_LOCALES)[number],
    { name?: string; description?: string }
  >
>;
export function validModelPresentation(
  value: unknown,
): value is ModelPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([locale, copy]) =>
      (MODEL_PRESENTATION_LOCALES as readonly string[]).includes(locale) &&
      copy &&
      typeof copy === "object" &&
      !Array.isArray(copy) &&
      Object.entries(copy).every(
        ([field, text]) =>
          (field === "name" || field === "description") &&
          typeof text === "string" &&
          text.trim().length > 0 &&
          text.length <= (field === "name" ? 256 : 2000),
      ),
  );
}
export function mergeModelPresentation(
  ...layers: (ModelPresentation | undefined)[]
): ModelPresentation | undefined {
  const result: ModelPresentation = {};
  for (const layer of layers)
    for (const locale of MODEL_PRESENTATION_LOCALES)
      if (layer?.[locale])
        result[locale] = { ...result[locale], ...layer[locale] };
  return Object.keys(result).length ? result : undefined;
}
export function localizedModelPresentation(
  value: ModelPresentation | undefined,
  language: string,
) {
  const normalized = language.toLowerCase();
  const locale = normalized.startsWith("zh")
    ? /tw|hk|hant/.test(normalized)
      ? "zh-TW"
      : "zh-CN"
    : normalized.split("-")[0];
  const selected = value?.[locale as keyof ModelPresentation];
  return selected || value?.en ? { ...value?.en, ...selected } : undefined;
}
