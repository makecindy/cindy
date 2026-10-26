import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { mountPage } from '../../ui-page/harness';

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
        {ctx.case === 'tail'
          ? <ErrorTailErrorBanner errorText={error} agentKind="cc" providerId="custom" errorSourceProviderId="custom"
              onContinue={() => {}} onDismiss={() => {}} />
          : <ErrorBanner error={displayedError} agentKind="cc" providerId={gateway ? 'xd' : 'custom'}
              errorSourceProviderId={ctx.case === 'unknown-source' ? undefined : gateway ? 'xd' : 'custom'}
              onRetry={() => {}} retryText="original input" onViewBalance={ctx.case === 'upstream-no-billing' ? undefined : () => {}} />}
      </div>
    );
  },
});
