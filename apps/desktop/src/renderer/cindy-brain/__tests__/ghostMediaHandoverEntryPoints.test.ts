/** @vitest-environment jsdom */

import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/composerDraftStore', () => ({ getDraft: vi.fn(), saveDraft: vi.fn() }));

import { GHOST_MEDIA_HANDOVER_MIME } from '../../../shared/ghost';
import { getGhostMediaHandoverFromDataTransfer } from '../ghostMediaHandover';

function loadDropBranch(filename: string, attach: ReturnType<typeof vi.fn>) {
  const source = fs.readFileSync(new URL(filename, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let statements = '';
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node)) {
      const position = node.statements.findIndex((statement) => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some((declaration) => declaration.initializer
          && ts.isCallExpression(declaration.initializer)
          && declaration.initializer.expression.getText(ast) === 'getGhostMediaHandoverFromDataTransfer'));
      if (position >= 0) {
        statements = node.statements[position].getText(ast) + String.fromCharCode(10) + node.statements[position + 1].getText(ast);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(statements).not.toBe('');
  const compiled = ts.transpileModule(statements, {}).outputText;
  return (dataTransfer: DataTransfer) => new Function(
    'e', 'event', 'storageKey', 'sessionId', 'attachmentScope', 'NEW_MAKER_DRAFT_KEY', 't',
    'getGhostMediaHandoverFromDataTransfer', 'attachGhostMediaToSession', compiled,
  )({ dataTransfer, preventDefault: vi.fn(), stopPropagation: vi.fn() }, { dataTransfer }, 'draft', 'session', 'group', 'maker-draft', vi.fn(), getGhostMediaHandoverFromDataTransfer, attach);
}

describe.each([
  ['../../components/new-chat/ChatInput.tsx', 'draft'],
  ['../../features/cc-agent/CCAgentSessionView.tsx', 'session'],
  ['../../features/cc-agent/NewMakerDraftRoute.tsx', 'maker-draft'],
  ['../../features/bots/BotGroupChatView.tsx', 'group'],
])('%s Ghost drop branch', (filename, session) => {
  it.each(['media', 'preview'])('hands the %s source token intact to the shared attachment chain', (shape) => {
    const uri = 'cindy-ghost://helper/' + shape + '/' + 'a'.repeat(64) + '.png';
    const values: Record<string, string> = {
      'text/uri-list': uri,
      [GHOST_MEDIA_HANDOVER_MIME]: JSON.stringify({ uri, sourceToken: 'opaque-source' }),
    };
    const attach = vi.fn();
    loadDropBranch(filename, attach)({ types: Object.keys(values), getData: (type: string) => values[type] ?? '' } as unknown as DataTransfer);
    expect(attach).toHaveBeenCalledExactlyOnceWith({ uri, sourceToken: 'opaque-source' }, session, expect.any(Function));
  });
});
