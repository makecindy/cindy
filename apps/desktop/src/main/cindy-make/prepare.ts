import type {
  MakeDoctorCheck,
  MakeDoctorReport,
  MakeToolId,
} from '../../shared/cindyMakeDoctor.js';
import { checkCindyMakeEnvironment } from './doctor.js';
import { DownloadError } from '../downloader/index.js';
import { makeToolCatalog } from './toolCatalog.js';
import { installMakeTool } from './toolInstaller.js';
import type { MakeToolchainEnvironment } from './toolchainEnvironment.js';

/** Native Make's first stage: check, provision missing portable tools, automatically recheck.
 * OS-level compiler/Git prerequisites stay visible for system installation; no admin shell runs.
 */
export async function prepareCindyMakeEnvironment(
  runId: string,
  env: MakeToolchainEnvironment,
  root: string,
  signal: AbortSignal,
  onProgress: (report: MakeDoctorReport) => void,
  install = installMakeTool,
): Promise<MakeDoctorReport> {
  let report: MakeDoctorReport;
  const receive = (snapshot: MakeDoctorReport) => {
    // A completed diagnostic pass is not the end of preparation.
    report = { ...snapshot, mode: 'prepare', status: 'running' };
    onProgress(report);
  };
  const checked = await checkCindyMakeEnvironment(runId, env, signal, receive);
  report = { ...checked, mode: 'prepare', status: 'running' };
  const put = (check: MakeDoctorCheck) => {
    report = { ...report, checks: report.checks.map((row) => (row.id === check.id ? check : row)) };
    onProgress(report);
  };
  const installErrors = new Map<MakeToolId, MakeDoctorCheck>();
  const storage = report.checks.find((row) => row.id === 'storage');
  const canInstall =
    report.checks.find((row) => row.id === 'platform')?.status === 'passed' &&
    storage?.status !== 'failed' &&
    storage?.freeGiB !== undefined &&
    storage.freeGiB >= 2;
  if (canInstall && !signal.aborted) {
    for (const artifact of makeToolCatalog(env.platform, env.arch)) {
      if (signal.aborted) break;
      // Recheck after each dependency install: e.g. pnpm may simply have lacked Node.
      if (report.checks.find((row) => row.id === artifact.id)?.status === 'passed') continue;
      // LFS cannot be used or verified until system Git is installed.
      if (
        artifact.id === 'gitLfs' &&
        report.checks.find((row) => row.id === 'git')?.status !== 'passed'
      )
        continue;
      let phase: MakeDoctorCheck['status'] = 'downloading';
      try {
        const executable = await install({
          root,
          artifact,
          signal,
          onProgress: (progress) => {
            phase = progress.status;
            if (!signal.aborted) put({ id: artifact.id, ...progress });
          },
          validate: (file) => env.validateTool(artifact.id, file, signal),
        });
        env.useTool(artifact.id, executable);
        await checkCindyMakeEnvironment(runId, env, signal, receive);
      } catch (error) {
        if (signal.aborted) break;
        const check: MakeDoctorCheck = {
          id: artifact.id,
          status: 'failed',
          reason:
            error instanceof DownloadError && error.code === 'CHECKSUM'
              ? 'checksum'
              : error instanceof DownloadError && error.code === 'DISK'
                ? 'storage'
                : phase === 'downloading'
                  ? 'downloadFailed'
                  : 'installFailed',
        };
        installErrors.set(artifact.id, check);
        put(check);
      }
    }
  }
  report = {
    ...report,
    status: signal.aborted ? (signal.reason === 'timeout' ? 'failed' : 'cancelled') : 'completed',
    checks: report.checks.map((check) => {
      if (['pending', 'checking', 'downloading', 'installing'].includes(check.status)) {
        return {
          ...check,
          status: signal.reason === 'timeout' ? 'failed' : 'cancelled',
          reason: signal.reason === 'timeout' ? 'timeout' : 'cancelled',
          progress: undefined,
        };
      }
      return check.status !== 'passed'
        ? (installErrors.get(check.id as MakeToolId) ?? check)
        : check;
    }),
  };
  onProgress(report);
  return report;
}
