import { useState } from 'react';
import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { UnreadFailedScheduleBanner } from '../../../src/renderer/components/chat/UnreadFailedScheduleBanner';
import { SubagentErrorNotice } from '../../../src/renderer/features/right-sidebar/plugins/subagents/SubagentChrome';
import { mountPage } from '../../ui-page/harness';

const error = 'queued heartbeat Codex thread provider identity does not match the current session route; api_key=private-fixture-value';

function Fixture({ kind }: { kind: string }) {
  const [count, setCount] = useState(0);
  const onDiagnose = () => setCount((value) => value + 1);
  return (
    <div className="p-4" data-diagnosis-count={count}>
      {kind === 'history' ? (
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

void mountPage({ render: (ctx) => <Fixture kind={ctx.case} /> });
