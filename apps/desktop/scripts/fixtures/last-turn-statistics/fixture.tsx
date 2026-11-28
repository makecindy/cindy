import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { RunningStatusBar } from '../../../src/renderer/features/cc-agent/CCAgentSessionView';
import { LastTurnStatistics, latestTurnStatistics } from '../../../src/renderer/features/cc-agent/LastTurnStatistics';
import { LastTurnStatisticsSettings } from '../../../src/renderer/components/settings/LastTurnStatisticsCell';
import { useLastTurnStatisticsPreference } from '../../../src/renderer/hooks/useLastTurnStatisticsPreference';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import type { TurnUsageDetails } from '../../../src/shared/turnUsageDetails';

function Fixture({ trace }: { trace: boolean }) {
  const { enabled } = useLastTurnStatisticsPreference();
  const [running, setRunning] = useState(false);
  const [view, setView] = useState(true);
  const details: TurnUsageDetails = { inputTokens: 90000, outputTokens: 1234, totalTokens: 91234,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, turnDurationMs: 123000,
    durationMs: 20000,
    ...(trace ? { trace: { durationMs: 20000, requests: 2, speed: [[5000, 45], [10000, 55], [20000, 60]] as Array<[number, number]>,
      marks: [[10000, 100, 1], [20000, 200, 1]] as Array<[number, number, number]>, reportedOutputTokens: 1234 } } : {}),
  };
  const messages = [{ role: 'user', clientId: 'u', content: 'Test' },
    { role: 'assistant', clientId: 'a', content: 'Done', turnUsageDetails: details }] as ChatMessage[];
  const saved = enabled && !running ? latestTurnStatistics(messages) : null;
  return <main className="flex h-screen flex-col justify-end gap-5 bg-content-area p-5 text-foreground">
    <LastTurnStatisticsSettings />
    <div data-ui-page-control className="flex gap-4">
      <button onClick={() => setRunning(value => !value)}>Toggle run</button>
      <button onClick={() => setView(value => !value)}>Switch task</button>
    </div>
    {view && <RunningStatusBar status={running ? 'Generating...' : 'Done'} visible={running}
      clockOnline={false} startedAt={null} tokenUsage={0} inputWidth="100%"
      idleStatistics={saved ? <LastTurnStatistics details={saved.details} /> : null} />}
    <div className="min-h-12 rounded-xl border border-border bg-[var(--card)]" />
  </main>;
}

void mountPage({ render: ctx => <Fixture trace={ctx.case !== 'no-trace'} /> });
