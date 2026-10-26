import { mountPage, forbid } from '../../ui-page/harness';
import { ClaudeAccountsPanel } from '../../../src/renderer/components/settings/ClaudeAccountsPanel';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import type { ClaudeAccountHealthView, ClaudeAccountsListView } from '../../../src/shared/claudeAccounts';

interface Data {
  list: ClaudeAccountsListView;
  health: ClaudeAccountHealthView[];
}

mountPage({
  host: (ctx) => {
    const data = ctx.data as unknown as Data;
    return {
      maker: {
        claudeAccountsList: async () => data.list,
        claudeAccountsHealth: async () => data.health,
        // Visual fixture only: anything that would change accounts must never run.
        claudeAccountsAdd: forbid('maker.claudeAccountsAdd'),
        claudeAccountsCancelAdd: forbid('maker.claudeAccountsCancelAdd'),
        claudeAccountsSwitch: forbid('maker.claudeAccountsSwitch'),
        claudeAccountsRemove: forbid('maker.claudeAccountsRemove'),
      },
    };
  },
  render: () => (
    <ConfirmDialogProvider>
      <main className="mx-auto w-full max-w-[720px] min-w-0 p-4">
        <div className="rounded-xl border" style={{ borderColor: 'var(--settings-theme-card-border)', background: 'var(--surface-elevated)' }}>
          <ClaudeAccountsPanel />
        </div>
      </main>
    </ConfirmDialogProvider>
  ),
});
