import { createHash } from 'node:crypto';

const command = 'echo text-only-turn >&2; exit 2';
const commandWindows = 'cmd.exe /d /c "echo text-only-turn 1>&2 & exit /b 2"';

/**
 * Codex 0.145 hooks require both a trusted definition and a blocking result.
 * Exit 2 WITHOUT stderr is merely a failed hook and permits execution.
 * Identity matches hooks/engine/discovery.rs: effective platform command,
 * normalized timeout, flattened MatcherGroup, sorted JSON via version_for_toml.
 * This approves only our fixed deny hook, never a user-supplied command.
 */
function trustHash(effectiveCommand: string): string {
  const identity = { event_name: 'pre_tool_use', hooks: [{
    async: false, command: effectiveCommand, timeout: 600, type: 'command',
  }] };
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function codexTextOnlyTurnConfig(): Record<string, unknown> {
  return {
    web_search: 'disabled',
    'features.standalone_web_search': false,
    'features.apps': false,
    'features.image_generation': false,
    'features.hooks': true,
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command, commandWindows }] }],
      state: {
        // Synthetic SessionFlags source paths are defined by native Codex,
        // not by the user's home or this client's OS (SSH may use another OS).
        '/<session-flags>/config.toml:pre_tool_use:0:0': { trusted_hash: trustHash(command) },
        'C:\\<session-flags>\\config.toml:pre_tool_use:0:0': { trusted_hash: trustHash(commandWindows) },
      },
    },
  };
}
