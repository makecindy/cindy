import { McpServerDialog } from '../../../src/renderer/components/settings/McpServerDialog';
import { McpSetupPrompt } from '../../../src/renderer/components/new-chat/McpSetupPrompt';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { AppFrame, mountPage } from '../../ui-page/harness';

let rejectResult = false;
void mountPage({
  route: '/cc-agent/mcp-form-fixture',
  host: {
    onSelectionContextMenuAddToChat: () => () => {},
    onSessionAttentionCleared: () => () => {},
    onUsageSessionSpendChanged: () => () => {},
    onAuthStateChange: () => () => {},
    authHasPersistedSessionHintSync: () => false,
    maker: {
      listCustomMcpServers: async () => ({ servers: [] }),
      createCustomMcpServer: async () => ({ ok: true }),
      refreshCustomMcpCodex: async () => ({ ok: true }),
      resolveInteraction: async () => {
        if (rejectResult) throw new Error('fixture result delivery unavailable');
        return { accepted: true };
      },
    },
    safeStorageStore: async () => true,
    safeStorageRemove: async () => true,
    safeStorageRead: async () => null,
  },
  render: context => {
    rejectResult = context.case === 'result-error';
    const request = { kind: 'mcp_setup' as const, requestId: 'mcp-form-fixture', proposal: {} };
    const form = <McpSetupPrompt request={request} />;
    if (context.case === 'layout') return <AppFrame>
      <div className="relative min-h-0 flex-1" data-ui-mcp-layout>
        <MessageStream workingDir="/project" sessionId="mcp-form-fixture" messages={[]} historyLoaded
          contentWidth="90%" bottomPadding={150}
          header={<div>{Array.from({ length: 20 }, (_, i) => <p key={i} className="py-3">Message {i + 1}</p>)}</div>}
          footer={form} />
        <textarea data-ui-composer aria-label="Composer"
          className="absolute bottom-5 left-[5%] h-[100px] w-[90%] rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-3" />
      </div>
    </AppFrame>;
    if (context.case === 'settings') return <McpServerDialog onSaved={() => {}} onClose={() => {}} />;
    return <div className="min-w-0 p-3" data-ui-mcp-form>{form}</div>;
  },
});
