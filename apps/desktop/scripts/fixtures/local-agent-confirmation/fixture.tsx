import { mountPage, subscription } from '../../ui-page/harness';
import { LocalAgentConfirmationHost } from '../../../src/renderer/components/LocalAgentConfirmationHost';

mountPage({
  host: {
    localAgent: {
      onConfirmation: subscription('confirmation'),
      onConfirmationDismissed: subscription('dismiss'),
      answerConfirmation: async (requestId: string, confirmed: boolean) => {
        const state = window as unknown as { answers: unknown[] };
        (state.answers ??= []).push({ requestId, confirmed });
        return true;
      },
    },
  },
  render: () => <LocalAgentConfirmationHost />,
});
