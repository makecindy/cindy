/**
 * Main-owned local Harness runtime profile contracts.
 *
 * A runtime profile is deliberately narrower than a model provider: it
 * describes a trusted executable distribution for an existing Agent adapter.
 * It contains no credentials, endpoints, or renderer-controlled command text.
 */

export type HarnessRuntimeAgentKind = 'claude-code' | 'codex';

export type TencentHarnessWrapperKind = 'tclaude' | 'tcodex';

/**
 * Identifies which component owns upstream authentication and request routing.
 * It prevents an Agent factory from injecting Cindy provider credentials into
 * a Harness-managed Tencent process.
 */
export type HarnessRuntimeOwner = 'cindy' | 'harness';

/**
 * Controls where the runtime reads its own non-Cindy configuration. Tencent
 * wrappers retain their local login/configuration; managed distributions use
 * Cindy's isolated runtime home.
 */
export type HarnessConfigHomePolicy = 'cindy-isolated' | 'harness-default';

export interface HarnessLaunchPlan {
  /** Absolute executable path. Native CLIs use themselves; Node wrappers use Node. */
  executable: string;
  /** Fixed, approved argv prefix before runtime-owned arguments. */
  argsPrefix: string[];
}

/**
 * Non-secret executable facts captured by a successful probe.
 *
 * `realpath` identifies the actual wrapper executable or entry script. The
 * persisted launch plan separately records a Node interpreter when needed.
 */
export interface ApprovedExecutableIdentity {
  /** Canonical target of the program passed to spawn (the native CLI or Node). */
  launcherRealpath: string;
  launcherSize: number;
  launcherMtimeMs: number;
  /** Canonical target of the Harness wrapper executable or entry script. */
  realpath: string;
  size: number;
  mtimeMs: number;
  wrapperKind: TencentHarnessWrapperKind;
  wrapperVersion: string;
  upstreamVersion: string;
}

/**
 * Only affirmative, probe-derived facts belong here. Unknown capabilities are
 * absent rather than treated as true.
 */
export type HarnessCapabilityProfile = Record<string, boolean>;

export interface TencentHarnessRuntimeOverride {
  launchPlan: HarnessLaunchPlan;
  identity: ApprovedExecutableIdentity;
  capabilityProfile?: HarnessCapabilityProfile;
}

export type HarnessRuntimeProfile =
  | {
      agentKind: HarnessRuntimeAgentKind;
      distribution: 'cindy-managed';
      authOwner: 'cindy';
      routeOwner: 'cindy';
      configHomePolicy: 'cindy-isolated';
    }
  | {
      agentKind: HarnessRuntimeAgentKind;
      distribution: 'tencent-local';
      authOwner: 'harness';
      routeOwner: 'harness';
      configHomePolicy: 'harness-default';
      launchPlan: HarnessLaunchPlan;
      identity: ApprovedExecutableIdentity;
      capabilityProfile: HarnessCapabilityProfile;
    };

export interface HarnessRuntimeProfileSettings {
  runtimes: Partial<Record<HarnessRuntimeAgentKind, TencentHarnessRuntimeOverride>>;
}

export interface LaunchPlanProbeDeps {
  realpath(file: string): Promise<string>;
  stat(file: string): Promise<{
    isFile(): boolean;
    size: number;
    mtimeMs: number;
  }>;
  access(file: string, mode: number): Promise<void>;
  runVersion(
    command: string,
    args: readonly string[],
  ): Promise<{
    stdout: string;
    stderr: string;
  }>;
}
