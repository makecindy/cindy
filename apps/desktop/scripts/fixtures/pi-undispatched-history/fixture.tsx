import { toSessionDispatchOutcome } from '../../../../../packages/maker-core/src/session-send-outcome';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { mountPage } from '../../ui-page/harness';

const outcome = toSessionDispatchOutcome({
  accepted: false, reason: 'provider-rejected-before-dispatch', diagnostic: 'pi-retry-history-frame-too-large',
}, 'fixture');
if (outcome.dispatched) throw new Error('Expected a refused retry');
const message = `${outcome.reason}: ${outcome.message}`;
void mountPage({
  render: ctx => <div className="p-4">
    {ctx.case === 'tail'
      ? <ErrorTailErrorBanner errorText={message} agentKind="pi" onContinue={() => {}} onDismiss={() => {}} />
      : ctx.case === 'history' ? <ErrorMessageCard message={message} />
      : <ErrorBanner error={message} agentKind="pi" onRetry={() => {}} />}
  </div>,
});
