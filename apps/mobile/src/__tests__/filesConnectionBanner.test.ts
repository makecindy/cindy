import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { resolveConnectionBannerVisibility, resolveEffectiveConnectionError } from '@/components/connectionBannerVisibility';

// Exercise the real page expressions and banner eligibility function; native paint is irrelevant.
const page = ts.createSourceFile('files.tsx', readFileSync(resolve(process.cwd(), 'app/files/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const banner = ts.createSourceFile('banner.tsx', readFileSync(resolve(process.cwd(), 'src/components/ConnectionBanner.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = banner.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useShowConnectionBanner');
if (!hook) throw new Error('Missing production banner eligibility function');
const hookCode = ts.transpileModule(hook.getText(banner).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
// This expression fixture has no native network; live network transitions are
// exercised through the real component in connectionBannerRecovery.test.tsx.
const useShowConnectionBanner = new Function('resolveConnectionBannerVisibility', 'resolveEffectiveConnectionError', 'useLocalNetworkStatus', hookCode + '\nreturn useShowConnectionBanner;')(resolveConnectionBannerVisibility, resolveEffectiveConnectionError, () => 'unknown');
let visibility: ts.Expression | undefined, render: ts.Expression | undefined, footer: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(page) === 'showConnectionBanner') visibility = node.initializer;
  if (ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression) && node.expression.whenTrue.getText(page).includes('<ConnectionBanner')) render = node.expression;
  if (ts.isJsxExpression(node) && node.expression?.getText(page).includes("t('files.browser.footerOnline')")) footer = node.expression;
  ts.forEachChild(node, visit);
}
visit(page);
function evaluate(expression: ts.Expression | undefined, bindings: Record<string, unknown>) {
  if (!expression) throw new Error('Missing production file-page expression');
  const code = ts.transpileModule('const result = ' + expression.getText(page) + ';', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), code + '\nreturn result;')(...Object.values(bindings));
}

describe('mobile files page connection banner noise budget', () => {
  it.each([
    ['online', null, null, false, false],
    ['online', 'request failed', null, false, true],
    ['online', null, null, true, true],
    ['stopped', null, { kind: 'auth' }, false, true],
    ['stopped', null, null, false, true],
    ['connecting', null, null, false, false],
  ])('renders degraded-link feedback for %s/error=%s/issue=%s/unresponsive=%s', (status, error, connectionIssue, deviceUnresponsive, expected) => {
    const showConnectionBanner = evaluate(visibility, { useShowConnectionBanner, status, error, connectionIssue, deviceUnresponsive });
    const loadDirectory = vi.fn();
    const element = evaluate(render, { React, ConnectionBanner: 'connection-banner', showConnectionBanner, status, error, connectionIssue, deviceUnresponsive, lastSyncedAt: null, loading: false, loadDirectory });
    expect(element !== null).toBe(expected);
    if (element) {
      expect(element.props).toMatchObject({ density: 'compact', variant: 'inline', status, error, issue: connectionIssue, deviceUnresponsive });
      element.props.onSync();
      expect(loadDirectory).toHaveBeenCalledOnce();
    }
  });
  it('keeps the footer realtime-sync hint available independently of the banner', () => {
    const t = (key: string) => key;
    expect(evaluate(footer, { notice: null, status: 'online', t })).toBe('files.browser.footerOnline');
    expect(evaluate(footer, { notice: null, status: 'connecting', t })).toBe('files.browser.footerConnecting');
  });
});
