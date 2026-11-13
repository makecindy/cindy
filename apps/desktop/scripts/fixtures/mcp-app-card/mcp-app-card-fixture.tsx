import { McpAppCard } from '../../../src/renderer/components/chat/McpAppCard';
import { AppFrame, mountPage } from '../../ui-page/harness';

// The page runner intentionally forbids guest frames. Exercise the actual error
// and retry surface here; connected guest teardown is a separate browser check.
let opens = 0;
void mountPage({
  host: {
    maker: {
      mcpApps: async (_sessionId: string, input: { op: string }) => {
        if (input.op === 'open') {
          document.documentElement.dataset.fixtureOpens = String(++opens);
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        }
        return {};
      },
    },
  },
  render: () => (
    <AppFrame>
      <div className="p-4">
        <McpAppCard sessionId="fixture-task" clientId="fixture-card" title="MCP App"
          fallbackText="Saved result: the form response remains available after the App closes." />
      </div>
    </AppFrame>
  ),
});
