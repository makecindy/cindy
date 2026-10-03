import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CindyMakeTaskPreparation } from '../../shared/cindyMakeDoctor.js';
import { createMakeBuildOutput } from './buildDiagnostic.js';
import { createMakeBuildLineOutput } from './buildProgress.js';

/**
 * The credential-free environment an install or cache warm of unverified content
 * may see: process essentials and Cindy's own toolchain settings only. Anything
 * else — above all credentials inherited from how Cindy was launched — stays out,
 * because `${VAR}` in a content `.npmrc` expands it into a request to a host the
 * content chooses; even an allowlisted name is dropped when it names a credential.
 * `userconfig` is pinned to the null device so the user's own `.npmrc` is not
 * loaded either. Corepack may not take anything from unverified content: a
 * project `.corepack.env` and the `packageManager` field can name, cache-poison
 * or point at a custom URL for the package manager Corepack runs before pnpm's
 * own guards apply, so its project env and project spec are disabled outright.
 */
export function unverifiedPnpmEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) =>
          /^(?:path|systemroot|windir|comspec|tmp|temp|home|userprofile|lang|lc_.*|tz|corepack_.*|pnpm_manage_package_manager_versions|pythondontwritebytecode|pythonutf8|python|npm_config_(?:manage_package_manager_versions|managepackagemanagerversions|python))$/i.test(
            key,
          ) &&
          !/(?:token|password|auth|secret|credential|key)/i.test(key) &&
          // Pinned below unconditionally; a differently-cased twin must not
          // survive to fight the pin on case-insensitive environments.
          !/^corepack_(?:env_file|enable_project_spec|enable_unsafe_custom_urls)$/i.test(key),
      ),
    ),
    npm_config_userconfig: os.devNull,
    // The global config may hold registry credentials of its own.
    npm_config_globalconfig: os.devNull,
    // Corepack must not read the content's `.corepack.env` or follow its
    // `packageManager` spec: together they can make the Corepack shim execute
    // attacker-chosen code before `--ignore-scripts` applies.
    COREPACK_ENV_FILE: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: '0',
  };
}

export function parseMakeDependencyProgress(
  text: string,
  previous?: CindyMakeTaskPreparation['dependencies'],
): CindyMakeTaskPreparation['dependencies'] {
  const matches = [
    ...text.matchAll(
      /Progress: resolved ([0-9]+), reused ([0-9]+), downloaded ([0-9]+), added ([0-9]+)/g,
    ),
  ];
  const match = matches.at(-1);
  const scripts = [
    ...text.matchAll(/(?:^|[\r\n])[^\r\n]*(?:preinstall|postinstall|install|prepare)[$:]/g),
  ].at(-1);
  const counts = match
    ? {
        resolved: Number(match[1]),
        reused: Number(match[2]),
        downloaded: Number(match[3]),
        added: Number(match[4]),
      }
    : previous;
  if (scripts && (!match || scripts.index! > match.index!))
    return {
      ...counts,
      activity: 'scripts',
    };
  return counts;
}

const OUTPUT_TAIL_CHARS = 2048;

async function resolvePnpm(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const directories = (environment.PATH ?? environment.Path ?? '').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const directory of directories) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const file = path.join(directory, `pnpm${extension}`);
      try {
        if (!(await stat(file)).isFile()) continue;
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        /* Try the next installed location. */
      }
    }
  }
  return null;
}

function killTree(child: ChildProcess, environment: NodeJS.ProcessEnv): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // pnpm.cmd runs a Node child; kill the tree so an abort does not leave it installing.
    const killer = spawn(
      path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', String(child.pid), '/t', '/f'],
      { windowsHide: true, stdio: 'ignore' },
    );
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Run pnpm from the same PATH the Make toolchain resolved (system first, managed
 * copy otherwise). Arguments are fixed by callers, never user input; output stays
 * bounded for diagnostics and the optional scrubbed live-status line.
 */
export async function runSourcePnpm(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  onProgress?: (progress: NonNullable<CindyMakeTaskPreparation['dependencies']>) => void,
  onOutput?: (line: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  // Keep progress visible in a non-TTY/CI process, including lifecycle scripts.
  args = ['install', 'fetch'].includes(args[0]) ? [...args, '--reporter=append-only'] : args;
  // The pinned pnpm write roots are fixed relative paths (no spaces, quotes or shell
  // metacharacters); every other argument stays in the tight literal charset.
  const writeRoot = /^--(?:config\.)?(?:modules-dir|virtual-store-dir|store-dir|cache-dir)=[\w.:/\\-]+$/;
  if (args.some((arg) => !/^[\w.:=-]+$/.test(arg) && !writeRoot.test(arg))) {
    throw Object.assign(new Error('unsafe pnpm argument'), { code: 'installFailed' });
  }
  const file = await resolvePnpm(env);
  if (!file) throw Object.assign(new Error('pnpm not found'), { code: 'installFailed' });
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  if (batch && /["%\r\n!^&|<>]/.test(file)) {
    throw Object.assign(new Error('unsafe pnpm path'), { code: 'installFailed' });
  }
  await new Promise<void>((resolve, reject) => {
    const output = createMakeBuildOutput();
    const environment: NodeJS.ProcessEnv = { ...env, CI: '1' };
    const child = batch
      ? spawn(
          path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
          ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`],
          {
            cwd,
            env: environment,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      : spawn(file, [...args], {
          cwd,
          env: environment,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let tail = '';
    let lastProgress = '';
    let previousProgress: CindyMakeTaskPreparation['dependencies'];
    const collect = (chunk: string) => {
      output.append(chunk);
      tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
      if (onProgress && !signal.aborted) {
        const progress = parseMakeDependencyProgress(tail, previousProgress);
        if (progress && JSON.stringify(progress) !== lastProgress) {
          previousProgress = progress;
          lastProgress = JSON.stringify(progress);
          onProgress(progress);
        }
      }
    };
    const lines = [child.stdout, child.stderr].map((stream) => {
      const lineOutput = createMakeBuildLineOutput(
        onOutput
          ? (line) => {
              if (!signal.aborted) onOutput(line);
            }
          : undefined,
      );
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        collect(chunk);
        lineOutput.append(chunk);
      });
      return lineOutput;
    });
    const abort = () => killTree(child, environment);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      output.append('\n' + error.message);
      reject(Object.assign(error, { code: 'installFailed', diagnostic: output.failure() }));
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      for (const lineOutput of lines) lineOutput.finish();
      if (signal.aborted) {
        reject(Object.assign(new Error('pnpm cancelled'), { code: 'cancelled' }));
        return;
      }
      if (code !== 0) {
        reject(
          Object.assign(new Error(`pnpm exited with ${code}: ${tail.trim()}`), {
            code: 'installFailed',
            diagnostic: output.failure(code ?? undefined),
          }),
        );
        return;
      }
      resolve();
    });
    if (signal.aborted) abort();
  });
}
