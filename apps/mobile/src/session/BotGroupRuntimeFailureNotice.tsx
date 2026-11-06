import { useTranslation } from 'react-i18next';
import type { BotGroupRuntimeFailureCode } from '@cindy/maker-shared/botGroupChat';
import { ErrorNotice } from '@/components/ErrorNotice';
import { AgentErrorDetails } from './AgentErrorDetails';

/** Group failures expose public categories, never the teammate's private diagnostics. */
export function BotGroupRuntimeFailureNotice({ code, name }: {
  code: BotGroupRuntimeFailureCode;
  name: string;
}) {
  const { t } = useTranslation();
  const needsComputer = code === 'IMAGE_INPUT_UNSUPPORTED' || code === 'MODEL_UNAVAILABLE'
    || code === 'AUTH_REQUIRED' || code === 'QUOTA_EXCEEDED'
    || code === 'RATE_LIMITED' || code === 'UPSTREAM_OVERLOADED' || code === 'RUNTIME_TIMEOUT'
    || code === 'REMOTE_DEVICE_LIMIT' || code === 'REMOTE_TOTAL_LIMIT';
  const guidance = t(`groupChat.notice.runtimeFailure.${code}.details`);
  const details = needsComputer
    ? `${guidance}\n${t('groupChat.notice.runtimeFailureSetupHint')}`
    : guidance;
  return <ErrorNotice
    testID="botGroup.notice"
    message={t(`groupChat.notice.runtimeFailure.${code}.summary`, { name })}
    description={t(`groupChat.notice.runtimeFailure.${code}.advice`)}
  >
    <AgentErrorDetails message={details} />
  </ErrorNotice>;
}
