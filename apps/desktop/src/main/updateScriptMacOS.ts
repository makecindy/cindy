/**
 * updateScriptMacOS — pure builder for the macOS update-apply bash script.
 *
 * Extracted from updateService.executeUpdateMacOS() so the generated script
 * (a release-critical path: exit-hang escalation, pre-swap clear-out, launch
 * verification) can be regression-tested without touching Electron. All
 * timing thresholds are parameterized for the same reason — tests compress
 * them to seconds and exercise the real generated artifact against real
 * processes (see __tests__/updateScriptMacOS.test.ts).
 */

import { MACOS_UPDATE_RELAUNCH_ARG } from './updateRelaunchSafety';

export interface MacUpdateScriptTimings {
  /** Seconds to wait for the old PID before escalating to SIGKILL. */
  exitKillAfterSeconds: number;
  /** Seconds after which a PID that survived SIGKILL aborts the update. */
  exitAbortAfterSeconds: number;
  /** Total seconds to poll for the relaunched main process. */
  verifyTimeoutSeconds: number;
  /** Second at which `open` is retried (only if the first open failed). */
  verifyRetryAtSeconds: number;
}

export const DEFAULT_MAC_UPDATE_SCRIPT_TIMINGS: MacUpdateScriptTimings = {
  exitKillAfterSeconds: 120,
  exitAbortAfterSeconds: 135,
  verifyTimeoutSeconds: 30,
  verifyRetryAtSeconds: 15,
};

export interface MacUpdateScriptParams {
  /** PID of the exiting app process the script must wait for. */
  pid: number;
  /** Absolute path of the installed .app bundle to replace. */
  appPath: string;
  /** Bundle name without .app, used in log lines. */
  appName: string;
  /** Temp dir the zip is extracted into. */
  extractDir: string;
  /** Downloaded update zip. */
  zipPath: string;
  /** Update lock file the bootstrap spins on during the swap. */
  lockFilePath: string;
  /** Where this script itself is written (self-deleted at the end). */
  scriptPath: string;
  /** cindy-update.log path. */
  logPath: string;
  timings?: Partial<MacUpdateScriptTimings>;
}

/**
 * pgrep -f treats its pattern as an ERE — escape metacharacters so a bundle
 * path matches literally (the "." in ".app" would otherwise match any
 * character, and "()" in a path would break the expression).
 */
export function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildMacOSUpdateScript(params: MacUpdateScriptParams): string {
  const {
    pid, appPath, appName, extractDir, zipPath, lockFilePath, scriptPath, logPath,
  } = params;
  const t = { ...DEFAULT_MAC_UPDATE_SCRIPT_TIMINGS, ...params.timings };
  // Main binary only — used for launch verification ("did the app come up").
  const appBinEre = escapeEre(`${appPath}/Contents/MacOS/`);
  // Whole bundle — used for the pre-swap clear-out. Renderer/GPU/utility
  // helpers run from Contents/Frameworks/... Helper.app/Contents/MacOS and
  // can briefly outlive a SIGKILL'd main process; swapping under them is
  // just as fatal as swapping under the main binary.
  const appBundleEre = escapeEre(`${appPath}/`);

  return [
    '#!/bin/bash',
    `echo "[$(date)] Update script started, waiting for PID ${pid}" >> "${logPath}"`,
    `echo "[$(date)] target app=\\"${appPath}\\" appName=\\"${appName}\\"" >> "${logPath}"`,
    '',
    // Poll until old PID exits — matches Windows :waitloop. The previous
    // single `sleep 1` was racing against ditto when the old process took
    // longer than a second to die.
    //
    // Bounded wait: process.exit(0) can hang in native teardown (observed
    // 2026-07-06: exit logged, PID stayed alive 32h, update never applied).
    // The JS event loop is already dead at that point so the process cannot
    // rescue itself — this script is the only place that can escalate.
    'WAITED=0',
    `while kill -0 ${pid} 2>/dev/null; do`,
    '    sleep 1',
    '    WAITED=$((WAITED+1))',
    `    if [ "$WAITED" -eq ${t.exitKillAfterSeconds} ]; then`,
    `        echo "[$(date)] PID ${pid} still alive after ${t.exitKillAfterSeconds}s — exit appears hung, sending SIGKILL" >> "${logPath}"`,
    `        kill -9 ${pid} 2>/dev/null`,
    '    fi',
    `    if [ "$WAITED" -ge ${t.exitAbortAfterSeconds} ]; then`,
    `        echo "[$(date)] FATAL: PID ${pid} survived SIGKILL — aborting update" >> "${logPath}"`,
    '        exit 1',
    '    fi',
    'done',
    `echo "[$(date)] Process ${pid} exited, waiting for filesystem to settle" >> "${logPath}"`,
    'sleep 2',
    '',
    `echo updating > "${lockFilePath}"`,
    '',
    `mkdir -p "${extractDir}"`,
    `echo "[$(date)] Extracting: ditto -x -k \\"${zipPath}\\" \\"${extractDir}\\"" >> "${logPath}"`,
    `/usr/bin/ditto -x -k "${zipPath}" "${extractDir}" >> "${logPath}" 2>&1`,
    'DITTO_EXIT=$?',
    `echo "[$(date)] ditto exit code: $DITTO_EXIT" >> "${logPath}"`,
    'if [ $DITTO_EXIT -ne 0 ]; then',
    `    echo "[$(date)] DITTO FAILED — aborting, app left intact" >> "${logPath}"`,
    `    rm -f "${lockFilePath}"`,
    '    exit 1',
    'fi',
    '',
    // macOS ships BSD find, which has no GNU -maxdepth option. A shell glob
    // keeps the search top-level, works with spaces in bundle paths, and is
    // available in the Bash used to run this detached script.
    'NEW_APP=""',
    `for candidate in "${extractDir}"/*.app; do`,
    '    if [ -d "$candidate" ]; then',
    '        NEW_APP="$candidate"',
    '        break',
    '    fi',
    'done',
    'if [ -z "$NEW_APP" ]; then',
    `    echo "[$(date)] FATAL: no .app found in ${extractDir} — zip layout unexpected" >> "${logPath}"`,
    `    rm -f "${lockFilePath}"`,
    '    exit 1',
    'fi',
    `echo "[$(date)] new app found: $NEW_APP" >> "${logPath}"`,
    '',
    // A fresh instance may have been launched while we waited (user reopened
    // the app between old-PID exit and the swap). Replacing the bundle under
    // a live process gets it SIGTRAP'd by macOS code-signing enforcement —
    // terminate strays before touching the bundle. Anything matching here is
    // by definition running from the bundle we are about to delete. The
    // update lock was written above, so an instance launched after that is
    // still spinning in bootstrap's lock wait and is pgrep-visible; the
    // last-instant SIGKILL sweep below runs with no sleeps between it and
    // the swap, shrinking the launch race to milliseconds.
    `STRAY_PIDS=$(pgrep -f "${appBundleEre}")`,
    'if [ -n "$STRAY_PIDS" ]; then',
    `    echo "[$(date)] instance(s) launched during update ($STRAY_PIDS) — terminating before swap" >> "${logPath}"`,
    '    kill $STRAY_PIDS 2>/dev/null',
    '    for i in 1 2 3 4 5; do',
    `        pgrep -f "${appBundleEre}" >/dev/null || break`,
    '        sleep 1',
    '    done',
    'fi',
    `STRAY_PIDS=$(pgrep -f "${appBundleEre}")`,
    'if [ -n "$STRAY_PIDS" ]; then',
    `    echo "[$(date)] SIGKILL stragglers just before swap: $STRAY_PIDS" >> "${logPath}"`,
    '    kill -9 $STRAY_PIDS 2>/dev/null',
    'fi',
    '',
    `echo "[$(date)] Removing old app: ${appPath}" >> "${logPath}"`,
    `rm -rf "${appPath}" 2>>"${logPath}"`,
    `echo "[$(date)] Moving new app into place" >> "${logPath}"`,
    `mv "$NEW_APP" "${appPath}" 2>>"${logPath}"`,
    'MV_EXIT=$?',
    `echo "[$(date)] mv exit code: $MV_EXIT" >> "${logPath}"`,
    `if [ $MV_EXIT -ne 0 ] || [ ! -d "${appPath}" ]; then`,
    `    echo "[$(date)] FATAL: APP MISSING at \\"${appPath}\\" after mv — bundle is in a bad state, dock icon will be dead" >> "${logPath}"`,
    `    rm -f "${lockFilePath}"`,
    '    exit 1',
    'fi',
    '',
    `/usr/bin/xattr -cr "${appPath}" 2>>"${logPath}"`,
    `echo "[$(date)] xattr cleared" >> "${logPath}"`,
    '',
    `rm -f "${lockFilePath}"`,
    '',
    `echo "[$(date)] Starting app: open \\"${appPath}\\" --args \\"${MACOS_UPDATE_RELAUNCH_ARG}\\"" >> "${logPath}"`,
    `open "${appPath}" --args "${MACOS_UPDATE_RELAUNCH_ARG}" >> "${logPath}" 2>&1`,
    'OPEN_EXIT=$?',
    `echo "[$(date)] open exit code: $OPEN_EXIT" >> "${logPath}"`,
    '',
    // open(1) returns immediately; verify the new main process actually came up
    // (Gatekeeper / quarantine / signature failure would otherwise fail
    // silently, mirroring the Windows tasklist check). First launch of a
    // freshly-installed bundle goes through a Gatekeeper deep scan that can
    // take well over 3s, so poll and retry open once halfway instead of a
    // single fixed-delay check (which false-negatived).
    'VERIFIED=0',
    `for i in $(seq 1 ${t.verifyTimeoutSeconds}); do`,
    `    if pgrep -f "${appBinEre}" >/dev/null 2>&1; then`,
    '        VERIFIED=1',
    '        break',
    '    fi',
    // Retry open only if the first one actually failed — an unconditional
    // second open while the first launch is still in its Gatekeeper scan
    // could race two instances against each other.
    `    if [ "$i" -eq ${t.verifyRetryAtSeconds} ] && [ "$OPEN_EXIT" -ne 0 ]; then`,
    `        echo "[$(date)] initial open failed (exit $OPEN_EXIT), still not up after ${t.verifyRetryAtSeconds}s — retrying open" >> "${logPath}"`,
    `        open "${appPath}" --args "${MACOS_UPDATE_RELAUNCH_ARG}" >> "${logPath}" 2>&1`,
    '        OPEN_EXIT=$?',
    '    fi',
    '    sleep 1',
    'done',
    'if [ "$VERIFIED" -eq 1 ]; then',
    `    echo "[$(date)] PROCESS VERIFIED: ${appName} main process is running; window activation is a separate presentation state" >> "${logPath}"`,
    'else',
    `    echo "[$(date)] PROCESS START FAILED: ${appName} NOT running ${t.verifyTimeoutSeconds}s after open — likely Gatekeeper-blocked or new bundle is corrupt" >> "${logPath}"`,
    'fi',
    '',
    `rm -rf "${extractDir}"`,
    `rm -f "${zipPath}"`,
    `echo "[$(date)] Cleanup done" >> "${logPath}"`,
    `rm -f "${scriptPath}"`,
  ].join('\n');
}
