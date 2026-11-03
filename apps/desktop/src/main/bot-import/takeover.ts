import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectImportSource, type SourceReaderDeps } from './sources.js';
import { fingerprint } from './files.js';
import { CompanionImportError, object, type ImportItem, type ImportSource } from './types.js';
import { importedProcessEnvironment, runImportedProcess } from './process.js';

function definition(job: Record<string, unknown>): string {
  const { enabled: _enabled, state: _state, paused_at: _pausedAt, paused_reason: _pausedReason,
    next_run_at: _nextRun, last_run_at: _lastRun, last_status: _lastStatus, last_error: _lastError,
    last_delivery_error: _deliveryError, last_delivery_unverified: _deliveryUnverified,
    run_claim: _runClaim, runtime_updated_at_ms: _runtimeUpdated, failure_streak: _failureStreak, monitor_state: _monitorState, updatedAtMs: _updatedAt, ...rest } = job;
  if (rest.repeat) { const { completed: _completed, ...repeat } = object(rest.repeat); rest.repeat = repeat; }
  return fingerprint(rest);
}

/** Resolve executable/interpreter only from the host, before adding source env. */
export async function resolveSourceCli(source: ImportSource, home: string, host: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform): Promise<{ executable: string; interpreter?: string }> {
  const name = source.kind === 'hermes' ? 'hermes' : 'openclaw';
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const env = importedProcessEnvironment({}, host, platform);
  const folders = [paths.join(home, '.local', 'bin'), ...(env.PATH ?? '').split(paths.delimiter),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])];
  for (const dir of folders) {
    // Relative/empty entries would be reinterpreted against the source cwd.
    if (!paths.isAbsolute(dir)) continue;
    for (const suffix of platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const executable = paths.join(dir, `${name}${suffix}`);
      let exists = false;
      try { exists = (await fs.stat(executable)).isFile(); } catch { /* Continue the host executable search path. */ }
      if (!exists) continue;
      if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { executable };
      const systemRoot = env.SYSTEMROOT || env.WINDIR;
      const interpreter = env.COMSPEC || (systemRoot ? paths.join(systemRoot, 'System32', 'cmd.exe') : '');
      if (!paths.isAbsolute(interpreter)) throw new CompanionImportError('SOURCE_COMMAND_UNAVAILABLE');
      return { executable, interpreter };
    }
  }
  throw new CompanionImportError('SOURCE_COMMAND_UNAVAILABLE');
}

/** Native commands own the source lock/gateway. Never edit a live cron JSON or SQLite file. */
export async function changeSourceAutomationState(source: ImportSource, item: ImportItem, enabled: boolean,
  readers: SourceReaderDeps, assertOwner: () => void, resumeInterruptedPause = false, selectedEnvironment: Record<string, string> = {}): Promise<void> {
  const original = item.automation;
  if (!original || !/^[a-zA-Z0-9_-]{1,128}$/.test(original.sourceId)) throw new CompanionImportError('SOURCE_AUTOMATION_INVALID');
  const readCurrent = async () => {
    const snapshot = await inspectImportSource(source, readers); assertOwner();
    const current = snapshot.items.find(row => row.automation?.sourceId === original.sourceId);
    if (!current?.automation || definition(current.automation.original) !== definition(original.original)) throw new CompanionImportError('SOURCE_AUTOMATION_CHANGED');
    return current;
  };
  const before = await readCurrent();
  const running = (value: ImportItem) => !!value.automation?.original.run_claim || !!object(value.automation?.original.state).runningAtMs;
  if (!enabled && running(before)) throw new CompanionImportError(resumeInterruptedPause ? 'SOURCE_HANDOVER_PENDING' : 'SOURCE_AUTOMATION_RUNNING');
  if (before.view.enabled === enabled) {
    if (enabled || resumeInterruptedPause) return;
    throw new CompanionImportError('SOURCE_AUTOMATION_CHANGED');
  }
  const cli = await resolveSourceCli(source, readers.home, readers.env); assertOwner();
  const env = importedProcessEnvironment({ ...selectedEnvironment,
    ...(source.kind === 'hermes' ? { HERMES_HOME: source.root } : { OPENCLAW_STATE_DIR: source.root, OPENCLAW_CONFIG_PATH: source.configFile }) }, readers.env);
  const args = ['cron', source.kind === 'hermes' ? enabled ? 'resume' : 'pause' : enabled ? 'enable' : 'disable', original.sourceId];
  let commandFailed = false;
  try {
    // The shared runner terminates the entire child tree when ownership changes.
    // The persisted pausing-source phase remains for same-owner reconciliation.
    const result = await runImportedProcess({ command: cli.interpreter ?? cli.executable,
      args: cli.interpreter ? ['/d', '/s', '/c', `""${cli.executable}" ${args.join(' ')}"`] : args,
      windowsVerbatimArguments: !!cli.interpreter,
      cwd: source.root, env, timeoutMs: 30_000, signal: new AbortController().signal, assertOwner });
    commandFailed = result.exitCode !== 0;
  } catch { commandFailed = true; }
  assertOwner();
  let after: ImportItem;
  try { after = await readCurrent(); } catch { throw new CompanionImportError('SOURCE_HANDOVER_UNCERTAIN'); }
  if (!enabled && after.view.enabled === false && running(after)) throw new CompanionImportError('SOURCE_HANDOVER_PENDING');
  if (commandFailed && after.view.enabled !== enabled) throw new CompanionImportError('SOURCE_HANDOVER_COMMAND_FAILED');
  if (after.view.enabled !== enabled) throw new CompanionImportError('SOURCE_HANDOVER_NOT_CONFIRMED');
}
