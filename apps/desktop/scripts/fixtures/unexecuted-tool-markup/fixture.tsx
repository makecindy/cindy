import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { mountPage, subscription } from '../../ui-page/harness';

void mountPage({
  host: { maker: {
    codexRuntimeRouteGet: async () => ({ authInjection: 'oauth-bearer' }),
    onCodexRuntimeRouteChanged: subscription('codexRuntimeRouteChanged'),
    auth: { onStateChanged: subscription('authStateChanged') },
  } },
  render: () => <div className="p-4 space-y-4">
    <ErrorBanner error="fallback" errorReason="unexecuted-tool-markup" agentKind="pi" onRetry={() => {}} />
    <ErrorMessageCard message="fallback" reason="unexecuted-tool-markup" />
  </div>,
});
