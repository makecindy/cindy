import { mountPage } from '../../ui-page/harness';
import { SystemCard } from '../../../src/renderer/components/chat/SystemCard';

mountPage({
  render: ctx => (
    <main className="p-4">
      <SystemCard cardType="agent-switch" data={{
        fromAgentKind: 'codex', toAgentKind: 'codex', toModel: 'gpt-6-astra',
        fromAgentDeviceId: null, toAgentDeviceId: 'mini', toAgentDeviceName: 'Mac mini',
        handoffCoverage: ctx.data.coverage,
        resumed: !ctx.data.fallback, nativeHistory: ctx.data.fallback ? 'fallback' : 'restored',
        handoff: ctx.data.fallback ? 'Earlier requirements and latest tool outcome.' : 'Native history restored; continue with the current environment.',
      }} />
      {ctx.data.coverage && (
        <SystemCard cardType="context-rebuild" data={{
          reason: 'context-overflow',
          handoffCoverage: ctx.data.coverage,
        }} />
      )}
    </main>
  ),
});
