import { McpServerDialog } from '../../../src/renderer/components/settings/McpServerDialog';
import { McpServersSection } from '../../../src/renderer/components/settings/McpServersSection';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { McpSetupPrompt } from '../../../src/renderer/components/new-chat/McpSetupPrompt';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { AppFrame, forbid, mountPage } from '../../ui-page/harness';
import type { CustomMcpInput, CustomMcpTokenChange } from '../../../src/shared/customMcp';

let rejectResult = false;
let saveCount = 0;
let settingsCase = '';
const save = (method: 'create' | 'update') => async (config: CustomMcpInput, tokenChange: CustomMcpTokenChange) => {
  if (!tokenChange || !['keep', 'clear', 'set'].includes(tokenChange.action)) throw new Error('Missing native MCP bearer intent');
  document.documentElement.dataset.uiMcpSave = JSON.stringify({ method, transport: config.transport,
    tokenAction: tokenChange.action, count: ++saveCount });
  return { ok: true };
};
void mountPage({
  route: '/cc-agent/mcp-form-fixture',
  host: {
    onSelectionContextMenuAddToChat: () => () => {},
    onSessionAttentionCleared: () => () => {},
    onUsageSessionSpendChanged: () => () => {},
    onAuthStateChange: () => () => {},
    authHasPersistedSessionHintSync: () => false,
    maker: {
      listCustomMcpServers: async () => {
        if (settingsCase === 'settings-load-error') throw new Error('fixture storage unavailable');
        return settingsCase.startsWith('settings-unreadable') ? {
          servers: [{ id: 'custom_healthy', name: 'Healthy connection', transport: 'http', url: 'https://example.test/mcp', headers: {} }],
          unreadableServers: [
            { id: 'custom_broken_local', name: 'Grafana', transport: 'stdio', reason: 'unreadable' },
            { id: 'custom_broken_remote', name: 'Remote connection', transport: 'http', reason: 'unreadable' },
          ],
        } : { servers: [] };
      },
      listMcpDuplicates: async () => ({ connections: [], complete: true }),
      onMcpChanged: () => () => {},
      createCustomMcpServer: save('create'),
      updateCustomMcpServer: save('update'),
      refreshCustomMcpCodex: forbid('maker.refreshCustomMcpCodex'),
      resolveInteraction: async () => {
        if (rejectResult) throw new Error('fixture result delivery unavailable');
        return { accepted: true };
      },
    },
    safeStorageStore: forbid('safeStorageStore'),
    safeStorageRemove: forbid('safeStorageRemove'),
    safeStorageRead: async () => null,
  },
  render: context => {
    settingsCase = context.case;
    if (context.case.startsWith('settings-unreadable') || context.case === 'settings-load-error') {
      return <div className="min-w-0 p-3"><ConfirmDialogProvider><McpServersSection /></ConfirmDialogProvider></div>;
    }
    rejectResult = context.case === 'result-error';
    const request = { kind: 'mcp_setup' as const, requestId: 'mcp-form-fixture', proposal: context.case.startsWith('stdio') ? {
      name: 'Grafana', transport: 'stdio' as const, command: 'uvx', args: ['mcp-grafana'],
      envKeys: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
    } : {} };
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
    if (context.case === 'stdio-edit' || context.case.startsWith('stdio-settings')) return <McpServerDialog initial={{ id: 'custom_grafana', name: 'Grafana',
      transport: 'stdio', command: 'uvx', args: ['mcp-grafana'], envKeys: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'] }}
      onSaved={() => {}} onClose={() => {}} />;
    if (context.case === 'settings') return <McpServerDialog onSaved={() => {}} onClose={() => {}} />;
    return <div className="min-w-0 p-3" data-ui-mcp-form>{form}</div>;
  },
});
