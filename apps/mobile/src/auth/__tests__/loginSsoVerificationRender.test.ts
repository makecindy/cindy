import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// P1-1: a failed first code request leaves codeRequested=false; its error must
// still render inside the panel. Run the production callback in both substates.
const source = ts.createSourceFile('login.tsx', readFileSync(resolve(process.cwd(), 'app/(auth)/login.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'renderSsoVerification') callback = node.initializer;
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('Missing production SSO verification callback');
const compiled = ts.transpileModule('const render = ' + callback.getText(source) + ';', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;

describe('SSO verification error visibility (P1-1)', () => {
  it.each([false, true])('shows the request error inside the panel when codeRequested=%s', (codeRequested) => {
    const host = ({ children, label, testID }: any) => React.createElement('div', { 'data-testid': testID }, label, children);
    const bindings = { React, auth: { loginState: { step: 'sso-verification', codeRequested, targetMasked: 'a***@example.invalid' }, isBusy: false },
      ssoVerificationCode: '', disabled: false, error: 'Code request failed',
      setSsoVerificationCode: () => {}, loginText: (key: string) => key, backNode: null,
      errorNode: React.createElement('span', { role: 'alert' }, 'Code request failed'),
      LoginPanel: host, LoginTitleBlock: host, LoginPrimaryButton: host, LoginResendCountdown: host, CodeInput: host };
    const render = new Function(...Object.keys(bindings), compiled + '\nreturn render;')(...Object.values(bindings));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain('data-testid="login.panel.sso-verification"');
    expect(markup).toContain('<span role="alert">Code request failed</span>');
    expect(markup).toContain(codeRequested ? 'login.ssoVerificationVerifyButton' : 'login.ssoVerificationSendButton');
  });
});
