import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { mountPage } from '../../ui-page/harness';

const subscriptionError = 'LAZY_CREATE_FAILED: [SUBSCRIPTION_ACCOUNT_LIMITED] The task subscription account is waiting for its usage window to reset\nresetAtMs=1900000000000';
const resumeError = 'LAZY_CREATE_FAILED: [REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer';
const chooseComputer = () => { document.documentElement.dataset.recoveryChosen = 'true'; };
const error = '402: {"message":"OpenAIException - Insufficient Balance","type":"insufficient_balance_error"}';
void mountPage({
  render: ctx => {
    const upstream = ctx.case.startsWith('upstream');
    const gateway = upstream || ctx.case === 'gateway';
    const displayedError = upstream
      ? '429 throttling_error provider_rate_limited: The upstream provider rate limit was exceeded. 余额不足或无可用资源包,请充值。'
      : error;
    return (
      <div className="p-4">
        {ctx.case.startsWith('shared-resume')
          ? ctx.case === 'shared-resume-tail'
            ? <ErrorTailErrorBanner errorText={resumeError} agentKind="codex" agentDeviceId="share:fixture"
                onContinue={() => {}} onDismiss={() => {}} onChooseComputer={chooseComputer} />
            : <ErrorBanner error={resumeError} agentKind="codex" agentDeviceId="share:fixture"
                retryText="original input" onRetry={() => {}} onChooseComputer={chooseComputer} />
          : ctx.case.startsWith('subscription')
          ? ctx.case === 'subscription-history'
            ? <ErrorMessageCard message={subscriptionError} />
            : <ErrorBanner error={subscriptionError} agentKind="cc" providerId="anthropic" onRetry={() => {}} retryText="original input" />
          : ctx.case === 'tail'
          ? <ErrorTailErrorBanner errorText={error} agentKind="cc" providerId="custom" errorSourceProviderId="custom"
              onContinue={() => {}} onDismiss={() => {}} />
          : <ErrorBanner error={displayedError} agentKind="cc" providerId={gateway ? 'xd' : 'custom'}
              errorSourceProviderId={ctx.case === 'unknown-source' ? undefined : gateway ? 'xd' : 'custom'}
              onRetry={() => {}} retryText="original input" onViewBalance={ctx.case === 'upstream-no-billing' ? undefined : () => {}} />}
      </div>
    );
  },
});
