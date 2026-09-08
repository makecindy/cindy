import type {
  MakeDoctorCheck,
  MakeDoctorCheckId,
  MakeDoctorReport,
  MakeToolId,
} from '../../shared/cindyMakeDoctor.js';
import { MAKE_DOCTOR_CHECK_IDS } from '../../shared/cindyMakeDoctor.js';

export interface DoctorProbeResult {
  status: 'ok' | 'missing' | 'failed' | 'timeout';
  stdout: string;
  path?: string;
  source?: 'system' | 'managed';
}

/** Injection boundary shared by doctor and the future personal-build workflow. */
export interface MakeDoctorEnvironment {
  platform: string;
  arch: string;
  probe: (
    command: string,
    args: readonly string[],
    signal: AbortSignal,
  ) => Promise<DoctorProbeResult>;
  native: (signal: AbortSignal) => Promise<DoctorProbeResult>;
  storage: () => Promise<{ path: string; writable: boolean; freeGiB: number }>;
}

export function initialDoctorReport(
  runId: string,
  platform: string,
  arch: string,
): MakeDoctorReport {
  return {
    runId,
    platform,
    arch,
    status: 'running',
    checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'pending' })),
  };
}

export function isSupportedMakeHost(platform: string, arch: string): boolean {
  return (
    (platform === 'win32' && arch === 'x64') ||
    ((platform === 'darwin' || platform === 'linux') && (arch === 'x64' || arch === 'arm64'))
  );
}

export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Diagnostic stopped'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function versionCheck(
  id: MakeDoctorCheckId,
  result: DoctorProbeResult,
  pattern: RegExp,
  compatible: (parts: number[]) => boolean,
): MakeDoctorCheck {
  if (result.status !== 'ok') {
    return {
      id,
      status: result.status === 'missing' ? 'missing' : 'failed',
      reason:
        result.status === 'timeout'
          ? 'timeout'
          : result.status === 'missing'
            ? 'notFound'
            : 'probeFailed',
    };
  }
  const version = pattern.exec(result.stdout)?.[1];
  if (!version) return { id, status: 'failed', reason: 'probeFailed' };
  return {
    id,
    version,
    path: result.path,
    source: result.source,
    status: compatible(version.split('.').map(Number)) ? 'passed' : 'incompatible',
    reason: 'version',
  };
}

/** Shared compatibility decision for system tools, cached tools, and staged installs. */
export function checkMakeToolVersion(
  id: MakeToolId,
  result: DoctorProbeResult,
  platform: string,
): MakeDoctorCheck {
  switch (id) {
    case 'git':
      return versionCheck(id, result, /git version (\d+\.\d+\.\d+)/, ([major]) => major >= 2);
    case 'gitLfs':
      return versionCheck(id, result, /git-lfs\/(\d+\.\d+\.\d+)/, () => true);
    case 'node':
      return versionCheck(
        id,
        result,
        /^v(\d+\.\d+\.\d+)\s*$/,
        ([major, minor]) => major > 22 || (major === 22 && minor >= 12),
      );
    case 'pnpm':
      return versionCheck(
        id,
        result,
        /^(\d+\.\d+\.\d+)\s*$/,
        ([major, minor]) => major === 10 && minor >= 7,
      );
    case 'python':
      return versionCheck(
        id,
        result,
        /^Python (\d+\.\d+\.\d+)\s*$/,
        ([major, minor]) => major === 3 && minor >= (platform === 'darwin' ? 10 : 9),
      );
  }
}

/** Executes fixed, bounded, read-only probes. Progress and final output are full snapshots. */
export async function checkCindyMakeEnvironment(
  runId: string,
  env: MakeDoctorEnvironment,
  signal: AbortSignal,
  onProgress: (report: MakeDoctorReport) => void = () => {},
): Promise<MakeDoctorReport> {
  let report = initialDoctorReport(runId, env.platform, env.arch);
  const publish = () =>
    onProgress({ ...report, checks: report.checks.map((check) => ({ ...check })) });
  const put = (check: MakeDoctorCheck) => {
    report = {
      ...report,
      checks: report.checks.map((current) => (current.id === check.id ? check : current)),
    };
    publish();
  };
  const probe = (command: string, args: readonly string[]) =>
    untilAborted(env.probe(command, args, signal), signal);
  publish();
  for (const id of MAKE_DOCTOR_CHECK_IDS) {
    if (signal.aborted) break;
    put({ id, status: 'checking' });
    let check: MakeDoctorCheck;
    try {
      switch (id) {
        case 'platform':
          check = {
            id,
            status: isSupportedMakeHost(env.platform, env.arch) ? 'passed' : 'incompatible',
            reason: isSupportedMakeHost(env.platform, env.arch) ? 'detected' : 'unsupported',
          };
          break;
        case 'git':
          check = checkMakeToolVersion(id, await probe('git', ['--version']), env.platform);
          break;
        case 'gitLfs':
          check =
            report.checks.find((row) => row.id === 'git')?.status !== 'passed'
              ? { id, status: 'missing', reason: 'dependency' }
              : checkMakeToolVersion(id, await probe('git', ['lfs', 'version']), env.platform);
          break;
        case 'node':
          check = checkMakeToolVersion(id, await probe('node', ['--version']), env.platform);
          break;
        case 'pnpm':
          check = checkMakeToolVersion(id, await probe('pnpm', ['--version']), env.platform);
          break;
        case 'python': {
          // A working but old python3 must not hide a compatible python/Windows launcher.
          const candidates: [string, string[]][] = [
            ['python3', ['--version']],
            ['python', ['--version']],
            ...(env.platform === 'win32'
              ? [['py', ['-3', '--version']] as [string, string[]]]
              : []),
          ];
          check = { id, status: 'missing', reason: 'notFound' };
          for (const [command, args] of candidates) {
            if (signal.aborted) break;
            const candidate = checkMakeToolVersion(id, await probe(command, args), env.platform);
            if (candidate.status === 'passed') {
              check = candidate;
              break;
            }
            // Keep an informative version/error if later aliases are absent.
            if (check.status === 'missing' || (!check.version && candidate.version))
              check = candidate;
          }
          break;
        }
        case 'native': {
          const result = await untilAborted(env.native(signal), signal);
          check = {
            id,
            status:
              result.status === 'ok'
                ? 'passed'
                : result.status === 'missing'
                  ? 'missing'
                  : 'failed',
            path: result.path,
            reason:
              result.status === 'timeout'
                ? 'timeout'
                : env.platform === 'win32'
                  ? 'nativeWindows'
                  : env.platform === 'darwin'
                    ? 'nativeMac'
                    : 'nativeLinux',
          };
          break;
        }
        case 'storage': {
          const storage = await untilAborted(env.storage(), signal);
          check = {
            id,
            status: !storage.writable ? 'failed' : storage.freeGiB < 10 ? 'warning' : 'passed',
            path: storage.path,
            freeGiB: Math.floor(storage.freeGiB * 10) / 10,
            reason: storage.freeGiB < 10 && storage.writable ? 'lowDisk' : 'storage',
          };
          break;
        }
      }
    } catch {
      check = { id, status: 'failed', reason: 'probeFailed' };
    }
    if (signal.aborted) break;
    put(check);
  }
  report = {
    ...report,
    status: signal.aborted ? (signal.reason === 'timeout' ? 'failed' : 'cancelled') : 'completed',
    checks: report.checks.map((check) =>
      check.status === 'checking' || check.status === 'pending'
        ? {
            ...check,
            status: signal.reason === 'timeout' ? 'failed' : 'cancelled',
            reason: signal.reason === 'timeout' ? 'timeout' : 'cancelled',
          }
        : check,
    ),
  };
  publish();
  return report;
}
