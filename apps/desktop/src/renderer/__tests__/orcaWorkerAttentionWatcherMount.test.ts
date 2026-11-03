import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';

// Guard tier (engineering-conventions §3.2): the long-lived sidebar owns the
// worker notification subscription. Moving it into the conditional ExpandedView
// loses completion/error notifications while collapsed. Hook behavior is tested
// by useWorkers.test.tsx; no isolated root-sidebar runtime harness exists, and
// mocking its expanded subtree would hide this mount-ownership regression.
it('owns worker attention in the sidebar root across collapsed-view unmounts', () => {
  const source = readFileSync(resolve(__dirname, '../features/cc-agent/CCAgentSidebarUpper.tsx'), 'utf8');
  const start = source.indexOf('export function CCAgentSidebarUpper()');
  const end = source.indexOf('function ExpandedView(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(source.slice(start, end)).toContain('useOrcaWorkerAttentionWatcher(sessionsHook.sessions, activeSessionId);');
  expect(source.slice(end)).not.toContain('useOrcaWorkerAttentionWatcher(');
});

// Hidden/local/remote metadata must reach the root notification dispatcher.
it('passes unfiltered local and remote metadata to notification dispatch', () => {
    const filename = resolve(__dirname, '../features/cc-agent/CCAgentSidebarUpper.tsx');
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let rawRemote: string | undefined;
    const props = new Map<string, string>();
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'remoteProjectSessionsRaw' && !rawRemote) {
        rawRemote = node.initializer?.getText(source);
      }
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'ExpandedView') {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
            props.set(attribute.name.getText(source), attribute.initializer.expression?.getText(source) ?? '');
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(rawRemote).toContain('useSyncExternalStore');
    expect(rawRemote).toContain('remoteProjectsStore.getMergedRemoteSessions');
    expect(props.get('allSessionsForNotification')).toBe('allSessionsForAttentionRaw');
    expect(props.get('remoteSessionsForNotification')).toBe('remoteProjectSessionsRaw');
  });
