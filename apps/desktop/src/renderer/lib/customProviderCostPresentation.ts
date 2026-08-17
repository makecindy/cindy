import type { ProviderView } from '@cindy/model-providers';

import type { ChatMessage } from '@/lib/makerChatStore';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  usdMoney,
  type RegionalMoney,
  type SdkCostPresentation,
} from '../../shared/regionalMoney';
import { normalizeTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails';
import {
  isCustomProviderForBilling,
  projectSdkCostMoney,
  projectSdkCostMoneyWithBreakdown,
  resolveTurnSdkCostPresentation,
} from '../../shared/customProviderBilling';

export type CustomProviderCostPresentation = SdkCostPresentation;

export function resolveCustomProviderCostPresentation(
  providerId: string | null | undefined,
  providers: readonly Pick<ProviderView, 'id' | 'source'>[],
  showSdkEstimate: boolean,
): CustomProviderCostPresentation {
  if (!isCustomProviderForBilling(providerId, providers)) return 'regular';
  return showSdkEstimate ? 'estimate' : 'hidden';
}

export function projectCustomProviderMoney(
  money: RegionalMoney | null | undefined,
  presentation: CustomProviderCostPresentation,
): RegionalMoney | null {
  return projectSdkCostMoney(money, presentation);
}

function moneyFromMessage(
  message: Pick<ChatMessage, 'turnMoney' | 'turnCostUsd' | 'turnCostIsEstimate'>,
): RegionalMoney | null {
  const structured = normalizeRegionalMoney(message.turnMoney);
  if (structured) return structured;
  if (
    typeof message.turnCostUsd !== 'number' ||
    !Number.isFinite(message.turnCostUsd) ||
    message.turnCostUsd <= 0
  ) {
    return null;
  }
  return message.turnCostIsEstimate === true
    ? usdMoney(message.turnCostUsd, 'value-estimate', 'legacy-usd')
    : usdMoney(message.turnCostUsd);
}

function userMoneyFromMessage(
  message: Pick<ChatMessage, 'userTurnMoney' | 'userTurnCostUsd' | 'userTurnCostIsEstimate'>,
): RegionalMoney | null {
  const structured = normalizeRegionalMoney(message.userTurnMoney);
  if (structured) return structured;
  if (
    typeof message.userTurnCostUsd !== 'number' ||
    !Number.isFinite(message.userTurnCostUsd) ||
    message.userTurnCostUsd <= 0
  ) {
    return null;
  }
  return message.userTurnCostIsEstimate === true
    ? usdMoney(message.userTurnCostUsd, 'value-estimate', 'legacy-usd')
    : usdMoney(message.userTurnCostUsd);
}

export function projectCustomProviderUsageDetails(
  details: TurnUsageDetails | null | undefined,
  presentation: CustomProviderCostPresentation,
): TurnUsageDetails | undefined {
  if (!details || presentation === 'regular') return details ?? undefined;
  const normalized = normalizeTurnUsageDetails(details);
  if (!normalized) return undefined;
  const projected = (normalized.perModelCost ?? []).flatMap((entry) => {
    const money = projectCustomProviderMoney(entry.money, presentation);
    return money ? [{ ...entry, money }] : [];
  });
  const { perModelCost: _perModelCost, ...withoutPerModelCost } = normalized;
  return projected.length > 0
    ? { ...withoutPerModelCost, perModelCost: projected }
    : withoutPerModelCost;
}

function projectMessageTurnMoney(
  message: Pick<ChatMessage, 'turnMoney' | 'turnCostUsd' | 'turnCostIsEstimate' | 'turnUsageDetails'>,
  presentation: CustomProviderCostPresentation,
): RegionalMoney | null {
  const normalizedDetails = normalizeTurnUsageDetails(message.turnUsageDetails);
  return projectSdkCostMoneyWithBreakdown(
    moneyFromMessage(message),
    normalizedDetails?.perModelCost?.map((entry) => entry.money),
    presentation,
  );
}

export function resolveMessageCustomProviderCostPresentation(
  message: Pick<
    ChatMessage,
    | 'turnMoney'
    | 'turnCostUsd'
    | 'turnCostIsEstimate'
    | 'userTurnMoney'
    | 'userTurnCostUsd'
    | 'userTurnCostIsEstimate'
    | 'turnCostIsCustomProvider'
  >,
  fallback: CustomProviderCostPresentation,
  showSdkEstimate: boolean,
): CustomProviderCostPresentation {
  return resolveTurnSdkCostPresentation({
    money: moneyFromMessage(message) ?? userMoneyFromMessage(message),
    isCustomProviderCost: message.turnCostIsCustomProvider,
    fallback,
    showSdkEstimate,
  });
}

function withProjectedCosts(
  message: ChatMessage,
  presentation: CustomProviderCostPresentation,
  userTurnMoney: RegionalMoney | null,
): ChatMessage {
  const turnMoney = projectMessageTurnMoney(message, presentation);
  const turnUsageDetails = projectCustomProviderUsageDetails(
    message.turnUsageDetails,
    presentation,
  );
  const {
    turnMoney: _turnMoney,
    turnCostUsd: _turnCostUsd,
    turnCostIsEstimate: _turnCostIsEstimate,
    userTurnMoney: _userTurnMoney,
    userTurnCostUsd: _userTurnCostUsd,
    userTurnCostIsEstimate: _userTurnCostIsEstimate,
    turnUsageDetails: _turnUsageDetails,
    ...rest
  } = message;
  return {
    ...rest,
    ...(turnMoney
      ? {
          turnMoney,
          ...(turnMoney.currency === 'USD' ? { turnCostUsd: turnMoney.amount } : {}),
          turnCostIsEstimate: turnMoney.kind === 'value-estimate',
        }
      : {}),
    ...(userTurnMoney
      ? {
          userTurnMoney,
          ...(userTurnMoney.currency === 'USD' ? { userTurnCostUsd: userTurnMoney.amount } : {}),
          userTurnCostIsEstimate: userTurnMoney.kind === 'value-estimate',
        }
      : {}),
    ...(turnUsageDetails ? { turnUsageDetails } : {}),
  };
}

/**
 * Read-only projection for persisted custom-provider amounts. It never rewrites message or
 * session ledgers. Historical actual-cost values are treated as legacy SDK estimates, while
 * user/reference estimates remain visible even when SDK estimates are hidden.
 */
export function projectCustomProviderMessages(
  messages: readonly ChatMessage[],
  fallbackPresentation: CustomProviderCostPresentation,
  showSdkEstimate: boolean = fallbackPresentation === 'estimate',
): ChatMessage[] {
  let hasUserBoundary = false;
  let roundValues: RegionalMoney[] = [];
  return messages.map((message) => {
    if (message.role === 'user' && message.systemCardType !== 'auto-resume') {
      hasUserBoundary = true;
      roundValues = [];
      return message;
    }
    if (message.role !== 'assistant') return message;

    const presentation = resolveMessageCustomProviderCostPresentation(
      message,
      fallbackPresentation,
      showSdkEstimate,
    );
    const turnMoney = projectMessageTurnMoney(message, presentation);
    if (hasUserBoundary && turnMoney?.amount) roundValues.push(turnMoney);
    const hasPersistedUserTotal = Boolean(
      normalizeRegionalMoney(message.userTurnMoney) ||
      (typeof message.userTurnCostUsd === 'number' && message.userTurnCostUsd > 0),
    );
    const projectedUserTurnMoney = hasUserBoundary
      ? hasPersistedUserTotal && roundValues.length > 0
        ? addCompatibleRegionalMoney(roundValues, roundValues[0].currency)
        : null
      : projectCustomProviderMoney(userMoneyFromMessage(message), presentation);
    return withProjectedCosts(message, presentation, projectedUserTurnMoney);
  });
}
