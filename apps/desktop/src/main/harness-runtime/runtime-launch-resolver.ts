/**
 * Main-facing trusted Harness launch resolution.
 *
 * This is the sole seam future Agent factories use to select a Tencent
 * executable. Renderer messages choose a route/model only; they never carry
 * an executable, argv prefix, or command string into this resolver.
 */

import {
  approveTencentHarnessRuntimeProfile,
  getHarnessRuntimeProfile,
  reconcileHarnessRuntimeIdentity,
} from './runtime-profile-store.js';
import { inspectTencentHarnessLaunchPlan } from './runtime-profile-probe.js';
import type {
  HarnessCapabilityProfile,
  HarnessLaunchPlan,
  HarnessRuntimeAgentKind,
  LaunchPlanProbeDeps,
} from './types.js';

export type ResolvedHarnessRuntimeLaunch =
  | {
      agentKind: HarnessRuntimeAgentKind;
      distribution: 'cindy-managed';
      authOwner: 'cindy';
      routeOwner: 'cindy';
      configHomePolicy: 'cindy-isolated';
      launchPlan: HarnessLaunchPlan;
    }
  | {
      agentKind: HarnessRuntimeAgentKind;
      distribution: 'tencent-local';
      authOwner: 'harness';
      routeOwner: 'harness';
      configHomePolicy: 'harness-default';
      launchPlan: HarnessLaunchPlan;
      capabilityProfile: HarnessCapabilityProfile;
      /**
       * A changed binary invalidates all probe-derived capability facts before
       * the caller can enable any high-risk runtime feature.
       */
      identityChanged: boolean;
    };

export interface HarnessRuntimeLaunchResolver {
  /**
   * Resolve the current user's saved profile for a supported Agent kind.
   *
   * This is deliberately the only runtime-selection input accepted at send
   * time. In particular, it accepts neither an executable nor argv from a
   * Renderer-originated request.
   */
  resolve(
    agentKind: HarnessRuntimeAgentKind,
    deps?: LaunchPlanProbeDeps,
  ): Promise<ResolvedHarnessRuntimeLaunch>;
}

export interface CreateHarnessRuntimeLaunchResolverOptions {
  /**
   * Main's installed Cindy runtime plan. This dependency is assembled while
   * bootstrapping the agent factory and is never sent over IPC.
   */
  getManagedLaunchPlan(agentKind: HarnessRuntimeAgentKind): HarnessLaunchPlan;
}

/**
 * Approve a Tencent profile from an explicit Main-owned Settings action.
 *
 * The caller must use this rather than persisting a raw renderer path. A
 * successful inspection canonicalizes the launch plan and records the
 * wrapper/upstream identity; capabilities begin disabled until their own
 * probes complete.
 */
export async function approveTencentHarnessRuntimeLaunchPlan(
  agentKind: HarnessRuntimeAgentKind,
  launchPlan: HarnessLaunchPlan,
  deps?: LaunchPlanProbeDeps,
): Promise<ResolvedHarnessRuntimeLaunch> {
  const inspected = await approveTencentHarnessRuntimeProfile(agentKind, launchPlan, deps);
  return {
    agentKind,
    distribution: 'tencent-local',
    authOwner: 'harness',
    routeOwner: 'harness',
    configHomePolicy: 'harness-default',
    launchPlan: inspected.launchPlan,
    capabilityProfile: {},
    identityChanged: false,
  };
}

/**
 * Create the Main-owned runtime-selection seam used by an Agent factory.
 *
 * The returned resolver receives only the selected Agent kind at task-send
 * time. Tencent plans are re-inspected on every launch; a changed identity
 * clears cached capability facts before the plan is returned.
 */
export function createHarnessRuntimeLaunchResolver(
  options: CreateHarnessRuntimeLaunchResolverOptions,
): HarnessRuntimeLaunchResolver {
  return {
    async resolve(
      agentKind: HarnessRuntimeAgentKind,
      deps?: LaunchPlanProbeDeps,
    ): Promise<ResolvedHarnessRuntimeLaunch> {
      const profile = getHarnessRuntimeProfile(agentKind);
      if (profile.distribution === 'cindy-managed') {
        return {
          agentKind,
          distribution: 'cindy-managed',
          authOwner: 'cindy',
          routeOwner: 'cindy',
          configHomePolicy: 'cindy-isolated',
          launchPlan: cloneLaunchPlan(options.getManagedLaunchPlan(agentKind)),
        };
      }

      const inspected = await inspectTencentHarnessLaunchPlan(agentKind, profile.launchPlan, deps);
      const { identityChanged, capabilityProfile } = reconcileHarnessRuntimeIdentity(
        agentKind,
        inspected.identity,
      );
      return {
        agentKind,
        distribution: 'tencent-local',
        authOwner: 'harness',
        routeOwner: 'harness',
        configHomePolicy: 'harness-default',
        launchPlan: inspected.launchPlan,
        capabilityProfile,
        identityChanged,
      };
    },
  };
}

function cloneLaunchPlan(launchPlan: HarnessLaunchPlan): HarnessLaunchPlan {
  return {
    executable: launchPlan.executable,
    argsPrefix: [...launchPlan.argsPrefix],
  };
}
