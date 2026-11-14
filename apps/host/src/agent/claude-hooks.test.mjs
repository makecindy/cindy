/*
 * 测试价值
 * - 生产入口与可观察结果：createHostAgentGraph 组装出的 ClaudeCodeAgent 读到的 claudeHooks
 *   （maker-core 在 claude-code/index.ts 交给 SDK）。
 * - 规则依据：桌面 maker-host/index.ts 给 Claude 装三组钩子（读图缩放、Bash 并发闸门、电脑操作
 *   防护），放行表第 10 行；Host 之前一个也没有。
 * - 断言：事件表的组成与桌面同一组函数拼出来的相同；读图钩子放过非图片；并发闸门的上限从
 *   本 profile 的代理资源设置现读，满员时第二条命令排队，第一条结束后放行；电脑操作防护拒绝
 *   Bash 里模拟键鼠，理由随本 owner 的 computer 插件开关变化。
 * - tier：unit（只构造实例、直接调钩子，不起子进程、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

const providerConfig = {
  grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
  list: async () => [], readKey: () => null,
  oauth: { readCachedGenericOAuthAccessToken: () => null },
  codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
};

/** Events and, per matcher, its tool and number of hooks. */
const shape = table => Object.fromEntries(Object.entries(table).map(([event, matchers]) =>
  [event, matchers.map(matcher => [matcher.matcher ?? null, matcher.hooks.length])]));

test('the Claude agent the Host assembles gets the desktop hooks: read-image, Bash gate, desktop-input guard', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-claude-hooks-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'claude-hooks-owner' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const graph = createHostAgentGraph({
    userDataDir: profile, harnessRoot: fixtureHarnessRoot(profile), gateway: null,
    binaryPath: path.join(profile, 'claude'), mcpRuntime: mcp, mcpProviders: [], storage: {}, providerConfig,
  });
  const hooks = graph.agent.deps.claudeHooks;
  assert.ok(hooks, 'the Claude agent has hooks');

  // The same composition as the desktop's (maker-host/index.ts), built from the same functions.
  const { createBashConcurrencyHooks, mergeClaudeHooks } = await import('../../../desktop/src/main/maker-host/claude-hooks/bash-concurrency-hook.ts');
  const { createReadImageHook } = await import('../../../desktop/src/main/maker-host/claude-hooks/read-image-hook.ts');
  const { createDesktopInputShellGuardHooks, SHELL_DESKTOP_INPUT_DISABLED_REASON } = await import('../../../desktop/src/main/maker-host/claude-hooks/desktop-input-shell-guard-hook.ts');
  const { SHELL_DESKTOP_INPUT_DENIAL_REASON } = await import('../../../../packages/maker-core/src/agents/shared/desktop-input-shell.ts');
  const { createCommandConcurrencyGate } = await import('../../../desktop/src/main/maker-host/command-concurrency-gate.ts');
  const { createMakerLogger } = await import('../../../desktop/src/main/maker-host/logger-adapter.ts');
  const logger = createMakerLogger('test');
  const desktop = mergeClaudeHooks(
    { PreToolUse: [{ matcher: 'Read', hooks: [createReadImageHook(logger)] }] },
    createBashConcurrencyHooks(createCommandConcurrencyGate({ readMaxConcurrent: () => 0, log: logger }), logger),
    createDesktopInputShellGuardHooks(() => true, logger),
  );
  assert.deepEqual(shape(hooks), shape(desktop));

  const pre = (tool, input, id) => ({ hook_event_name: 'PreToolUse', session_id: 'task-a', tool_name: tool, tool_input: input, tool_use_id: id });
  const signal = new AbortController().signal;
  const run = async (event, tool, input, id) => {
    const results = [];
    for (const matcher of hooks[event]) {
      if (matcher.matcher && matcher.matcher !== tool) continue;
      for (const hook of matcher.hooks) results.push(await hook(event === 'PreToolUse' ? pre(tool, input, id)
        : { hook_event_name: event, session_id: 'task-a', tool_name: tool, tool_use_id: id }, id, { signal }));
    }
    return results;
  };

  // Read of a file that is not an image passes through unchanged.
  const notes = path.join(profile, 'notes.txt');
  fs.writeFileSync(notes, 'text');
  const read = await run('PreToolUse', 'Read', { file_path: notes }, 'read-1');
  assert.equal(read.length, 1);
  assert.equal(read[0].hookSpecificOutput?.updatedInput, undefined);

  // The Bash gate reads this profile's agent resource settings at each admission.
  const { writeAgentResourceSetting } = await import('../../../desktop/src/main/maker-host/agent-resource-settings-store.ts');
  writeAgentResourceSetting('maxConcurrentCommands', 1);
  await run('PreToolUse', 'Bash', { command: 'true' }, 'bash-1');
  let secondAdmitted = false;
  const second = run('PreToolUse', 'Bash', { command: 'true' }, 'bash-2').then(() => { secondAdmitted = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(secondAdmitted, false, 'the second command waits while the only slot is taken');
  await run('PostToolUse', 'Bash', {}, 'bash-1');
  await second;
  assert.equal(secondAdmitted, true, 'it runs once the first one ends');
  await run('PostToolUse', 'Bash', {}, 'bash-2');
  // Back to the default (no limit): the guard checks below pass the gate without holding a slot.
  writeAgentResourceSetting('maxConcurrentCommands', 0);

  // Desktop input simulated in Bash is denied; the reason follows this owner's computer plugin.
  const keystroke = { command: `osascript -e 'tell application "System Events" to keystroke "x"'` };
  const decision = async () => (await run('PreToolUse', 'Bash', keystroke, `guard-${Math.random()}`))
    .map(result => result.hookSpecificOutput).filter(output => output?.permissionDecision === 'deny');
  const { ownerScopedPath } = await import('../../../desktop/src/main/ownerContext.ts');
  const settings = path.join(ownerScopedPath(), 'builtin-tools-settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  for (const [enabled, reason] of [[true, SHELL_DESKTOP_INPUT_DENIAL_REASON], [false, SHELL_DESKTOP_INPUT_DISABLED_REASON]]) {
    fs.writeFileSync(settings, JSON.stringify({ builtinTools: { computer: { enabled } } }));
    const { createPluginRegistry, resetPluginRegistry } = await import('../../../desktop/src/main/maker-host/plugins/index.ts');
    resetPluginRegistry();
    assert.equal(createPluginRegistry().isEnabled('computer'), enabled, 'fixture plugin setting is read');
    const denied = await decision();
    assert.equal(denied.length, 1, `denied with computer use ${enabled ? 'on' : 'off'}`);
    assert.equal(denied[0].permissionDecisionReason, reason);
  }
});


