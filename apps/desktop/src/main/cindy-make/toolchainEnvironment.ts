import type { MakeToolId } from '../../shared/cindyMakeDoctor.js';
import path from 'node:path';
import {
  checkMakeToolVersion,
  makePythonProbeCandidates,
  untilAborted,
  type MakeDoctorEnvironment,
} from './doctor.js';
import {
  createMakeDoctorEnvironment,
  makeToolProcessEnvironment,
  type MakeToolPaths,
} from './doctorEnvironment.js';
import { makeToolCatalog } from './toolCatalog.js';
import { installedMakeTool, makeToolRoot } from './toolInstaller.js';

export const makeToolProbe: Record<MakeToolId, [string, string[]]> = {
  git: ['git', ['--version']],
  gitLfs: ['git', ['lfs', 'version']],
  node: ['node', ['--version']],
  pnpm: ['pnpm', ['--version']],
  python: ['python3', ['--version']],
};
export interface MakeToolchainEnvironment extends MakeDoctorEnvironment {
  useTool: (id: MakeToolId, executable: string) => void;
  validateTool: (id: MakeToolId, executable: string, signal: AbortSignal) => Promise<boolean>;
  /** Available to subsequent source/build steps, without process.env mutation. */
  processEnvironment: () => NodeJS.ProcessEnv;
}

export async function resolveMakeToolEnvironment(
  env: MakeToolchainEnvironment,
  tools: readonly MakeToolId[],
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  for (const tool of tools) {
    signal.throwIfAborted();
    const candidates =
      tool === 'python' ? makePythonProbeCandidates(env.platform) : [makeToolProbe[tool]];
    let ready = false;
    for (const [command, args] of candidates) {
      signal.throwIfAborted();
      const probe = await untilAborted(env.probe(command, args, signal), signal);
      if (checkMakeToolVersion(tool, probe, env.platform).status === 'passed') {
        ready = true;
        break;
      }
    }
    if (!ready) {
      const code = tool === 'git' ? 'gitUnavailable' : 'environmentNotReady';
      throw Object.assign(new Error(code), { code });
    }
  }
  signal.throwIfAborted();
  return env.processEnvironment();
}

/** Prefer working system tools, then reuse an already installed managed tool. This is read-only. */
export function selectMakeToolchainEnvironment(
  factory: (paths: MakeToolPaths) => MakeDoctorEnvironment,
  installed: MakeToolPaths,
  processEnvironment: (paths: MakeToolPaths) => NodeJS.ProcessEnv = makeToolProcessEnvironment,
): MakeToolchainEnvironment {
  const selected: MakeToolPaths = {};
  const managed = new Set<MakeToolId>();
  const base = factory(selected);
  const env: MakeToolchainEnvironment = {
    ...base,
    processEnvironment: () => processEnvironment(selected),
    useTool: (id, executable) => {
      selected[id] = executable;
      managed.add(id);
    },
    validateTool: async (id, executable, signal) => {
      const [command, args] = makeToolProbe[id];
      const result = await factory({ ...selected, [id]: executable }).probe(command, args, signal);
      return checkMakeToolVersion(id, result, base.platform).status === 'passed';
    },
    probe: async (command, args, signal) => {
      const id =
        command === 'git'
          ? args[0] === 'lfs'
            ? 'gitLfs'
            : 'git'
          : command === 'node' || command === 'pnpm'
            ? command
            : ['python3', 'python', 'py'].includes(command)
              ? 'python'
              : undefined;
      const result = await factory(selected).probe(command, args, signal);
      if (!id) return result;
      if (checkMakeToolVersion(id, result, base.platform).status === 'passed') {
        // `git lfs version` may resolve through Git's exec-path, and py is a launcher.
        // Do not mistake their executable paths for standalone LFS/Python interpreters.
        if (result.path && id !== 'gitLfs' && command !== 'py') selected[id] = result.path;
        if (id === 'python' && command === 'py' && !selected.python) {
          const interpreter = await factory(selected).probe(
            'py',
            ['-3', '-c', 'import sys; print(sys.executable)'],
            signal,
          );
          const executable = interpreter.stdout.trim();
          const paths = base.platform === 'win32' ? path.win32 : path.posix;
          if (
            interpreter.status === 'ok' &&
            paths.isAbsolute(executable) &&
            !/[\r\n]/.test(executable)
          ) {
            selected.python = executable;
            return { ...result, path: executable, source: 'system' };
          }
        }
        return { ...result, source: managed.has(id) ? 'managed' : 'system' };
      }
      const cached = installed[id];
      if (cached && !signal.aborted) {
        const fallback = await factory({ ...selected, [id]: cached }).probe(command, args, signal);
        if (checkMakeToolVersion(id, fallback, base.platform).status === 'passed') {
          env.useTool(id, cached);
          return { ...fallback, source: 'managed' };
        }
      }
      return result;
    },
  };
  return env;
}

export async function createMakeToolchainEnvironment(
  userData: string,
  options: { forceManagedTools?: boolean } = {},
): Promise<MakeToolchainEnvironment> {
  const installed: MakeToolPaths = {};
  await Promise.all(
    makeToolCatalog(process.platform, process.arch).map(async (artifact) => {
      const executable = await installedMakeTool(makeToolRoot(userData), artifact);
      if (executable) installed[artifact.id] = executable;
    }),
  );
  return selectMakeToolchainEnvironment(
    (tools) =>
      createMakeDoctorEnvironment(userData, tools, {
        ignoreSystemTools: options.forceManagedTools === true,
      }),
    installed,
  );
}
