import { useTranslation } from 'react-i18next';
import { readBotGroupRuntimeFailureReason, type BotGroupRuntimeFailureCode } from '@cindy/maker-shared/botGroupChat';
import { ErrorNotice } from '@/components/ErrorNotice';
import { AgentErrorDetails } from './AgentErrorDetails';

/** Group failures expose public categories, never the teammate's private diagnostics. */
export function BotGroupRuntimeFailureNotice({ code, name, reason }: {
  code: BotGroupRuntimeFailureCode;
  name: string;
  reason?: unknown;
}) {
  const { t } = useTranslation();
  const publicReason = readBotGroupRuntimeFailureReason(code, reason);
  const key = publicReason ? `groupChat.notice.runtimeFailureReason.${publicReason}` : `groupChat.notice.runtimeFailure.${code}`;
  const needsComputer = !publicReason && (code === 'IMAGE_INPUT_UNSUPPORTED' || code === 'MODEL_UNAVAILABLE'
    || code === 'AUTH_REQUIRED' || code === 'QUOTA_EXCEEDED'
    || code === 'RATE_LIMITED' || code === 'UPSTREAM_OVERLOADED' || code === 'RUNTIME_TIMEOUT'
    || code === 'REMOTE_DEVICE_LIMIT' || code === 'REMOTE_TOTAL_LIMIT');
  const guidance = t(`${key}.details`);
  const details = needsComputer
    ? `${guidance}\n${t('groupChat.notice.runtimeFailureSetupHint')}`
    : guidance;
  return <ErrorNotice
    testID="botGroup.notice"
    message={t(`${key}.summary`, { name })}
    description={t(`${key}.advice`)}
  >
    <AgentErrorDetails message={details} />
  </ErrorNotice>;
}
