import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { projectSessionRuntimeControl } from '../../../../main/maker-ipc/sessionRuntimeControl';
import { dbToMakerAgentKind } from '../../../../shared/agentKindConversion';

// Execute the actual SessionView send callback up to its before-enqueue boundary.
// A disconnected old Harness must not prevent main from restoring the saved one.
const source = ts.createSourceFile('CCAgentSessionView.tsx', readFileSync(
  new URL('../CCAgentSessionView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSend' &&
      node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('SessionView send callback missing');
const code = ts.transpileModule('(' + callback.getText(source) + ')', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

it.each(['recovery', 'ordinary', 'missing-offer', 'pending', 'new-provider', 'new-model', 'new-intent', 'no-composer-offer'])(
  'defers old-Harness authentication only for the unchanged recovery route (%s)', async (scenario) => {
    const auth = vi.fn(async () => ({ proceed: false }));
    const beforeEnqueue = vi.fn(async () => false); // Stop before unrelated persistence/workdir work.
    const route = { agentKind: 'codex', model: 'retired', providerId: 'removed' };
    const session = { source: scenario === 'ordinary' ? 'user' : 'bot',
      runtimeBaselineRecoveryPending: scenario !== 'missing-offer',
      runtimePending: scenario === 'pending' ? route : null, runtimeEffective: route };
    const send = runInNewContext(code, { readOnly: false, cindyMakeInputLocked: false,
      invalidateHistoryRecoveryNavigation: vi.fn(), getDataOwnerGeneration: () => 1,
      remoteDeviceId: null, displayAgentKind: 'codex', isCodex: true, session,
      agentSwitchIntent: scenario === 'new-intent' ? { target: 'pi' } : null,
      vendorAuthGate: { checkAndConfirm: auth },
    });
    await send('hello', scenario === 'new-model' ? 'new' : 'retired', '', 'ask', undefined, undefined, {
      literalText: true, baselineRecovery: scenario !== 'no-composer-offer',
      providerId: scenario === 'new-provider' ? 'new' : 'removed', beforeEnqueue,
    });
    expect(auth).toHaveBeenCalledTimes(scenario === 'recovery' ? 0 : 1);
    expect(beforeEnqueue).toHaveBeenCalledTimes(scenario === 'recovery' ? 1 : 0);
  });

it('authenticates the recovered Harness on subsequent sends after a legacy projection patch', async () => {
  const recovered = { agentKind: 'pi' as const, model: 'saved', providerId: 'connected', effort: null, fastMode: false };
  const session = { source: 'bot', agentKind: 'codex', runtimeBaselineRecoveryPending: true,
    ...projectSessionRuntimeControl('recovered-companion', recovered) };
  const auth = vi.fn(async (vendor: string) => ({ proceed: vendor === 'pi' }));
  const beforeEnqueue = vi.fn(async () => false);
  const displayAgentKind = dbToMakerAgentKind(session.agentKind);
  const send = runInNewContext(code, { readOnly: false, cindyMakeInputLocked: false,
    invalidateHistoryRecoveryNavigation: vi.fn(), getDataOwnerGeneration: () => 1,
    remoteDeviceId: null, displayAgentKind, isCodex: displayAgentKind === 'codex', session,
    agentSwitchIntent: null, vendorAuthGate: { checkAndConfirm: auth },
  });
  await send('hello again', recovered.model, '', 'ask', undefined, undefined, {
    literalText: true, providerId: recovered.providerId, beforeEnqueue,
  });
  expect(auth).toHaveBeenCalledWith('pi', expect.anything());
  expect(beforeEnqueue).toHaveBeenCalledOnce();
});
