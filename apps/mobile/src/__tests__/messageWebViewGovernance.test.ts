import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import ts from 'typescript';
import {
  getMobileMessageWebViewMetrics,
  registerMobileMessageWebView,
  resetMobileMessageWebViewMetrics,
} from '@/session/mobileMessageWebViewMetrics';

describe('mobile message WebView lifecycle accounting', () => {
  beforeEach(() => resetMobileMessageWebViewMetrics());

  it('counts active instances by kind and makes cleanup idempotent', () => {
    const releaseMermaid = registerMobileMessageWebView('mermaid');
    const releaseMath = registerMobileMessageWebView('math');

    expect(getMobileMessageWebViewMetrics()).toMatchObject({
      mounted: 2,
      mountedByKind: { mermaid: 1, math: 1, media: 0, composer: 0 },
      mounts: 2,
      unmounts: 0,
    });

    releaseMermaid();
    releaseMermaid();
    releaseMath();
    expect(getMobileMessageWebViewMetrics()).toMatchObject({
      mounted: 0,
      mountedByKind: { mermaid: 0, math: 0, media: 0, composer: 0 },
      mounts: 2,
      unmounts: 2,
    });
  });
});

// Actual native rich-view lifecycle is covered by richContentViews.test.tsx.
// Keep the consumer gate behavioral: a hidden item must pass inactive to the host.
it.each([false, true])('passes visible=%s to both rich-content hosts', (active) => {
  const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
  const tree = ts.createSourceFile('renderer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ['ViewabilityGatedMermaidDiagram', 'ViewabilityGatedMathFormula'].includes(node.name.getText(tree))) functions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const code = ts.transpileModule(functions.map((node) => 'const ' + node.getText(tree) + ';').join('\n'), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const bindings = { React, memo: (component: unknown) => component, useContext: () => active, MessageHeavyContentVisibilityContext: {}, MermaidDiagramWebView: 'MermaidHost', MathFormulaWebView: 'MathHost' };
  const hosts = new Function(...Object.keys(bindings), code + '\nreturn [ViewabilityGatedMermaidDiagram, ViewabilityGatedMathFormula];')(...Object.values(bindings));
  if (hosts.length !== 2) throw new Error('Missing production rich-content visibility gates');
  for (const render of hosts) expect(render({ source: 'content', testID: 'rich' }).props).toMatchObject({ active, source: 'content', testID: 'rich' });
});
