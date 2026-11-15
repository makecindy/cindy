import { spawn, execSync } from 'node:child_process';
import type { AgentAdapter, RefreshInput, RewriteInput } from './types.js';

export interface ClaudeCodeAdapterOptions {
  command?: string; // override binary, defaults to "claude"
  /** Rewrite path timeout in SECONDS. Default 120. */
  timeoutSeconds?: number;
  model?: string;
  /**
   * Refresh path timeout in SECONDS. Default 600.
   * Refresh can take much longer than rewrite (agent has to explore source).
   */
  refreshTimeoutSeconds?: number;
}

/**
 * Adapter that shells out to the local `claude` CLI in headless mode (`-p`).
 * Reads the user's existing Claude Code auth — no API key required at this layer.
 *
 * Failure modes:
 *   - `claude` not in PATH: rethrown with actionable hint
 *   - non-zero exit: rethrown with stderr captured
 *   - timeout: process killed, error thrown
 */
export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  const command = opts.command ?? 'claude';
  const rewriteTimeoutMs = (opts.timeoutSeconds ?? 120) * 1000;
  const refreshTimeoutMs = (opts.refreshTimeoutSeconds ?? 600) * 1000;

  return {
    name: 'claude-code',

    async rewriteKnowledge(input: RewriteInput): Promise<string> {
      const prompt = buildRewritePrompt(input);
      const args = ['-p', '--output-format', 'text'];
      if (opts.model) {
        args.push('--model', opts.model);
      }
      const raw = await runClaude(command, args, prompt, rewriteTimeoutMs);
      return stripPreambleAndTrailing(raw);
    },

    async refreshKnowledge(input: RefreshInput): Promise<string> {
      const prompt = buildRefreshPrompt(input);
      // Refresh deliberately keeps tool access enabled so the agent can Read / Glob
      // / Grep the source. Spawn cwd is set to the repo root so relative globs work.
      const args = ['-p', '--output-format', 'text'];
      if (opts.model) {
        args.push('--model', opts.model);
      }
      const raw = await runClaude(command, args, prompt, refreshTimeoutMs, input.cwd);
      return stripPreambleAndTrailing(raw);
    },
  };
}

function buildRewritePrompt(input: RewriteInput): string {
  return [
    input.instruction,
    '',
    '--- BEGIN OLD KNOWLEDGE FILE ---',
    input.oldContent,
    '--- END OLD KNOWLEDGE FILE ---',
    '',
    '--- BEGIN GIT DIFF ---',
    input.diff,
    '--- END GIT DIFF ---',
    '',
    'Output ONLY the new markdown body (do NOT include the frontmatter / `---` block).',
    'Preserve the H2 section structure of the old file. In particular, keep the',
    '`## 是什么` heading verbatim — its first paragraph is consumed downstream as a',
    'per-module summary by the desktop session TOC; renaming or replacing this',
    'heading silently breaks summary extraction. Append (do not overwrite) any',
    '"演进备忘" entries.',
  ].join('\n');
}

function buildRefreshPrompt(input: RefreshInput): string {
  return [
    input.instruction,
    '',
    '--- CONTEXT ---',
    input.contextHint,
    '',
    '--- BEGIN OLD KNOWLEDGE FILE (may be empty TODOs for first-fill) ---',
    input.oldContent,
    '--- END OLD KNOWLEDGE FILE ---',
    '',
    'You have full Read / Glob / Grep tool access. Use them to inspect the source',
    'files under the covered paths above (cwd is set to the repo root, so relative',
    'paths like `packages/foo/src/...` resolve directly).',
    '',
    'OUTPUT FORMAT — strict:',
    '- Your VERY FIRST output character must be `#` (the H1 heading).',
    '- No preamble, no "Let me...", no "Here is...", no acknowledgements.',
    '- No frontmatter / no `---` block.',
    '- No trailing notes, suggestions, or "let me know if..." after the last section.',
    '- Preserve the H2 section structure of the old file. In particular, keep the',
    '  `## 是什么` heading verbatim — its first paragraph is consumed downstream as a',
    '  per-module summary by the desktop session TOC; renaming or replacing this',
    '  heading silently breaks summary extraction.',
    '- Preserve any existing "演进备忘" entries verbatim and DO NOT add new ones',
    '  (refresh is structural, not change-driven).',
  ].join('\n');
}

/**
 * Defense-in-depth: even with the strict OUTPUT FORMAT instruction, agents
 * sometimes leak preamble like "Now I have all the info..." or trailing
 * meta-commentary. Trim to the [first H1, last H2-section content end] window.
 */
function stripPreambleAndTrailing(raw: string): string {
  const trimmed = raw.trim();
  // Find first line that looks like a top-level markdown heading (`# ` or `## `).
  // We accept H2 too in case the agent skipped H1.
  const lines = trimmed.split(/\r?\n/);
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  return lines.slice(startIdx).join('\n').trimEnd() + '\n';
}

function runClaude(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // On Windows, npm-installed CLIs ship as `.cmd` / `.ps1` shims and bare
    // `spawn(name)` with shell:false will NOT extension-resolve via PATHEXT.
    // Going through cmd.exe (shell:true) lets Windows find the shim. On
    // POSIX we keep shell:false to avoid quoting pitfalls — `claude` there is
    // a normal binary or symlink and resolves directly.
    const useShell = process.platform === 'win32';
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      cwd,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // Windows quirk: with shell:true, child.kill('SIGTERM') only terminates
      // the cmd.exe wrapper, leaving the real `claude` (and its node spawner)
      // running as orphans that keep eating CPU/memory/LLM tokens and never
      // free the worker lane. Use taskkill /T /F to terminate the whole tree.
      if (process.platform === 'win32' && child.pid != null) {
        try {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          /* process may already be gone */
        }
      } else {
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (enoent) {
        reject(
          new Error(
            `claude-code adapter: \`${command}\` not found in PATH. ` +
              'Install Claude Code CLI or set agent_options.command in config.yaml.',
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`claude-code adapter: timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `claude-code adapter: exit ${code}. stderr:\n${stderr.trim() || '(empty)'}`,
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}
