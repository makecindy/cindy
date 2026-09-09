/**
 * Trusted local Tencent Harness launch-plan probe.
 *
 * The probe runs only from Main-owned saved profiles. It validates fixed argv
 * shape before spawning `--version`, never accepts renderer-provided command
 * text, and returns only non-secret executable facts.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

import type {
  ApprovedExecutableIdentity,
  HarnessLaunchPlan,
  HarnessRuntimeAgentKind,
  LaunchPlanProbeDeps,
  TencentHarnessWrapperKind,
} from './types.js';

const VERSION_TIMEOUT_MS = 5_000;

function expectedWrapper(agentKind: HarnessRuntimeAgentKind): TencentHarnessWrapperKind {
  return agentKind === 'claude-code' ? 'tclaude' : 'tcodex';
}

function isAbsoluteFile(value: string): boolean {
  return value.length > 0 && path.isAbsolute(value);
}

function parseVersion(output: string, expression: RegExp, label: string): string {
  const match = expression.exec(output);
  if (!match?.[1]) throw new Error(`${label} version was not found in --version output`);
  return match[1];
}

function assertNodeLauncherVersion(output: string): void {
  if (!/(?:^|\n)v\d+\.\d+\.\d+(?:\s|$)/.test(output)) {
    throw new Error('tcodex launcher must be an explicit Node executable');
  }
}

function versionExpressions(wrapper: TencentHarnessWrapperKind): {
  wrapper: RegExp;
  upstream: RegExp;
} {
  return wrapper === 'tclaude'
    ? {
        wrapper: /@tencent\/tclaude\s+([0-9][^\s]*)/i,
        upstream: /@anthropic-ai\/claude-code\s+([0-9][^\s]*)/i,
      }
    : {
        wrapper: /@tencent\/tcodex\s+([0-9][^\s]*)/i,
        upstream: /@openai\/codex\s+([0-9][^\s]*)/i,
      };
}

export function validateTencentHarnessLaunchPlanShape(
  agentKind: HarnessRuntimeAgentKind,
  launchPlan: HarnessLaunchPlan,
): void {
  if (!isAbsoluteFile(launchPlan.executable)) {
    throw new Error('Harness executable must be an absolute path');
  }
  if (!Array.isArray(launchPlan.argsPrefix)) {
    throw new Error('Harness launch argsPrefix must be an array');
  }
  if (agentKind === 'claude-code') {
    if (launchPlan.argsPrefix.length !== 0) {
      throw new Error('tclaude does not accept a wrapper entry script prefix');
    }
    return;
  }
  if (launchPlan.argsPrefix.length !== 1 || !isAbsoluteFile(launchPlan.argsPrefix[0] ?? '')) {
    throw new Error('tcodex requires exactly one wrapper entry script in argsPrefix');
  }
  if (
    launchPlan.argsPrefix.some(
      (argument) => typeof argument !== 'string' || !isAbsoluteFile(argument),
    )
  ) {
    throw new Error('Harness launch argsPrefix must contain only absolute paths');
  }
}

async function runVersion(
  command: string,
  args: readonly string[],
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args, '--version'],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

const defaultDeps: LaunchPlanProbeDeps = {
  realpath: (file) => fsp.realpath(file),
  stat: (file) => fsp.stat(file),
  access: (file, mode) => fsp.access(file, mode),
  runVersion,
};

export async function inspectTencentHarnessLaunchPlan(
  agentKind: HarnessRuntimeAgentKind,
  launchPlan: HarnessLaunchPlan,
  deps: LaunchPlanProbeDeps = defaultDeps,
): Promise<{ launchPlan: HarnessLaunchPlan; identity: ApprovedExecutableIdentity }> {
  validateTencentHarnessLaunchPlanShape(agentKind, launchPlan);

  const wrapperPath =
    agentKind === 'claude-code' ? launchPlan.executable : launchPlan.argsPrefix[0]!;
  await Promise.all([
    deps.access(launchPlan.executable, fs.constants.R_OK | fs.constants.X_OK),
    deps.access(wrapperPath, fs.constants.R_OK),
  ]);
  const [launcherRealpath, wrapperRealpath] = await Promise.all([
    deps.realpath(launchPlan.executable),
    deps.realpath(wrapperPath),
  ]);
  if (!isAbsoluteFile(launcherRealpath) || !isAbsoluteFile(wrapperRealpath)) {
    throw new Error('Harness canonical executable targets must be absolute paths');
  }
  await Promise.all([
    deps.access(launcherRealpath, fs.constants.R_OK | fs.constants.X_OK),
    deps.access(wrapperRealpath, fs.constants.R_OK),
  ]);
  const [launcherStat, wrapperStat] = await Promise.all([
    deps.stat(launcherRealpath),
    deps.stat(wrapperRealpath),
  ]);
  if (!launcherStat.isFile()) {
    throw new Error('Harness executable target must be a regular file');
  }
  if (!wrapperStat.isFile()) {
    throw new Error('Harness wrapper target must be a regular file');
  }
  const canonicalLaunchPlan: HarnessLaunchPlan =
    agentKind === 'claude-code'
      ? { executable: launcherRealpath, argsPrefix: [] }
      : { executable: launcherRealpath, argsPrefix: [wrapperRealpath] };
  const [output, launcherOutput] = await Promise.all([
    deps.runVersion(canonicalLaunchPlan.executable, canonicalLaunchPlan.argsPrefix),
    agentKind === 'codex'
      ? deps.runVersion(canonicalLaunchPlan.executable, [])
      : Promise.resolve(null),
  ]);
  if (launcherOutput) {
    assertNodeLauncherVersion(
      [launcherOutput.stdout, launcherOutput.stderr].filter(Boolean).join('\n'),
    );
  }

  const wrapperKind = expectedWrapper(agentKind);
  const expressions = versionExpressions(wrapperKind);
  const versionText = [output.stdout, output.stderr].filter(Boolean).join('\n');
  const identity: ApprovedExecutableIdentity = {
    launcherRealpath,
    launcherSize: launcherStat.size,
    launcherMtimeMs: launcherStat.mtimeMs,
    realpath: wrapperRealpath,
    size: wrapperStat.size,
    mtimeMs: wrapperStat.mtimeMs,
    wrapperKind,
    wrapperVersion: parseVersion(versionText, expressions.wrapper, wrapperKind),
    upstreamVersion: parseVersion(versionText, expressions.upstream, `${wrapperKind} upstream`),
  };

  return {
    launchPlan: canonicalLaunchPlan,
    identity,
  };
}
