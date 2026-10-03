import type { TFunction } from "i18next";
import type { SessionMenuAccountUsage } from "./readSessionMenuAccountUsage";
import {
  normalizeRemoteMoney,
  remoteMoneySymbol,
  type RemoteMoney,
} from "./remoteMoney";
import type { RemoteSession } from "./types";
import { quotaCountdown } from "./mobileModelRowPresentation";

/**
 * Time left until a quota resets, used as the window label like the desktop status
 * chip ("7 hours": one unit, rounded up). Null once the reset time has passed.
 * A known windowMinutes caps it so a just-reset weekly window never reads "8 days".
 */
export function formatQuotaResetCountdown(
  resetsAt: number,
  now: number,
  t: TFunction,
  windowMinutes?: number | null,
): string | null {
  return quotaCountdown(
    resetsAt,
    now,
    (unit) => t(`models.unified.timeUnit.${unit}`),
    windowMinutes,
  );
}

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
    // The countdown replaces the window name; without one (unknown or elapsed
    // reset) the row falls back to naming the window.
    const countdown =
      window.resetsAt === null
        ? null
        : formatQuotaResetCountdown(
            window.resetsAt,
            now,
            t,
            // xAI resetsAt may fall back to a non-weekly period end; only its label is weekly.
            account.source === "xai" ? null : window.minutes,
          );
    const label =
      countdown ??
      (window.minutes === 10080
        ? t("session.menu.usage.week")
        : window.minutes && window.minutes % 60 === 0
          ? t("session.menu.usage.hours", { count: window.minutes / 60 })
          : window.minutes
            ? t("session.menu.usage.minutes", { count: window.minutes })
            : t("session.menu.usage.quota"));
    const expired = window.resetsAt !== null && window.resetsAt * 1000 <= now;
    rows.push({
      label: window.modelLabel ? `${window.modelLabel} · ${label}` : label,
      value: expired
        ? t("session.menu.usage.awaitingRefresh")
        : t("session.menu.usage.remaining", {
            percent: Math.round(window.remainingPercent),
          }),
      warning: !expired && window.remainingPercent <= 10,
    });
  }
  const credits = account.credits;
  if (credits) {
    const parts = [
      credits.balance === null
        ? null
        : t("session.menu.usage.creditsRemaining", {
            credits: credits.balance.toLocaleString(locale, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          }),
      credits.status === null
        ? null
        : t(
            {
              unlimited: "session.menu.usage.creditsUnlimited",
              depleted: "session.menu.usage.creditsDepleted",
              available: "session.menu.usage.creditsAvailable",
            }[credits.status],
          ),
    ].filter((part): part is string => part !== null);
    rows.push({
      label: t("session.menu.usage.credits"),
      value: parts.join(" · "),
      warning: credits.status === "depleted",
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
