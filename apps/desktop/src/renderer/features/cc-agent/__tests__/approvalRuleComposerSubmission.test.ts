import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isApprovalRuleCommand } from '../../../../shared/approvalRuleCommand';

// Invoke the actual SessionView send callback at its first dispatch boundary.
const source = ts.createSourceFile('CCAgentSessionView.tsx', readFileSync(
  resolve(__dirname, '../CCAgentSessionView.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let send: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSend'
    && node.initializer && ts.isCallExpression(node.initializer)) send = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!send) throw new Error('SessionView send callback missing');
const callbackSource = ts.transpileModule('(' + send.getText(source) + ')', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function setup(result: object = { kind: 'saved', revision: 1, ruleId: 'rule', clientId: 'client' }, realAgentKind = 'claude-code') {
  const approvalRuleCommand = vi.fn(async () => result);
  const maybeDispatchDesktopSlashCommand = vi.fn();
  const sendMessage = vi.fn();
  const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
  const context = {
    readOnly: false, cindyMakeInputLocked: false, isApprovalRuleCommand,
    personalRuleContext: 'existing:claude-code:auto:false',
    refreshPersonalRules: vi.fn(), setPersonalRuleStatus: vi.fn(),
    sessionId: 'existing', session: { id: 'existing', source: 'desktop', status: 'active', remoteHostId: null },
    realAgentKind, remoteDeviceId: undefined,
    getDataOwnerGeneration: () => 1,
    isDataOwnerGenerationCurrent: () => true,
    currentSessionIdRef: { current: 'existing' },
    window: { electronAPI: { maker: { approvalRuleCommand } } },
    toast, t: (key: string) => key, log: { warn: vi.fn() },
    invalidateHistoryRecoveryNavigation: () => { throw new Error('normal send path'); },
    maybeDispatchDesktopSlashCommand, sendMessage,
  };
  const handleSend = runInNewContext(callbackSource, context) as (
    message: string, model: string, effort: string, permissionMode: string,
    files?: unknown[], mentions?: unknown[], opts?: object,
  ) => Promise<boolean>;
  return { handleSend, approvalRuleCommand, maybeDispatchDesktopSlashCommand, sendMessage, toast, context };
}

describe('existing task approval command composer boundary', () => {
  it('returns read-only per-end status to the composer without model dispatch or a saved acknowledgement', async () => {
    const statuses = [{ harness: 'codex', state: 'not-effective', reason: 'auto-required' }];
    const h = setup({ kind: 'status', statuses });
    expect(await h.handleSend('/approval-rule status', 'model', 'medium', 'auto')).toBe(true);
    expect(h.context.setPersonalRuleStatus).toHaveBeenCalledWith({ sessionId: 'existing',
      context: h.context.personalRuleContext, owner: 1, statuses });
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['saved', 'unsupported', 'failed'] as const)('preserves requirement JSON and clears input only after %s', async outcome => {
    const h = setup(outcome === 'unsupported' ? { kind: 'unsupported', reason: 'syntax' } : undefined);
    if (outcome === 'failed') h.approvalRuleCommand.mockRejectedValueOnce(new Error('marker write failed'));
    const text = '/approval-rule set user --requirements ' + JSON.stringify({ id: 'release', targets: ['claude-code'], text: '  原文\r\n保留 🧪\u2028\u2029  ' });
    expect(await h.handleSend(text, 'model', 'medium', 'auto')).toBe(outcome === 'saved');
    expect(h.approvalRuleCommand).toHaveBeenCalledWith({ sessionId: 'existing', text });
    expect(h.sendMessage).not.toHaveBeenCalled(); expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
  });
  it.each(['claude-code', 'pi', 'codex'])('forwards an explicit complete mapping unchanged from a %s task without Agent dispatch', async harness => {
    const h = setup({ kind: 'saved', revision: 3, ruleId: 'cc', ruleIds: ['cc', 'pi'], clientId: 'client' }, harness);
    const text = '/approval-rule ask user --targets {"claude-code":"git push","pi":"git status"}';
    expect(await h.handleSend(text, 'model', 'medium', 'auto')).toBe(true);
    expect(h.approvalRuleCommand).toHaveBeenCalledWith({ sessionId: 'existing', text });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledWith('ccAgent.approvalRule.saved');
  });
  it.each(['pi', 'codex'])('handles a %s task rule before Skills or optimistic input without inventing target identity', async harness => {
    const h = setup(undefined, harness);
    const text = '/approval-rule ask user -- git push';
    expect(await h.handleSend(text, 'model', 'medium', 'auto')).toBe(true);
    expect(h.approvalRuleCommand).toHaveBeenCalledWith({ sessionId: 'existing', text });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
  });
  it('handles a reserved command before a same-name Skill and before optimistic send', async () => {
    const h = setup();
    expect(await h.handleSend('/approval-rule deny user -- git push', 'model', 'medium', 'default')).toBe(true);
    expect(h.approvalRuleCommand).toHaveBeenCalledWith({ sessionId: 'existing',
      text: '/approval-rule deny user -- git push' });
    expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledWith('ccAgent.approvalRule.saved');
  });

  it('retains the exact ask draft when activation fails in Main', async () => {
    const h = setup();
    h.approvalRuleCommand.mockRejectedValueOnce(new Error('activation failed'));
    expect(await h.handleSend('/approval-rule ask user -- git push', 'model', 'medium', 'default')).toBe(false);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith('ccAgent.approvalRule.failed');
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the original composer input when Main rejects the save', async () => {
    const h = setup({ kind: 'unsupported', reason: 'context' });
    expect(await h.handleSend('/approval-rule deny user -- git push', 'model', 'medium', 'default')).toBe(false);
    expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('names an old host conflict and keeps the draft without dispatching to the Agent', async () => {
    const h = setup({ kind: 'error', code: 'host-identity-conflict' });
    expect(await h.handleSend('/approval-rule publish', 'model', 'medium', 'default')).toBe(false);
    expect(h.toast.error).toHaveBeenCalledWith('ccAgent.approvalRule.hostIdentityConflict');
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
  });

  it('does not turn a literal voice or handoff send into a rule edit', async () => {
    const h = setup();
    await expect(h.handleSend('/approval-rule deny user -- git push', 'model', 'medium', 'default',
      undefined, undefined, { literalText: true })).rejects.toThrow('normal send path');
    expect(h.approvalRuleCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['attachment', '/approval-rule deny user -- git push', [{}], []],
    ['reference', '/approval-rule deny user -- git push', [], [{}]],
    ['multiline', '/approval-rule deny user -- git push\necho ok', [], []],
  ])('keeps the %s input without dispatching to Main or Agent', async (_label, text, files, mentions) => {
    const h = setup();
    expect(await h.handleSend(text, 'model', 'medium', 'default', files, mentions)).toBe(false);
    expect(h.approvalRuleCommand).not.toHaveBeenCalled();
    expect(h.maybeDispatchDesktopSlashCommand).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});
