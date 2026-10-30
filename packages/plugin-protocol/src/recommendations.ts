/** Optional author content, never a capability grant or a model system instruction. */
export interface GhostRecommendation {
  id: string;
  label: string;
  prompt: string;
  locales?: Partial<
    Record<
      "en" | "zh-CN" | "zh-TW" | "ja" | "ko",
      { label: string; prompt: string }
    >
  >;
}

export function validateGhostRecommendations(
  value: unknown,
): { ok: true; items: GhostRecommendation[] } | { ok: false; reason: string } {
  const fail = {
    ok: false as const,
    reason:
      "recommendations must contain at most 24 unique tasks (id, label, prompt, optional locales), within 64 KiB",
  };
  if (!Array.isArray(value) || value.length > 24) return fail;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
      return fail;
  } catch {
    return fail;
  }
  const ids = new Set<string>();
  const text = (x: unknown, max: number): x is string =>
    typeof x === "string" && x.trim().length > 0 && x.length <= max;
  const object = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === "object" && !Array.isArray(x);
  const items: GhostRecommendation[] = [];
  for (const raw of value) {
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (k) => !["id", "label", "prompt", "locales"].includes(k),
      ) ||
      typeof raw.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id) ||
      ids.has(raw.id) ||
      !text(raw.label, 120) ||
      !text(raw.prompt, 8000)
    )
      return fail;
    ids.add(raw.id);
    const locales: GhostRecommendation["locales"] = {};
    if (raw.locales !== undefined) {
      if (!object(raw.locales)) return fail;
      for (const [locale, entry] of Object.entries(raw.locales)) {
        if (
          !["en", "zh-CN", "zh-TW", "ja", "ko"].includes(locale) ||
          !object(entry) ||
          Object.keys(entry).some((k) => k !== "label" && k !== "prompt") ||
          !text(entry.label, 120) ||
          !text(entry.prompt, 8000)
        )
          return fail;
        locales[locale as keyof typeof locales] = {
          label: entry.label,
          prompt: entry.prompt,
        };
      }
    }
    items.push({
      id: raw.id,
      label: raw.label,
      prompt: raw.prompt,
      ...(raw.locales === undefined ? {} : { locales }),
    });
  }
  return { ok: true, items };
}

export function localizeGhostRecommendation(
  item: GhostRecommendation,
  locale: string,
): GhostRecommendation {
  const translated =
    item.locales?.[
      locale as keyof NonNullable<GhostRecommendation["locales"]>
    ] ?? item.locales?.en;
  return {
    id: item.id,
    label: translated?.label ?? item.label,
    prompt: translated?.prompt ?? item.prompt,
  };
}
