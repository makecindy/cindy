import { useState } from 'react';
import { McpSetupPrompt } from '../../../src/renderer/components/new-chat/McpSetupPrompt';
import { McpServerDialog } from '../../../src/renderer/components/settings/McpServerDialog';
import type {
  McpSetupSnapshot,
  McpSetupDraftUpdate,
  McpSetupSubmission,
} from '../../../src/shared/mcpSetup';
import { AppFrame, mountPage, registerHost, forbid } from '../../ui-page/harness';

function Scenario({ mode }: { mode: string }) {
  const [snapshot, setSnapshot] = useState<McpSetupSnapshot>({
    kind: 'mcp_setup',
    operationId: '00000000-0000-4000-8000-000000000001',
    requestId: 'desktop-confirm-source-fixture',
    revision: 0,
    expiresAt: Date.now() + 900_000,
    deviceName: 'Demo Desktop',
    draft: {
      name: 'Example MCP',
      url: 'https://example.test/mcp',
      transport: 'http',
      headerNames: [],
    },
    status:
      mode === 'verifying'
        ? 'verifying'
        : mode === 'saved' || mode === 'activation-pending'
          ? 'saved'
          : 'awaiting_user',
    errorCode: mode === 'failed' ? 'AUTH_REJECTED' : undefined,
    activation: mode === 'activation-pending' ? 'pending' : 'next_session',
  });
  const publish = (value: McpSetupSnapshot) => {
    setSnapshot(value);
    return value;
  };
  registerHost({
    maker: {
      updateMcpSetup: async (input: McpSetupDraftUpdate) =>
        publish({ ...snapshot, draft: input.draft, revision: snapshot.revision + 1 }),
      submitMcpSetup: async (input: McpSetupSubmission) => {
        if (
          input.token !== 'test-invalid-token' ||
          input.headers['X-Test-Key'] !== 'test-invalid-header'
        )
          throw new Error('Fixture requires invalid test values');
        document.documentElement.dataset.fixtureMcpSubmitted = 'true';
        return publish({
          ...snapshot,
          status: 'saved',
          verification: 'passed',
          activation: 'next_session',
        });
      },
      cancelMcpSetup: async () => publish({ ...snapshot, status: 'cancelled' }),
      retryMcpSetupActivation: async () =>
        publish({ ...snapshot, status: 'saved', activation: 'next_session' }),
      createCustomMcpServer: forbid('maker.createCustomMcpServer'),
      updateCustomMcpServer: forbid('maker.updateCustomMcpServer'),
    },
  });
  return (
    // AppFrame mirrors Desktop's 400 px minimum. This component-only case
    // removes that shell minimum to exercise the card itself at 320 px.
    <div className={mode === 'narrow' ? '[&_[data-ui-frame=content]]:min-w-0' : undefined}>
      <AppFrame>
        <div className="min-w-0 p-3" data-ui-mcp>
          {mode === 'settings' ? (
            <McpServerDialog
              initial={{
                id: 'custom_demo',
                name: 'Example MCP',
                url: 'https://example.test/mcp',
                transport: 'http',
                headers: { 'X-Test-Key': '' },
                hasToken: true,
                revision: 12,
              }}
              onSaved={() => {}}
              onClose={() => {}}
            />
          ) : (
            <McpSetupPrompt snapshot={snapshot} onDismiss={() => {}} />
          )}
        </div>
      </AppFrame>
    </div>
  );
}
void mountPage({
  host: {
    safeStorageRead: forbid('safeStorageRead'),
    safeStorageStore: forbid('safeStorageStore'),
    safeStorageRemove: forbid('safeStorageRemove'),
  },
  render: (context) => <Scenario mode={context.case} />,
});
