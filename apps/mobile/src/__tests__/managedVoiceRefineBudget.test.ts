import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every dictation entry that refines through the managed voice session must
// pass that session's request allowance, or pause refinement can spend the
// requests the final text needs (the voice-server then rejects it with 409).
const ENTRIES = [
  'app/sessions/new.tsx',
  'app/sessions/[sessionId].tsx',
  'src/session/askCardVoiceStart.ts',
];

function controllerOptionNames(file: string): string[][] {
  const source = ts.createSourceFile(file, readFileSync(resolve(process.cwd(), file), 'utf8'),
    ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls: string[][] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'createMobileVoiceControllerSession') {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        calls.push(options.properties.flatMap((prop) => (prop.name ? [prop.name.getText(source)] : [])));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

describe.each(ENTRIES)('%s managed dictation', (file) => {
  it('passes the managed session refine allowance wherever it passes the managed refiner', () => {
    const calls = controllerOptionNames(file).filter((names) => names.includes('refinerTargetProvider'));
    expect(calls.length).toBeGreaterThan(0);
    for (const names of calls) expect(names).toContain('refineRequestBudget');
  });
});
