import { useState } from 'react';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { mountPage, subscription } from '../../ui-page/harness';

const error = 'Error running remote compact task: invalid_encrypted_content';

function Fixture({ kind }: { kind: string }) {
  const [retries, setRetries] = useState(0);
  const message = kind === 'overflow'
    ? 'Error running remote compact task: maximum context length exceeded'
    : kind.endsWith('-split') ? 'Error running remote compact task' : error;
  return (
    <div className="p-4" data-retries={retries}>
      {kind.startsWith('history') ? (
        <ErrorMessageCard message={message} reason="context-overflow" />
      ) : (
        <ErrorBanner error={message}
          errorReason={kind.startsWith('legacy') || kind === 'overflow' ? 'context-overflow' : 'remote-compact-encrypted-content'}
          agentKind="codex" retryText="Continue the fixture task"
          onRetry={() => setRetries((value) => value + 1)} />
      )}
    </div>
  );
}

void mountPage({
  host: {
    maker: {
      codexRuntimeRouteGet: async () => ({ authInjection: 'oauth-bearer' }),
      onCodexRuntimeRouteChanged: subscription('codexRuntimeRouteChanged'),
      auth: { onStateChanged: subscription('authStateChanged') },
    },
  },
  render: (ctx) => <Fixture kind={ctx.case} />,
});
