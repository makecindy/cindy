import { McpAppCard } from '../../../src/renderer/components/chat/McpAppCard';
import { AppFrame, mountPage } from '../../ui-page/harness';

// The fullscreen case exercises host chrome with a stubbed guest transport.
// A live guest and its teardown are covered separately.
let opens = 0;
void mountPage({
  host: ({ case: scenario }) => ({
    maker: {
      mcpApps: async (_sessionId: string, input: { op: string }) => {
        if (input.op === 'open') {
          if (scenario === 'fullscreen') {
            return { viewId: 'fixture', transport: 'sandbox', prefersBorder: true };
          }
          document.documentElement.dataset.fixtureOpens = String(++opens);
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        }
        return {};
      },
    },
  }),
  render: ({ case: scenario }) => {
    if (scenario === 'fullscreen') {
      // Leave the fixture's iframe blank without weakening the runner's frame-src policy.
      const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')!;
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        ...src,
        set(this: HTMLIFrameElement, value: string) {
          if (value === 'cindy-mcp-app://fixture/sandbox') {
            Object.defineProperty(HTMLIFrameElement.prototype, 'src', src);
          } else {
            src.set!.call(this, value);
          }
        },
      });
    }
    return (
      <AppFrame>
        <div className="p-4">
          <McpAppCard sessionId="fixture-task" clientId="fixture-card" title="MCP App"
            fallbackText="Saved result: the form response remains available after the App closes." />
        </div>
      </AppFrame>
    );
  },
});
