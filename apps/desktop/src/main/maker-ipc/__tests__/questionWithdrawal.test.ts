import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Regression: a model withdrawal needs the same reason in the persisted row and all clients.
// Execute the production event preparation and default cancellation decision without Electron.
// Minimal input: one async question dismissal; tier: unit (host event ingress).
function declaration(file: string, name: string) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const node = ast.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing production function: ${name}`);
  return node.getText(ast).replace(/^export /, '');
}
const code = ts.transpileModule([
  declaration('../sessionEventPreparation.ts', 'prepareSessionEvent'),
  declaration('../register.ts', 'defaultDecisionForPending'),
  'return { prepareSessionEvent, defaultDecisionForPending };',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const runtime = new Function('readChannelToolScope', 'MAKER_PUSH', code)(() => null,
  { INTERACTION_DISMISSED: 'maker:interaction-dismissed' });

it('persists and broadcasts withdrawal without turning it into a user answer', () => {
  const request = { kind: 'ask_user_question', requestId: 'q1', delivery: 'async', questions: [{ question: 'Logged in?' }] };
  const entry = { kind: 'ask_user_question', request, persistId: 'row1', resolve: vi.fn() };
  const deps = {
    isFencedStaleSessionTerminal: () => false,
    redactEventForRenderer: (event: unknown) => event,
    handleAgentIslandInteractionDismissed: vi.fn(),
    clearPendingInteraction: vi.fn(() => entry),
    defaultDecisionForPending: runtime.defaultDecisionForPending,
    persistInteractionDecision: vi.fn(), broadcastToAllWindows: vi.fn(),
  };
  runtime.prepareSessionEvent(deps, { id: 'task', instanceId: 'instance' }, {
    type: 'interaction_dismissed', source: 'codex',
    data: { requestId: 'q1', reason: 'question_withdrawn', withdrawalReason: '已从日志确认', resolvedAs: 'deny' },
  });
  expect(entry.resolve).toHaveBeenCalledWith({ kind: 'ask_user_question', answers: {}, dismissed: true });
  expect(deps.persistInteractionDecision).toHaveBeenCalledWith('task', 'row1', 'ask_user_question', request,
    { kind: 'ask_user_question', answers: {}, dismissed: true, withdrawalReason: '已从日志确认' });
  expect(deps.broadcastToAllWindows).toHaveBeenCalledWith('maker:interaction-dismissed', {
    sessionId: 'task', requestId: 'q1', reason: 'question_withdrawn', withdrawalReason: '已从日志确认', resolvedAs: 'deny',
  });
});
