import type { TFunction } from "i18next";
import type { SessionMenuAccountUsage } from "./readSessionMenuAccountUsage";
import {
  normalizeRemoteMoney,
  remoteMoneySymbol,
  type RemoteMoney,
} from "./remoteMoney";
import type { RemoteSession } from "./types";

export function formatSessionUsageMoney(money: RemoteMoney): string {
  const symbol = remoteMoneySymbol(money.currency);
  const amount =
    money.amount > 0 && money.amount < 0.01
      ? `<${symbol}0.01`
      : `${symbol}${money.amount.toFixed(2)}`;
  return `${money.approximate || money.kind === "value-estimate" ? "≈ " : ""}${amount}`;
}

export function sessionUsageAmounts(
  session: Pick<RemoteSession, "totalMoney" | "totalCostUsd">,
  estimate: RemoteMoney | null,
) {
  const actual =
    normalizeRemoteMoney(session.totalMoney) ??
    (typeof session.totalCostUsd === "number" &&
    Number.isFinite(session.totalCostUsd) &&
    session.totalCostUsd >= 0
      ? {
          amount: session.totalCostUsd,
          currency: "USD" as const,
          approximate: false,
          kind: "actual-cost" as const,
        }
      : null);
  // Do not combine incompatible currencies or relabel a value estimate as a bill.
  const values = [actual, estimate].filter(
    (value): value is RemoteMoney => value !== null && value.amount > 0,
  );
  const total =
    values.length === 0
      ? null
      : values.every((value) => value.currency === values[0].currency)
        ? {
            ...values[0],
            amount: values.reduce((sum, value) => sum + value.amount, 0),
            approximate: values.some(
              (value) => value.approximate || value.kind === "value-estimate",
            ),
            kind: values.some((value) => value.kind === "value-estimate")
              ? ("value-estimate" as const)
              : ("actual-cost" as const),
          }
        : null;
  return { actual, estimate, total, mixed: values.length > 1 };
}

export interface AccountUsageRow {
  label: string;
  value: string;
  detail?: string;
  warning?: boolean;
}

export function accountUsageRows(
  account: SessionMenuAccountUsage | null,
  t: TFunction,
  locale: string,
  now = Date.now(),
): AccountUsageRow[] {
  if (!account) return [];
  const rows: AccountUsageRow[] = [];
  for (const window of account.windows) {
    const label =
      window.minutes === 10080
        ? t("session.menu.usage.week")
        : window.minutes && window.minutes % 60 === 0
          ? t("session.menu.usage.hours", { count: window.minutes / 60 })
          : window.minutes
            ? t("session.menu.usage.minutes", { count: window.minutes })
            : t("session.menu.usage.quota");
    const expired = window.resetsAt !== null && window.resetsAt * 1000 <= now;
    rows.push({
      label: window.modelLabel ? `${window.modelLabel} · ${label}` : label,
      value: expired
        ? t("session.menu.usage.awaitingRefresh")
        : t("session.menu.usage.remaining", {
            percent: Math.round(window.remainingPercent),
          }),
      warning: !expired && window.remainingPercent <= 10,
      ...(window.resetsAt !== null
        ? {
            detail: t("session.menu.usage.resets", {
              time: new Date(window.resetsAt * 1000).toLocaleString(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
            }),
          }
        : {}),
    });
  }
  for (const amount of account.amounts) {
    const money: RemoteMoney = {
      amount: amount.amount,
      currency: amount.currency,
      approximate: false,
      kind: "actual-cost",
    };
    rows.push({
      label: t(`session.menu.usage.${amount.id}`),
      value: `${formatSessionUsageMoney(money)}${amount.limit === undefined ? "" : ` / ${formatSessionUsageMoney({ ...money, amount: amount.limit })}`}`,
      warning:
        amount.id === "balance"
          ? amount.amount <= 0
          : amount.limit !== undefined && amount.amount >= amount.limit,
    });
  }
  return rows;
}
