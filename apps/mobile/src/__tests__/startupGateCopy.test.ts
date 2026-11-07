import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
import { loginMessages } from '@/auth/loginMessages';
import { getMobileConfigIssues } from '@/config/env';

// SC-4: execute the actual blocked-screen JSX and config-issue renderer. Catalog-only
// tests missed hardcoded rendered text and swapped reset/retry callbacks. No native app starts.
const layout = ts.createSourceFile('layout.tsx', readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const login = ts.createSourceFile('login.tsx', readFileSync(resolve(process.cwd(), 'app/(auth)/login.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let blockedExpression: ts.Expression | undefined;
let configRenderer: ts.Expression | undefined;
function visitLayout(node: ts.Node) {
  if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression) && ts.isStringLiteral(node.expression.right) && node.expression.right.text === 'error') {
    const assignment = (child: ts.Node) => {
      if (ts.isBinaryExpression(child) && ts.isIdentifier(child.left) && child.left.text === 'body') blockedExpression ??= child.right;
      ts.forEachChild(child, assignment);
    };
    assignment(node.thenStatement);
  }
  ts.forEachChild(node, visitLayout);
}
function visitLogin(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'renderConfigIssues') configRenderer = node.initializer;
  ts.forEachChild(node, visitLogin);
}
visitLayout(layout); visitLogin(login);
if (!blockedExpression || !configRenderer) throw new Error('startup copy render entry missing');
const compilerOptions = { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 };
const blockedCode = ts.transpileModule(`const rendered = ${blockedExpression.getText(layout)};`, { compilerOptions }).outputText;
const configCode = ts.transpileModule(`const render = ${configRenderer.getText(login)}; const rendered = render();`, { compilerOptions }).outputText;

describe('startup gate localized rendering', () => {
  it.each([false, true])('renders the blocked reason and selects reset-to-dev=%s', (canResetToDev) => {
    const retry = vi.fn(); const resetToDev = vi.fn();
    const element = runInNewContext(`${blockedCode}
rendered`, {
      React, MobileLoginHandoffStage: 'brand', StartupGateBlockedContent: 'blocked',
      endpointGate: { canResetToDev, reason: 'offline fixture', retry, resetToDev },
      loginText: (key: keyof typeof loginMessages.en) => loginMessages.en[key],
    });
    const blocked = element.props.children;
    expect(blocked.type).toBe('blocked');
    expect(blocked.props.title).toBe(loginMessages.en.endpointGateTitle);
    expect(blocked.props.subtitle).toBe(loginMessages.en.endpointGateSubtitle.replace('{reason}', 'offline fixture'));
    expect(blocked.props.actionLabel).toBe(loginMessages.en[canResetToDev ? 'endpointGateResetToDev' : 'retry']);
    blocked.props.onAction();
    expect(retry).toHaveBeenCalledTimes(canResetToDev ? 0 : 1);
    expect(resetToDev).toHaveBeenCalledTimes(canResetToDev ? 1 : 0);
  });

  it('renders invalid config through its message key for all five locales', () => {
    const configIssues = getMobileConfigIssues({ EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'ftp://auth.example.invalid' });
    expect(configIssues).toHaveLength(1);
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', "es", "fr", "de", "pt-PT", "pt-BR"] as const) {
      const catalog = loginMessages[locale];
      const rendered = runInNewContext(`${configCode}
rendered`, {
        React, configIssues, LoginPanel: 'panel', LoginTitleBlock: 'title', View: 'view', Text: 'text',
        configIssueStyles: { list: {}, line: {} }, loginText: (key: keyof typeof catalog) => catalog[key],
      });
      const issueText = rendered.props.children[1].props.children[0];
      expect(issueText.props.children.join('')).toBe(`${configIssues[0].key}: ${catalog[configIssues[0].messageKey]}`);
      expect(catalog[configIssues[0].messageKey].trim(), locale).not.toBe('');
      expect(catalog.endpointGateTitle.trim(), locale).not.toBe('');
      expect(catalog.endpointGateSubtitle, locale).toContain('{reason}');
      expect(catalog.endpointGateResetToDev.trim(), locale).not.toBe('');
      expect(catalog.retry.trim(), locale).not.toBe('');
    }
  });
});