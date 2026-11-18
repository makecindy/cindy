import type { SpawnOptions } from 'node:child_process';
import path from 'node:path';
import spawn from 'cross-spawn';
import { resolveWindowsMcpJob } from '../windowsMcpJob.js';

// cross-spawn 7 exposes the same parser it uses inside spawn(). Using it here
// preserves PATHEXT, shebangs and .cmd argument escaping across the extra hop.
const { _parse: parse } = spawn as typeof spawn & {
  _parse(command: string, args: string[], options: SpawnOptions): {
    command: string; args: string[]; file?: string; options: SpawnOptions;
  };
};

export async function prepareWindowsStdioLaunch(command: string, args: string[], options: SpawnOptions) {
  const parsed = parse(command, args, options);
  if (!parsed.file) throw new Error('MCP_STDIO_COMMAND_NOT_FOUND');
  const verbatim = parsed.options.windowsVerbatimArguments;
  let program = parsed.file;
  if (verbatim) {
    // .cmd/.bat must use the system interpreter, including when the tool sets PATH.
    program = path.win32.isAbsolute(parsed.command) ? parsed.command
      : path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  } else if (parsed.command !== command) {
    // parsed.file still refers to the original script in the shebang case.
    const interpreter = parse(parsed.command, [], options).file;
    if (!interpreter) throw new Error('MCP_STDIO_COMMAND_NOT_FOUND');
    program = interpreter;
  }
  const helper = await resolveWindowsMcpJob().catch(() => { throw new Error('MCP_STDIO_START_FAILED'); });
  return { command: helper, args: [String(process.pid), verbatim ? '--verbatim' : '--argv', program, ...parsed.args] };
}
