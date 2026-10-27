/** Undiscounted presentation quote; its unit never participates in token cost estimates. */
export interface SummaryQuote {
  price: number;
  maxPrice?: number;
  unit: string;
  quantity: number;
  tier?: string;
  priceType?: "exact" | "estimated";
}

export type ModelDisplayPricingSummary = Partial<
  Record<"input" | "output" | "cacheRead" | "cacheWrite", SummaryQuote[]>
>;

/** Provider presentation only; never used to calculate usage or authorize a model. */
export interface ModelDisplayPricing {
  items: Array<{
    label: string;
    tier?: string;
    price: number;
    unit: string;
    quantity: number;
    priceType?: "exact" | "estimated" | "starting_at";
  }>;
  notes?: string[];
  summary?: ModelDisplayPricingSummary;
}

/** The whole table is atomic: never silently drop a charge or billing condition. */
export function parseModelDisplayPricing(
  value: unknown,
): ModelDisplayPricing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.items) ||
    raw.items.length === 0 ||
    raw.items.length > 128
  )
    return undefined;
  if (
    raw.notes !== undefined &&
    (!Array.isArray(raw.notes) ||
      raw.notes.length > 32 ||
      raw.notes.some((note) => !text(note, 2048)))
  )
    return undefined;
  const items: ModelDisplayPricing["items"] = [];
  for (const item of raw.items) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return undefined;
    const row = item as Record<string, unknown>;
    if (!text(row.label, 256)) return undefined;
    const quote = parseQuote(row);
    if (!quote) return undefined;
    items.push({ label: row.label, ...quote });
  }
  const summary = parseSummary(raw.summary);
  return {
    items,
    ...(summary ? { summary } : {}),
    ...(raw.notes !== undefined ? { notes: [...(raw.notes as string[])] } : {}),
  };
}

/** Invalid optional summaries never discard the independent detailed price table. */
function parseSummary(value: unknown): ModelDisplayPricingSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const summary: ModelDisplayPricingSummary = {};
  for (const role of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const quotes = raw[role];
    if (quotes === undefined) continue;
    if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 4)
      return undefined;
    const result: SummaryQuote[] = [];
    for (const quote of quotes) {
      if (!quote || typeof quote !== "object" || Array.isArray(quote))
        return undefined;
      // Reuse item validation, then restrict summary qualifiers to exact or estimated.
      const item = parseQuote(quote as Record<string, unknown>);
      if (!item) return undefined;
      const { priceType, ...fields } = item;
      if (priceType === "starting_at") return undefined;
      const maxPrice: unknown = quote.maxPrice;
      if (
        maxPrice !== undefined &&
        (typeof maxPrice !== "number" ||
          !Number.isFinite(maxPrice) ||
          maxPrice <= item.price)
      ) {
        return undefined;
      }
      if (
        result.some(
          (previous) =>
            previous.unit === item.unit &&
            previous.quantity === item.quantity &&
            previous.tier === item.tier,
        )
      ) {
        return undefined;
      }
      result.push({
        ...fields,
        ...(priceType !== undefined ? { priceType } : {}),
        ...(maxPrice !== undefined ? { maxPrice } : {}),
      });
    }
    summary[role] = result;
  }
  return Object.keys(summary).length ? summary : undefined;
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

/** Shared quote fields; summaries additionally reject the item-only starting_at qualifier. */
function parseQuote(
  row: Record<string, unknown>,
): Omit<ModelDisplayPricing["items"][number], "label"> | undefined {
  if (
    !text(row.unit, 128) ||
    (row.tier !== undefined && !text(row.tier, 256)) ||
    typeof row.price !== "number" ||
    !Number.isFinite(row.price) ||
    row.price < 0 ||
    typeof row.quantity !== "number" ||
    !Number.isFinite(row.quantity) ||
    row.quantity <= 0 ||
    (row.priceType !== undefined &&
      row.priceType !== "exact" &&
      row.priceType !== "estimated" &&
      row.priceType !== "starting_at")
  )
    return undefined;
  return {
    price: row.price,
    unit: row.unit,
    quantity: row.quantity,
    ...(row.tier !== undefined ? { tier: row.tier } : {}),
    ...(row.priceType !== undefined ? { priceType: row.priceType } : {}),
  };
}
