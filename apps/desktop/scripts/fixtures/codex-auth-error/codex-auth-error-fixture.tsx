import { useLocation } from 'react-router-dom';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { mountPage, subscription } from '../../ui-page/harness';

function Fixture({ kind }: { kind: string }) {
  const location = useLocation();
  return (
    <div className="p-4" data-location={`${location.pathname}${location.search}`}>
      <ErrorBanner error="401 Unauthorized" agentKind="codex"
        providerId={kind === 'changed-source' ? 'custom-deepseek' : 'openai'}
        errorSourceProviderId="openai" retryText="Continue the task" onRetry={() => {}} />
    </div>
  );
}

void mountPage({
  route: '/tasks/fixture',
  host: {
    maker: {
      codexRuntimeRouteGet: async () => ({ authInjection: 'env-key' }),
      onCodexRuntimeRouteChanged: subscription('codexRuntimeRouteChanged'),
      auth: {
        getState: async () => ({ authenticated: false }),
        onStateChanged: subscription('authStateChanged'),
        onLoginProgress: subscription('loginProgress'),
      },
    },
  },
  render: ctx => <Fixture kind={ctx.case} />,
});
