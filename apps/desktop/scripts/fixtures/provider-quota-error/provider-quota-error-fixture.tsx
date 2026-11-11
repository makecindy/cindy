import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { mountPage } from '../../ui-page/harness';

const subscriptionError = 'LAZY_CREATE_FAILED: [SUBSCRIPTION_ACCOUNT_LIMITED] The task subscription account is waiting for its usage window to reset\nresetAtMs=1900000000000';
const error = '402: {"message":"OpenAIException - Insufficient Balance","type":"insufficient_balance_error"}';
void mountPage({
  render: ctx => (
    <div className="p-4">
      {ctx.case.startsWith('subscription')
        ? ctx.case === 'subscription-history'
          ? <ErrorMessageCard message={subscriptionError} />
          : <ErrorBanner error={subscriptionError} agentKind="cc" providerId="anthropic" onRetry={() => {}} retryText="original input" />
        : ctx.case === 'tail'
        ? <ErrorTailErrorBanner errorText={error} agentKind="cc" providerId="custom" errorSourceProviderId="custom"
            onContinue={() => {}} onDismiss={() => {}} />
        : <ErrorBanner error={error} agentKind="cc" providerId={ctx.case === 'gateway' ? 'xd' : 'custom'}
            errorSourceProviderId={ctx.case === 'unknown-source' ? undefined : ctx.case === 'gateway' ? 'xd' : 'custom'}
            onRetry={() => {}} retryText="original input" onViewBalance={() => {}} />}
    </div>
  ),
});
