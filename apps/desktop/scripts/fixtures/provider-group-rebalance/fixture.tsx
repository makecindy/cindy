import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage } from '../../ui-page/harness';
import { useConfirmDialog } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { offerSessionRebalance, prefetchSessionRebalance } from '../../../src/renderer/features/provider-group/sessionRebalancePrompt';

function Prompt() {
  const dialogs = useConfirmDialog();
  const { t } = useTranslation();
  useEffect(() => {
    void prefetchSessionRebalance('rebalance-preview').then(() => offerSessionRebalance({ sessionId: 'rebalance-preview', ...dialogs, t }));
  }, [dialogs.confirm, dialogs.confirmWithCheckbox, t]);
  return null;
}

mountPage({
  host: (ctx) => ({
    providerGroup: { command: async () => ({
      kind: 'ask', memberKey: 'device:example:anthropic',
      label: ctx.case === 'long-name' ? 'Example MacBook Air · Example subscription account' : 'Example MacBook Air',
      quota: { usedPercent: 28, resetAtMs: Date.now() + 32 * 3_600_000, windowMs: 604_800_000 },
    }) },
  }),
  render: () => <Prompt />,
});
