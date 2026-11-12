import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DoctorProbeResult, MakeDoctorEnvironment } from './doctor.js';
import type { MakeToolId } from '../../shared/cindyMakeDoctor.js';

const PROBE_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 16_384;

/** No shell text from the composer, no profile scripts, no process-wide environment changes. */
export function runDoctorProbe(
  file: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<DoctorProbeResult> {
  if (signal.aborted) return Promise.resolve({ status: 'failed', stdout: '' });
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (status: DoctorProbeResult['status']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({
        status,
        stdout: status === 'ok' ? Buffer.concat(chunks).toString('utf8').trim() : '',
        path: file,
      });
    };
    const stop = (status: 'timeout' | 'failed') => {
      if (settled) return;
      // pnpm.cmd has a Node child. Kill the probe tree so cancellation/timeout
      // cannot leave that child running after the card reaches its terminal state.
      if (process.platform === 'win32' && child?.pid) {
        const killer = spawn(
          path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => {
          child?.kill('SIGKILL');
        });
        killer.on('close', () => {
          child?.kill('SIGKILL');
        });
      } else {
        try {
          if (child?.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child?.kill('SIGKILL');
        }
      }
      finish(status);
    };
    const abort = () => stop('failed');
    try {
      // .cmd/.bat cannot be spawned directly. The resolved path is quoted; reject cmd
      // metacharacters rather than attempting general-purpose shell escaping.
      const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
      if (batch && (/["%\r\n!^&|<>]/.test(file) || args.some((arg) => !/^[\w.-]+$/.test(arg)))) {
        finish('failed');
        return;
      }
      child = batch
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
      const collect = (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          stop('failed');
          return;
        }
        chunks.push(chunk);
      };
      child.stdout?.on('data', collect);
      // Some Python launchers print their version on stderr. Never expose raw output
      // in a report: doctor.ts extracts only a validated version/path.
      child.stderr?.on('data', collect);
      child.once('error', () => finish('failed'));
      child.once('close', (code) => finish(code === 0 ? 'ok' : 'failed'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), PROBE_TIMEOUT_MS);
      if (signal.aborted) abort();
    } catch {
      finish('failed');
    }
  });
}

async function accessible(file: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

export function doctorSearchDirectories(
  environment: NodeJS.ProcessEnv,
  platform: string,
  home: string,
): string[] {
  const paths = (environment.PATH ?? environment.Path ?? '').split(
    platform === 'win32' ? ';' : ':',
  );
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    for (const base of [environment.ProgramFiles, environment['ProgramFiles(x86)']]) {
      if (base) paths.push(join(base, 'Git', 'cmd'), join(base, 'nodejs'));
    }
    if (environment.APPDATA) paths.push(join(environment.APPDATA, 'npm'));
    if (environment.LOCALAPPDATA) paths.push(join(environment.LOCALAPPDATA, 'pnpm'));
  } else {
    paths.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      join(home, '.local', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.nvm', 'current', 'bin'),
    );
  }
  if (environment.PNPM_HOME) paths.push(environment.PNPM_HOME);
  // Do not resolve an executable in the task directory or via a relative PATH entry.
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  return [
    ...new Set(
      paths.map((entry) => entry.replace(/^"|"$/g, '')).filter((entry) => isAbsolute(entry)),
    ),
  ];
}

export type MakeToolPaths = Partial<Record<MakeToolId, string>>;

/** Only the returned child-process environment changes; never the user's global PATH. */
export function makeToolProcessEnvironment(
  tools: MakeToolPaths,
  base: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): NodeJS.ProcessEnv {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const environment: NodeJS.ProcessEnv = {
    ...base,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_managePackageManagerVersions: 'false',
    PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
  };
  const directories = [
    ...new Set([
      ...Object.values(tools).map((file) => paths.dirname(file)),
      ...doctorSearchDirectories(environment, platform, home),
    ]),
  ];
  // Use the same PATH for resolution and child dependencies (e.g. pnpm's Node).
  for (const key of Object.keys(environment)) {
    if (key === 'PATH' || (platform === 'win32' && key.toLowerCase() === 'path'))
      delete environment[key];
  }
  environment.PATH = directories.join(paths.delimiter);
  if (tools.python) {
    environment.npm_config_python = tools.python;
    environment.PYTHON = tools.python;
  }
  return environment;
}

export function createMakeDoctorEnvironment(
  storageDir: string,
  tools: MakeToolPaths = {},
  options: { ignoreSystemTools?: boolean } = {},
): MakeDoctorEnvironment {
  const platform = process.platform;
  const environment = makeToolProcessEnvironment(tools);
  const directories = (environment.PATH ?? '').split(path.delimiter);
  const resolve = async (command: string): Promise<string | null> => {
    if (path.isAbsolute(command)) return (await accessible(command)) ? command : null;
    const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
    for (const directory of directories) {
      for (const extension of extensions) {
        const file = path.join(directory, `${command}${extension}`);
        // Python's Windows Store alias can launch an installer even with --version.
        if (/[/\\]Microsoft[/\\]WindowsApps[/\\]python/i.test(file)) continue;
        try {
          if (
            (await stat(file)).isFile() &&
            (await accessible(file, platform === 'win32' ? constants.F_OK : constants.X_OK))
          )
            return file;
        } catch {
          /* Try the next installed location. */
        }
      }
    }
    return null;
  };
  const probe = async (
    command: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<DoctorProbeResult> => {
    const tool =
      command === 'git' && args[0] === 'lfs'
        ? 'gitLfs'
        : command === 'python3' || command === 'python' || command === 'py'
          ? 'python'
          : command === 'git' || command === 'node' || command === 'pnpm'
            ? command
            : undefined;
    const override = tool ? tools[tool] : undefined;
    // Portable probes use managed copies in test mode. Unix system Git stays
    // real; Windows native prerequisite simulation is handled in native().
    if (options.ignoreSystemTools && tool && !override && (tool !== 'git' || platform === 'win32'))
      return { status: 'missing', stdout: '' };
    const file = override ?? (await resolve(command));
    const probeArgs =
      override && tool === 'gitLfs'
        ? ['version']
        : override && tool === 'python'
          ? ['--version']
          : args;
    if (
      platform === 'darwin' &&
      file &&
      /^\/usr\/bin\/(git|make|python3|clang\+\+|g\+\+)$/.test(file)
    ) {
      // Apple's developer-tool stubs can open an installer, including on --version.
      const selected = await runDoctorProbe(
        '/usr/bin/xcode-select',
        ['-p'],
        storageDir,
        signal,
        environment,
      );
      if (selected.status !== 'ok') return { status: 'missing', stdout: '' };
    }
    return file
      ? runDoctorProbe(file, probeArgs, storageDir, signal, environment)
      : { status: 'missing', stdout: '' };
  };
  const native = async (signal: AbortSignal): Promise<DoctorProbeResult> => {
    if (platform === 'win32') {
      // The development-only managed-tool test must also exercise the native
      // prerequisite guidance. We cannot provision MSVC/Windows SDK safely from
      // Cindy, so simulate the missing state instead of treating the host VS
      // installation as a pass. This flag is only reachable from the guarded
      // developer command path.
      if (options.ignoreSystemTools) return { status: 'missing', stdout: '' };
      const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
      if (!programFiles) return { status: 'missing', stdout: '' };
      const found = await probe(
        path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
        [
          '-latest',
          '-products',
          '*',
          '-requires',
          'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
          '-property',
          'installationPath',
        ],
        signal,
      );
      if (found.status !== 'ok') return found;
      const installation = found.stdout.trim();
      if (!path.isAbsolute(installation) || /[\r\n]/.test(installation))
        return { status: 'missing', stdout: '' };
      const toolVersion = (
        await readFile(
          path.join(
            installation,
            'VC',
            'Auxiliary',
            'Build',
            'Microsoft.VCToolsVersion.default.txt',
          ),
          'utf8',
        )
      ).trim();
      if (!/^\d+\.\d+\.\d+$/.test(toolVersion)) return { status: 'failed', stdout: '' };
      const compiler = path.join(
        installation,
        'VC',
        'Tools',
        'MSVC',
        toolVersion,
        'bin',
        'Hostx64',
        'x64',
        'cl.exe',
      );
      const sdk = path.join(programFiles, 'Windows Kits', '10');
      const versions = (await readdir(path.join(sdk, 'Include'))).filter((name) =>
        /^10\.0\.\d+\.0$/.test(name),
      );
      let hasSdk = false;
      for (const version of versions) {
        if (
          (await accessible(path.join(sdk, 'Include', version, 'um', 'Windows.h'))) &&
          (await accessible(path.join(sdk, 'Include', version, 'ucrt', 'stdio.h'))) &&
          (await accessible(path.join(sdk, 'Lib', version, 'um', 'x64', 'kernel32.lib'))) &&
          (await accessible(path.join(sdk, 'Lib', version, 'ucrt', 'x64', 'ucrt.lib')))
        ) {
          hasSdk = true;
          break;
        }
      }
      return {
        status:
          hasSdk &&
          (await accessible(compiler)) &&
          (await accessible(path.join(installation, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')))
            ? 'ok'
            : 'missing',
        stdout: '',
        path: installation,
      };
    }
    if (platform === 'darwin') {
      // xcode-select -p avoids invoking Apple's compiler stub before CLT exists.
      const selected = await probe('/usr/bin/xcode-select', ['-p'], signal);
      if (selected.status !== 'ok') return selected;
      const compiler = await probe('/usr/bin/xcrun', ['--find', 'clang++'], signal);
      if (compiler.status !== 'ok') return compiler;
      if (!path.isAbsolute(compiler.stdout) || /[\r\n]/.test(compiler.stdout))
        return { status: 'failed', stdout: '' };
      const compilerVersion = await probe(compiler.stdout, ['--version'], signal);
      if (compilerVersion.status !== 'ok') return compilerVersion;
      const sdk = await probe('/usr/bin/xcrun', ['--show-sdk-path'], signal);
      if (sdk.status !== 'ok') return sdk;
      return probe('make', ['--version'], signal);
    }
    if (platform === 'linux') {
      const compiler = await probe('g++', ['--version'], signal);
      if (compiler.status !== 'ok') return compiler;
      return probe('make', ['--version'], signal);
    }
    return { status: 'missing', stdout: '' };
  };
  return {
    platform,
    arch: process.arch,
    probe,
    native,
    storage: async () => {
      const info = await statfs(storageDir);
      return {
        path: storageDir,
        writable: await accessible(storageDir, constants.W_OK),
        freeGiB: (info.bavail * info.bsize) / 1024 ** 3,
      };
    },
  };
}
