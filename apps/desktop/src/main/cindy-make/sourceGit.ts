import { spawn } from 'node:child_process';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { MakeSourceGitProgress } from '../../shared/cindyMakeDoctor.js';

const MAX_CAPTURED_STDOUT = 64 * 1024;
const MAX_CAPTURED_STDERR = 16 * 1024;

function sanitizeProgressLine(line: string): string {
  return redactSensitiveText(
    line
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\b(?:https?|ssh):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
      .trim(),
  ).slice(-512);
}

export function parseSourceGitProgress(line: string): MakeSourceGitProgress | undefined {
  const match =
    /(?:^|remote:\s*)(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/.exec(
      line.trim(),
    );
  if (!match || Number(match[2]) > 100) return undefined;
  const stages: Record<string, MakeSourceGitProgress['stage']> = {
    'Counting objects': 'counting',
    'Compressing objects': 'compressing',
    'Receiving objects': 'receiving',
    'Resolving deltas': 'resolving',
    'Updating files': 'checkingOut',
  };
  return { stage: stages[match[1]], percent: Number(match[2]) };
}

/** Drain progress without buffering an entire clone log or passing raw Git output to the UI. */
export async function runSourceGit(
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onProgress?: (progress: MakeSourceGitProgress) => void,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let stdout = '';
    let stderr = '';
    let stderrTruncated = false;
    let stderrTail = '';
    let failed = false;
    let spawnCode: string | undefined;
    let latest: MakeSourceGitProgress | undefined;
    let sent: MakeSourceGitProgress | undefined;
    let lastSent = 0;
    const publish = () => {
      if (
        !latest ||
        (sent?.stage === latest.stage &&
          sent.percent === latest.percent &&
          sent.message === latest.message)
      )
        return;
      onProgress?.(latest);
      sent = latest;
      lastSent = Date.now();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failed) return;
      if (stdout.length < MAX_CAPTURED_STDOUT)
        stdout += chunk.slice(0, MAX_CAPTURED_STDOUT - stdout.length);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      const lines = (stderrTail + chunk).split(/[\r\n]/);
      stderrTail = (lines.pop() ?? '').slice(-1024);
      if (stderr.length > MAX_CAPTURED_STDERR) {
        stderrTruncated = true;
        stderr = stderr.slice(-MAX_CAPTURED_STDERR);
      }
      for (const line of lines) {
        const progress = parseSourceGitProgress(line);
        if (!progress) continue;
        latest = { ...progress, message: sanitizeProgressLine(line) };
        if (
          sent?.stage !== progress.stage ||
          progress.percent === 100 ||
          Date.now() - lastSent >= 200
        )
          publish();
      }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failed = true;
      spawnCode = error.code;
    });
    // Wait for close, including abort/error paths, before another operation can touch the checkout.
    child.on('close', (code, exitSignal) => {
      if (signal.aborted || failed || code !== 0) {
        const diagnostic = stderrTruncated ? `[stderr truncated] ${stderr}` : stderr;
        reject(
          Object.assign(new Error('Git source operation failed'), {
            code: signal.aborted ? 'cancelled' : 'gitFailed',
            operation: args[0],
            exitCode: code,
            exitSignal,
            spawnCode,
            stderr: redactSensitiveText(
              diagnostic.replace(/\b(?:https?|ssh):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]'),
            ).trim(),
          }),
        );
        return;
      }
      latest = parseSourceGitProgress(stderrTail) ?? latest;
      publish();
      resolve(stdout.trim());
    });
  });
}
