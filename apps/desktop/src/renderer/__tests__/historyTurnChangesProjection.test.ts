import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { ChatMessage } from '../lib/makerChatStore';
import type { TurnChangeSetSummary } from '../../shared/turnChangeSet';

// Exercise the actual history-view build callback, rather than supplying the
// missing option directly to buildRenderItems (which already has unit coverage).
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'renderHistoryView') {
    const options = node.arguments[0] as ts.ObjectLiteralExpression;
    callback = (options.properties.find(p => ts.isPropertyAssignment(p)
      && p.name.getText(source) === 'build') as ts.PropertyAssignment).initializer as ts.ArrowFunction;
  }
  ts.forEachChild(node, visit);
}
visit(source);
const code = ts.transpileModule(`return (${callback!.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const changeSet: TurnChangeSetSummary = {
  id: 'changes-1', sessionId: 'session-1', anchorClientId: 'user-1', provider: 'codex',
  providerTurnId: 'turn-1', cwd: 'C:/fixture', state: 'complete', workspaceState: 'applied',
  isReversible: true, incompleteReasons: [], createdAt: 1, completedAt: 2,
  files: Array.from({ length: 5 }, (_, i) => ({ id: `file-${i}`, path: `note-${i}.txt`,
    oldPath: null, status: 'modified' as const, additions: 1, deletions: 1 })),
  fileCount: 5, additions: 5, deletions: 5,
};
function render(rows: ChatMessage[], streaming = false) {
  const bindings = { buildRenderItems, groupWorkRuns, results: new Map(),
    taskUpdates: undefined, ghostCardSnapshot: undefined, workingDir: 'C:/fixture',
    turnChangeSets: [changeSet], simplifiedBotConversation: false, sessionId: 'session-1',
    markdownImageTargetCacheRef: { current: new Map() }, cindyMakeSessionId: undefined,
    cindyMakeCompletionInComposer: undefined, subagentRunStatuses: undefined,
    isSessionStreaming: streaming };
  const build = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as
    (rows: ChatMessage[], streaming: boolean) => ReturnType<typeof buildRenderItems>['items'];
  return build(rows, streaming);
}
describe('history-view changed files cards', () => {
  it('keeps the completed five-file card before the next streaming turn', () => {
    const rows: ChatMessage[] = [
      { clientId: 'user-1', role: 'user', content: 'Edit five files' },
      { clientId: 'answer-1', role: 'assistant', content: 'Done' },
      { clientId: 'user-2', role: 'user', content: 'Continue' },
      { clientId: 'answer-2', role: 'assistant', content: 'Streaming', isStreaming: true },
    ];
    const items = render(rows, true);
    const cards = items.filter(item => item.type === 'turn_changes');
    expect(cards).toHaveLength(1);
    expect(cards[0].changeSet.files).toHaveLength(5);
    expect(items.map(item => item.key)).toEqual([
      'msg-user-1', 'msg-answer-1', 'turnchanges-changes-1', 'msg-user-2', 'msg-answer-2',
    ]);
    expect(render(rows.slice(0, 2)).filter(item => item.type === 'turn_changes')).toHaveLength(1);
  });
  it('does not pull a changed-files card from a turn outside the loaded history', () => {
    expect(render([{ clientId: 'user-2', role: 'user', content: 'Another page' }])
      .filter(item => item.type === 'turn_changes')).toEqual([]);
  });
});
