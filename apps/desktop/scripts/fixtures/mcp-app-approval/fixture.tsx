import { mountPage } from '../../ui-page/harness';
import { McpAppPermissionPrompt } from '../../../src/renderer/components/chat/McpAppPermissionPrompt';
import { showApproval } from '../../../src/renderer/lib/makerChatStore';

mountPage({ render: () => <div className="flex h-screen flex-col bg-[var(--surface)] p-4">
  <div data-conversation className="min-h-0 flex-1 overflow-auto"><button onClick={showApproval}>Request page tool</button><p>Monthly planner</p></div>
  <div className="relative flex flex-col gap-[10px]">
    <McpAppPermissionPrompt sessionId="task" floating />
    <textarea data-composer aria-label="Message" className="h-24 w-full resize-none rounded-xl border border-border bg-[var(--surface-elevated)] p-3 text-[var(--text-primary)]" />
  </div>
</div> });
