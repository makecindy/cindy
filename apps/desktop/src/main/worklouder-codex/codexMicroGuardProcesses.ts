import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TARGET_EXECUTABLES = new Set([
  '/Applications/Codex.app/Contents/MacOS/Codex',
  '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
]);

export interface CodexMicroGuardProcess {
  pid: number;
  startedAt: number;
  executable: string;
}

export async function listCodexMicroGuardProcesses(): Promise<CodexMicroGuardProcess[]> {
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-ww', '-U', String(process.getuid!()), '-o', 'pid=,lstart=,comm='],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 1_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return parseCodexMicroGuardProcesses(stdout);
}

export function parseCodexMicroGuardProcesses(output: string): CodexMicroGuardProcess[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(
      line,
    );
    if (!match || !TARGET_EXECUTABLES.has(match[3])) return [];
    const pid = Number(match[1]);
    const startedAt = Date.parse(`${match[2]} UTC`);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startedAt)
      ? [{ pid, startedAt, executable: match[3] }]
      : [];
  });
}
