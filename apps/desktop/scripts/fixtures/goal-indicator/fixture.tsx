import { GoalIndicator } from '../../../src/renderer/components/new-chat/GoalIndicator';
import { mountPage, subscription } from '../../ui-page/harness';

mountPage({
  host: (ctx) => ({
    maker: {
      getGoalStatus: async () => ({
        sessionId: 'fixture-goal',
        objective: 'Summarize the playtest feedback',
        status: 'blocked',
        lastReason: ctx.data.reason,
        turnsUsed: 2,
        tokensUsed: 100,
        maxTurns: null,
        budgetTokens: null,
        noProgressLimit: null,
        noProgressStreak: 0,
        usageResetAt: null,
        startedAt: 1,
        updatedAt: 1,
      }),
      onGoalStatusChanged: subscription('goalStatusChanged'),
    },
  }),
  render: () => (
    <div className="p-4">
      <GoalIndicator sessionId="fixture-goal" />
    </div>
  ),
});
