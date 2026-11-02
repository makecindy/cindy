/** Non-secret, append-only billing facts shared by desktop and mobile. */
export interface UsageCostMoney {
  amount: number;
  currency: "USD" | "CNY";
  approximate: boolean;
  kind: "actual-cost" | "value-estimate";
}

export interface UsageBillingSource {
  providerId?: string;
  providerName?: string;
  billingSource?: "subscription" | "cindy-ai" | "provider" | "unknown";
}

export interface UsageCostRow extends UsageBillingSource {
  model: string;
  category: "conversation" | "additional";
  money: UsageCostMoney;
}

/** The legacy round total includes additional spend; remove it before displaying A + B. */
export function splitUsageCost(
  total: UsageCostMoney,
  additionalValue: unknown,
) {
  const additional = Array.isArray(additionalValue)
    ? additionalValue
        .map(normalizeUsageCostMoney)
        .filter((money): money is UsageCostMoney => !!money)
    : [];
  const included = additional
    .filter((money) => money.currency === total.currency)
    .reduce((sum, money) => sum + money.amount, 0);
  return {
    conversation: { ...total, amount: Math.max(0, total.amount - included) },
    additional,
  };
}

export function normalizeUsageBillingSource(
  value: unknown,
): UsageBillingSource {
  const raw = record(value);
  return {
    ...(typeof raw.providerId === "string"
      ? { providerId: raw.providerId }
      : {}),
    ...(typeof raw.providerName === "string"
      ? { providerName: raw.providerName }
      : {}),
    ...(["subscription", "cindy-ai", "provider", "unknown"].includes(
      String(raw.billingSource),
    )
      ? {
          billingSource:
            raw.billingSource as UsageBillingSource["billingSource"],
        }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeUsageCostMoney(value: unknown): UsageCostMoney | null {
  const raw = record(value);
  if (
    typeof raw.amount !== "number" ||
    !Number.isFinite(raw.amount) ||
    raw.amount < 0 ||
    (raw.currency !== "USD" && raw.currency !== "CNY") ||
    (raw.kind !== "actual-cost" && raw.kind !== "value-estimate")
  )
    return null;
  return {
    amount: raw.amount,
    currency: raw.currency,
    kind: raw.kind,
    approximate: raw.approximate === true || raw.kind === "value-estimate",
  };
}

export function normalizeUsageCostRows(value: unknown): UsageCostRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = record(item),
      money = normalizeUsageCostMoney(raw.money);
    if (
      !money ||
      typeof raw.model !== "string" ||
      (raw.category !== "conversation" && raw.category !== "additional")
    )
      return [];
    return [
      {
        ...normalizeUsageBillingSource(raw),
        model: raw.model,
        category: raw.category,
        money,
      },
    ];
  });
}

/** Keep currencies, channels and estimates separate, even for the same model. */
export function groupUsageCostRows(
  rows: readonly UsageCostRow[],
): UsageCostRow[] {
  const groups = new Map<string, UsageCostRow>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.category,
      row.model,
      row.providerId,
      row.providerName,
      row.billingSource,
      row.money.currency,
      row.money.kind,
      row.money.approximate,
    ]);
    const current = groups.get(key);
    if (current) current.money.amount += row.money.amount;
    else groups.set(key, { ...row, money: { ...row.money } });
  }
  return [...groups.values()];
}

export function usageCostTotals(
  rows: readonly UsageCostRow[],
): UsageCostMoney[] {
  const totals = new Map<string, UsageCostMoney>();
  for (const { money } of rows) {
    const prior = totals.get(money.currency);
    totals.set(
      money.currency,
      prior
        ? {
            ...money,
            amount: prior.amount + money.amount,
            approximate: prior.approximate || money.approximate,
            kind:
              prior.kind === "value-estimate" || money.kind === "value-estimate"
                ? "value-estimate"
                : "actual-cost",
          }
        : { ...money },
    );
  }
  return [...totals.values()];
}

/** Subscription value may accompany actual spend. Add it only to display totals. */
export function supplementalConversationEstimates(
  metaValue: unknown,
): UsageCostMoney[] {
  const meta = record(metaValue);
  if (
    meta.turnCostIsEstimate === true ||
    normalizeUsageCostMoney(meta.turnCost)?.kind === "value-estimate"
  )
    return [];
  const usage = record(meta.turnUsageDetails);
  return usageCostTotals(
    normalizeUsageCostRows(
      Array.isArray(usage.perModelCost)
        ? usage.perModelCost.map((item) => ({
            ...record(item),
            category: "conversation",
          }))
        : [],
    ).filter((row) => row.money.kind === "value-estimate"),
  );
}

/** Reconstruct only recorded facts. Never infer a historical channel from today's selection. */
export function messageUsageCostRows(
  metaValue: unknown,
  role: string,
): UsageCostRow[] {
  const meta = record(metaValue);
  if (role === "user") {
    const details = normalizeUsageCostRows(meta.mediaCostDetails);
    const totals = Array.isArray(meta.mediaCosts) ? meta.mediaCosts : [];
    // Old totals can predate model-level recording. Preserve that remainder explicitly.
    for (const raw of totals) {
      const money = normalizeUsageCostMoney(raw);
      if (!money) continue;
      const known = details
        .filter((row) => row.money.currency === money.currency)
        .reduce((sum, row) => sum + row.money.amount, 0);
      if (money.amount - known > 1e-9)
        details.push({
          model: "",
          category: "additional",
          billingSource: "cindy-ai",
          money: { ...money, amount: money.amount - known },
        });
    }
    return details;
  }
  if (role !== "assistant") return [];
  const usage = record(meta.turnUsageDetails);
  const source = normalizeUsageBillingSource(usage);
  const perModel = Array.isArray(usage.perModelCost) ? usage.perModelCost : [];
  const rows: UsageCostRow[] = perModel.flatMap((value) => {
    const item = record(value);
    const money = normalizeUsageCostMoney(item.money) ?? normalizeUsageCostMoney({
      amount: item.costUsd,
      currency: "USD",
      approximate: meta.turnCostIsEstimate === true,
      kind: meta.turnCostIsEstimate === true ? "value-estimate" : "actual-cost",
    });
    return money && typeof item.model === "string"
      ? [
          {
            ...(item.billingSource &&
            item.billingSource !== source.billingSource
              ? {}
              : source),
            ...normalizeUsageBillingSource(item),
            model: item.model,
            category: "conversation" as const,
            money,
          },
        ]
      : [];
  });
  const rawMoney =
    normalizeUsageCostMoney(meta.turnCost) ??
    (typeof meta.turnCostUsd === "number" &&
    Number.isFinite(meta.turnCostUsd) &&
    meta.turnCostUsd > 0
      ? {
          amount: meta.turnCostUsd,
          currency: "USD" as const,
          approximate: false,
          kind: "actual-cost" as const,
        }
      : null);
  const money =
    rawMoney && meta.turnCostIsEstimate === true
      ? { ...rawMoney, approximate: true, kind: "value-estimate" as const }
      : rawMoney;
  if (money) {
    const known = rows
      .filter(
        (row) =>
          row.money.currency === money.currency &&
          row.money.kind === money.kind,
      )
      .reduce((sum, row) => sum + row.money.amount, 0);
    if (money.amount - known > 1e-9)
      rows.push({
        ...source,
        model: rows.length
          ? ""
          : typeof usage.model === "string"
            ? usage.model
            : "",
        category: "conversation",
        money: { ...money, amount: money.amount - known },
      });
  }
  return rows;
}
