import { isSharedTaskPeer, sharedTaskHostPeer } from '@cindy/device-link';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const composer = readFileSync(resolve(__dirname, '../components/new-chat/ChatInput.tsx'), 'utf8');
const sessionView = readFileSync(
  resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'),
  'utf8',
);
const ast = ts.createSourceFile('session.tsx', sessionView, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode<T extends ts.Node>(matches: (node: ts.Node) => node is T): T {
  const nodes: T[] = [];
  const visit = (node: ts.Node) => {
    if (matches(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

// Execute the production expressions without mounting the full session/runtime.
function evaluate(expression: ts.Expression, scope: Record<string, unknown>): unknown {
  const { outputText } = ts.transpileModule(`return (${expression.getText(ast)});`, {
    fileName: 'composer-expression.tsx',
    compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'createElement' },
  });
  return new Function(...Object.keys(scope), outputText)(...Object.values(scope));
}

describe('Cindy Make composer presentation', () => {
  it('opens preflight in place and only routes standalone diagnostics to their container', () => {
    expect(composer).toContain('<CindyMakePreflightDialog');
    expect(composer).toContain("makeResult.kind === 'preflight'");
    expect(composer).toContain('setMakePreflight({');
    expect(composer).toContain('else if (makeResult.sessionId !== sourceSessionId)');
  });

  it('keeps question, plan and permission prompts ahead of the first-execution input lock', () => {
    const promptHost = sessionView.indexOf('<InteractionPromptHost');
    const mask = sessionView.indexOf('<CindyMakeComposerMask');
    const input = sessionView.indexOf('<ChatInput', mask);
    expect(promptHost).toBeGreaterThan(-1);
    expect(mask).toBeGreaterThan(promptHost);
    expect(input).toBeGreaterThan(mask);
    const promptEnd = sessionView.indexOf('</InteractionPromptHost>');
    // Parse the real guard so grouping/formatting does not change the contract.
    let condition: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isConditionalExpression(node) && node.getStart(ast) > promptEnd && node.getStart(ast) < mask
          && node.whenTrue.kind === ts.SyntaxKind.NullKeyword
          && node.condition.getText(ast).includes('pendingGhostGrantConfirm')) {
        condition = node.condition;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(condition).toBeDefined();
    const prompts = ['pendingPlanReview', 'pendingPermission', 'pendingAskUser', 'pendingPluginSetup',
      'pendingIssueConfirm', 'pendingRenameSessionsConfirm', 'pendingGhostGrantConfirm'];
    const hidesComposer = new Function('isSharedTaskPeer', 'remoteDeviceId', ...prompts,
      `return Boolean(${condition!.getText(ast)});`);
    for (const deviceId of [undefined, 'own-device', sharedTaskHostPeer('m', 'desktop')]) {
      expect(hidesComposer(isSharedTaskPeer, deviceId, ...prompts.map(() => false))).toBe(false);
      for (const active of prompts) {
        expect(hidesComposer(isSharedTaskPeer, deviceId, ...prompts.map((name) => name === active)),
          `${deviceId ?? 'local'}: ${active}`).toBe(deviceId !== sharedTaskHostPeer('m', 'desktop'));
      }
    }
    expect(sessionView).toContain('if (cindyMakeInputLocked) return false;');
    expect(sessionView).not.toContain('CindyMakeResumeCard');
    const testCard = sessionView.indexOf('<CindyMakeTestCard', mask);
    expect(testCard).toBeGreaterThan(mask);
    expect(testCard).toBeLessThan(input);
  });

  it('keeps recovery actions in the ordinary input top slot with the current task and message', () => {
    const input = findNode((node): node is ts.JsxSelfClosingElement =>
      ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'ChatInput');
    const topSlot = input.attributes.properties.find((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'topSlot');
    if (!topSlot || !ts.isJsxAttribute(topSlot) || !topSlot.initializer
        || !ts.isJsxExpression(topSlot.initializer) || !topSlot.initializer.expression) {
      throw new Error('ChatInput must expose its recovery actions through topSlot');
    }
    const expression = topSlot.initializer.expression;
    const renderSlot = (cindyMakeRecoveryId: string | null, session: { id: string } | null) =>
      evaluate(expression, {
        createElement,
        CindyMakeEditingActions: 'editing-actions',
        cindyMakeRecoveryId,
        session,
        remoteMakeCards: { blocked: false, handlesSession: false, supported: false },
      });

    // Recovery must still reach ChatInput, never replace it with a blocking card.
    for (let child: ts.Node = input; !ts.isJsxExpression(child.parent); child = child.parent) {
      const parent = child.parent;
      if (!ts.isConditionalExpression(parent)) continue;
      expect(child).toBe(parent.whenFalse);
      expect(Boolean(evaluate(parent.condition, {
        isSharedTaskPeer, remoteDeviceId: undefined,
        pendingPlanReview: null, pendingPermission: null, pendingAskUser: null,
        pendingPluginSetup: null, pendingIssueConfirm: null,
        pendingRenameSessionsConfirm: null, pendingGhostGrantConfirm: null,
        sessionBinding: { attached: false }, sessionId: 'task-a', session: { id: 'task-a' },
        cindyMakeComposerPhase: null, cindyMakePendingTest: null,
        cindyMakeRecoveryId: 'continued-completion',
        remoteMakeCards: { blocked: false, handlesSession: false, supported: false },
        worktreePreparing: false, smoothedBranchName: null, shareSelectionActive: false,
      })), parent.condition.getText(ast)).toBe(false);
    }

    for (const sessionId of ['task-a', 'task-b']) {
      for (const messageId of ['completion-a', 'completion-b']) {
        const actions = renderSlot(messageId, { id: sessionId });
        expect(isValidElement(actions)).toBe(true);
        if (!isValidElement(actions)) throw new Error('Missing recovery actions');
        expect(actions.type).toBe('editing-actions');
        expect(actions.key).toBe(`${sessionId}:${messageId}`);
        expect(actions.props).toEqual({ sessionId, messageId });
      }
    }
    expect(renderSlot(null, { id: 'task-a' })).toBeUndefined();
    expect(renderSlot('completion-a', null)).toBeUndefined();
    expect(renderSlot(null, null)).toBeUndefined();
  });

  it('locks preparation and first-test input but leaves continued editing unlocked', () => {
    const lock = findNode((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText(ast) === 'cindyMakeInputLocked');
    expect(lock.initializer).toBeDefined();
    for (const phase of [null, 'preparing']) {
      for (const pendingTest of [null, { completionId: 'first-completion' }]) {
        for (const recoveryId of [null, 'continued-completion']) {
          expect(evaluate(lock.initializer!, {
            cindyMakeComposerPhase: phase,
            cindyMakePendingTest: pendingTest,
            cindyMakeRecoveryId: recoveryId,
            remoteMakeCards: { blocked: false, handlesSession: false, supported: false },
          })).toBe(Boolean(phase || pendingTest));
        }
      }
    }
  });

  it('keeps recovery actions inside the editable composer instead of replacing it', () => {
    const ast = ts.createSourceFile('session.tsx', sessionView, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let topSlot: ts.JsxAttribute | undefined;
    let inputLock: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
          && node.tagName.getText(ast) === 'ChatInput') {
        topSlot = node.attributes.properties.find((prop): prop is ts.JsxAttribute =>
          ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'topSlot');
      }
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'cindyMakeInputLocked') {
        inputLock = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(topSlot).toBeDefined();
    expect(topSlot!.getText(ast)).toMatch(/cindyMakeRecoveryId\s*&&\s*session\s*\?/);
    expect(topSlot!.getText(ast)).toContain('<CindyMakeEditingActions');
    expect(topSlot!.getText(ast)).toContain('sessionId={session.id}');
    expect(topSlot!.getText(ast)).toContain('messageId={cindyMakeRecoveryId}');
    expect(inputLock).toBeDefined();
    expect(inputLock!.getText(ast)).toContain('cindyMakeComposerPhase || cindyMakePendingTest');
    expect(inputLock!.getText(ast)).not.toContain('cindyMakeRecoveryId');
  });
});
