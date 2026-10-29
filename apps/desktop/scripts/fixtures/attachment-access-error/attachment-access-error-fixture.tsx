import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import { mountPage } from '../../ui-page/harness';

const error = '[DEVICE_LINK_MEDIA_ACCESS_DENIED] Cannot read the source attachment.';
void mountPage({
  render: (ctx) => (
    <div className="p-4">
      {ctx.case.startsWith('live')
        ? <ErrorBanner error={error} onRetry={() => {}} />
        : ctx.case.startsWith('tail')
          ? <ErrorTailErrorBanner errorText={error} onContinue={() => {}} onDismiss={() => {}} />
          : <ErrorMessageCard message={error} />}
    </div>
  ),
});
