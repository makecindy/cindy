import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { projectScheduleEvent } from '@cindy/maker-shared/schedule-events';
it('refreshes the actual notice effect when a completed run is later bound to the task', () => {
  const source = ts.createSourceFile('screen.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let dependencies: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useCallback'
      && node.arguments[0]?.getText(source).includes('setScheduleFailure') && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])) {
      dependencies = node.arguments[1].elements.map((element) => element.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const event = projectScheduleEvent({ type: 'session-bound', scheduleId: 'schedule', runId: 'run', sessionId: 'task' });
  expect(event.refresh.sessionIndex).toBe(true);
  expect(event.refresh.unreadSummary).toBe(false);
  expect(dependencies).toContain('scheduleEventSnapshot.sessionIndexVersion');
  expect(dependencies).toContain('remoteHistoryAvailable');
  expect(dependencies).toContain('appStateActive');
});
