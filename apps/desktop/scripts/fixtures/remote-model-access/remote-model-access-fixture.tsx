import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { RemoteModelAccessDialog, RemoteModelAccessSection } from '../../../src/renderer/features/provider-share/RemoteModelAccessSection';
import type { RemoteModelSelection } from '../../../src/shared/remoteModelAccess';

void mountPage({
  host: (ctx) => {
    const budgetCase = ctx.case.startsWith('budget');
    const claude = ctx.case === 'budget-claude';
    const recommended = claude ? 'claude-sonnet' : 'gpt-terra';
    const limited = claude ? 'claude-fable' : 'gpt-astra';
    const catalog = claude ? [
      { id: 'claude-sonnet', name: 'Sonnet' }, { id: 'claude-haiku', name: 'Haiku' }, { id: 'claude-fable', name: 'Fable' },
    ] : [
      { id: 'gpt-sol', name: 'Sol' }, { id: 'gpt-terra', name: 'Terra' }, { id: 'gpt-astra', name: 'Astra' },
      ...(ctx.case === 'budget-new-model' ? [{ id: 'catalog-new-model-42', name: 'New model 42' }] : []),
    ];
    let budget = budgetCase ? { recommendedModel: recommended, rules: [{ id: 'premium', models: [limited], maxPercent: 30 }], basis: 'member-input-output-7d' as const, enabled: false } : null;
    let models: RemoteModelSelection = ctx.case === 'member' ? ['small'] : null;
    return {
      providerShare: {
        onOwnedChanged: subscription('ownedShares'),
        command: async (cmd: { action: string; models?: RemoteModelSelection; memberBudget?: typeof budget }) => {
          if (cmd.action === 'set-model-access' && ctx.case === 'budget-save-failure') throw new Error('Fixture save failed');
          if (cmd.memberBudget !== undefined) budget = cmd.memberBudget;
          if (cmd.action === 'set-model-access') models = cmd.models ?? null;
          return {
            version: 1, providerName: claude ? 'Claude' : 'OpenAI', models, providerModels: ctx.case === 'member' ? ['small', 'medium'] : null,
            ...(budgetCase ? {
              budgetSupported: true, budgetAvailable: ctx.case !== 'budget-unsupported', memberBudget: budget,
              budgetStatus: { state: ctx.case === 'budget-learning' ? 'empty' : 'recorded', enabled: false, windowStart: '2026-10-22', windowEnd: '2026-10-28', nextWindowAt: Date.parse('2026-10-29T00:00:00+08:00'), totalTokens: ctx.case === 'budget-learning' ? 0 : 100,
                recommendedModel: recommended,
                rules: [{ id: 'premium', models: [limited], tokens: ctx.case === 'budget-learning' ? 0 : 60, usedPercent: ctx.case === 'budget-learning' ? null : 60, limitPercent: 30, wouldBlock: ctx.case !== 'budget-learning', blocked: false }] },
            } : {}),
            availableModels: budgetCase ? catalog : [
              { id: 'small', name: 'Claude Haiku' },
              { id: 'medium', name: 'Claude Sonnet' },
              { id: 'large', name: 'Claude Opus' },
            ],
          };
        },
      },
    };
  },
  render: (ctx) => (
    <AppFrame header={false}>
      <div className="p-6">
        <RemoteModelAccessSection providerId={ctx.case === 'budget-claude' ? 'anthropic' : 'openai'} />
        {(ctx.case === 'member' || ctx.case.startsWith('budget')) && <RemoteModelAccessDialog providerId={ctx.case === 'budget-claude' ? 'anthropic' : 'openai'} memberId="fixture-member" memberName="小林" onClose={() => {}} />}
      </div>
    </AppFrame>
  ),
});
