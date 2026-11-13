import { useState } from 'react';
import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { UnreadFailedScheduleBanner } from '../../../src/renderer/components/chat/UnreadFailedScheduleBanner';
import { SubagentErrorNotice } from '../../../src/renderer/features/right-sidebar/plugins/subagents/SubagentChrome';
import { mountPage } from '../../ui-page/harness';

const error = 'queued heartbeat Codex thread provider identity does not match the current session route; api_key=private-fixture-value';
const resumeError = 'LAZY_CREATE_FAILED: [REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer';

function Fixture({ kind }: { kind: string }) {
  const [count, setCount] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const onDiagnose = () => setCount((value) => value + 1);
  return (
    <div className="p-4" data-diagnosis-count={count} data-retry-count={retryCount}>
      {kind.startsWith('resume-live') ? (
        <ErrorBanner error={resumeError} retryText="Continue the existing task"
          onRetry={() => setRetryCount((value) => value + 1)}
          onContinueAfterError={async () => setRetryCount((value) => value + 1)}
          onDiagnose={onDiagnose} />
      ) : kind === 'resume-history-narrow' ? (
        <ErrorMessageCard message={resumeError} onDiagnose={onDiagnose} />
      ) : kind === 'history' ? (
        <ErrorMessageCard message={error} onDiagnose={onDiagnose} />
      ) : kind === 'subagent' ? (
        <SubagentErrorNotice rawError={error} onDiagnose={onDiagnose} />
      ) : (
        <UnreadFailedScheduleBanner dataOwnerId="fixture-owner" sessionId="fixture-task"
          latestFailedRun={{ runId: 'fixture-run', firedAt: 1, errorMsg: error }}
          onDiagnose={onDiagnose} />
      )}
    </div>
  );
}

void mountPage({ route: '/tasks/fixture', render: (ctx) => <Fixture kind={ctx.case} /> });
