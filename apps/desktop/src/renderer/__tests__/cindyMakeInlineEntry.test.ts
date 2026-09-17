import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { isMeetingPeer } from '@cindy/device-link';

const composer = readFileSync(resolve(__dirname, '../components/new-chat/ChatInput.tsx'), 'utf8');
const sessionView = readFileSync(
  resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'),
  'utf8',
);

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
    const ast = ts.createSourceFile('session.tsx', sessionView, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
    const hidesComposer = new Function('isMeetingPeer', 'remoteDeviceId', ...prompts,
      `return Boolean(${condition!.getText(ast)});`);
    for (const deviceId of [undefined, 'own-device', 'meeting~m~host']) {
      expect(hidesComposer(isMeetingPeer, deviceId, ...prompts.map(() => false))).toBe(false);
      for (const active of prompts) {
        expect(hidesComposer(isMeetingPeer, deviceId, ...prompts.map((name) => name === active)),
          `${deviceId ?? 'local'}: ${active}`).toBe(deviceId !== 'meeting~m~host');
      }
    }
    expect(sessionView).toContain('if (cindyMakeComposerPhase) return false;');
  });
});
