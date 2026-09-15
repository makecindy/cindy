import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { codexTextOnlyTurnConfig } from './text-only-turn.js';

it('uses a trusted native hook whose blocking exit includes stderr', () => {
  const config = codexTextOnlyTurnConfig();
  const hooks = config.hooks as {
    PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows: string }> }>;
    state: Record<string, { trusted_hash: string }>;
  };
  // Confirmed with the real Codex 0.145 hooks/list, not only our own hash function.
  expect(hooks.state['/<session-flags>/config.toml:pre_tool_use:0:0']?.trusted_hash)
    .toBe('sha256:f4d331746bfe136b3a878345ecba33cb38cadef7e4ee7cae93eae12fccc70bd1');
  const hook = hooks.PreToolUse[0]!.hooks[0]!;
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', hook.commandWindows], { encoding: 'utf8' })
    : spawnSync('/bin/sh', ['-c', hook.command], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr.trim()).toBe('text-only-turn');
});
