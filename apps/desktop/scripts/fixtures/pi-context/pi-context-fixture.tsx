import { mountPage } from '../../ui-page/harness';
import { SystemCard } from '../../../src/renderer/components/chat/SystemCard';
import { UI_MOCK_PI_CONTEXT_USAGE } from '@cindy/maker-shared/ui-mock';

mountPage({
  render: ctx => (
    <main className="p-4">
      <SystemCard cardType="context" data={{ usage: {
        ...UI_MOCK_PI_CONTEXT_USAGE,
        ...(ctx.data.legacy ? { textEstimate: undefined } : {}),
      } }} />
    </main>
  ),
});
