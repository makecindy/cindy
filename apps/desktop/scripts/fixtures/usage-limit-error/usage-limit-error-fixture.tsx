import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { mountPage } from '../../ui-page/harness';

const error = "You've hit your session limit · resets 4:10pm (Asia/Shanghai)";
const resetAtMs = Date.now() + 70 * 60 * 1000;
void mountPage({
  render: ctx => (
    <div className="p-4">
      {ctx.case === 'history'
        ? <ErrorMessageCard message={error} />
        : ctx.case === 'tail'
          ? <ErrorTailErrorBanner errorText={error} agentKind="cc" onContinue={() => {}} onDismiss={() => {}} />
          : <ErrorBanner error={error} agentKind="cc" onRetry={() => {}} retryText="original input" onCancel={() => {}}
              usageLimitRecovery={{ resetAtMs }}
              usageLimitWait={ctx.case === 'cancelled' ? null : { resumeAt: resetAtMs + 60_000 }}
              onCancelUsageLimitWait={() => {}} />}
    </div>
  ),
});
