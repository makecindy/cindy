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
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
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
    if (
      !text(row.label, 256) ||
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
    items.push({
      label: row.label,
      price: row.price,
      unit: row.unit,
      quantity: row.quantity,
      ...(row.tier !== undefined ? { tier: row.tier } : {}),
      ...(row.priceType !== undefined ? { priceType: row.priceType } : {}),
    });
  }
  return {
    items,
    ...(raw.notes !== undefined ? { notes: [...(raw.notes as string[])] } : {}),
  };
}
