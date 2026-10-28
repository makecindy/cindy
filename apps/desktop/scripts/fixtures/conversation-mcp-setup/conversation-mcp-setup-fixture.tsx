import { useEffect, useState } from 'react';
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
        : mode === 'saved' || mode.startsWith('activation-')
          ? 'saved'
          : 'awaiting_user',
    errorCode: mode === 'failed' ? 'AUTH_REJECTED' : undefined,
    activation: mode === 'activation-pending' ? 'pending' : mode === 'activation-deferred' ? 'deferred' : mode === 'activation-refreshing' ? 'refreshing' : 'next_session',
  });
  useEffect(() => {
    const apply = () => setSnapshot(value => ({ ...value, activation: 'next_session' }));
    window.addEventListener('fixture-mcp-applied', apply);
    return () => window.removeEventListener('fixture-mcp-applied', apply);
  }, []);
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
        <div className={mode.startsWith('layout') ? 'relative min-h-0 flex-1' : 'min-h-0 min-w-0 overflow-y-auto p-3'} data-ui-mcp>
          {mode.startsWith('layout') ? (
            <>
              <div data-ui-messages className="absolute inset-0 overflow-y-auto px-4 pb-[150px]">
                <div className="mx-auto w-[90%]" data-ui-timeline-column>
                  {Array.from({ length: 12 }, (_, index) => <p key={index} className="py-3 text-13">Message {index + 1}</p>)}
                  <McpSetupPrompt snapshot={snapshot} onDismiss={() => {}} />
                </div>
              </div>
              <div className="pointer-events-none absolute bottom-0 left-4 right-4">
                <div className="pointer-events-auto mx-auto flex w-[90%] flex-col items-center gap-[10px] pb-5" data-chat-composer-stack>
                  <textarea data-ui-composer aria-label="Composer" className="h-[100px] w-full shrink-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-3" />
                </div>
              </div>
            </>
          ) : mode === 'settings' ? (
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
