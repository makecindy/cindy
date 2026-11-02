import { McpAppCard } from '../../../src/renderer/components/chat/McpAppCard';
import { mountPage } from '../../ui-page/harness';

// Only the host open receipt is supplied; card/controller, sizing and nested
// sandbox documents are production code. No synthetic wheel listener or relay.
void mountPage({
  host: {
    maker: {
      mcpApps: async (_session: string, input: { op: string }) =>
        input.op === 'open' ? { viewId: 'wheel', transport: 'sandbox', prefersBorder: true } : {},
    },
  },
  render: () => (
    <main id="conversation" style={{ height: 650, overflow: 'auto' }}>
      <div style={{ height: 500 }}>Earlier messages</div>
      <McpAppCard sessionId="wheel-task" clientId="wheel-card" title="Wheel regression" />
      <div style={{ height: 2000 }}>Later messages</div>
    </main>
  ),
});
