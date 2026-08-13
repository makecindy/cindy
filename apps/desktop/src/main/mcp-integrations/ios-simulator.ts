import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { release as hostOsRelease } from 'node:os';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  IOSSimulatorAppLifecycle,
  auditIOSSimulatorScreenMap,
  diffIOSSimulatorScreenMaps,
  IOSSimulatorDeviceGrantRegistryFile,
  IOSSimulatorDeviceGrantStore,
  IOSSimulatorDiagnosticsStore,
  IOSSimulatorFramePump,
  IOSSimulatorH264FramePump,
  IOSSimulatorInstanceActor,
  IOSSimulatorInstanceError,
  IOSSimulatorOwnershipStore,
  IOSSimulatorOwnershipRegistryFile,
  IOSSimulatorPendingCreateEvidenceFile,
  IOSSimulatorProjectBuildError,
  IOSSimulatorProjectBuilder,
  IOSSimulatorResourceScheduler,
  IOSSimulatorScreenMapStore,
  HostIOSSimulatorSidecarSupervisor,
  IOSSimulatorNativeSidecarProcessManager,
  IOSSimulatorStaticSidecarArtifactResolver,
  createIOSSimulatorNativeSidecarSandboxPolicy,
  resolveIOSSimulatorNativeSidecarBinary,
  WdaError,
  WdaProcessManager,
  type IOSSimulatorEnvironmentReport,
  type IOSSimulatorDriverCapabilityReport,
  type IOSSimulatorDeviceGrant,
  type IOSSimulatorAdmissionPolicy,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
  type IOSSimulatorNativeSidecarDiagnostics,
  type IOSSimulatorAppArtifact,
  type IOSSimulatorFramePumpSnapshot,
  type IOSSimulatorGrantDecision,
  type IOSSimulatorInstance,
  type IOSSimulatorLocationRouteOptions,
  type IOSSimulatorLiveTouchPoint,
  type IOSSimulatorContentSize,
  type IOSSimulatorScreenMap,
  type IOSSimulatorMutationRoute,
  type IOSSimulatorNativeSidecarDriver,
  type IOSSimulatorLatestH264Frame,
  type IOSSimulatorPendingCreateEvidence,
  type IOSSimulatorPendingCreateEvidenceStore,
  type IOSSimulatorProjectBuildResult,
  type IOSSimulatorRuntime,
  type IOSSimulatorSimctlLifecycle,
  type IOSSimulatorStreamProfile,
  type IOSSimulatorStatusBarOverrides,
  type IOSSimulatorTouchEdge,
  type IOSSimulatorTouchPoint,
  type IOSSimulatorWindowSize,
  type WdaRunningInstance,
  type WdaStartOptions,
} from '@cindy/ios-simulator-runtime';
import type {
  IOSSimulatorMcpCallContext,
  IOSSimulatorMcpAccessDecision,
  IOSSimulatorMcpDeps,
  IOSSimulatorMcpErrorCode,
  IOSSimulatorMcpToolName,
  IOSSimulatorToolAvailability,
  IOSSimulatorToolAvailabilityReport,
} from '@cindy/mcps';

import type {
  IOSSimulatorNativeH264StreamProfileRequest,
  IOSSimulatorPublicEnvironmentReport,
  IOSSimulatorPublicInstance,
  IOSSimulatorPublicViewport,
  IOSSimulatorPublicRouteReasonCode,
  IOSSimulatorPublicRouteState,
  IOSSimulatorPublicRouteStatus,
  IOSSimulatorSessionStatus,
} from '../../shared/iosSimulatorIpc.js';
import type {
  GhostIOSSimulatorStatusProbeResult,
  GhostIOSSimulatorStatusSnapshot,
} from '../../shared/ghost.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { redact } from '../log-upload/redact.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { desktopSessionStorage } from '../maker-host/session-storage.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import {
  IOSSimulatorPackagedSidecarArtifactResolver,
  verifyIOSSimulatorSidecarDigest,
} from './ios-simulator-artifact.js';
import { resolveIOSSimulatorDesktopAdmissionPolicy } from './ios-simulator-admission.js';
import { registerIOSSimulatorExitAbortHandler } from './ios-simulator-exit.js';
import { compareIOSSimulatorPngBuffers, IOSSimulatorMediaCapture } from './ios-simulator-media.js';
import {
  clearIOSSimulatorRendererAccess,
  configureIOSSimulatorRendererAccessRevocationObserver,
  focusIOSSimulatorRendererSession,
  pushIOSSimulatorRouteStatusToGrantedRenderers,
  revokeIOSSimulatorRendererSession,
} from './ios-simulator-renderer-access.js';

const logger = createLogger('mcp/cindy_ios_simulator');
const BUILD_DIAGNOSTICS_TTL_MS = 30 * 60_000;
const PLUGIN_ENVIRONMENT_CACHE_MS = 30_000;
const MAX_BUILD_DIAGNOSTICS = 32;
const MANAGED_BUILD_RESULT_BUNDLE_PATTERN = /^CindyBuild(?:-[0-9a-f-]+)?\.xcresult$/i;
const DEFAULT_DEVICE_LIVENESS_INTERVAL_MS = 1_000;
const MAX_WDA_VIEWER_FRAMES_PER_SECOND = 20;
const MAX_NATIVE_H264_VIEWER_FRAMES_PER_SECOND = 60;
const MAX_INSTANCES_PER_SESSION = 4;

interface IOSSimulatorSessionSnapshot {
  id: string;
  workDir: string;
  remoteHostId?: string | null;
  status?: 'active' | 'archived' | 'deleted' | null;
}

interface IOSSimulatorPersistedInstanceReconcileResult {
  /** False when this binding still needs another reconcile pass. */
  complete: boolean;
  /**
   * True once this pass either reconciled the binding or removed it, meaning a
   * later pass must no longer treat its persisted `viewerState` as inherited.
   */
  viewerStateHandled: boolean;
}

interface IOSSimulatorPluginStatusReadOptions {
  /** Test seam; production uses the active Main-owned task database. */
  getSession?: (sessionId: string) => Promise<IOSSimulatorSessionSnapshot | null>;
  /** Test seam; production uses the shared passive environment cache. */
  inspectEnvironment?: () => Promise<IOSSimulatorEnvironmentReport>;
  /** Test seam for account-generation fencing around passive async reads. */
  getOwnerScopeKey?: () => string;
  /** Test seam for the fail-closed account replacement boundary. */
  isOwnerBoundaryPending?: () => boolean;
  /** Test seam for Desktop shutdown racing a passive status read. */
  isHostClosing?: () => boolean;
}

interface IOSSimulatorDriverManager {
  get(instanceId: string): WdaRunningInstance | null;
  probe?(instanceId: string): Promise<WdaRunningInstance | null>;
  cleanupOrphaned?(instanceId: string, simulatorUdid: string): Promise<void>;
  start(options: WdaStartOptions): Promise<WdaRunningInstance>;
  stop(instanceId: string): Promise<void>;
  recoverNativeSidecar?(
    instanceId: string,
    options?: { rearm?: boolean },
  ): Promise<WdaRunningInstance | null>;
  diagnostics?(instanceId: string): {
    running: boolean;
    logTail: string;
    capabilityReport?: IOSSimulatorDriverCapabilityReport | null;
    nativeSidecar?: IOSSimulatorNativeSidecarDiagnostics | null;
  };
  /** Synchronous child teardown used immediately before updater force-quit. */
  abortOperationsForExit?(): void;
}

export type IOSSimulatorAppLifecycleAdapter = Pick<
  IOSSimulatorAppLifecycle,
  'inspectArtifact' | 'installExact' | 'launchExact' | 'terminateExact' | 'openUrlExact'
>;

export type IOSSimulatorProjectBuilderAdapter = Pick<IOSSimulatorProjectBuilder, 'build'> & {
  readXcresult?: IOSSimulatorProjectBuilder['readXcresult'];
  validateLaunch?: IOSSimulatorProjectBuilder['validateLaunch'];
};

export type IOSSimulatorMediaCaptureAdapter = Pick<
  IOSSimulatorMediaCapture,
  | 'takeScreenshot'
  | 'captureScreenshotBytes'
  | 'startRecording'
  | 'stopRecording'
  | 'discardInstance'
  | 'discardSession'
> &
  Partial<Pick<IOSSimulatorMediaCapture, 'dispose' | 'abortOperationsForExit'>>;

export type IOSSimulatorHostResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      errorCode: IOSSimulatorMcpErrorCode;
      message: string;
      data?: Record<string, unknown>;
    };

export interface IOSSimulatorHostOptions {
  runtime?: IOSSimulatorRuntime;
  actor?: IOSSimulatorInstanceActor;
  lifecycle?: IOSSimulatorSimctlLifecycle;
  grantStore?: IOSSimulatorDeviceGrantStore;
  driverManager?: IOSSimulatorDriverManager;
  framePump?: IOSSimulatorFramePump;
  h264FramePump?: IOSSimulatorH264FramePump;
  appLifecycle?: IOSSimulatorAppLifecycleAdapter;
  projectBuilder?: IOSSimulatorProjectBuilderAdapter;
  mediaCapture?: IOSSimulatorMediaCaptureAdapter;
  diagnosticsStore?: IOSSimulatorDiagnosticsStore;
  resourceScheduler?: IOSSimulatorResourceScheduler;
  /** Fail-closed gate supplied by the persisted registry owner. */
  canReconcilePendingCreates?: () => boolean;
  /**
   * Profile-scoped interrupted-create breadcrumb shared with the injected
   * lifecycle. A completed sweep retires it so later startups can skip the
   * CoreSimulator probe entirely.
   */
  pendingCreateEvidence?: IOSSimulatorPendingCreateEvidenceStore;
  /** Main-owned account generation used to scope persisted ownership reconciliation. */
  getOwnerScopeKey?: () => string;
  /** Fail closed while the active account runtime is being replaced. */
  isOwnerBoundaryPending?: () => boolean;
  /** Recycle an idle WDA process while retaining the booted simulator binding. */
  idleRecycleMs?: number;
  /** Minimum interval between exact-UDID CoreSimulator liveness checks. */
  deviceLivenessIntervalMs?: number;
  getSession?: (sessionId: string) => Promise<IOSSimulatorSessionSnapshot | null>;
  /** Serialize persisted recovery with task archive/restore/send mutations. */
  withSessionLock?: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  resolveWorktreeRoot?: (workDir: string) => Promise<string>;
  requestViewerFocus?: (sessionId: string, instanceId: string) => void;
  /** Main → renderer route diagnostics seam; injected in tests, broadcast by default. */
  pushRouteStatus?: (status: IOSSimulatorPublicRouteStatus) => void;
  /** Main → exact owning viewer frame seam; injected in tests, fail-closed by default. */
  pushH264Frame?: (viewerWebContentsId: number, frame: IOSSimulatorLatestH264Frame) => void;
  /** Exact viewer liveness seam used to prevent cross-window ownership replacement. */
  isViewerWebContentsAlive?: (viewerWebContentsId: number) => boolean;
}

export interface IOSSimulatorHost {
  /** Stop host-owned WDA/recording resources without changing simulator ownership. */
  dispose(): Promise<void>;
  /** Synchronously signal child process trees before updater force-quit bypasses async cleanup. */
  abortOperationsForExit(): void;
  /** Cancel build processes before a task is archived, deleted, or its worktree is recycled. */
  cancelSessionOperations(sessionId: string): Promise<void>;
  /** Tear down all simulator runtime and ownership after a task is durably removed. */
  cleanupRemovedSession(sessionId: string): Promise<void>;
  reconcileOwnership(): Promise<void>;
  describeTools(sessionId: string): Promise<IOSSimulatorToolAvailabilityReport>;
  getStatus(sessionId: string): Promise<IOSSimulatorSessionStatus>;
  /** Read-only, redacted plugin projection; never reconciles or renews an ownership lease. */
  getPluginStatus(sessionId: string): Promise<GhostIOSSimulatorStatusProbeResult>;
  /** Synchronously retire media/input owned by one exact revoked renderer grant. */
  revokeRendererViewer(sessionId: string, viewerWebContentsId: number): number;
  callTool(
    name: IOSSimulatorMcpToolName,
    args: Record<string, unknown>,
    context?: IOSSimulatorMcpCallContext,
  ): Promise<IOSSimulatorHostResult>;
  setAgentControlGrant(
    sessionId: string,
    instanceId: string,
    decision: Exclude<IOSSimulatorGrantDecision, 'unknown'>,
    assertElevationCurrent?: () => void,
  ): Promise<IOSSimulatorHostResult>;
  setAgentMutationPaused(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    paused: boolean,
  ): Promise<IOSSimulatorHostResult>;
  setViewerVisibility(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    visible: boolean,
    preferredEncoding?: 'jpeg' | 'h264',
    fallbackReason?: 'native-decoder-fallback',
    viewerWebContentsId?: number,
    viewerToken?: string,
  ): Promise<IOSSimulatorHostResult>;
  getLatestFrame(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    viewerWebContentsId: number,
  ): Promise<IOSSimulatorHostResult>;
  setViewerStreamProfile(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    viewerWebContentsId: number,
    viewerToken: string,
    profile: IOSSimulatorStreamProfile,
    nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest,
  ): Promise<IOSSimulatorHostResult>;
  updateViewerTouch(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    viewerWebContentsId: number,
    touch: {
      gestureId: string;
      phase: 'begin' | 'move' | 'end' | 'cancel';
      xRatio: number;
      yRatio: number;
    },
  ): Promise<IOSSimulatorHostResult>;
}

type SessionResolution =
  | {
      ok: true;
      sessionId: string;
      session: IOSSimulatorSessionSnapshot;
      removalBarrierOperation?: IOSSimulatorSessionRemovalBarrierOperation;
    }
  | Extract<IOSSimulatorSessionStatus, { ok: false }>;

interface IOSSimulatorSessionRemovalBarrierOperation {
  admissionEpoch: number;
  settled: Promise<void>;
  finish(): void;
}

function sessionError(
  sessionId: string | null,
  errorCode: IOSSimulatorMcpErrorCode,
  message: string,
): Extract<IOSSimulatorSessionStatus, { ok: false }> {
  return { ok: false, sessionId, errorCode, message };
}

function projectPluginEnvironment(
  environment: IOSSimulatorEnvironmentReport,
): GhostIOSSimulatorStatusSnapshot['environment'] {
  return {
    platform: environment.platform,
    supported: environment.supported,
    ready: environment.ready,
    xcodeVersion: environment.xcodeVersion,
    availableDeviceCount: environment.devices.filter((device) => device.isAvailable).length,
  };
}

function reportDetachCleanupError(error: unknown, instance: IOSSimulatorInstance): void {
  logger.warn('iOS Simulator deferred detach cleanup failed and will retry', {
    instanceId: instance.instanceId,
    simulatorUdid: instance.simulatorUdid,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function createRegistryBackedIOSSimulatorActor(
  lifecycle: IOSSimulatorSimctlLifecycle,
  registry: IOSSimulatorOwnershipRegistryFile,
): {
  actor: IOSSimulatorInstanceActor;
  flush: () => Promise<void>;
  release: () => void;
  canReconcilePendingCreates: () => boolean;
} {
  let ownsWriterLease = false;
  let startupError: unknown = null;
  try {
    ownsWriterLease = registry.acquireWriterSync();
  } catch (error) {
    startupError = new IOSSimulatorInstanceError(
      'DEVICE_BUSY',
      'Cindy cannot safely manage iOS Simulator devices because the ownership registry is unavailable.',
      false,
    );
    logger.error('iOS Simulator ownership registry writer could not start', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    let initialInstances: IOSSimulatorInstance[] = [];
    if (ownsWriterLease && !startupError) {
      try {
        initialInstances = registry.loadSync();
      } catch (error) {
        // A corrupt/partially-written registry must fail closed for Simulator
        // ownership without preventing the rest of Desktop Main from starting.
        // Keep the writer lease and refuse every ownership mutation so another
        // process cannot claim the same devices or overwrite recovery evidence.
        startupError = new IOSSimulatorInstanceError(
          'DEVICE_BUSY',
          'Cindy cannot safely manage iOS Simulator devices because the ownership registry is invalid.',
          false,
        );
        logger.error('iOS Simulator ownership registry is unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const assertMutationAllowed = (): void => {
      if (startupError) throw startupError;
      registry.assertWriter();
    };
    const store = new IOSSimulatorOwnershipStore({
      maxInstancesPerSession: MAX_INSTANCES_PER_SESSION,
      initialInstances,
      assertMutationAllowed,
      // Persist in the same mutation transaction. If the writer lease is lost or
      // the atomic write fails, OwnershipStore rolls its in-memory mutation back.
      onChange: (instances) => registry.saveSync(instances),
    });
    return {
      actor: new IOSSimulatorInstanceActor({
        store,
        lifecycle,
        assertMutationAllowed,
        onDetachCleanupError: reportDetachCleanupError,
      }),
      flush: async () => {
        if (registry.isWriter && !startupError) registry.saveSync(store.listAll());
      },
      release: () => registry.releaseWriterSync(),
      canReconcilePendingCreates: () => !startupError && registry.isWriter,
    };
  } catch (error) {
    registry.releaseWriterSync();
    throw error;
  }
}

function createDefaultOwnershipRegistry(): IOSSimulatorOwnershipRegistryFile {
  return new IOSSimulatorOwnershipRegistryFile(
    path.join(app.getPath('userData'), 'ios-simulator', 'ownership-registry.json'),
  );
}

/**
 * Device consent is profile-scoped but independent from task ownership. Reuse
 * the ownership registry's process-wide writer lease while keeping a corrupt
 * consent snapshot from blocking lifecycle recovery: invalid data restores as
 * all-unknown, and the next explicit decision must persist before it succeeds.
 */
export function createRegistryBackedIOSSimulatorDeviceGrantStore(
  ownershipRegistry: IOSSimulatorOwnershipRegistryFile,
): IOSSimulatorDeviceGrantStore {
  const grantRegistry = new IOSSimulatorDeviceGrantRegistryFile(
    path.join(path.dirname(ownershipRegistry.filePath), 'device-grants.json'),
    { assertMutationAllowed: () => ownershipRegistry.assertWriter() },
  );
  let initialGrants: IOSSimulatorDeviceGrant[];
  try {
    initialGrants = grantRegistry.loadSync();
  } catch (error) {
    if (error instanceof IOSSimulatorInstanceError && error.code === 'DEVICE_BUSY') {
      throw error;
    }
    logger.warn('Ignoring invalid persisted iOS Simulator device grants', {
      filePath: redact(grantRegistry.filePath),
      error: error instanceof Error ? error.message : String(error),
    });
    initialGrants = [];
  }
  return new IOSSimulatorDeviceGrantStore({
    initialGrants,
    assertMutationAllowed: () => ownershipRegistry.assertWriter(),
    onChange: (grants) => grantRegistry.saveSync(grants),
  });
}

/**
 * Interrupted-create evidence lives beside the ownership registry, inside the
 * active Cindy profile. Its presence is the only reason a profile without
 * persisted ownership still needs a CoreSimulator sweep, so keeping it accurate
 * is what keeps Xcode consent prompts tied to real simulator use.
 */
function createDefaultPendingCreateEvidence(
  registry: IOSSimulatorOwnershipRegistryFile,
): IOSSimulatorPendingCreateEvidenceStore {
  const filePath = path.join(path.dirname(registry.filePath), 'pending-create-evidence.json');
  return new IOSSimulatorPendingCreateEvidenceFile(filePath, {
    onError: (error) =>
      logger.warn('iOS Simulator interrupted-create evidence could not be updated', {
        filePath: redact(filePath),
        error: error instanceof Error ? error.message : String(error),
      }),
  });
}

function createProfileScopedIOSSimulatorLifecycle(
  registry: IOSSimulatorOwnershipRegistryFile,
  pendingCreateEvidence: IOSSimulatorPendingCreateEvidence,
): IOSSimulatorSimctlLifecycle {
  const createMarkerNamespace = createHash('sha256')
    .update(path.resolve(registry.filePath))
    .digest('hex')
    .slice(0, 16);
  return createIOSSimulatorSimctlLifecycle({ createMarkerNamespace, pendingCreateEvidence });
}

const STARTUP_PENDING_CREATE_RECOVERY_TIMEOUT_MS = 6_000;

async function recoverProfilePendingCreatesAtStartup(
  lifecycle: IOSSimulatorSimctlLifecycle,
  persistedInstances: readonly IOSSimulatorInstance[],
  options: {
    signal?: AbortSignal;
    /** Retired only after a completed sweep proves no marker is left. */
    evidence?: IOSSimulatorPendingCreateEvidenceStore | null;
  } = {},
): Promise<void> {
  if (!lifecycle.recoverPendingCreatesAtStartup) return;
  const { signal, evidence } = options;
  const evidenceGeneration = evidence?.generation() ?? 0;
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Simulator pending-create startup recovery timed out')),
    STARTUP_PENDING_CREATE_RECOVERY_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const recovery = await lifecycle.recoverPendingCreatesAtStartup(
      persistedInstances.map((instance) => ({
        udid: instance.simulatorUdid,
        name: instance.simulatorName,
      })),
      controller.signal,
    );
    // A completed sweep proves this profile holds no leftover create marker.
    // Retire the breadcrumb so the next startup stays off xcrun — unless
    // another create armed it while this sweep was still running.
    if (recovery.complete) evidence?.clearIfUnchanged(evidenceGeneration);
  } catch (error) {
    // A marker remains hidden and profile-scoped, so an optional Simulator
    // cleanup failure must not block Cindy startup. Keeping it intact lets the
    // next startup retry under the same exclusive registry lease.
    logger.warn('Interrupted simulator create startup recovery will retry', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

function createDefaultActor(
  lifecycle: IOSSimulatorSimctlLifecycle,
  registry = createDefaultOwnershipRegistry(),
): {
  actor: IOSSimulatorInstanceActor;
  flush: () => Promise<void>;
  release: () => void;
  canReconcilePendingCreates: () => boolean;
} {
  const persisted = createRegistryBackedIOSSimulatorActor(lifecycle, registry);
  if (!registry.isWriter) {
    persisted.release();
    throw new IOSSimulatorInstanceError(
      'DEVICE_BUSY',
      'Another Cindy process is managing iOS Simulator ownership for this profile.',
      true,
    );
  }
  return persisted;
}

function createInMemoryActor(lifecycle: IOSSimulatorSimctlLifecycle): IOSSimulatorInstanceActor {
  return new IOSSimulatorInstanceActor({
    store: new IOSSimulatorOwnershipStore({
      maxInstancesPerSession: MAX_INSTANCES_PER_SESSION,
    }),
    lifecycle,
    onDetachCleanupError: reportDetachCleanupError,
  });
}

function createDefaultDriverManager(): IOSSimulatorDriverManager {
  const resourceRoot = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const artifactResolver = app.isPackaged
    ? new IOSSimulatorPackagedSidecarArtifactResolver({
        resourcesPath: resourceRoot,
        version: app.getVersion(),
        architecture,
      })
    : new IOSSimulatorStaticSidecarArtifactResolver({
        artifactId: 'cindy.ios-simulator-sidecar',
        source: 'bundled',
        version: app.getVersion(),
        architecture,
        executablePath: resolveIOSSimulatorNativeSidecarBinary(resourceRoot, architecture),
        trust: 'development',
        sha256: null,
      });
  const nativeAdmissionPolicy: IOSSimulatorAdmissionPolicy = {
    resolve: ({ artifact, start }): IOSSimulatorNativeCapabilityAdmissionPolicy =>
      resolveIOSSimulatorDesktopAdmissionPolicy({
        packaged: app.isPackaged,
        platform: process.platform,
        architecture: process.arch,
        hostOsRelease: hostOsRelease(),
        artifact,
        start,
        developmentRequests: {
          // Native routes are probe-first by default in development too. A
          // deliberate `0` remains an escape hatch for diagnosing WDA-only.
          h264Stream: process.env.CINDY_IOS_SIMULATOR_NATIVE_H264 !== '0',
          continuousInput: process.env.CINDY_IOS_SIMULATOR_NATIVE_HID !== '0',
        },
      }),
  };
  const nativeCapabilityProvider = new HostIOSSimulatorSidecarSupervisor({
    providerId: 'cindy.bundled-ios-simulator',
    artifactResolver,
    admissionPolicy: nativeAdmissionPolicy,
    createRuntime: ({ artifact, admissionPolicy }) =>
      new IOSSimulatorNativeSidecarProcessManager({
        binaryPath: artifact.executablePath,
        admissionPolicy,
        verifyBinaryIntegrity: artifact.sha256
          ? () => verifyIOSSimulatorSidecarDigest(artifact.executablePath, artifact.sha256!)
          : undefined,
        sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
          required: true,
          platform: process.platform,
          developerDirectory:
            process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer',
          coreSimulatorRoot: path.join(
            app.getPath('home'),
            'Library',
            'Developer',
            'CoreSimulator',
          ),
        }),
      }),
  });
  return new WdaProcessManager({
    archivePath: path.join(resourceRoot, 'ios-simulator', 'WebDriverAgent-v15.1.6.tar.gz'),
    cacheRoot: path.join(app.getPath('userData'), 'ios-simulator', 'wda'),
    nativeCapabilityProvider,
  });
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', `${key} is required`);
  }
  return value.trim();
}

function readOptionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a non-empty string no longer than ${maxLength} characters`,
    );
  }
  return value.trim();
}

function readObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', `${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readPositiveInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', `${key} must be a positive integer`);
  }
  return Number(value);
}

function readNonNegativeInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a non-negative integer`,
    );
  }
  return Number(value);
}

function readFiniteCoordinate(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a bounded non-negative number`,
    );
  }
  return value;
}

function readBoundedFinite(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be between ${min} and ${max}`,
    );
  }
  return value;
}

function readPositiveFinite(args: Record<string, unknown>, key: string, max: number): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a positive number no greater than ${max}`,
    );
  }
  return value;
}

function readNormalizedCoordinate(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a finite number between 0 and 1`,
    );
  }
  return value;
}

function readMutationRoute(
  sessionId: string,
  args: Record<string, unknown>,
): IOSSimulatorMutationRoute {
  return {
    sessionId,
    instanceId: readString(args, 'instanceId'),
    generation: readPositiveInteger(args, 'generation'),
    leaseId: readString(args, 'leaseId'),
  };
}

function sourceFingerprint(worktreeRoot: string): string {
  return createHash('sha256').update(`worktree:${worktreeRoot}`).digest('hex');
}

function publicInstance(instance: IOSSimulatorInstance): IOSSimulatorPublicInstance {
  const { worktreeRoot, ...safe } = instance;
  void worktreeRoot;
  return safe;
}

function instanceData(instance: IOSSimulatorInstance): { instance: IOSSimulatorPublicInstance } {
  return { instance: publicInstance(instance) };
}

function displayRuntimeName(device: IOSSimulatorEnvironmentReport['devices'][number]): string {
  const identifierMatch = device.runtimeIdentifier.match(
    /\.SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/,
  );
  if (identifierMatch) {
    return `${identifierMatch[1]} ${identifierMatch[2].replace(/-/g, '.')}`;
  }
  return device.runtimeName.replace(
    /^(iOS) (\d+(?:-\d+)+)$/,
    (_match, platform, version) => `${platform} ${String(version).replace(/-/g, '.')}`,
  );
}

function publicEnvironment(
  environment: IOSSimulatorEnvironmentReport,
  options: {
    sessionId?: string;
    instances?: readonly IOSSimulatorInstance[];
  } = {},
): IOSSimulatorPublicEnvironmentReport {
  const { xcodeSelectPath, runtimes, devices, ...safe } = environment;
  void xcodeSelectPath;
  const error = environment.ready
    ? null
    : environment.issue === 'UNSUPPORTED_PLATFORM'
      ? 'iOS Simulator is available only for local macOS sessions.'
      : environment.issue === 'XCODE_NOT_FOUND'
        ? 'Xcode and its command line tools are required.'
        : environment.issue === 'IOS_RUNTIME_NOT_FOUND'
          ? 'No available iOS Simulator runtime is installed.'
          : environment.issue === 'NO_SIMULATOR_DEVICES'
            ? 'No available iOS Simulator device exists.'
            : 'The iOS Simulator environment is unavailable.';
  return {
    ...safe,
    error,
    runtimes: runtimes.map((runtime) => {
      const { availabilityError: _availabilityError, ...safeRuntime } = runtime;
      void _availabilityError;
      return safeRuntime;
    }),
    devices: devices.map((device) => {
      const { availabilityError, ...safeDevice } = device;
      const runtimeAvailabilityError = runtimes.find(
        (runtime) => runtime.identifier === device.runtimeIdentifier,
      )?.availabilityError;
      const owner = options.instances?.find(
        (instance) => instance.simulatorUdid.toUpperCase() === device.udid.toUpperCase(),
      );
      const ownership = options.sessionId
        ? owner?.sessionId === options.sessionId
          ? 'current-task'
          : owner
            ? 'other-task'
            : 'unowned'
        : undefined;
      const unavailableReason = device.isAvailable
        ? undefined
        : [availabilityError, runtimeAvailabilityError].some(
              (detail) => detail && /runtime profile not found/i.test(detail),
            )
          ? ({ code: 'missing-runtime', runtimeName: displayRuntimeName(device) } as const)
          : ({ code: 'device-unavailable' } as const);
      return {
        ...safeDevice,
        ...(unavailableReason?.code === 'missing-runtime'
          ? { runtimeName: unavailableReason.runtimeName }
          : {}),
        ...(ownership ? { ownership } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
      };
    }),
  };
}

function publicDriverLogTail(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, '<redacted-url>')
    .replace(/(?:\/Users\/|\/private\/var\/|\/tmp\/)[^\s)]+/g, '<redacted-path>')
    .replace(
      /\b(authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2<redacted>',
    )
    .slice(-8_000);
}

function publicNativeSidecarDiagnostics(
  diagnostics: IOSSimulatorNativeSidecarDiagnostics | null | undefined,
): IOSSimulatorNativeSidecarDiagnostics | null {
  if (!diagnostics) return null;
  return {
    ...diagnostics,
    // Sidecar/framework text is an untrusted implementation detail. The
    // structured probe and admission decision carry the public diagnosis.
    lastFailure: diagnostics.lastFailure ? 'Native sidecar is unavailable.' : null,
    lastTermination: diagnostics.lastTermination
      ? {
          ...diagnostics.lastTermination,
          message: publicDriverLogTail(diagnostics.lastTermination.message).slice(-2_000),
          stderrTail: diagnostics.lastTermination.stderrTail
            ? publicDriverLogTail(diagnostics.lastTermination.stderrTail)
            : null,
        }
      : null,
  };
}

function publicBuildText(value: string): string {
  return redact(value)
    .replace(/https?:\/\/[^\s)]+/gi, '<redacted-url>')
    .replace(/(?:\/Users\/|\/private\/var\/|\/tmp\/)[^\s"']+/g, '<redacted-path>')
    .slice(-2 * 1024 * 1024);
}

class IOSSimulatorHostDisposedError extends Error {
  constructor() {
    super('The iOS Simulator host is shutting down.');
    this.name = 'IOSSimulatorHostDisposedError';
  }
}

function safeHostError(
  error: unknown,
  sessionId: string,
  operation: string,
): IOSSimulatorHostResult {
  const errorCode: IOSSimulatorMcpErrorCode =
    error instanceof IOSSimulatorInstanceError
      ? error.code
      : error instanceof WdaError
        ? error.code === 'START_CANCELLED'
          ? 'MUTATION_CANCELLED'
          : error.code === 'BUILD_FAILED'
            ? 'XCODE_BUILD_FAILED'
            : error.code === 'UNREACHABLE'
              ? 'DRIVER_DISCONNECTED'
              : error.code === 'ORIENTATION_UNSUPPORTED'
                ? 'ORIENTATION_UNSUPPORTED'
                : 'WDA_UNAVAILABLE'
        : 'IOS_SIMULATOR_HOST_ERROR';
  logger.warn('iOS Simulator host call failed', {
    sessionId,
    tool: operation,
    errorCode,
    error: error instanceof Error ? error.message : String(error),
  });
  const publicMessage =
    error instanceof IOSSimulatorHostDisposedError
      ? error.message
      : error instanceof WdaError
        ? error.code === 'START_CANCELLED'
          ? 'The simulator automation driver startup was cancelled.'
          : error.code === 'BUILD_FAILED'
            ? 'WebDriverAgent could not be built for this simulator.'
            : error.code === 'UNREACHABLE'
              ? 'The simulator automation driver is disconnected.'
              : error.code === 'ORIENTATION_UNSUPPORTED'
                ? 'The foreground app does not support the requested orientation.'
                : 'The simulator automation driver is unavailable.'
        : error instanceof IOSSimulatorInstanceError
          ? error.message
          : 'The iOS Simulator operation failed.';
  return {
    ok: false,
    errorCode,
    message: publicMessage,
  };
}

/** Main-owned module shared by MCP and IPC callers. */
export function createIOSSimulatorHost(options: IOSSimulatorHostOptions = {}): IOSSimulatorHost {
  const runtime = options.runtime ?? createIOSSimulatorRuntime();
  const lifecycle = options.lifecycle ?? createIOSSimulatorSimctlLifecycle();
  // The exported factory is an isolated test/embedding seam. Only the module
  // singleton below owns the profile-persisted registry and its writer lease.
  const actor = options.actor ?? createInMemoryActor(lifecycle);
  const grantStore = options.grantStore ?? new IOSSimulatorDeviceGrantStore();
  /**
   * A successful agent-created/agent-attached binding gets a host-issued,
   * process-local control lease for that same Cindy session. This removes the
   * redundant pane click from the normal attach -> start workflow without
   * turning a device grant into a cross-session permission.
   */
  const agentControlLeases = new Map<string, string>();
  const screenMaps = new IOSSimulatorScreenMapStore();
  const framePump = options.framePump ?? new IOSSimulatorFramePump();
  const viewerSessions = new Map<
    string,
    { sessionId: string; webContentsId: number | null; viewerToken: string | null }
  >();
  type ViewerVisibilityIntent = {
    sequence: number;
    sessionId: string;
    viewerToken: string | null;
    visible: boolean;
  };
  const viewerVisibilityIntents = new Map<string, Map<number, ViewerVisibilityIntent>>();
  let nextViewerVisibilityIntentSequence = 0;
  const activeViewerTouches = new Map<string, Map<string, IOSSimulatorLiveTouchPoint>>();
  const pushH264Frame =
    options.pushH264Frame ??
    ((viewerWebContentsId: number, frame: IOSSimulatorLatestH264Frame) => {
      const target = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === viewerWebContentsId,
      );
      if (!target || !isTrustedAppRendererWindow(target)) return;
      const bytes = frame.bytes.slice().buffer as ArrayBuffer;
      target.webContents.send('maker:ios-simulator:h264-frame', {
        frame: {
          ...frame,
          bytes,
        },
      });
    });
  const isViewerWebContentsAlive =
    options.isViewerWebContentsAlive ??
    ((viewerWebContentsId: number) =>
      BrowserWindow.getAllWindows().some(
        (candidate) =>
          !candidate.isDestroyed() &&
          !candidate.webContents.isDestroyed() &&
          candidate.webContents.id === viewerWebContentsId &&
          isTrustedAppRendererWindow(candidate),
      ));
  const h264FramePump =
    options.h264FramePump ??
    new IOSSimulatorH264FramePump({
      onFrame: (frame: IOSSimulatorLatestH264Frame) => {
        const viewer = viewerSessions.get(frame.instanceId);
        if (!viewer) return;
        try {
          const instance = actor.getOwned(viewer.sessionId, frame.instanceId);
          if (instance.generation !== frame.generation) return;
          if (viewer.webContentsId !== null) {
            pushH264Frame(viewer.webContentsId, frame);
          }
          publishRouteStatusForInstance(instance);
        } catch (error) {
          // The instance or exact viewer may have disappeared while this frame
          // was queued. Never fall back to broadcasting encoded screen data.
          logger.debug('iOS Simulator H.264 frame push skipped', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
  const appLifecycle = options.appLifecycle ?? new IOSSimulatorAppLifecycle();
  const projectBuilder = options.projectBuilder ?? new IOSSimulatorProjectBuilder();
  const appArtifacts = new Map<
    string,
    {
      instanceId: string;
      projectKind: IOSSimulatorProjectBuildResult['kind'];
      artifact: IOSSimulatorAppArtifact;
    }
  >();
  type BuildDiagnosticRecord = {
    sessionId: string;
    instanceId: string;
    logTail: string;
    resultBundlePath: string | null;
    xcresultText: string | null;
    outputTruncated: boolean;
    createdAt: number;
  };
  const buildDiagnostics = new Map<string, BuildDiagnosticRecord>();
  const buildDiagnosticExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const buildDiagnosticReaders = new Map<string, number>();
  const buildDiagnosticReadExitController = new AbortController();
  const runtimeInspectionExitController = new AbortController();
  const activeBuildDiagnosticReads = new Set<Promise<unknown>>();
  const pendingBuildDiagnosticRemoval = new Map<string, BuildDiagnosticRecord>();
  let buildResultBundlesReconciled = false;
  let buildResultBundlesReconcilePromise: Promise<void> | null = null;
  type ActiveBuild = {
    sessionId: string;
    controller: AbortController;
    settled: Promise<void>;
    resolveSettled: () => void;
  };
  const activeBuilds = new Map<string, ActiveBuild>();
  const sessionOperationAdmissionEpochs = new Map<string, number>();
  const sessionRemovalAdmissionEpochs = new Map<string, number>();
  const activeSessionRemovalBarrierOperations = new Map<
    string,
    Set<IOSSimulatorSessionRemovalBarrierOperation>
  >();
  const sessionRemovalCleanupPromises = new Map<string, Promise<void>>();
  const blockedBuildInstances = new Set<string>();
  const instanceLifecycleBarriers = new Map<string, { epoch: number; pendingTeardowns: number }>();
  const mediaCapture = options.mediaCapture ?? new IOSSimulatorMediaCapture();
  const visualBaselines = new Map<
    string,
    {
      baselineId: string;
      sessionId: string;
      instanceId: string;
      generation: number;
      capturedAt: string;
      bytes: Buffer;
    }
  >();
  const diagnosticsStore = options.diagnosticsStore ?? new IOSSimulatorDiagnosticsStore();
  const resourceScheduler = options.resourceScheduler ?? new IOSSimulatorResourceScheduler();
  const idleRecycleMs = options.idleRecycleMs ?? 5 * 60_000;
  const idleRecycleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const viewports = new Map<string, IOSSimulatorPublicViewport>();
  const driverViewports = new Map<string, IOSSimulatorPublicViewport>();
  const viewerOrientationOverrides = new Map<string, 'PORTRAIT' | 'LANDSCAPE'>();
  const streamProfiles = new Map<string, IOSSimulatorStreamProfile>();
  const nativeStreamProfiles = new Map<string, IOSSimulatorNativeH264StreamProfileRequest>();
  const viewerEncodings = new Map<string, 'jpeg' | 'h264'>();
  const viewerPreferredEncodings = new Map<string, 'jpeg' | 'h264'>();
  const viewerFallbackReasons = new Map<string, IOSSimulatorPublicRouteReasonCode>();
  const routeStatusCache = new Map<string, string>();
  let pluginEnvironmentCache: {
    expiresAt: number;
    value: GhostIOSSimulatorStatusSnapshot['environment'];
  } | null = null;
  let pluginEnvironmentInFlight: Promise<GhostIOSSimulatorStatusSnapshot['environment']> | null =
    null;
  const configuredDeviceLivenessIntervalMs =
    options.deviceLivenessIntervalMs ?? DEFAULT_DEVICE_LIVENESS_INTERVAL_MS;
  const deviceLivenessIntervalMs =
    Number.isFinite(configuredDeviceLivenessIntervalMs) && configuredDeviceLivenessIntervalMs >= 0
      ? configuredDeviceLivenessIntervalMs
      : DEFAULT_DEVICE_LIVENESS_INTERVAL_MS;
  const exactDeviceProbeAvailable = options.actor === undefined || options.lifecycle !== undefined;
  const deviceLivenessChecks = new Map<
    string,
    {
      generation: number;
      checkedAt: number;
      promise: Promise<IOSSimulatorInstance> | null;
    }
  >();
  const getOwnerScopeKey = options.getOwnerScopeKey ?? activeOwnerScopeKey;
  const isOwnerBoundaryPending =
    options.isOwnerBoundaryPending ?? isAppSessionBoundaryPending;
  const pendingCreateEvidence = options.pendingCreateEvidence ?? null;
  let ownershipReconciledScopeKey: string | null = null;
  // Persisted `viewerState` can only be stale on the first sweep that actually
  // reaches a binding; after that a detached value would be this process's own
  // truth. Tracked per binding, because an incomplete sweep can skip one
  // binding entirely while normalizing the rest.
  let viewerStateNormalizedScopeKey: string | null = null;
  const viewerStateNormalizedInstanceIds = new Set<string>();
  let ownershipReconcilePromise: { scopeKey: string; promise: Promise<void> } | null = null;
  let pendingCreateReconcileController: AbortController | null = null;
  let pendingCreateReconcilePromise: Promise<unknown> | null = null;
  let startupPendingCreateRecoveryAttempted = false;
  let disposePromise: Promise<void> | null = null;
  const inspectRuntime = (): Promise<IOSSimulatorEnvironmentReport> =>
    runtime.inspect(runtimeInspectionExitController.signal);
  const canReconcilePendingCreates = options.canReconcilePendingCreates ?? (() => true);

  function abortPendingCreateReconciliation(): Promise<void> {
    pendingCreateReconcileController?.abort();
    return (
      pendingCreateReconcilePromise?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve()
    );
  }
  const pushRouteStatus =
    options.pushRouteStatus ??
    ((status: IOSSimulatorPublicRouteStatus) => {
      if (pushIOSSimulatorRouteStatusToGrantedRenderers(status) === 0) {
        logger.debug('iOS Simulator route status has no granted renderer', {
          sessionId: status.sessionId,
          instanceId: status.instanceId,
        });
      }
    });
  const hostDisposedResult = (): IOSSimulatorHostResult => ({
    ok: false,
    errorCode: 'IOS_SIMULATOR_HOST_ERROR',
    message: 'The iOS Simulator host is shutting down.',
  });
  const hostDisposedStatus = (sessionId: string | null): IOSSimulatorSessionStatus => ({
    ok: false,
    sessionId,
    errorCode: 'IOS_SIMULATOR_HOST_ERROR',
    message: 'The iOS Simulator host is shutting down.',
  });
  function assertSessionOperationAdmission(
    sessionId: string,
    expectedEpoch: number,
    operation: 'app build' | 'screenshot' | 'screen recording' | 'simulator operation',
  ): void {
    if ((sessionOperationAdmissionEpochs.get(sessionId) ?? 0) === expectedEpoch) return;
    throw new IOSSimulatorInstanceError(
      'MUTATION_CANCELLED',
      `The ${operation} was cancelled because its Cindy task lifecycle changed.`,
      true,
    );
  }
  function beginSessionRemovalBarrierOperation(
    sessionId: string,
    expectedRemovalEpoch: number,
  ): IOSSimulatorSessionRemovalBarrierOperation {
    if (
      (sessionRemovalAdmissionEpochs.get(sessionId) ?? 0) !== expectedRemovalEpoch ||
      sessionRemovalCleanupPromises.has(sessionId)
    ) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        'The simulator binding was cancelled because its Cindy task lifecycle changed.',
        true,
      );
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let finished = false;
    const operation: IOSSimulatorSessionRemovalBarrierOperation = {
      admissionEpoch: expectedRemovalEpoch,
      settled,
      finish() {
        if (finished) return;
        finished = true;
        const operations = activeSessionRemovalBarrierOperations.get(sessionId);
        operations?.delete(operation);
        if (operations?.size === 0) activeSessionRemovalBarrierOperations.delete(sessionId);
        resolveSettled();
      },
    };
    let operations = activeSessionRemovalBarrierOperations.get(sessionId);
    if (!operations) {
      operations = new Set();
      activeSessionRemovalBarrierOperations.set(sessionId, operations);
    }
    operations.add(operation);
    return operation;
  }
  function assertSessionRemovalAdmission(
    sessionId: string,
    operation: IOSSimulatorSessionRemovalBarrierOperation | null,
  ): void {
    if (
      operation &&
      (sessionRemovalAdmissionEpochs.get(sessionId) ?? 0) === operation.admissionEpoch &&
      !sessionRemovalCleanupPromises.has(sessionId)
    ) {
      return;
    }
    throw new IOSSimulatorInstanceError(
      'MUTATION_CANCELLED',
      'The simulator binding was cancelled because its Cindy task lifecycle changed.',
      true,
    );
  }
  function beginBuild(instance: IOSSimulatorInstance, expectedSessionEpoch: number): ActiveBuild {
    if (disposePromise) throw new IOSSimulatorHostDisposedError();
    assertSessionOperationAdmission(instance.sessionId, expectedSessionEpoch, 'app build');
    if (blockedBuildInstances.has(instance.instanceId)) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        'The app build was cancelled because the simulator lifecycle is changing.',
        true,
      );
    }
    if (activeBuilds.has(instance.instanceId)) {
      throw new IOSSimulatorInstanceError(
        'DEVICE_BUSY',
        'This simulator already has an app build in progress.',
        true,
      );
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const build: ActiveBuild = {
      sessionId: instance.sessionId,
      controller: new AbortController(),
      settled,
      resolveSettled,
    };
    activeBuilds.set(instance.instanceId, build);
    return build;
  }
  function finishBuild(instanceId: string, build: ActiveBuild): void {
    if (activeBuilds.get(instanceId) === build) activeBuilds.delete(instanceId);
    build.resolveSettled();
  }
  async function cancelBuild(instanceId: string): Promise<void> {
    const build = activeBuilds.get(instanceId);
    if (!build) return;
    build.controller.abort();
    await build.settled;
  }
  async function cancelSessionBuildsAndRecordings(sessionId: string): Promise<void> {
    sessionOperationAdmissionEpochs.set(
      sessionId,
      (sessionOperationAdmissionEpochs.get(sessionId) ?? 0) + 1,
    );
    const builds = [...activeBuilds.entries()].filter(([, build]) => build.sessionId === sessionId);
    for (const [, build] of builds) build.controller.abort();
    const results = await Promise.allSettled([
      ...builds.map(([, build]) => build.settled),
      mediaCapture.discardSession(sessionId),
    ]);
    // Admission is already closed above, so a recorder cleanup failure must not
    // strand the whole task archive/delete (or an Orca shutdown) halfway through.
    // The media adapter keeps its own failed process state for later lifecycle
    // reconciliation; here we only wait for every build/cleanup attempt to settle
    // and surface diagnostics without reopening task-owned mutations.
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      logger.warn('iOS Simulator task-owned operation cleanup failed', {
        sessionId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  function lifecycleBarrier(instanceId: string): { epoch: number; pendingTeardowns: number } {
    return instanceLifecycleBarriers.get(instanceId) ?? { epoch: 0, pendingTeardowns: 0 };
  }
  function beginInstanceTeardown(instanceId: string): void {
    // Abort CoreSimulator startup at teardown admission, before media or WDA
    // cleanup can spend the remaining lifecycle budget. App lifecycle calls
    // use the same mutation signal, so a slow simctl install is terminated too.
    actor.abortMutationsForInstance(instanceId);
    void actor.cancelLifecycleStartsForInstance(instanceId);
    const current = lifecycleBarrier(instanceId);
    instanceLifecycleBarriers.set(instanceId, {
      epoch: current.epoch + 1,
      pendingTeardowns: current.pendingTeardowns + 1,
    });
    blockedBuildInstances.add(instanceId);
    releaseViewerTouches(instanceId);
  }
  function finishInstanceTeardown(instanceId: string): void {
    const current = lifecycleBarrier(instanceId);
    instanceLifecycleBarriers.set(instanceId, {
      epoch: current.epoch,
      pendingTeardowns: Math.max(0, current.pendingTeardowns - 1),
    });
  }
  function captureInstanceActivation(instanceId: string): number {
    const current = lifecycleBarrier(instanceId);
    if (current.pendingTeardowns > 0) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        'The simulator cannot be activated while its lifecycle is changing.',
        true,
      );
    }
    return current.epoch;
  }
  function captureInstanceOperationAdmission(instanceId: string, operation: string): number {
    const current = lifecycleBarrier(instanceId);
    if (current.pendingTeardowns > 0) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        `The simulator ${operation} was cancelled because its lifecycle is changing.`,
        true,
      );
    }
    return current.epoch;
  }
  function assertInstanceOperationAdmission(
    instanceId: string,
    expectedEpoch: number,
    operation: string,
  ): void {
    const current = lifecycleBarrier(instanceId);
    if (current.epoch !== expectedEpoch || current.pendingTeardowns > 0) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        `The simulator ${operation} was cancelled because its lifecycle changed.`,
        true,
      );
    }
  }
  function completeInstanceActivation(instance: IOSSimulatorInstance, expectedEpoch: number): void {
    assertInstanceActivation(instance.instanceId, expectedEpoch);
    actor.assertRoute({
      sessionId: instance.sessionId,
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    });
    blockedBuildInstances.delete(instance.instanceId);
  }
  function assertInstanceActivation(instanceId: string, expectedEpoch: number): void {
    const current = lifecycleBarrier(instanceId);
    if (current.epoch !== expectedEpoch || current.pendingTeardowns > 0) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        'The simulator activation was cancelled because its lifecycle changed.',
        true,
      );
    }
  }
  function managedBuildResultsRoot(): string {
    return path.join(app.getPath('userData'), 'ios-simulator', 'projects');
  }
  function isManagedBuildResultBundle(resultBundlePath: string): boolean {
    const managedRoot = managedBuildResultsRoot();
    const relative = path.relative(managedRoot, resultBundlePath);
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      MANAGED_BUILD_RESULT_BUNDLE_PATTERN.test(path.basename(resultBundlePath))
    );
  }
  async function discardManagedBuildResultBundle(
    resultBundlePath: string | null,
    diagnosticsId?: string,
  ): Promise<void> {
    if (!resultBundlePath || !isManagedBuildResultBundle(resultBundlePath)) return;
    await rm(resultBundlePath, { recursive: true, force: true }).catch((error) => {
      logger.warn('iOS Simulator could not remove a managed build result bundle', {
        ...(diagnosticsId ? { diagnosticsId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  async function removeBuildDiagnostic(
    diagnosticsId: string,
    diagnostic: BuildDiagnosticRecord,
  ): Promise<void> {
    if (buildDiagnostics.get(diagnosticsId) === diagnostic) {
      buildDiagnostics.delete(diagnosticsId);
    }
    const expiryTimer = buildDiagnosticExpiryTimers.get(diagnosticsId);
    if (expiryTimer) clearTimeout(expiryTimer);
    buildDiagnosticExpiryTimers.delete(diagnosticsId);
    if ((buildDiagnosticReaders.get(diagnosticsId) ?? 0) > 0) {
      pendingBuildDiagnosticRemoval.set(diagnosticsId, diagnostic);
      return;
    }
    pendingBuildDiagnosticRemoval.delete(diagnosticsId);
    await discardManagedBuildResultBundle(diagnostic.resultBundlePath, diagnosticsId);
  }
  async function releaseBuildDiagnosticReader(diagnosticsId: string): Promise<void> {
    const remaining = (buildDiagnosticReaders.get(diagnosticsId) ?? 1) - 1;
    if (remaining > 0) {
      buildDiagnosticReaders.set(diagnosticsId, remaining);
      return;
    }
    buildDiagnosticReaders.delete(diagnosticsId);
    const pending = pendingBuildDiagnosticRemoval.get(diagnosticsId);
    if (!pending) return;
    pendingBuildDiagnosticRemoval.delete(diagnosticsId);
    await discardManagedBuildResultBundle(pending.resultBundlePath, diagnosticsId);
  }
  function scheduleBuildDiagnosticExpiry(
    diagnosticsId: string,
    diagnostic: BuildDiagnosticRecord,
  ): void {
    const timer = setTimeout(() => {
      void removeBuildDiagnostic(diagnosticsId, diagnostic);
    }, BUILD_DIAGNOSTICS_TTL_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    buildDiagnosticExpiryTimers.set(diagnosticsId, timer);
  }
  async function reconcileOrphanedBuildResultBundles(): Promise<void> {
    if (buildResultBundlesReconciled || disposePromise) return;
    if (buildResultBundlesReconcilePromise) return buildResultBundlesReconcilePromise;
    buildResultBundlesReconcilePromise = (async () => {
      let complete = true;
      const root = managedBuildResultsRoot();
      const candidates: string[] = [];
      let projectEntries: Dirent[];
      try {
        projectEntries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          buildResultBundlesReconciled = true;
          return;
        }
        logger.warn('iOS Simulator could not inspect managed build result bundles', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue;
        const projectPath = path.join(root, projectEntry.name);
        if (MANAGED_BUILD_RESULT_BUNDLE_PATTERN.test(projectEntry.name)) {
          candidates.push(projectPath);
          continue;
        }
        try {
          const entries = await readdir(projectPath, { withFileTypes: true });
          candidates.push(
            ...entries
              .filter(
                (entry) =>
                  entry.isDirectory() && MANAGED_BUILD_RESULT_BUNDLE_PATTERN.test(entry.name),
              )
              .map((entry) => path.join(projectPath, entry.name)),
          );
        } catch (error) {
          complete = false;
          logger.warn('iOS Simulator could not inspect a project build result directory', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const activePaths = new Set(
        [...buildDiagnostics.values()].flatMap((diagnostic) =>
          diagnostic.resultBundlePath ? [diagnostic.resultBundlePath] : [],
        ),
      );
      const now = Date.now();
      await Promise.all(
        candidates.map(async (candidate) => {
          if (activePaths.has(candidate)) return;
          try {
            const metadata = await stat(candidate);
            if (now - metadata.mtimeMs <= BUILD_DIAGNOSTICS_TTL_MS) return;
            await discardManagedBuildResultBundle(candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              complete = false;
              logger.warn('iOS Simulator could not reconcile a build result bundle', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }),
      );
      buildResultBundlesReconciled = complete;
    })().finally(() => {
      buildResultBundlesReconcilePromise = null;
    });
    return buildResultBundlesReconcilePromise;
  }
  async function storeBuildDiagnostics(input: {
    sessionId: string;
    instanceId: string;
    logTail: string;
    resultBundlePath: string | null;
    outputTruncated?: boolean;
  }): Promise<{
    diagnosticsId: string;
    buildLogTail: string;
    xcresultAvailable: boolean;
    outputTruncated: boolean;
  }> {
    if (disposePromise) {
      await discardManagedBuildResultBundle(input.resultBundlePath);
      throw new IOSSimulatorHostDisposedError();
    }
    const now = Date.now();
    await Promise.all(
      [...buildDiagnostics.entries()]
        .filter(([, diagnostic]) => now - diagnostic.createdAt > BUILD_DIAGNOSTICS_TTL_MS)
        .map(([diagnosticsId, diagnostic]) => removeBuildDiagnostic(diagnosticsId, diagnostic)),
    );
    if (disposePromise) {
      await discardManagedBuildResultBundle(input.resultBundlePath);
      throw new IOSSimulatorHostDisposedError();
    }
    const diagnosticsId = randomUUID();
    const logTail = publicBuildText(input.logTail);
    const diagnostic = {
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      logTail,
      resultBundlePath: input.resultBundlePath,
      xcresultText: null,
      outputTruncated: Boolean(input.outputTruncated),
      createdAt: now,
    };
    buildDiagnostics.set(diagnosticsId, diagnostic);
    scheduleBuildDiagnosticExpiry(diagnosticsId, diagnostic);
    if (buildDiagnostics.size > MAX_BUILD_DIAGNOSTICS) {
      const oldest = [...buildDiagnostics.entries()].sort(
        ([, left], [, right]) => left.createdAt - right.createdAt,
      )[0];
      if (oldest) await removeBuildDiagnostic(oldest[0], oldest[1]);
    }
    if (disposePromise) {
      await removeBuildDiagnostic(diagnosticsId, diagnostic);
      throw new IOSSimulatorHostDisposedError();
    }
    return {
      diagnosticsId,
      buildLogTail: logTail,
      xcresultAvailable: Boolean(input.resultBundlePath),
      outputTruncated: diagnostic.outputTruncated,
    };
  }
  function buildFailureWithDiagnostics(
    error: unknown,
    sessionId: string,
    diagnostics: Awaited<ReturnType<typeof storeBuildDiagnostics>>,
  ): IOSSimulatorHostResult {
    const failure = safeHostError(error, sessionId, 'build_app');
    if (failure.ok) return failure;
    return {
      ...failure,
      data: {
        ...(failure.data ?? {}),
        diagnostics,
      },
    };
  }
  function clearVisualBaselines(instanceId?: string): void {
    for (const [baselineId, baseline] of visualBaselines) {
      if (!instanceId || baseline.instanceId === instanceId) visualBaselines.delete(baselineId);
    }
  }
  function clearViewportState(instanceId: string): void {
    viewports.delete(instanceId);
    driverViewports.delete(instanceId);
    viewerOrientationOverrides.delete(instanceId);
  }
  function clearViewerOrientationOverride(instanceId: string): void {
    viewerOrientationOverrides.delete(instanceId);
    const driverViewport = driverViewports.get(instanceId);
    if (driverViewport) viewports.set(instanceId, driverViewport);
  }
  function currentExpiredViewerRoute(
    route: IOSSimulatorMutationRoute,
    error: unknown,
  ): IOSSimulatorInstance | null {
    if (!(error instanceof IOSSimulatorInstanceError) || error.code !== 'LEASE_EXPIRED') {
      return null;
    }
    try {
      const current = actor.getOwned(route.sessionId, route.instanceId);
      return current.generation === route.generation && current.lease.id === route.leaseId
        ? current
        : null;
    } catch {
      return null;
    }
  }
  function assertViewerDeactivationRoute(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    try {
      return actor.assertRoute(route);
    } catch (error) {
      // Hiding a viewer is a de-escalating cleanup. A renderer suspended past
      // the deadline may stop its exact stream, but an obsolete lease must not
      // stop a replacement viewer for the same simulator generation.
      const current = currentExpiredViewerRoute(route, error);
      if (current) return current;
      throw error;
    }
  }
  const assertHostActive = (): void => {
    if (disposePromise) throw new IOSSimulatorHostDisposedError();
  };
  let driverManager = options.driverManager;
  const getDriverManager = () => {
    driverManager ??= createDefaultDriverManager();
    return driverManager;
  };
  const getHealthyDriver = async (instanceId: string): Promise<WdaRunningInstance | null> => {
    const manager = getDriverManager();
    return manager.probe ? manager.probe(instanceId) : manager.get(instanceId);
  };

  function publicRouteState(
    state: IOSSimulatorFramePumpSnapshot['state'] | null,
  ): IOSSimulatorPublicRouteState {
    switch (state) {
      case 'connecting':
        return 'detecting';
      case 'streaming':
        return 'active';
      case 'reconnecting':
        return 'reconnecting';
      case 'disconnected':
        return 'unavailable';
      case 'paused':
      case 'idle':
      default:
        return 'idle';
    }
  }

  function routeStatusForInstance(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance | null = getDriverManager().get(instance.instanceId),
  ): IOSSimulatorPublicRouteStatus {
    const now = new Date().toISOString();
    const notReady = instance.lifecycleState !== 'ready';
    const selectedEncoding = viewerEncodings.get(instance.instanceId) ?? null;
    const preferredEncoding = viewerPreferredEncodings.get(instance.instanceId) ?? null;
    const streamSnapshot =
      selectedEncoding === 'h264'
        ? h264FramePump.snapshot(instance.instanceId)
        : selectedEncoding === 'jpeg'
          ? framePump.snapshot(instance.instanceId)
          : null;
    const capabilityReport = running?.driverRouter?.capabilityReport;
    const report =
      typeof capabilityReport === 'function' ? capabilityReport.call(running?.driverRouter) : null;
    const nativeStreamRoute = report?.routes?.stream?.h264;
    const nativeInputRoute = report?.routes?.continuousInput;
    const nativeAdmission = report?.nativeSidecar.admission;

    let stream: IOSSimulatorPublicRouteStatus['stream'];
    if (notReady) {
      stream = {
        adapter: null,
        encoding: null,
        state: 'unavailable',
        reasonCode: instance.lifecycleState === 'stopped' ? 'route-stopped' : 'instance-not-ready',
      };
    } else if (!selectedEncoding) {
      stream = {
        adapter: null,
        encoding: null,
        state: 'idle',
        reasonCode: 'viewer-hidden',
      };
    } else if (selectedEncoding === 'h264') {
      const routeIsNative =
        nativeStreamRoute?.selected === 'native-sidecar' && !nativeStreamRoute.fallback;
      const pumpState = publicRouteState(streamSnapshot?.state ?? null);
      stream = {
        adapter: routeIsNative ? 'native-sidecar' : 'wda',
        encoding: routeIsNative ? 'h264' : 'jpeg',
        state: routeIsNative ? pumpState : 'fallback',
        reasonCode: routeIsNative
          ? streamSnapshot?.state === 'disconnected'
            ? 'native-stream-disconnected'
            : streamSnapshot?.state === 'connecting'
              ? 'native-probe-pending'
              : 'native-active'
          : !report || report.nativeSidecar.available === false
            ? 'native-sidecar-unavailable'
            : 'native-capability-unavailable',
      };
    } else {
      const pumpState = publicRouteState(streamSnapshot?.state ?? null);
      const fallback = preferredEncoding === 'h264';
      stream = {
        adapter: 'wda',
        encoding: 'jpeg',
        // The route label already communicates compatibility mode. Preserve
        // the JPEG pump's live health so reconnecting/disconnected is visible.
        state: fallback && pumpState === 'idle' ? 'fallback' : pumpState,
        reasonCode: fallback
          ? (viewerFallbackReasons.get(instance.instanceId) ?? 'wda-fallback')
          : streamSnapshot?.state === 'disconnected'
            ? 'route-error'
            : 'wda-active',
      };
    }

    let input: IOSSimulatorPublicRouteStatus['input'];
    if (notReady) {
      input = {
        adapter: null,
        state: 'unavailable',
        continuous: false,
        multiTouch: false,
        reasonCode: 'instance-not-ready',
      };
    } else if (!running) {
      input = {
        adapter: null,
        state: 'detecting',
        continuous: false,
        multiTouch: false,
        reasonCode: 'native-probe-pending',
      };
    } else if (!report) {
      input = {
        adapter: 'wda',
        state: 'fallback',
        continuous: false,
        multiTouch: false,
        reasonCode: 'native-sidecar-unavailable',
      };
    } else {
      const nativeInputActive =
        nativeInputRoute?.selected === 'native-sidecar' && !nativeInputRoute.fallback;
      const probing = nativeAdmission?.capabilities.continuousInput.reasonCode === 'AWAITING_PROBE';
      const nativeMultiTouch = Boolean(nativeAdmission?.capabilities.multiTouch.active);
      input = {
        adapter: nativeInputActive ? 'native-sidecar' : 'wda',
        state: probing ? 'detecting' : nativeInputActive ? 'active' : 'fallback',
        continuous: nativeInputActive,
        multiTouch: nativeInputActive && nativeMultiTouch,
        reasonCode: probing
          ? 'native-probe-pending'
          : nativeInputActive
            ? 'native-active'
            : report.nativeSidecar.available
              ? 'native-capability-unavailable'
              : 'native-sidecar-unavailable',
      };
    }
    return {
      sessionId: instance.sessionId,
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: now,
      stream,
      input,
    };
  }

  function publishRouteStatus(status: IOSSimulatorPublicRouteStatus): void {
    // Do not make the timestamp defeat coalescing; frame delivery may call
    // this helper frequently while the public route itself remains unchanged.
    const fingerprint = JSON.stringify({ ...status, updatedAt: '' });
    if (routeStatusCache.get(status.instanceId) === fingerprint) return;
    routeStatusCache.set(status.instanceId, fingerprint);
    pushRouteStatus(status);
  }

  function publishRouteStatusForInstance(
    instance: IOSSimulatorInstance,
    running?: WdaRunningInstance | null,
  ): IOSSimulatorPublicRouteStatus {
    const status = routeStatusForInstance(instance, running);
    publishRouteStatus(status);
    return status;
  }

  const getSession =
    options.getSession ??
    (async (sessionId: string) => {
      const session = await desktopSessionStorage.get(sessionId);
      if (!session) return null;
      return {
        ...session,
        status: await desktopSessionStorage.getStatus(sessionId),
      };
    });
  const withSessionLock = options.withSessionLock ?? withSessionRouteLock;
  const resolveWorktreeRoot = options.resolveWorktreeRoot ?? realpath;
  const requestViewerFocus =
    options.requestViewerFocus ??
    ((sessionId: string, instanceId: string) => {
      if (!focusIOSSimulatorRendererSession(sessionId, instanceId)) {
        logger.debug('iOS Simulator focus request has no Main-owned renderer target', {
          sessionId,
          instanceId,
        });
      }
    });

  async function resolveSession(
    sessionId: string,
    options: { registerRemovalBarrier?: boolean } = {},
  ): Promise<SessionResolution> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return sessionError(null, 'SESSION_CONTEXT_REQUIRED', 'A Cindy session is required.');
    }
    const removalAdmissionEpoch = sessionRemovalAdmissionEpochs.get(normalizedSessionId) ?? 0;
    const session = await getSession(normalizedSessionId);
    if (!session) {
      return sessionError(
        normalizedSessionId,
        'SESSION_NOT_FOUND',
        'The Cindy session no longer exists.',
      );
    }
    if (session.status && session.status !== 'active') {
      return sessionError(
        normalizedSessionId,
        'SESSION_NOT_FOUND',
        'The Cindy session is no longer active.',
      );
    }
    if (session.remoteHostId) {
      return sessionError(
        normalizedSessionId,
        'UNSUPPORTED_SESSION_KIND',
        'SSH and remote sessions cannot access simulators on this Mac.',
      );
    }
    const removalBarrierOperation = options.registerRemovalBarrier
      ? beginSessionRemovalBarrierOperation(normalizedSessionId, removalAdmissionEpoch)
      : undefined;
    return { ok: true, sessionId: normalizedSessionId, session, removalBarrierOperation };
  }

  function currentOwnedInstance(instance: IOSSimulatorInstance): IOSSimulatorInstance {
    return actor.getOwned(instance.sessionId, instance.instanceId);
  }

  function currentReadyGeneration(instance: IOSSimulatorInstance): IOSSimulatorInstance | null {
    let current: IOSSimulatorInstance;
    try {
      current = currentOwnedInstance(instance);
    } catch {
      return null;
    }
    return current.generation === instance.generation &&
      current.simulatorUdid.toUpperCase() === instance.simulatorUdid.toUpperCase() &&
      current.lifecycleState === 'ready'
      ? current
      : null;
  }

  function viewerRouteRefreshResult(instance: IOSSimulatorInstance): IOSSimulatorHostResult {
    publishRouteStatusForInstance(instance);
    return {
      ok: true,
      data: {
        instance: publicInstance(instance),
        stream: null,
        viewport: null,
        mutation: actor.mutationState(instance.instanceId),
      },
    };
  }

  function isInstanceError(error: unknown, code: IOSSimulatorMcpErrorCode): boolean {
    return error instanceof IOSSimulatorInstanceError && error.code === code;
  }

  async function releaseExternallyStoppedRuntime(instance: IOSSimulatorInstance): Promise<void> {
    beginInstanceTeardown(instance.instanceId);
    try {
      await cancelBuild(instance.instanceId);
      cancelIdleRecycle(instance.instanceId);
      framePump.clear(instance.instanceId);
      h264FramePump.clear(instance.instanceId);
      viewerEncodings.delete(instance.instanceId);
      viewerPreferredEncodings.delete(instance.instanceId);
      viewerFallbackReasons.delete(instance.instanceId);
      viewerSessions.delete(instance.instanceId);
      viewerVisibilityIntents.delete(instance.instanceId);
      streamProfiles.delete(instance.instanceId);
      nativeStreamProfiles.delete(instance.instanceId);
      clearViewportState(instance.instanceId);
      screenMaps.clear(instance.instanceId);
      clearVisualBaselines(instance.instanceId);
      await mediaCapture.discardInstance(instance.instanceId).catch((error) => {
        logger.warn('iOS Simulator external stop could not discard recording', {
          instanceId: instance.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (driverManager) {
        await driverManager.stop(instance.instanceId).catch((error) => {
          logger.warn('iOS Simulator external stop could not stop driver runtime', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      resourceScheduler.markStopped(instance.instanceId);
    } finally {
      finishInstanceTeardown(instance.instanceId);
    }
  }

  function clearInstanceRuntimeProjection(instanceId: string): void {
    cancelIdleRecycle(instanceId);
    releaseViewerTouches(instanceId);
    screenMaps.clear(instanceId);
    framePump.clear(instanceId);
    h264FramePump.clear(instanceId);
    viewerEncodings.delete(instanceId);
    viewerPreferredEncodings.delete(instanceId);
    viewerFallbackReasons.delete(instanceId);
    viewerSessions.delete(instanceId);
    viewerVisibilityIntents.delete(instanceId);
    streamProfiles.delete(instanceId);
    nativeStreamProfiles.delete(instanceId);
    clearViewportState(instanceId);
    clearVisualBaselines(instanceId);
    deviceLivenessChecks.delete(instanceId);
    routeStatusCache.delete(instanceId);
  }

  function clearRemovedInstanceProjection(instanceId: string): void {
    agentControlLeases.delete(instanceId);
    for (const [artifactId, stored] of appArtifacts) {
      if (stored.instanceId === instanceId) appArtifacts.delete(artifactId);
    }
  }

  async function cleanupOrphanedDriverRuntime(instance: IOSSimulatorInstance): Promise<boolean> {
    if (!driverManager?.cleanupOrphaned) return true;
    try {
      await driverManager.cleanupOrphaned(instance.instanceId, instance.simulatorUdid);
      return true;
    } catch (error) {
      logger.warn('iOS Simulator ownership cleanup could not recover orphaned driver runtime', {
        instanceId: instance.instanceId,
        simulatorUdid: instance.simulatorUdid,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function releaseInstanceRuntime(instance: IOSSimulatorInstance): Promise<boolean> {
    beginInstanceTeardown(instance.instanceId);
    try {
      await cancelBuild(instance.instanceId);
      clearInstanceRuntimeProjection(instance.instanceId);
      let cleanupSucceeded = true;
      await mediaCapture.discardInstance(instance.instanceId).catch((error) => {
        cleanupSucceeded = false;
        logger.warn('iOS Simulator ownership cleanup could not discard recording', {
          instanceId: instance.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (driverManager) {
        await driverManager.stop(instance.instanceId).catch((error) => {
          cleanupSucceeded = false;
          logger.warn('iOS Simulator ownership cleanup could not stop driver runtime', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        if (!(await cleanupOrphanedDriverRuntime(instance))) cleanupSucceeded = false;
      }
      return cleanupSucceeded;
    } finally {
      finishInstanceTeardown(instance.instanceId);
    }
  }

  async function releaseStaleBinding(
    instance: IOSSimulatorInstance,
    device: IOSSimulatorEnvironmentReport['devices'][number] | null | undefined,
    deviceStateKnown = true,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const hostOwnsBoot =
      instance.bootProvenance === 'agent-booted' || instance.creationProvenance === 'cindy';
    const deviceState = device?.state.trim().toLowerCase() ?? null;
    let deviceStopped = deviceStateKnown && (!device || deviceState === 'shutdown');
    let cleanupSucceeded = await releaseInstanceRuntime(instance);
    clearRemovedInstanceProjection(instance.instanceId);
    let schedulerReleaseAllowed = cleanupSucceeded && (!hostOwnsBoot || deviceStopped);
    if (cleanupSucceeded && hostOwnsBoot && !deviceStopped) {
      if (!deviceStateKnown) {
        cleanupSucceeded = false;
        logger.warn('iOS Simulator stale binding cleanup could not verify exact device state', {
          instanceId: instance.instanceId,
        });
      } else {
        try {
          await lifecycle.shutdownExact(instance.simulatorUdid, signal);
          deviceStopped = true;
          schedulerReleaseAllowed = true;
        } catch (error) {
          cleanupSucceeded = false;
          logger.warn('iOS Simulator stale binding cleanup could not shut down device', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // A known-missing Cindy-created device is already deleted. Reissuing
    // `simctl delete` would turn successful external cleanup into a permanent
    // retry loop, so only delete when the exact device still exists.
    if (instance.creationProvenance === 'cindy' && cleanupSucceeded && device) {
      await lifecycle.deleteExact(instance.simulatorUdid, signal).catch((error) => {
        cleanupSucceeded = false;
        logger.warn('iOS Simulator stale binding cleanup could not delete device', {
          instanceId: instance.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (schedulerReleaseAllowed) resourceScheduler.markStopped(instance.instanceId);
    if (cleanupSucceeded) {
      actor.forget(instance.instanceId, instance.sessionId);
    } else {
      ownershipReconciledScopeKey = null;
      actor.reconcile(
        instance.instanceId,
        instance.sessionId,
        deviceStopped ? 'stopped' : 'error',
        'degraded',
        'ARCHIVED_CLEANUP_FAILED',
      );
    }
    return cleanupSucceeded;
  }

  async function performRemovedSessionCleanup(sessionId: string): Promise<void> {
    // Startup calls hold the same session-removal barrier awaited below. Abort
    // them first so task archive/delete never waits out the 120-second boot
    // budget before ownership cleanup can begin.
    const lifecycleStarts = actor.cancelLifecycleStartsForSession(sessionId);
    await Promise.all([
      lifecycleStarts,
      actor.cancelMutationsForSession(sessionId),
      cancelSessionBuildsAndRecordings(sessionId),
    ]);
    await Promise.all(
      [...(activeSessionRemovalBarrierOperations.get(sessionId) ?? [])].map(
        (operation) => operation.settled,
      ),
    );
    const failures = new Set<string>();
    for (const snapshot of actor.list(sessionId)) {
      try {
        const released = await actor.runOwnershipCleanup(
          snapshot.instanceId,
          sessionId,
          async (instance, signal) => {
            const hostOwnsBoot =
              instance.bootProvenance === 'agent-booted' || instance.creationProvenance === 'cindy';
            let device: IOSSimulatorEnvironmentReport['devices'][number] | null | undefined;
            let deviceStateKnown = !hostOwnsBoot;
            if (hostOwnsBoot) {
              try {
                device = await lifecycle.findExact(instance.simulatorUdid, signal);
                deviceStateKnown = device !== undefined;
              } catch (error) {
                logger.warn('iOS Simulator removed task cleanup could not inspect exact device', {
                  sessionId,
                  instanceId: instance.instanceId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return releaseStaleBinding(instance, device, deviceStateKnown, signal);
          },
        );
        if (!released) failures.add(snapshot.instanceId);
        else {
          blockedBuildInstances.delete(snapshot.instanceId);
          instanceLifecycleBarriers.delete(snapshot.instanceId);
        }
      } catch (error) {
        if (
          isInstanceError(error, 'INSTANCE_NOT_OWNED') &&
          !actor.list(sessionId).some((instance) => instance.instanceId === snapshot.instanceId)
        ) {
          continue;
        }
        failures.add(snapshot.instanceId);
        logger.warn('iOS Simulator removed task cleanup failed', {
          sessionId,
          instanceId: snapshot.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.size > 0) {
      throw new IOSSimulatorInstanceError(
        'DEVICE_BUSY',
        `Simulator cleanup is still pending for ${failures.size} instance(s).`,
        true,
      );
    }
  }

  function cleanupRemovedSessionRuntime(sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    const existing = sessionRemovalCleanupPromises.get(normalizedSessionId);
    if (existing) return existing;
    sessionRemovalAdmissionEpochs.set(
      normalizedSessionId,
      (sessionRemovalAdmissionEpochs.get(normalizedSessionId) ?? 0) + 1,
    );
    let trackedCleanup: Promise<void>;
    const cleanup = Promise.resolve().then(() => performRemovedSessionCleanup(normalizedSessionId));
    trackedCleanup = cleanup.finally(() => {
      if (sessionRemovalCleanupPromises.get(normalizedSessionId) === trackedCleanup) {
        sessionRemovalCleanupPromises.delete(normalizedSessionId);
      }
    });
    sessionRemovalCleanupPromises.set(normalizedSessionId, trackedCleanup);
    return trackedCleanup;
  }

  async function reconcileLiveDevice(
    instance: IOSSimulatorInstance,
  ): Promise<IOSSimulatorInstance> {
    if (!exactDeviceProbeAvailable || disposePromise) return currentOwnedInstance(instance);
    const existing = deviceLivenessChecks.get(instance.instanceId);
    const now = Date.now();
    if (existing?.generation === instance.generation) {
      if (existing.promise) return existing.promise;
      if (deviceLivenessIntervalMs > 0 && now - existing.checkedAt < deviceLivenessIntervalMs) {
        return currentOwnedInstance(instance);
      }
    }

    const record = {
      generation: instance.generation,
      checkedAt: now,
      promise: null as Promise<IOSSimulatorInstance> | null,
    };
    const promise = (async () => {
      let device: Awaited<ReturnType<IOSSimulatorSimctlLifecycle['findExact']>> | undefined;
      try {
        device = await lifecycle.findExact(instance.simulatorUdid);
      } catch (error) {
        logger.debug('iOS Simulator exact-device liveness probe failed', {
          instanceId: instance.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return currentOwnedInstance(instance);
      }
      // Some injected test/extension lifecycles predate the exact probe seam.
      // Treat an undefined result as indeterminate; the production lifecycle
      // always returns either the exact device or null.
      if (device === undefined) {
        return currentOwnedInstance(instance);
      }
      const normalizedDeviceState = device?.state.trim().toLowerCase();
      const observedState =
        device === null || device.isAvailable === false
          ? 'missing'
          : normalizedDeviceState === 'shutdown'
            ? 'shutdown'
            : null;
      if (!observedState) return currentOwnedInstance(instance);
      const result = await actor.reconcileExternalDeviceState(
        {
          sessionId: instance.sessionId,
          instanceId: instance.instanceId,
          simulatorUdid: instance.simulatorUdid,
          expectedGeneration: instance.generation,
          state: observedState,
        },
        async (previous) => releaseExternallyStoppedRuntime(previous),
      );
      if (result.applied) {
        logger.info('iOS Simulator external device state reconciled', {
          instanceId: instance.instanceId,
          simulatorUdid: instance.simulatorUdid,
          state: observedState,
          generation: result.instance.generation,
        });
      }
      return result.instance;
    })();
    record.promise = promise;
    deviceLivenessChecks.set(instance.instanceId, record);
    try {
      return await promise;
    } finally {
      if (deviceLivenessChecks.get(instance.instanceId) === record) {
        record.promise = null;
        record.checkedAt = Date.now();
      }
    }
  }

  async function reconcileLiveDevices(instances: IOSSimulatorInstance[]): Promise<void> {
    await Promise.all(
      instances.map(async (instance) => {
        try {
          await reconcileLiveDevice(instance);
        } catch (error) {
          // A concurrent detach/delete makes this probe obsolete. The caller
          // reads the actor again after all probes settle, so the released
          // binding should disappear rather than fail the whole status call.
          if (isInstanceError(error, 'INSTANCE_NOT_FOUND')) return;
          throw error;
        }
      }),
    );
  }

  async function readPluginEnvironment(): Promise<GhostIOSSimulatorStatusSnapshot['environment']> {
    const now = Date.now();
    if (pluginEnvironmentCache && pluginEnvironmentCache.expiresAt > now) {
      return pluginEnvironmentCache.value;
    }
    if (pluginEnvironmentInFlight) return pluginEnvironmentInFlight;
    pluginEnvironmentInFlight = inspectRuntime().then((environment) => {
      const value = projectPluginEnvironment(environment);
      if (!disposePromise) {
        pluginEnvironmentCache = { value, expiresAt: Date.now() + PLUGIN_ENVIRONMENT_CACHE_MS };
      }
      return value;
    });
    try {
      return await pluginEnvironmentInFlight;
    } finally {
      pluginEnvironmentInFlight = null;
    }
  }

  async function inspectForPlugin(sessionId: string): Promise<GhostIOSSimulatorStatusProbeResult> {
    if (disposePromise) {
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator host is shutting down.',
      };
    }
    if (isOwnerBoundaryPending()) {
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      };
    }
    const ownerScopeKey = getOwnerScopeKey();
    const resolved = await resolveSession(sessionId);
    if (isOwnerBoundaryPending() || getOwnerScopeKey() !== ownerScopeKey) {
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      };
    }
    if (!resolved.ok)
      return { ok: false, errorCode: resolved.errorCode, message: resolved.message };
    try {
      const environment = await readPluginEnvironment();
      if (disposePromise) {
        return {
          ok: false,
          errorCode: 'IOS_SIMULATOR_HOST_ERROR',
          message: 'The iOS Simulator host is shutting down.',
        };
      }
      if (isOwnerBoundaryPending() || getOwnerScopeKey() !== ownerScopeKey) {
        return {
          ok: false,
          errorCode: 'IOS_SIMULATOR_HOST_ERROR',
          message: 'The iOS Simulator status is temporarily unavailable.',
        };
      }
      const instances = actor.list(resolved.sessionId);
      return {
        ok: true,
        status: {
          environment,
          instances: instances.map((instance) => ({
            instanceId: instance.instanceId,
            simulatorName: instance.simulatorName,
            generation: instance.generation,
            lifecycleState: instance.lifecycleState,
            healthState: instance.healthState,
          })),
          routeStatuses: instances.map((instance) => {
            const route = routeStatusForInstance(
              instance,
              driverManager?.get(instance.instanceId) ?? null,
            );
            return {
              instanceId: route.instanceId,
              generation: route.generation,
              stream: {
                adapter: route.stream.adapter,
                encoding: route.stream.encoding,
                state: route.stream.state,
              },
              input: {
                adapter: route.input.adapter,
                state: route.input.state,
              },
            };
          }),
        },
      };
    } catch (error) {
      logger.warn('iOS Simulator plugin status snapshot failed', {
        sessionId: resolved.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      };
    }
  }

  async function inspectForSession(sessionId: string): Promise<IOSSimulatorSessionStatus> {
    if (disposePromise) return hostDisposedStatus(sessionId);
    const resolved = await resolveSession(sessionId);
    if (!resolved.ok) return resolved;
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    await reconcilePersistedOwnership();
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    await reconcileLiveDevices(actor.list(resolved.sessionId));
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    const environment = await inspectRuntime();
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    const instances = actor
      .list(resolved.sessionId)
      .map((instance) => actor.heartbeatOwned(resolved.sessionId, instance.instanceId));
    return {
      ok: true,
      sessionId: resolved.sessionId,
      environment: publicEnvironment(environment, {
        sessionId: resolved.sessionId,
        instances: actor.listAll(),
      }),
      instances: instances.map(publicInstance),
      deviceGrants: instances.map((instance) => grantStore.get(instance.simulatorUdid)),
      mutationStates: instances.map((instance) => actor.mutationState(instance.instanceId)),
      resource: {
        ...resourceScheduler.snapshot(),
        maxInstancesPerTask: MAX_INSTANCES_PER_SESSION,
      },
      routeStatuses: instances.map((instance) => publishRouteStatusForInstance(instance)),
    };
  }

  async function reconcilePersistedInstance(
    snapshot: IOSSimulatorInstance,
    devices: ReadonlyMap<string, IOSSimulatorEnvironmentReport['devices'][number]>,
    normalizeViewerState: boolean,
  ): Promise<IOSSimulatorPersistedInstanceReconcileResult> {
    const instance = actor
      .list(snapshot.sessionId)
      .find((candidate) => candidate.instanceId === snapshot.instanceId);
    // A binding that no longer exists has no inherited viewer state to correct.
    if (!instance) return { complete: true, viewerStateHandled: true };

    let complete = true;
    let driverRuntimeRecovered = await cleanupOrphanedDriverRuntime(instance);
    if (!driverRuntimeRecovered) complete = false;
    const device = devices.get(instance.simulatorUdid.toUpperCase());
    const deviceState = device?.state.trim().toLowerCase() ?? null;
    const shouldResumeDetachGrace =
      instance.bootProvenance === 'agent-booted' &&
      instance.viewerState === 'detached' &&
      instance.graceExpiresAt !== null;
    if (device && deviceState !== 'shutdown') {
      // This scheduler is process-local while ownership is persisted. Restore
      // observed occupancy before any fallible lookup/cleanup.
      resourceScheduler.restoreRunning(instance.instanceId);
    }
    let session: IOSSimulatorSessionSnapshot | null = null;
    try {
      session = await getSession(instance.sessionId);
    } catch (error) {
      logger.warn('iOS Simulator ownership reconcile could not read session', {
        instanceId: instance.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      // This binding was skipped before any reconcile, so its inherited viewer
      // state is still unhandled and the retry must normalize it.
      return { complete: false, viewerStateHandled: false };
    }
    if (!session || session.status === 'deleted' || session.status === 'archived') {
      const released = await actor.runOwnershipCleanup(
        instance.instanceId,
        instance.sessionId,
        (owned, signal) => releaseStaleBinding(owned, device, true, signal),
      );
      return { complete: released && complete, viewerStateHandled: released };
    }
    if (session.remoteHostId || !device) {
      const runtimeReleased = await releaseInstanceRuntime(instance);
      if (!runtimeReleased) complete = false;
      if (runtimeReleased && (!device || device.state.trim().toLowerCase() === 'shutdown')) {
        resourceScheduler.markStopped(instance.instanceId);
      }
      actor.reconcile(
        instance.instanceId,
        instance.sessionId,
        device ? (deviceState === 'booted' ? 'ready' : 'stopped') : 'error',
        'degraded',
        session.remoteHostId ? 'UNSUPPORTED_SESSION_KIND' : 'ORPHANED_DEVICE',
        { normalizeViewerState },
      );
      return { complete, viewerStateHandled: true };
    }
    const reconciledDeviceState = deviceState ?? 'unknown';
    if (reconciledDeviceState === 'shutdown') {
      const runtimeReleased = await releaseInstanceRuntime(instance);
      if (runtimeReleased) {
        resourceScheduler.markStopped(instance.instanceId);
      } else {
        driverRuntimeRecovered = false;
        complete = false;
      }
    } else if (reconciledDeviceState !== 'booted') {
      // Booting / Shutting Down / unknown concrete states may still own a
      // CoreSimulator process. Tear down Cindy media but keep scheduler
      // occupancy until a later probe proves the device is Shutdown.
      if (!(await releaseInstanceRuntime(instance))) {
        driverRuntimeRecovered = false;
        complete = false;
      }
    }
    const reconciled = actor.reconcile(
      instance.instanceId,
      instance.sessionId,
      reconciledDeviceState === 'booted'
        ? 'ready'
        : reconciledDeviceState === 'shutdown'
          ? 'stopped'
          : reconciledDeviceState.includes('boot')
            ? 'booting'
            : reconciledDeviceState.includes('shutting')
              ? 'stopping'
              : 'error',
      !driverRuntimeRecovered
        ? 'degraded'
        : reconciledDeviceState === 'booted' || reconciledDeviceState === 'shutdown'
          ? 'healthy'
          : 'recovering',
      driverRuntimeRecovered ? null : 'WDA_UNAVAILABLE',
      { preserveDetachGrace: shouldResumeDetachGrace, normalizeViewerState },
    );
    if (shouldResumeDetachGrace && driverRuntimeRecovered && complete) {
      await actor.resumeDetachGrace(reconciled.instanceId, reconciled.sessionId, () =>
        resourceScheduler.markStopped(reconciled.instanceId),
      );
    }
    return { complete, viewerStateHandled: true };
  }

  function isViewerStateNormalized(scopeKey: string, instanceId: string): boolean {
    return (
      viewerStateNormalizedScopeKey === scopeKey &&
      viewerStateNormalizedInstanceIds.has(instanceId)
    );
  }

  function markViewerStateNormalized(scopeKey: string, instanceId: string): void {
    // An old in-flight pass must not suppress the new owner's normalization.
    if (isOwnerBoundaryPending() || getOwnerScopeKey() !== scopeKey) return;
    if (viewerStateNormalizedScopeKey !== scopeKey) {
      viewerStateNormalizedInstanceIds.clear();
      viewerStateNormalizedScopeKey = scopeKey;
    }
    viewerStateNormalizedInstanceIds.add(instanceId);
  }

  /** Keep the per-binding latch bounded by the bindings that still exist. */
  function retainViewerStateNormalized(
    scopeKey: string,
    persisted: readonly IOSSimulatorInstance[],
  ): void {
    if (viewerStateNormalizedScopeKey !== scopeKey) return;
    const live = new Set(persisted.map((instance) => instance.instanceId));
    for (const instanceId of viewerStateNormalizedInstanceIds) {
      if (!live.has(instanceId)) viewerStateNormalizedInstanceIds.delete(instanceId);
    }
  }

  async function reconcilePersistedOwnership(): Promise<void> {
    if (disposePromise) return;
    if (isOwnerBoundaryPending()) return;
    const requestedScopeKey = getOwnerScopeKey();
    if (ownershipReconciledScopeKey === requestedScopeKey) return;
    const inFlight = ownershipReconcilePromise;
    if (inFlight) {
      try {
        await inFlight.promise;
      } catch (error) {
        if (disposePromise || isOwnerBoundaryPending()) return;
        if (getOwnerScopeKey() !== requestedScopeKey) return;
        // A failed old-owner pass is not the new owner's result. Retry against
        // the current DB instead of surfacing stale-owner failure or leaving
        // the old scheduler occupancy latched until the next process start.
        if (inFlight.scopeKey !== requestedScopeKey) {
          return reconcilePersistedOwnership();
        }
        throw error;
      }
      if (disposePromise || isOwnerBoundaryPending()) return;
      // A new owner must not treat the previous owner's reconciliation as its
      // own. Wait for the old pass to settle, then run a fresh pass against
      // the new owner DB. A caller whose own scope became stale simply exits.
      if (getOwnerScopeKey() !== requestedScopeKey) return;
      if (
        inFlight.scopeKey !== requestedScopeKey &&
        ownershipReconciledScopeKey !== requestedScopeKey
      ) {
        return reconcilePersistedOwnership();
      }
      return;
    }
    const scopeKey = requestedScopeKey;
    let reconciliation!: Promise<void>;
    reconciliation = (async () => {
      let complete = true;
      if (!startupPendingCreateRecoveryAttempted && lifecycle.recoverPendingCreatesAtStartup) {
        if (!canReconcilePendingCreates()) {
          complete = false;
        } else {
          startupPendingCreateRecoveryAttempted = true;
          const controller = new AbortController();
          const recovery = recoverProfilePendingCreatesAtStartup(lifecycle, actor.listAll(), {
            signal: controller.signal,
            evidence: pendingCreateEvidence,
          });
          pendingCreateReconcileController = controller;
          pendingCreateReconcilePromise = recovery;
          try {
            await recovery;
          } finally {
            if (pendingCreateReconcileController === controller) {
              pendingCreateReconcileController = null;
              pendingCreateReconcilePromise = null;
            }
          }
        }
      }
      if (disposePromise) return;
      const persistedInstances = actor.listAll();
      if (lifecycle.reconcilePendingCreates && persistedInstances.length > 0) {
        if (!canReconcilePendingCreates()) {
          complete = false;
        } else {
          const controller = new AbortController();
          const reconciliation = lifecycle.reconcilePendingCreates(
            persistedInstances.map((instance) => ({
              udid: instance.simulatorUdid,
              name: instance.simulatorName,
            })),
            controller.signal,
          );
          pendingCreateReconcileController = controller;
          pendingCreateReconcilePromise = reconciliation;
          try {
            await reconciliation;
          } catch (error) {
            complete = false;
            if (!disposePromise) {
              logger.warn('Interrupted simulator create reconciliation will retry', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } finally {
            if (pendingCreateReconcileController === controller) {
              pendingCreateReconcileController = null;
              pendingCreateReconcilePromise = null;
            }
          }
        }
      }
      if (disposePromise) return;
      await reconcileOrphanedBuildResultBundles();
      if (disposePromise) return;
      const environment = await inspectRuntime();
      if (disposePromise) return;
      if (!environment?.ready) return;
      const devices = new Map(
        environment.devices.map((device) => [device.udid.toUpperCase(), device]),
      );
      const persisted = actor.listAll();
      retainViewerStateNormalized(scopeKey, persisted);
      for (const snapshot of persisted) {
        const normalizeViewerState = !isViewerStateNormalized(scopeKey, snapshot.instanceId);
        const instanceResult = await withSessionLock(snapshot.sessionId, () =>
          reconcilePersistedInstance(snapshot, devices, normalizeViewerState),
        );
        if (!instanceResult.complete) complete = false;
        // Latch per binding, not per pass: a binding skipped before its reconcile
        // (e.g. its session row was unreadable) still carries viewer state
        // inherited from a dead process, and the retry has to correct it. A
        // binding that was reconciled must not be normalized again, or the retry
        // would kick a viewer that attached in the meantime.
        if (instanceResult.viewerStateHandled) {
          markViewerStateNormalized(scopeKey, snapshot.instanceId);
        }
      }
      // Every DB/session read above belongs to the captured owner generation.
      // Never latch it across an account boundary or let an old in-flight pass
      // suppress the new owner's required cleanup and scheduler reconciliation.
      if (!isOwnerBoundaryPending() && getOwnerScopeKey() === scopeKey) {
        ownershipReconciledScopeKey = complete ? scopeKey : null;
      }
    })().finally(() => {
      if (ownershipReconcilePromise?.promise === reconciliation) {
        ownershipReconcilePromise = null;
      }
    });
    ownershipReconcilePromise = { scopeKey, promise: reconciliation };
    return reconciliation;
  }

  async function ensureDriver(
    instance: IOSSimulatorInstance,
    environment: IOSSimulatorEnvironmentReport,
  ): Promise<WdaRunningInstance> {
    const manager = getDriverManager();
    try {
      assertHostActive();
      const running = await manager.start({
        instanceId: instance.instanceId,
        simulatorUdid: instance.simulatorUdid,
        runtimeIdentifier: instance.runtimeIdentifier,
        runtimeBuildVersion:
          environment.runtimes.find((runtime) => runtime.identifier === instance.runtimeIdentifier)
            ?.buildVersion ?? null,
        xcodeBuild: environment.xcodeVersion ?? 'unknown',
        architecture: process.arch === 'x64' ? 'x86_64' : 'arm64',
        generation: instance.generation,
      });
      if (disposePromise) {
        await manager.stop(instance.instanceId).catch(() => undefined);
        throw new IOSSimulatorHostDisposedError();
      }
      if (!currentReadyGeneration(instance)) {
        await manager.stop(instance.instanceId).catch(() => undefined);
        throw new IOSSimulatorInstanceError(
          'STALE_GENERATION',
          'The simulator changed while its automation driver was starting.',
          true,
        );
      }
      const profile = streamProfiles.get(instance.instanceId);
      if (profile && typeof running.driver.configureStream === 'function') {
        await running.driver.configureStream(running.driverSessionId, profile);
      }
      const current = currentReadyGeneration(instance);
      if (!current) {
        await manager.stop(instance.instanceId).catch(() => undefined);
        throw new IOSSimulatorInstanceError(
          'STALE_GENERATION',
          'The simulator changed while its automation driver was starting.',
          true,
        );
      }
      actor.markHealth(current.sessionId, current.instanceId, 'healthy', null);
      return running;
    } catch (error) {
      const current = currentReadyGeneration(instance);
      if (
        current &&
        !(error instanceof IOSSimulatorHostDisposedError) &&
        !isInstanceError(error, 'STALE_GENERATION')
      ) {
        actor.markHealth(current.sessionId, current.instanceId, 'degraded', 'WDA_UNAVAILABLE');
      }
      throw error;
    }
  }

  function requireDriver(instanceId: string): WdaRunningInstance {
    const running = getDriverManager().get(instanceId);
    if (!running) {
      throw new WdaError('UNREACHABLE', 'The simulator automation driver is not connected.');
    }
    return running;
  }

  function requireControlGrant(
    instance: IOSSimulatorInstance,
    context: IOSSimulatorMcpCallContext | undefined,
  ): void {
    if (context?.origin === 'user') return;
    if (
      context?.origin === 'agent' &&
      agentControlLeases.get(instance.instanceId) === context.sessionId
    ) {
      return;
    }
    grantStore.requireAgentControl(instance.simulatorUdid);
  }

  function displayedViewport(
    driverViewport: IOSSimulatorPublicViewport,
    orientation: 'PORTRAIT' | 'LANDSCAPE',
  ): IOSSimulatorPublicViewport {
    if (driverViewport.orientation === orientation) return driverViewport;
    return {
      width: driverViewport.height,
      height: driverViewport.width,
      orientation,
    };
  }

  async function readDriverViewport(
    running: WdaRunningInstance,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorPublicViewport> {
    const [size, orientation] = await Promise.all([
      running.driver.getWindowSize(running.driverSessionId, signal),
      running.driver.getOrientation(running.driverSessionId, signal),
    ]);
    const viewport = { ...size, orientation };
    driverViewports.set(running.instanceId, viewport);
    return viewport;
  }

  async function readViewport(
    running: WdaRunningInstance,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorPublicViewport> {
    const driverViewport = await readDriverViewport(running, signal);
    const viewport = displayedViewport(
      driverViewport,
      viewerOrientationOverrides.get(running.instanceId) ?? driverViewport.orientation,
    );
    viewports.set(running.instanceId, viewport);
    return viewport;
  }

  async function currentViewports(
    running: WdaRunningInstance,
    signal?: AbortSignal,
  ): Promise<{
    viewer: IOSSimulatorPublicViewport;
    driver: IOSSimulatorPublicViewport;
  }> {
    const cachedViewer = viewports.get(running.instanceId);
    const cachedDriver = driverViewports.get(running.instanceId);
    if (cachedViewer && cachedDriver) {
      return { viewer: cachedViewer, driver: cachedDriver };
    }
    const viewer = await readViewport(running, signal);
    return {
      viewer,
      driver: driverViewports.get(running.instanceId) ?? viewer,
    };
  }

  async function refreshInteractionSnapshot(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    signal?: AbortSignal,
  ) {
    const snapshot = await running.driver.getAccessibilityTree(running.driverSessionId, signal);
    return screenMaps.capture({
      instanceId: instance.instanceId,
      generation: instance.generation,
      capturedAt: snapshot.capturedAt,
      tree: snapshot.tree,
    });
  }

  function requireAgentInteractionSnapshot(
    instance: IOSSimulatorInstance,
    args: Record<string, unknown>,
  ) {
    return screenMaps.requireCurrent({
      instanceId: instance.instanceId,
      generation: instance.generation,
      snapshotId: readString(args, 'snapshotId'),
    });
  }

  async function describeToolsForSession(
    sessionId: string,
    environment?: IOSSimulatorEnvironmentReport,
  ): Promise<IOSSimulatorToolAvailabilityReport> {
    const inspected = environment ?? (await inspectRuntime());
    const instances = actor.list(sessionId);
    const running = instances
      .map((instance) => ({ instance, driver: getDriverManager().get(instance.instanceId) }))
      .filter((entry) => entry.driver !== null);
    const capabilityReports = running
      .map((entry) => entry.driver?.driverRouter?.capabilityReport?.())
      .filter((report): report is NonNullable<typeof report> => Boolean(report));
    const hasNativeInput = capabilityReports.some(
      (report) =>
        report.routes.continuousInput.selected === 'native-sidecar' &&
        !report.routes.continuousInput.fallback,
    );
    const hasMultiTouch = capabilityReports.some(
      (report) =>
        report.nativeSidecar.capabilities?.multiTouch === true && report.nativeSidecar.available,
    );
    const hasInstance = instances.length > 0;
    const hasRunning = running.length > 0;
    const requiresInstance: IOSSimulatorToolAvailability = {
      state: hasInstance ? (hasRunning ? 'available' : 'instance-dependent') : 'requires-instance',
      ...(hasInstance ? {} : { reasonCode: 'INSTANCE_REQUIRED' }),
    };
    // Keyed by the advertised (model-facing) tool names, because the registry
    // merges this map into its own listing. Host dispatch names stay unchanged.
    const tools: Record<string, IOSSimulatorToolAvailability> = {
      check_environment: { state: 'available', backend: 'host' },
      doctor: { state: 'available', backend: 'host' },
      list_simulator_devices: inspected.ready
        ? { state: 'available', backend: 'simctl' }
        : { state: 'unavailable', reasonCode: inspected.issue ?? 'ENVIRONMENT_NOT_READY' },
      list_instances: { state: 'available', backend: 'host' },
      create_instance: inspected.ready
        ? { state: 'available', backend: 'simctl' }
        : { state: 'unavailable', reasonCode: inspected.issue ?? 'ENVIRONMENT_NOT_READY' },
      attach_device: inspected.ready
        ? { state: 'available', backend: 'host' }
        : { state: 'unavailable', reasonCode: inspected.issue ?? 'ENVIRONMENT_NOT_READY' },
      read_build_diagnostics: { state: 'available', backend: 'host' },
      start_instance: { ...requiresInstance, backend: 'simctl' },
      stop_instance: { ...requiresInstance, backend: 'simctl' },
      detach_device: { ...requiresInstance, backend: 'host' },
      get_screen_map: { ...requiresInstance, backend: 'wda' },
      audit_accessibility: { ...requiresInstance, backend: 'wda' },
      compare_screen_maps: { ...requiresInstance, backend: 'wda' },
      wait_for_ui: { ...requiresInstance, backend: 'wda' },
      tap: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      swipe: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      drag_on_simulator: {
        ...requiresInstance,
        backend: hasNativeInput ? 'native-hid' : 'wda',
      },
      long_press: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      press_simulator_key: { ...requiresInstance, backend: 'wda' },
      batch: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      touch_path: hasNativeInput
        ? { state: 'available', backend: 'native-hid' }
        : {
            state: hasInstance ? 'unavailable' : 'requires-instance',
            reasonCode: hasInstance ? 'NATIVE_HID_NOT_ADMITTED' : 'INSTANCE_REQUIRED',
          },
      touch2_path: hasMultiTouch
        ? { state: 'available', backend: 'native-hid' }
        : {
            state: hasInstance ? 'unavailable' : 'requires-instance',
            reasonCode: hasInstance ? 'MULTI_TOUCH_NOT_ADMITTED' : 'INSTANCE_REQUIRED',
          },
    };
    for (const name of [
      'type_simulator_text',
      'press_home',
      'set_orientation',
      'set_appearance',
      'set_increase_contrast',
      'set_content_size',
      'set_location',
      'start_location_route',
      'clear_location',
      'set_privacy',
      'push_notification',
      'set_status_bar',
      'clear_status_bar',
      'lock_screen',
      'unlock_screen',
      'build_app',
      'install_app',
      'launch_app',
      'terminate_app',
      'open_simulator_url',
      'take_simulator_screenshot',
      'capture_visual_baseline',
      'visual_diff',
      'capture_state',
      'get_diagnostics',
      'start_recording',
      'stop_recording',
    ]) {
      tools[name] = { ...requiresInstance, backend: name === 'build_app' ? 'host' : 'wda' };
    }
    return {
      ready: inspected.ready,
      instanceCount: instances.length,
      runningInstanceCount: running.length,
      tools,
    };
  }

  function screenMapFingerprint(screenMap: IOSSimulatorScreenMap): string {
    return createHash('sha256').update(JSON.stringify(screenMap.elements)).digest('hex');
  }

  function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(
        new IOSSimulatorInstanceError(
          'MUTATION_CANCELLED',
          'The UI operation was cancelled.',
          true,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(
          new IOSSimulatorInstanceError(
            'MUTATION_CANCELLED',
            'The UI operation was cancelled.',
            true,
          ),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function elementMatches(
    element: IOSSimulatorScreenMap['elements'][number],
    selector: Record<string, unknown>,
  ): boolean {
    if (typeof selector.elementId === 'string' && element.elementId !== selector.elementId) {
      return false;
    }
    if (typeof selector.role === 'string' && element.role !== selector.role) return false;
    if (
      typeof selector.labelContains === 'string' &&
      !element.label?.toLocaleLowerCase().includes(selector.labelContains.toLocaleLowerCase())
    ) {
      return false;
    }
    if (
      typeof selector.valueContains === 'string' &&
      !element.value?.toLocaleLowerCase().includes(selector.valueContains.toLocaleLowerCase())
    ) {
      return false;
    }
    return true;
  }

  function elementPoint(screenMap: IOSSimulatorScreenMap, elementId: string) {
    const element = screenMap.elements.find((candidate) => candidate.elementId === elementId);
    if (!element?.frame || element.enabled === false || element.visible === false) {
      throw new IOSSimulatorInstanceError(
        'STALE_UI_SNAPSHOT',
        'The target is no longer interactable. Read a new screen map.',
        true,
      );
    }
    return {
      x: element.frame.x + element.frame.width / 2,
      y: element.frame.y + element.frame.height / 2,
    };
  }

  async function waitForUiCondition(input: {
    instance: IOSSimulatorInstance;
    running: WdaRunningInstance;
    condition: Record<string, unknown>;
    timeoutMs: number;
    pollIntervalMs: number;
    stableForMs: number;
    signal: AbortSignal;
    throwOnTimeout: boolean;
  }): Promise<{
    screenMap: IOSSimulatorScreenMap;
    elapsedMs: number;
    stable: boolean;
    timedOut: boolean;
  }> {
    const startedAt = Date.now();
    let previousFingerprint: string | null = null;
    let stableSince = startedAt;
    let lastScreenMap: IOSSimulatorScreenMap | null = null;
    let baselineFingerprint: string | null = null;
    const kind = readString(input.condition, 'kind');
    if (kind === 'screen_changed') {
      const baseline = screenMaps.requireCurrent({
        instanceId: input.instance.instanceId,
        generation: input.instance.generation,
        snapshotId: readString(input.condition, 'snapshotId'),
      });
      baselineFingerprint = screenMapFingerprint(baseline);
    }
    while (true) {
      const screenMap = await refreshInteractionSnapshot(
        input.instance,
        input.running,
        input.signal,
      );
      lastScreenMap = screenMap;
      const fingerprint = screenMapFingerprint(screenMap);
      const now = Date.now();
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        stableSince = now;
      }
      let matched = false;
      if (kind === 'element_exists' || kind === 'element_missing') {
        const selector = readObject(input.condition, 'selector');
        const exists = screenMap.elements.some((element) => elementMatches(element, selector));
        matched = kind === 'element_exists' ? exists : !exists;
      } else if (kind === 'screen_changed') {
        matched = fingerprint !== baselineFingerprint;
      } else if (kind === 'screen_stable') {
        matched = now - stableSince >= input.stableForMs;
      } else {
        throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'Unsupported UI wait condition.');
      }
      if (matched) {
        return {
          screenMap,
          elapsedMs: now - startedAt,
          stable: kind === 'screen_stable',
          timedOut: false,
        };
      }
      if (now - startedAt >= input.timeoutMs) {
        if (input.throwOnTimeout) {
          throw new IOSSimulatorInstanceError(
            'UI_WAIT_TIMEOUT',
            'The requested UI condition did not become true before the timeout.',
            true,
          );
        }
        return {
          screenMap: lastScreenMap,
          elapsedMs: now - startedAt,
          stable: false,
          timedOut: true,
        };
      }
      await sleepWithAbort(input.pollIntervalMs, input.signal);
    }
  }

  async function observeAfterInteraction(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const mode = args.observeAfter === undefined ? 'none' : readString(args, 'observeAfter');
    if (mode === 'none') return null;
    if (mode === 'immediate') {
      return {
        mode,
        screenMap: await refreshInteractionSnapshot(instance, running, signal),
        stable: false,
        timedOut: false,
        elapsedMs: 0,
      };
    }
    if (mode !== 'stable') {
      throw new IOSSimulatorInstanceError(
        'INVALID_ARGUMENT',
        'observeAfter must be none, immediate, or stable',
      );
    }
    const observed = await waitForUiCondition({
      instance,
      running,
      condition: { kind: 'screen_stable' },
      timeoutMs: readPositiveInteger(args, 'observeTimeoutMs'),
      pollIntervalMs: 100,
      stableForMs: readPositiveInteger(args, 'stableForMs'),
      signal,
      throwOnTimeout: false,
    });
    return { mode, ...observed };
  }

  async function performSwipe(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    signal: AbortSignal,
  ): Promise<'native-hid' | 'wda'> {
    const nativeInput = running.driverRouter?.continuousInput();
    if (nativeInput && durationMs >= 8) {
      const viewport =
        driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running, signal));
      await nativeInput.touchPath(nativeSwipePath(start, end, durationMs, viewport), signal);
      return 'native-hid';
    }
    await running.driver.swipe(running.driverSessionId, start, end, durationMs, signal);
    return 'wda';
  }

  async function performLongPress(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    point: { x: number; y: number },
    durationMs: number,
    signal: AbortSignal,
  ): Promise<'native-hid' | 'wda'> {
    const nativeInput = running.driverRouter?.continuousInput();
    if (nativeInput) {
      const viewport =
        driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running, signal));
      const normalized = normalizedPointFromViewport(point, viewport);
      await nativeInput.touchPath(
        [
          { ...normalized, phase: 'down', dtMs: 0, edge: 'none' },
          { ...normalized, phase: 'up', dtMs: durationMs, edge: 'none' },
        ],
        signal,
      );
      return 'native-hid';
    }
    await running.driver.swipe(running.driverSessionId, point, point, durationMs, signal);
    return 'wda';
  }

  const webDriverKeys: Record<string, string> = {
    return: '\uE007',
    tab: '\uE004',
    escape: '\uE00C',
    delete: '\uE017',
    arrow_up: '\uE013',
    arrow_down: '\uE015',
    arrow_left: '\uE012',
    arrow_right: '\uE014',
  };

  async function performKeyPress(
    running: WdaRunningInstance,
    key: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = webDriverKeys[key];
    if (!value) throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'Unsupported key.');
    await running.driver.typeText(running.driverSessionId, value, signal);
  }

  function pointFromViewer(
    args: Record<string, unknown>,
    viewerViewport: IOSSimulatorPublicViewport,
    driverViewport: IOSSimulatorPublicViewport,
    xKey: string,
    yKey: string,
  ) {
    const xRatio = readNormalizedCoordinate(args, xKey);
    const yRatio = readNormalizedCoordinate(args, yKey);
    let driverXRatio = xRatio;
    let driverYRatio = yRatio;
    if (driverViewport.orientation === 'PORTRAIT' && viewerViewport.orientation === 'LANDSCAPE') {
      // Native Sidecar rotates portrait framebuffer pixels clockwise.
      driverXRatio = yRatio;
      driverYRatio = 1 - xRatio;
    } else if (
      driverViewport.orientation === 'LANDSCAPE' &&
      viewerViewport.orientation === 'PORTRAIT'
    ) {
      driverXRatio = 1 - yRatio;
      driverYRatio = xRatio;
    }
    return {
      x: Math.min(driverViewport.width - 1, driverXRatio * driverViewport.width),
      y: Math.min(driverViewport.height - 1, driverYRatio * driverViewport.height),
    };
  }

  function normalizedPointFromViewport(
    point: { x: number; y: number },
    size: IOSSimulatorWindowSize,
  ): { x: number; y: number } {
    if (
      size.width <= 0 ||
      size.height <= 0 ||
      point.x < 0 ||
      point.x > size.width ||
      point.y < 0 ||
      point.y > size.height
    ) {
      throw new IOSSimulatorInstanceError(
        'INVALID_ARGUMENT',
        'Touch coordinates must be inside the current simulator viewport.',
      );
    }
    return {
      x: point.x / size.width,
      y: point.y / size.height,
    };
  }

  function readTouchEdge(value: unknown): IOSSimulatorTouchEdge {
    if (
      value === undefined ||
      value === 'none' ||
      value === 'left' ||
      value === 'top' ||
      value === 'bottom' ||
      value === 'right'
    ) {
      return value ?? 'none';
    }
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'edge is invalid.');
  }

  function readTouchPath(
    args: Record<string, unknown>,
    key: string,
    viewport: IOSSimulatorWindowSize,
    edge: IOSSimulatorTouchEdge = 'none',
  ): IOSSimulatorTouchPoint[] {
    const value = args[key];
    if (!Array.isArray(value) || value.length < 2 || value.length > 4_096) {
      throw new IOSSimulatorInstanceError(
        'INVALID_ARGUMENT',
        `${key} must contain between 2 and 4096 touch samples.`,
      );
    }
    return value.map((sample, index) => {
      if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
        throw new IOSSimulatorInstanceError(
          'INVALID_ARGUMENT',
          `${key}[${index}] must be an object.`,
        );
      }
      const record = sample as Record<string, unknown>;
      const phase = record.phase;
      if (phase !== 'down' && phase !== 'move' && phase !== 'up' && phase !== 'cancel') {
        throw new IOSSimulatorInstanceError(
          'INVALID_ARGUMENT',
          `${key}[${index}].phase is invalid.`,
        );
      }
      const point = normalizedPointFromViewport(
        {
          x: readFiniteCoordinate(record, 'x'),
          y: readFiniteCoordinate(record, 'y'),
        },
        viewport,
      );
      const dtMs =
        record.dtMs === undefined ? undefined : readBoundedFinite(record, 'dtMs', 0, 60_000);
      if (dtMs !== undefined && !Number.isSafeInteger(dtMs)) {
        throw new IOSSimulatorInstanceError(
          'INVALID_ARGUMENT',
          `${key}[${index}].dtMs must be an integer.`,
        );
      }
      return {
        ...point,
        phase,
        ...(dtMs === undefined ? {} : { dtMs }),
        edge,
      };
    });
  }

  function nativeSwipePath(
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    viewport: IOSSimulatorWindowSize,
  ): IOSSimulatorTouchPoint[] {
    const normalizedStart = normalizedPointFromViewport(start, viewport);
    const normalizedEnd = normalizedPointFromViewport(end, viewport);
    const segments = Math.max(2, Math.ceil(durationMs / 16));
    const baseDelay = Math.floor(durationMs / segments);
    const remainder = durationMs % segments;
    return Array.from({ length: segments + 1 }, (_, index) => {
      const progress = index / segments;
      return {
        x: normalizedStart.x + (normalizedEnd.x - normalizedStart.x) * progress,
        y: normalizedStart.y + (normalizedEnd.y - normalizedStart.y) * progress,
        phase: index === 0 ? 'down' : index === segments ? 'up' : 'move',
        dtMs: index === 0 ? 0 : baseDelay + (index <= remainder ? 1 : 0),
        edge: 'none',
      };
    });
  }

  function runHostMutation<T>(
    route: IOSSimulatorMutationRoute,
    context: IOSSimulatorMcpCallContext | undefined,
    task: (instance: IOSSimulatorInstance, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assertHostActive();
    const sessionAdmissionEpoch = sessionOperationAdmissionEpochs.get(route.sessionId) ?? 0;
    const instanceAdmissionEpoch = captureInstanceOperationAdmission(route.instanceId, 'operation');
    return actor.runMutation(
      route,
      async (instance, signal) => {
        assertHostActive();
        assertSessionOperationAdmission(
          instance.sessionId,
          sessionAdmissionEpoch,
          'simulator operation',
        );
        assertInstanceOperationAdmission(instance.instanceId, instanceAdmissionEpoch, 'operation');
        let result: T;
        try {
          result = await task(instance, signal);
        } catch (error) {
          if (signal.aborted) {
            throw new IOSSimulatorInstanceError(
              'MUTATION_CANCELLED',
              'The simulator operation was cancelled because its lifecycle changed.',
              true,
            );
          }
          throw error;
        }
        assertSessionOperationAdmission(
          instance.sessionId,
          sessionAdmissionEpoch,
          'simulator operation',
        );
        assertInstanceOperationAdmission(instance.instanceId, instanceAdmissionEpoch, 'operation');
        assertHostActive();
        return result;
      },
      context?.origin === 'user' ? 'user' : 'agent',
    );
  }

  async function discardInstanceMediaForLifecycle(
    instanceId: string,
    operation: 'stop' | 'detach',
  ): Promise<{ code: 'MEDIA_CLEANUP_INCOMPLETE'; message: string } | null> {
    try {
      await mediaCapture.discardInstance(instanceId);
      return null;
    } catch (error) {
      logger.warn('iOS Simulator media cleanup did not finish before lifecycle teardown', {
        instanceId,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        code: 'MEDIA_CLEANUP_INCOMPLETE',
        message:
          'The simulator lifecycle completed, but pending media cleanup did not finish. Restart Cindy before capturing more simulator media.',
      };
    }
  }

  function requireArtifact(
    instance: IOSSimulatorInstance,
    artifactId: string,
  ): IOSSimulatorAppArtifact {
    const stored = appArtifacts.get(artifactId);
    if (!stored || stored.instanceId !== instance.instanceId) {
      throw new IOSSimulatorInstanceError(
        'APP_ARTIFACT_INVALID',
        'The app build artifact is unavailable for this simulator instance.',
      );
    }
    return stored.artifact;
  }

  function cancelIdleRecycle(instanceId: string): void {
    const timer = idleRecycleTimers.get(instanceId);
    if (timer) clearTimeout(timer);
    idleRecycleTimers.delete(instanceId);
  }

  function scheduleIdleRecycle(instance: IOSSimulatorInstance): void {
    cancelIdleRecycle(instance.instanceId);
    if (!Number.isFinite(idleRecycleMs) || idleRecycleMs <= 0) return;
    const timer = setTimeout(() => {
      idleRecycleTimers.delete(instance.instanceId);
      void (async () => {
        try {
          const current = actor.getOwned(instance.sessionId, instance.instanceId);
          if (current.lifecycleState !== 'ready' || current.viewerState !== 'attached') return;
          if (!getDriverManager().get(instance.instanceId)) return;
          await getDriverManager().stop(instance.instanceId);
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          actor.markHealth(instance.sessionId, instance.instanceId, 'healthy', null);
        } catch (error) {
          logger.warn('iOS Simulator idle WDA recycle failed', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, idleRecycleMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    idleRecycleTimers.set(instance.instanceId, timer);
  }

  function releaseViewerTouches(instanceId: string): void {
    const touches = activeViewerTouches.get(instanceId);
    activeViewerTouches.delete(instanceId);
    if (!touches || touches.size === 0) return;
    const nativeInput = getDriverManager().get(instanceId)?.driverRouter?.continuousInput();
    if (!nativeInput) return;
    for (const [gestureId, point] of touches) {
      try {
        void nativeInput.endTouch(gestureId, point, true).catch((error) => {
          logger.warn('iOS Simulator viewer touch release failed', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        logger.warn('iOS Simulator viewer touch release failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function stopViewerMedia(instance: IOSSimulatorInstance): IOSSimulatorFramePumpSnapshot | null {
    const running = getDriverManager().get(instance.instanceId);
    // Enqueue Native HID cancellation before clearing the stream/viewer claim.
    // Renderer cleanup IPC may already be denied after its capability is revoked.
    releaseViewerTouches(instance.instanceId);
    viewerSessions.delete(instance.instanceId);
    h264FramePump.clear(instance.instanceId);
    viewerEncodings.delete(instance.instanceId);
    viewerPreferredEncodings.delete(instance.instanceId);
    viewerFallbackReasons.delete(instance.instanceId);
    if (!running) {
      cancelIdleRecycle(instance.instanceId);
      framePump.clear(instance.instanceId);
      clearViewportState(instance.instanceId);
      publishRouteStatusForInstance(instance, null);
      return null;
    }
    scheduleIdleRecycle(instance);
    const snapshot = framePump.setVisible({
      instanceId: instance.instanceId,
      generation: instance.generation,
      driver: running.driver,
      visible: false,
    });
    publishRouteStatusForInstance(instance, running);
    return snapshot;
  }

  function nativeH264Driver(running: WdaRunningInstance): IOSSimulatorNativeSidecarDriver | null {
    const route = running.driverRouter?.stream('h264');
    if (route?.adapter !== 'native-sidecar') return null;
    return route.source;
  }

  function nativeViewerProfile(
    instanceId: string,
    fallback: IOSSimulatorStreamProfile,
  ): IOSSimulatorNativeH264StreamProfileRequest {
    return (
      nativeStreamProfiles.get(instanceId) ?? {
        framesPerSecond: fallback.framesPerSecond,
        scalingPercent: fallback.scalingPercent,
      }
    );
  }

  function activeNativeH264Driver(
    instanceId: string,
    running: WdaRunningInstance,
  ): IOSSimulatorNativeSidecarDriver | null {
    if (viewerEncodings.get(instanceId) !== 'h264') return null;
    if (h264FramePump.snapshot(instanceId)?.state !== 'streaming') return null;
    return nativeH264Driver(running);
  }

  function assertCurrentViewer(
    sessionId: string,
    instanceId: string,
    viewerWebContentsId: number,
    viewerToken?: string,
  ): void {
    const viewer = viewerSessions.get(instanceId);
    if (
      !viewer ||
      viewer.sessionId !== sessionId ||
      viewer.webContentsId === null ||
      viewer.webContentsId !== viewerWebContentsId ||
      (viewerToken !== undefined && viewer.viewerToken !== viewerToken)
    ) {
      throw new IOSSimulatorInstanceError(
        'INSTANCE_NOT_OWNED',
        'This simulator viewer is not owned by the current Cindy window.',
        true,
      );
    }
  }

  function assertViewerClaimAvailable(
    sessionId: string,
    instanceId: string,
    viewerWebContentsId?: number,
  ): void {
    if (viewerWebContentsId === undefined) return;
    const activeViewer = viewerSessions.get(instanceId);
    if (
      activeViewer?.webContentsId !== null &&
      activeViewer?.webContentsId !== undefined &&
      activeViewer.webContentsId !== viewerWebContentsId &&
      isViewerWebContentsAlive(activeViewer.webContentsId)
    ) {
      throw new IOSSimulatorInstanceError(
        'INSTANCE_NOT_OWNED',
        'This simulator already has an active viewer in another Cindy window.',
        true,
      );
    }
    if (activeViewer && activeViewer.sessionId !== sessionId) {
      throw new IOSSimulatorInstanceError(
        'INSTANCE_NOT_OWNED',
        'This simulator viewer belongs to another Cindy task.',
        true,
      );
    }
  }

  function registerViewerVisibilityIntent(
    sessionId: string,
    instanceId: string,
    visible: boolean,
    viewerWebContentsId?: number,
    viewerToken?: string,
  ): { intent: ViewerVisibilityIntent | null; ignored: boolean } {
    if (viewerWebContentsId === undefined || disposePromise) {
      return { intent: null, ignored: false };
    }
    const normalizedSessionId = sessionId.trim();
    // Register ordering before the first await, but never allocate state for a
    // renderer-supplied instance id that is not owned by this exact task.
    if (!actor.list(normalizedSessionId).some((instance) => instance.instanceId === instanceId)) {
      return { intent: null, ignored: false };
    }
    const normalizedViewerToken = viewerToken ?? null;
    const intents = viewerVisibilityIntents.get(instanceId) ?? new Map();
    const previous = intents.get(viewerWebContentsId);
    const activeViewer = viewerSessions.get(instanceId);
    const latestViewer =
      previous ??
      (activeViewer?.webContentsId === viewerWebContentsId
        ? {
            sequence: 0,
            sessionId: activeViewer.sessionId,
            viewerToken: activeViewer.viewerToken,
            visible: true,
          }
        : null);
    if (
      !visible &&
      latestViewer &&
      (latestViewer.sessionId !== normalizedSessionId ||
        (latestViewer.viewerToken !== null && latestViewer.viewerToken !== normalizedViewerToken))
    ) {
      return { intent: null, ignored: true };
    }
    const intent: ViewerVisibilityIntent = {
      sequence: ++nextViewerVisibilityIntentSequence,
      sessionId: normalizedSessionId,
      viewerToken: normalizedViewerToken,
      visible,
    };
    intents.set(viewerWebContentsId, intent);
    viewerVisibilityIntents.set(instanceId, intents);
    return { intent, ignored: false };
  }

  function isCurrentViewerVisibilityIntent(
    instanceId: string,
    viewerWebContentsId: number | undefined,
    intent: ViewerVisibilityIntent | null,
  ): boolean {
    if (viewerWebContentsId === undefined || !intent) return true;
    return viewerVisibilityIntents.get(instanceId)?.get(viewerWebContentsId) === intent;
  }

  function assertCurrentViewerVisibilityIntent(
    instanceId: string,
    viewerWebContentsId: number | undefined,
    intent: ViewerVisibilityIntent | null,
  ): void {
    if (isCurrentViewerVisibilityIntent(instanceId, viewerWebContentsId, intent)) return;
    throw new IOSSimulatorInstanceError(
      'INSTANCE_NOT_OWNED',
      'This simulator viewer request was replaced by a newer visibility request.',
      true,
    );
  }

  function revokeRendererViewerIntents(
    sessionId: string,
    viewerWebContentsId: number,
  ): Set<string> {
    const revokedInstanceIds = new Set<string>();
    for (const [instanceId, intents] of viewerVisibilityIntents) {
      const current = intents.get(viewerWebContentsId);
      if (!current || current.sessionId !== sessionId) continue;
      // Removing the exact object invalidates every pending assertion while
      // avoiding an unbounded tombstone per destroyed WebContents.
      intents.delete(viewerWebContentsId);
      if (intents.size === 0) viewerVisibilityIntents.delete(instanceId);
      revokedInstanceIds.add(instanceId);
    }
    return revokedInstanceIds;
  }

  function reserveViewerClaim(
    sessionId: string,
    instanceId: string,
    viewerWebContentsId?: number,
    viewerToken?: string,
  ): { assertCurrent(): void; rollback(): void } | null {
    if (viewerWebContentsId === undefined) return null;
    assertViewerClaimAvailable(sessionId, instanceId, viewerWebContentsId);
    const previous = viewerSessions.get(instanceId);
    const claim = {
      sessionId,
      webContentsId: viewerWebContentsId,
      viewerToken:
        viewerToken ??
        (previous?.webContentsId === viewerWebContentsId ? previous.viewerToken : null),
    };
    if (
      previous &&
      (previous.sessionId !== claim.sessionId ||
        previous.webContentsId !== claim.webContentsId ||
        previous.viewerToken !== claim.viewerToken)
    ) {
      releaseViewerTouches(instanceId);
    }
    viewerSessions.set(instanceId, claim);
    return {
      assertCurrent: () => {
        if (viewerSessions.get(instanceId) === claim) return;
        throw new IOSSimulatorInstanceError(
          'INSTANCE_NOT_OWNED',
          'This simulator viewer was replaced by a newer viewer request.',
          true,
        );
      },
      rollback: () => {
        if (viewerSessions.get(instanceId) !== claim) return;
        if (previous?.webContentsId === viewerWebContentsId) {
          viewerSessions.set(instanceId, previous);
        } else {
          viewerSessions.delete(instanceId);
        }
      },
    };
  }

  function startViewerStream(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    preferredEncoding: 'jpeg' | 'h264',
    orientation: 'PORTRAIT' | 'LANDSCAPE' = 'PORTRAIT',
    fallbackReason: IOSSimulatorPublicRouteReasonCode = null,
    viewerWebContentsId?: number,
    viewerToken?: string,
  ): IOSSimulatorFramePumpSnapshot {
    const previousViewer = viewerSessions.get(instance.instanceId);
    const nextViewerWebContentsId = viewerWebContentsId ?? previousViewer?.webContentsId ?? null;
    const nextViewerToken = viewerToken ?? previousViewer?.viewerToken ?? null;
    if (
      !previousViewer ||
      previousViewer.sessionId !== instance.sessionId ||
      previousViewer.webContentsId !== nextViewerWebContentsId ||
      previousViewer.viewerToken !== nextViewerToken
    ) {
      if (previousViewer) releaseViewerTouches(instance.instanceId);
      viewerSessions.set(instance.instanceId, {
        sessionId: instance.sessionId,
        webContentsId: nextViewerWebContentsId,
        viewerToken: nextViewerToken,
      });
    }
    viewerPreferredEncodings.set(instance.instanceId, fallbackReason ? 'h264' : preferredEncoding);
    const nativeDriver = preferredEncoding === 'h264' ? nativeH264Driver(running) : null;
    if (nativeDriver) {
      viewerEncodings.set(instance.instanceId, 'h264');
      viewerFallbackReasons.delete(instance.instanceId);
      framePump.setVisible({
        instanceId: instance.instanceId,
        generation: instance.generation,
        driver: running.driver,
        visible: false,
      });
      const fallbackProfile = streamProfiles.get(instance.instanceId) ?? {
        framesPerSecond: 5,
        jpegQuality: 25,
        scalingPercent: 50,
      };
      const nativeProfile = nativeViewerProfile(instance.instanceId, fallbackProfile);
      const snapshot = h264FramePump.setVisible({
        instanceId: instance.instanceId,
        generation: instance.generation,
        driver: nativeDriver,
        profile: {
          encoding: 'h264',
          framesPerSecond: nativeProfile.framesPerSecond,
          scalingPercent: nativeProfile.scalingPercent,
          orientation,
        },
        visible: true,
      });
      publishRouteStatusForInstance(instance, running);
      return snapshot;
    }
    viewerEncodings.set(instance.instanceId, 'jpeg');
    if (preferredEncoding === 'h264' || fallbackReason) {
      const report = running.driverRouter?.capabilityReport();
      viewerFallbackReasons.set(
        instance.instanceId,
        fallbackReason ??
          (!report || report.nativeSidecar.available === false
            ? 'native-sidecar-unavailable'
            : 'native-capability-unavailable'),
      );
    } else {
      viewerFallbackReasons.delete(instance.instanceId);
    }
    clearViewerOrientationOverride(instance.instanceId);
    h264FramePump.clear(instance.instanceId);
    const snapshot = framePump.setVisible({
      instanceId: instance.instanceId,
      generation: instance.generation,
      driver: running.driver,
      visible: true,
    });
    publishRouteStatusForInstance(instance, running);
    return snapshot;
  }

  return {
    reconcileOwnership: reconcilePersistedOwnership,
    async describeTools(sessionId) {
      const resolved = await resolveSession(sessionId);
      if (!resolved.ok) {
        return {
          ready: false,
          instanceCount: 0,
          runningInstanceCount: 0,
          tools: {
            doctor: { state: 'available', backend: 'host' },
            check_environment: { state: 'available', backend: 'host' },
            // Advertised name: the registry merges availability by the name it
            // lists, so a stale key would report TOOL_NOT_REPORTED instead of the
            // real session rejection reason.
            list_simulator_devices: {
              state: 'unavailable',
              reasonCode: resolved.errorCode,
            },
          },
        };
      }
      return describeToolsForSession(resolved.sessionId);
    },
    getStatus: inspectForSession,
    getPluginStatus: inspectForPlugin,
    revokeRendererViewer(sessionId, viewerWebContentsId) {
      const revokedInstanceIds = revokeRendererViewerIntents(sessionId, viewerWebContentsId);
      for (const [instanceId, viewer] of [...viewerSessions]) {
        if (viewer.sessionId !== sessionId || viewer.webContentsId !== viewerWebContentsId)
          continue;
        revokedInstanceIds.add(instanceId);
        try {
          stopViewerMedia(actor.getOwned(sessionId, instanceId));
        } catch {
          // Ownership can disappear before the renderer grant. Clear every
          // process-local viewer resource without trying to recover a route.
          releaseViewerTouches(instanceId);
          viewerSessions.delete(instanceId);
          cancelIdleRecycle(instanceId);
          framePump.clear(instanceId);
          h264FramePump.clear(instanceId);
          viewerEncodings.delete(instanceId);
          viewerPreferredEncodings.delete(instanceId);
          viewerFallbackReasons.delete(instanceId);
          clearViewportState(instanceId);
        }
      }
      return revokedInstanceIds.size;
    },
    async setViewerVisibility(
      sessionId,
      route,
      visible,
      preferredEncoding = 'jpeg',
      fallbackReason,
      viewerWebContentsId,
      viewerToken,
    ) {
      const viewerIntentRegistration = registerViewerVisibilityIntent(
        sessionId,
        route.instanceId,
        visible,
        viewerWebContentsId,
        viewerToken,
      );
      const viewerIntent = viewerIntentRegistration.intent;
      let viewerClaimReservation: ReturnType<typeof reserveViewerClaim> = null;
      let removalBarrierOperation: IOSSimulatorSessionRemovalBarrierOperation | null = null;
      let viewerRuntimeInstance: IOSSimulatorInstance | null = null;
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId, {
          registerRemovalBarrier: visible,
        });
        if (!resolved.ok) return resolved;
        if (visible) {
          assertCurrentViewerVisibilityIntent(route.instanceId, viewerWebContentsId, viewerIntent);
        }
        removalBarrierOperation = resolved.removalBarrierOperation ?? null;
        if (visible) assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        assertHostActive();
        const mutationRoute = { ...route, sessionId: resolved.sessionId };
        if (visible) {
          assertViewerClaimAvailable(resolved.sessionId, route.instanceId, viewerWebContentsId);
        }
        let instance = visible
          ? actor.heartbeat(mutationRoute)
          : assertViewerDeactivationRoute(mutationRoute);
        if (!visible) {
          if (
            viewerIntentRegistration.ignored ||
            !isCurrentViewerVisibilityIntent(instance.instanceId, viewerWebContentsId, viewerIntent)
          ) {
            return {
              ok: true,
              data: {
                stream: null,
                ignored: true,
                mutation: actor.mutationState(instance.instanceId),
              },
            };
          }
          const activeViewer = viewerSessions.get(instance.instanceId);
          if (
            activeViewer &&
            (activeViewer.sessionId !== resolved.sessionId ||
              (activeViewer.webContentsId !== null &&
                activeViewer.webContentsId !== viewerWebContentsId) ||
              (activeViewer.viewerToken !== null && activeViewer.viewerToken !== viewerToken))
          ) {
            return {
              ok: true,
              data: {
                stream: null,
                ignored: true,
                mutation: actor.mutationState(instance.instanceId),
              },
            };
          }
          const stream = stopViewerMedia(instance);
          return {
            ok: true,
            data: {
              stream,
              ...(stream
                ? {}
                : {
                    viewport: null,
                    mutation: actor.mutationState(instance.instanceId),
                  }),
            },
          };
        }
        // A visible viewer session may retry an optional Native route in the
        // background, but those retries must respect the Sidecar crash budget.
        // Only an explicit close -> reopen starts a new viewer session that may
        // re-arm a parked Sidecar.
        const rearmNativeSidecar = !viewerSessions.has(instance.instanceId);
        instance = await reconcileLiveDevice(instance);
        assertCurrentViewerVisibilityIntent(instance.instanceId, viewerWebContentsId, viewerIntent);
        if (visible) assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        assertHostActive();
        if (instance.lifecycleState !== 'ready') {
          return viewerRouteRefreshResult(instance);
        }
        cancelIdleRecycle(instance.instanceId);
        viewerRuntimeInstance = instance;
        const driverManager = getDriverManager();
        let running = await getHealthyDriver(instance.instanceId);
        assertCurrentViewerVisibilityIntent(instance.instanceId, viewerWebContentsId, viewerIntent);
        let current = currentReadyGeneration(instance);
        if (!current) return viewerRouteRefreshResult(currentOwnedInstance(instance));
        instance = current;
        if (!running) {
          const environment = await inspectRuntime();
          assertCurrentViewerVisibilityIntent(
            instance.instanceId,
            viewerWebContentsId,
            viewerIntent,
          );
          assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
          assertHostActive();
          current = currentReadyGeneration(instance);
          if (!current) return viewerRouteRefreshResult(currentOwnedInstance(instance));
          instance = current;
          if (!environment.ready) {
            throw new IOSSimulatorInstanceError(
              'INVALID_INSTANCE_STATE',
              'The simulator environment is not ready for recovery.',
              true,
            );
          }
          const device = environment.devices.find(
            (candidate) => candidate.udid.toUpperCase() === instance.simulatorUdid.toUpperCase(),
          );
          if (!device || !device.isAvailable || device.state.toLowerCase() !== 'booted') {
            const reconciled = await actor.reconcileExternalDeviceState(
              {
                sessionId: instance.sessionId,
                instanceId: instance.instanceId,
                simulatorUdid: instance.simulatorUdid,
                expectedGeneration: instance.generation,
                state: !device || !device.isAvailable ? 'missing' : 'shutdown',
              },
              async (previous) => releaseExternallyStoppedRuntime(previous),
            );
            instance = reconciled.instance;
            return viewerRouteRefreshResult(instance);
          }
          try {
            running = await resourceScheduler.runStart(
              instance.instanceId,
              async (commitRunning) => {
                assertCurrentViewerVisibilityIntent(
                  instance.instanceId,
                  viewerWebContentsId,
                  viewerIntent,
                );
                assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
                assertHostActive();
                commitRunning();
                actor.markHealth(resolved.sessionId, instance.instanceId, 'recovering', null);
                const started = await ensureDriver(instance, environment);
                assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
                return started;
              },
            );
            assertCurrentViewerVisibilityIntent(
              instance.instanceId,
              viewerWebContentsId,
              viewerIntent,
            );
          } catch (error) {
            if (isInstanceError(error, 'STALE_GENERATION')) {
              return viewerRouteRefreshResult(currentOwnedInstance(instance));
            }
            throw error;
          }
          assertHostActive();
        }
        if (
          preferredEncoding === 'h264' &&
          running.driverRouter?.capabilityReport().nativeSidecar.available === false &&
          driverManager.recoverNativeSidecar
        ) {
          running =
            (await driverManager.recoverNativeSidecar(instance.instanceId, {
              rearm: rearmNativeSidecar,
            })) ?? running;
          assertCurrentViewerVisibilityIntent(
            instance.instanceId,
            viewerWebContentsId,
            viewerIntent,
          );
          assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
          assertHostActive();
          current = currentReadyGeneration(instance);
          if (!current) return viewerRouteRefreshResult(currentOwnedInstance(instance));
          instance = current;
        }
        assertCurrentViewerVisibilityIntent(instance.instanceId, viewerWebContentsId, viewerIntent);
        viewerClaimReservation = reserveViewerClaim(
          resolved.sessionId,
          instance.instanceId,
          viewerWebContentsId,
          viewerToken,
        );
        let viewport: IOSSimulatorPublicViewport;
        try {
          viewport = await readViewport(running);
          assertCurrentViewerVisibilityIntent(
            instance.instanceId,
            viewerWebContentsId,
            viewerIntent,
          );
          assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        } catch (error) {
          current = currentReadyGeneration(instance);
          if (!current) return viewerRouteRefreshResult(currentOwnedInstance(instance));
          throw error;
        }
        assertHostActive();
        current = currentReadyGeneration(instance);
        if (!current) return viewerRouteRefreshResult(currentOwnedInstance(instance));
        instance = current;
        // Driver recovery can outlive the lease that authorized it. Renew once
        // more after all slow startup work so the successful response always
        // carries a live viewer route.
        instance = actor.heartbeatOwned(resolved.sessionId, instance.instanceId);
        assertCurrentViewerVisibilityIntent(instance.instanceId, viewerWebContentsId, viewerIntent);
        viewerClaimReservation?.assertCurrent();
        if (viewerWebContentsId !== undefined) {
          assertCurrentViewer(resolved.sessionId, instance.instanceId, viewerWebContentsId);
        }
        const stream = startViewerStream(
          instance,
          running,
          preferredEncoding,
          viewport.orientation,
          fallbackReason ?? null,
          viewerWebContentsId,
          viewerToken,
        );
        viewerClaimReservation = null;
        return {
          ok: true,
          data: {
            // Heartbeat may replace an expired lease while keeping the same
            // simulator generation. Return the refreshed instance as well so
            // the renderer can atomically move its viewer route forward
            // instead of continuing to send the obsolete lease id.
            ...(instance.generation !== route.generation || instance.lease.id !== route.leaseId
              ? { instance: publicInstance(instance) }
              : {}),
            viewport: viewports.get(instance.instanceId) ?? viewport,
            mutation: actor.mutationState(instance.instanceId),
            stream,
          },
        };
      } catch (error) {
        return safeHostError(error, sessionId, 'set_viewer_visibility');
      } finally {
        viewerClaimReservation?.rollback();
        if (
          visible &&
          viewerRuntimeInstance &&
          !isCurrentViewerVisibilityIntent(
            viewerRuntimeInstance.instanceId,
            viewerWebContentsId,
            viewerIntent,
          ) &&
          !viewerSessions.has(viewerRuntimeInstance.instanceId) &&
          driverManager?.get(viewerRuntimeInstance.instanceId)
        ) {
          scheduleIdleRecycle(viewerRuntimeInstance);
        }
        removalBarrierOperation?.finish();
      }
    },
    async getLatestFrame(sessionId, route, viewerWebContentsId) {
      let removalBarrierOperation: IOSSimulatorSessionRemovalBarrierOperation | null = null;
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId, { registerRemovalBarrier: true });
        if (!resolved.ok) return resolved;
        removalBarrierOperation = resolved.removalBarrierOperation ?? null;
        assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        assertHostActive();
        assertCurrentViewer(resolved.sessionId, route.instanceId, viewerWebContentsId);
        let instance = actor.heartbeat({ ...route, sessionId: resolved.sessionId });
        instance = await reconcileLiveDevice(instance);
        assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        assertHostActive();
        if (instance.lifecycleState !== 'ready') {
          return {
            ok: true,
            data: {
              instance: publicInstance(instance),
              stream: null,
              viewport: null,
              mutation: actor.mutationState(instance.instanceId),
            },
          };
        }
        let selectedEncoding = viewerEncodings.get(instance.instanceId) ?? 'jpeg';
        let snapshot: IOSSimulatorFramePumpSnapshot | null =
          selectedEncoding === 'h264'
            ? h264FramePump.snapshot(instance.instanceId)
            : framePump.snapshot(instance.instanceId);
        if (selectedEncoding === 'h264' && snapshot?.state === 'disconnected') {
          const running = await getHealthyDriver(instance.instanceId);
          assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
          h264FramePump.clear(instance.instanceId);
          if (running) {
            snapshot = startViewerStream(
              instance,
              running,
              'jpeg',
              viewports.get(instance.instanceId)?.orientation ?? 'PORTRAIT',
              'native-stream-disconnected',
            );
            selectedEncoding = 'jpeg';
          } else {
            viewerEncodings.delete(instance.instanceId);
            snapshot = null;
          }
        }
        if (snapshot && snapshot.generation !== instance.generation) {
          releaseViewerTouches(instance.instanceId);
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          viewerPreferredEncodings.delete(instance.instanceId);
          viewerFallbackReasons.delete(instance.instanceId);
          viewerSessions.delete(instance.instanceId);
          viewerVisibilityIntents.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          publishRouteStatusForInstance(instance);
          return {
            ok: true,
            data: {
              instance: publicInstance(instance),
              stream: null,
              viewport: null,
              mutation: actor.mutationState(instance.instanceId),
            },
          };
        }
        publishRouteStatusForInstance(instance);
        return {
          ok: true,
          data: {
            stream: snapshot,
            viewport: viewports.get(instance.instanceId) ?? null,
            mutation: actor.mutationState(instance.instanceId),
          },
        };
      } catch (error) {
        const expired = currentExpiredViewerRoute({ ...route, sessionId: sessionId.trim() }, error);
        if (expired) stopViewerMedia(expired);
        return safeHostError(error, sessionId, 'get_latest_frame');
      } finally {
        removalBarrierOperation?.finish();
      }
    },
    async setAgentControlGrant(sessionId, instanceId, decision, assertElevationCurrent) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const instance = actor.getOwned(resolved.sessionId, instanceId);
        if (decision === 'allowed') assertElevationCurrent?.();
        if (decision === 'denied') {
          agentControlLeases.delete(instance.instanceId);
        }
        return {
          ok: true,
          data: {
            grant: grantStore.set(instance.simulatorUdid, { agentControl: decision }),
          },
        };
      } catch (error) {
        return {
          ok: false,
          errorCode:
            error instanceof IOSSimulatorInstanceError ? error.code : 'IOS_SIMULATOR_HOST_ERROR',
          message:
            error instanceof IOSSimulatorInstanceError
              ? error.message
              : 'Unable to update simulator control permission.',
        };
      }
    },
    async setAgentMutationPaused(sessionId, route, paused) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const mutationRoute = { ...route, sessionId: resolved.sessionId };
        const mutation = paused
          ? actor.takeover(mutationRoute)
          : actor.resumeAgentMutations(mutationRoute);
        if (paused) screenMaps.invalidate(route.instanceId);
        return { ok: true, data: { mutation } };
      } catch (error) {
        return safeHostError(error, sessionId, 'set_agent_mutation_paused');
      }
    },
    async updateViewerTouch(sessionId, route, viewerWebContentsId, touch) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        assertCurrentViewer(resolved.sessionId, route.instanceId, viewerWebContentsId);
        const mutationRoute = { ...route, sessionId: resolved.sessionId };
        await runHostMutation(
          mutationRoute,
          { sessionId: resolved.sessionId, origin: 'user' },
          async (instance, signal) => {
            assertCurrentViewer(resolved.sessionId, instance.instanceId, viewerWebContentsId);
            const running = requireDriver(instance.instanceId);
            const nativeInput = running.driverRouter?.continuousInput();
            if (!nativeInput) {
              throw new IOSSimulatorInstanceError(
                'NATIVE_INPUT_UNAVAILABLE',
                'Continuous native touch input is unavailable.',
                true,
              );
            }
            const { viewer, driver } = await currentViewports(running, signal);
            assertCurrentViewer(resolved.sessionId, instance.instanceId, viewerWebContentsId);
            const driverPoint = pointFromViewer(
              { xRatio: touch.xRatio, yRatio: touch.yRatio },
              viewer,
              driver,
              'xRatio',
              'yRatio',
            );
            const point = normalizedPointFromViewport(driverPoint, driver);
            if (touch.phase === 'begin') {
              await nativeInput.beginTouch(touch.gestureId, point, signal);
              try {
                assertCurrentViewer(resolved.sessionId, instance.instanceId, viewerWebContentsId);
              } catch (error) {
                await nativeInput.endTouch(touch.gestureId, point, true).catch(() => undefined);
                throw error;
              }
              const touches = activeViewerTouches.get(instance.instanceId) ?? new Map();
              touches.set(touch.gestureId, point);
              activeViewerTouches.set(instance.instanceId, touches);
            } else if (touch.phase === 'move') {
              await nativeInput.moveTouch(touch.gestureId, point, signal);
              try {
                assertCurrentViewer(resolved.sessionId, instance.instanceId, viewerWebContentsId);
              } catch (error) {
                await nativeInput.endTouch(touch.gestureId, point, true).catch(() => undefined);
                activeViewerTouches.get(instance.instanceId)?.delete(touch.gestureId);
                throw error;
              }
              activeViewerTouches.get(instance.instanceId)?.set(touch.gestureId, point);
            } else {
              await nativeInput.endTouch(touch.gestureId, point, touch.phase === 'cancel', signal);
              const touches = activeViewerTouches.get(instance.instanceId);
              touches?.delete(touch.gestureId);
              if (touches?.size === 0) activeViewerTouches.delete(instance.instanceId);
            }
            screenMaps.invalidate(instance.instanceId);
          },
        );
        return { ok: true, data: { interaction: `touch_${touch.phase}` } };
      } catch (error) {
        return safeHostError(error, sessionId, `viewer_touch_${touch.phase}`);
      }
    },
    async setViewerStreamProfile(
      sessionId,
      route,
      viewerWebContentsId,
      viewerToken,
      profile,
      nativeProfile,
    ) {
      let removalBarrierOperation: IOSSimulatorSessionRemovalBarrierOperation | null = null;
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId, { registerRemovalBarrier: true });
        if (!resolved.ok) return resolved;
        removalBarrierOperation = resolved.removalBarrierOperation ?? null;
        assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        assertHostActive();
        assertCurrentViewer(resolved.sessionId, route.instanceId, viewerWebContentsId, viewerToken);
        if (
          !Number.isSafeInteger(profile.framesPerSecond) ||
          profile.framesPerSecond < 1 ||
          profile.framesPerSecond > MAX_WDA_VIEWER_FRAMES_PER_SECOND ||
          !Number.isSafeInteger(profile.jpegQuality) ||
          profile.jpegQuality < 1 ||
          profile.jpegQuality > 100 ||
          !Number.isSafeInteger(profile.scalingPercent) ||
          profile.scalingPercent < 1 ||
          profile.scalingPercent > 100
        ) {
          throw new IOSSimulatorInstanceError(
            'INVALID_ARGUMENT',
            'WDA fallback profile values are outside the supported range.',
          );
        }
        if (
          nativeProfile &&
          (!Number.isSafeInteger(nativeProfile.framesPerSecond) ||
            nativeProfile.framesPerSecond < 1 ||
            nativeProfile.framesPerSecond > MAX_NATIVE_H264_VIEWER_FRAMES_PER_SECOND ||
            !Number.isSafeInteger(nativeProfile.scalingPercent) ||
            nativeProfile.scalingPercent < 1 ||
            nativeProfile.scalingPercent > 100)
        ) {
          throw new IOSSimulatorInstanceError(
            'INVALID_ARGUMENT',
            'Native H.264 profile values are outside the supported range.',
          );
        }
        const instance = actor.heartbeat({ ...route, sessionId: resolved.sessionId });
        assertCurrentViewer(
          resolved.sessionId,
          instance.instanceId,
          viewerWebContentsId,
          viewerToken,
        );
        const running = getDriverManager().get(instance.instanceId);
        const activeNativeDriver =
          nativeProfile && running ? activeNativeH264Driver(instance.instanceId, running) : null;
        if (nativeProfile && !activeNativeDriver) {
          throw new IOSSimulatorInstanceError(
            'INVALID_ARGUMENT',
            'Native H.264 profile changes require an active Native H.264 viewer.',
          );
        }
        if (!running) {
          // The viewer may request its fallback profile while WDA is being rebuilt.
          // Native-only intent is rejected above because no active route can prove it.
          assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
          assertCurrentViewer(
            resolved.sessionId,
            instance.instanceId,
            viewerWebContentsId,
            viewerToken,
          );
          streamProfiles.set(instance.instanceId, profile);
          nativeStreamProfiles.delete(instance.instanceId);
          return { ok: true, data: { profile } };
        }
        const applied = await running.driver.configureStream(running.driverSessionId, profile);
        assertSessionRemovalAdmission(resolved.sessionId, removalBarrierOperation);
        assertHostActive();
        assertCurrentViewer(
          resolved.sessionId,
          instance.instanceId,
          viewerWebContentsId,
          viewerToken,
        );
        streamProfiles.set(instance.instanceId, applied);
        if (nativeProfile) nativeStreamProfiles.set(instance.instanceId, nativeProfile);
        else nativeStreamProfiles.delete(instance.instanceId);
        if (viewerEncodings.get(instance.instanceId) === 'h264') {
          const nativeDriver = activeNativeDriver ?? nativeH264Driver(running);
          if (nativeDriver) {
            const appliedNativeProfile = nativeProfile ?? {
              framesPerSecond: applied.framesPerSecond,
              scalingPercent: applied.scalingPercent,
            };
            h264FramePump.setVisible({
              instanceId: instance.instanceId,
              generation: instance.generation,
              driver: nativeDriver,
              profile: {
                encoding: 'h264',
                framesPerSecond: appliedNativeProfile.framesPerSecond,
                scalingPercent: appliedNativeProfile.scalingPercent,
                orientation: viewports.get(instance.instanceId)?.orientation ?? 'PORTRAIT',
              },
              visible: true,
            });
          }
        }
        return {
          ok: true,
          data: {
            profile: applied,
            ...(nativeProfile ? { nativeProfile: { ...nativeProfile } } : {}),
          },
        };
      } catch (error) {
        return safeHostError(error, sessionId, 'set_viewer_stream_profile');
      } finally {
        removalBarrierOperation?.finish();
      }
    },
    async callTool(name, args, context): Promise<IOSSimulatorHostResult> {
      const sessionId = context?.sessionId?.trim();
      if (!sessionId) {
        return {
          ok: false,
          errorCode: 'SESSION_CONTEXT_REQUIRED',
          message: 'iOS Simulator tools require an active Cindy session.',
        };
      }
      if (disposePromise) return hostDisposedResult();
      let removalBarrierOperation: IOSSimulatorSessionRemovalBarrierOperation | null = null;
      try {
        const resolved = await resolveSession(sessionId, {
          registerRemovalBarrier:
            name === 'start_instance' || name === 'create_instance' || name === 'attach_device',
        });
        if (!resolved.ok) return resolved;
        removalBarrierOperation = resolved.removalBarrierOperation ?? null;
        assertHostActive();
        await reconcilePersistedOwnership();
        assertHostActive();

        if (name === 'list_instances') {
          return {
            ok: true,
            data: {
              instances: actor
                .list(sessionId)
                .map((instance) => actor.heartbeatOwned(sessionId, instance.instanceId))
                .map(publicInstance),
            },
          };
        }
        if (name === 'start_instance') {
          assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
          const route = readMutationRoute(sessionId, args);
          requireControlGrant(actor.getOwned(sessionId, route.instanceId), context);
          const activationEpoch = captureInstanceActivation(route.instanceId);
          const environment = await inspectRuntime();
          assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
          if (!environment.ready) {
            const safeEnvironment = publicEnvironment(environment);
            return {
              ok: false,
              errorCode: environment.issue ?? 'IOS_SIMULATOR_HOST_ERROR',
              message: safeEnvironment.error ?? 'iOS Simulator is not ready.',
            };
          }
          const instance = await resourceScheduler.runStart(
            route.instanceId,
            async (commitRunning) => {
              assertHostActive();
              assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
              const starting = actor.getOwned(sessionId, route.instanceId);
              let lifecycleStartAttempted = false;
              let runningCommitted = false;
              try {
                assertInstanceActivation(route.instanceId, activationEpoch);
                lifecycleStartAttempted = true;
                const started = await actor.start(route);
                assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
                commitRunning();
                runningCommitted = true;
                assertInstanceActivation(route.instanceId, activationEpoch);
                await ensureDriver(started, environment);
                assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
                return actor.heartbeatOwned(sessionId, started.instanceId);
              } catch (error) {
                // simctl can boot the device and then fail while waiting for
                // readiness. Preserve the real resource occupancy even when
                // actor.start() never returns its ready snapshot.
                if (lifecycleStartAttempted && !runningCommitted) {
                  if (
                    error instanceof IOSSimulatorInstanceError &&
                    error.code === 'MUTATION_CANCELLED'
                  ) {
                    // Teardown must not start another uncancellable simctl
                    // probe after it has already aborted bootstatus. Startup
                    // may have crossed `simctl boot`, so preserve occupancy.
                    commitRunning();
                  } else {
                    try {
                      const device = await lifecycle.findExact(starting.simulatorUdid);
                      if (device && device.state.trim().toLowerCase() !== 'shutdown') {
                        commitRunning();
                      }
                    } catch {
                      // An ambiguous probe cannot prove that CoreSimulator
                      // released the resource. Fail closed while preserving the
                      // original startup failure as the authoritative error.
                      commitRunning();
                    }
                  }
                }
                throw error;
              }
            },
          );
          assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
          completeInstanceActivation(instance, activationEpoch);
          releaseViewerTouches(instance.instanceId);
          screenMaps.clear(instance.instanceId);
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          viewerPreferredEncodings.delete(instance.instanceId);
          viewerFallbackReasons.delete(instance.instanceId);
          viewerSessions.delete(instance.instanceId);
          viewerVisibilityIntents.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          requestViewerFocus(sessionId, instance.instanceId);
          publishRouteStatusForInstance(instance, getDriverManager().get(instance.instanceId));
          return {
            ok: true,
            data: instanceData(instance),
          };
        }
        if (name === 'stop_instance') {
          const route = readMutationRoute(sessionId, args);
          requireControlGrant(actor.getOwned(sessionId, route.instanceId), context);
          actor.assertRoute(route);
          beginInstanceTeardown(route.instanceId);
          try {
            await cancelBuild(route.instanceId);
            cancelIdleRecycle(route.instanceId);
            const mediaCleanupWarning = await discardInstanceMediaForLifecycle(
              route.instanceId,
              'stop',
            );
            clearVisualBaselines(route.instanceId);
            await getDriverManager().stop(route.instanceId);
            screenMaps.clear(route.instanceId);
            framePump.clear(route.instanceId);
            h264FramePump.clear(route.instanceId);
            viewerEncodings.delete(route.instanceId);
            viewerPreferredEncodings.delete(route.instanceId);
            viewerFallbackReasons.delete(route.instanceId);
            viewerSessions.delete(route.instanceId);
            viewerVisibilityIntents.delete(route.instanceId);
            clearViewportState(route.instanceId);
            const stopped = await actor.stop(route);
            resourceScheduler.markStopped(route.instanceId);
            publishRouteStatusForInstance(stopped, null);
            return {
              ok: true,
              data: {
                ...instanceData(stopped),
                ...(mediaCleanupWarning ? { mediaCleanupWarning } : {}),
              },
            };
          } finally {
            finishInstanceTeardown(route.instanceId);
          }
        }
        if (name === 'detach_device') {
          const route = readMutationRoute(sessionId, args);
          requireControlGrant(actor.getOwned(sessionId, route.instanceId), context);
          actor.assertRoute(route);
          beginInstanceTeardown(route.instanceId);
          try {
            await cancelBuild(route.instanceId);
            cancelIdleRecycle(route.instanceId);
            const mediaCleanupWarning = await discardInstanceMediaForLifecycle(
              route.instanceId,
              'detach',
            );
            clearVisualBaselines(route.instanceId);
            await getDriverManager().stop(route.instanceId);
            screenMaps.clear(route.instanceId);
            framePump.clear(route.instanceId);
            h264FramePump.clear(route.instanceId);
            viewerEncodings.delete(route.instanceId);
            viewerPreferredEncodings.delete(route.instanceId);
            viewerFallbackReasons.delete(route.instanceId);
            viewerSessions.delete(route.instanceId);
            viewerVisibilityIntents.delete(route.instanceId);
            clearViewportState(route.instanceId);
            agentControlLeases.delete(route.instanceId);
            return {
              ok: true,
              data: {
                ...instanceData(
                  await actor.detach(route, () => resourceScheduler.markStopped(route.instanceId)),
                ),
                ...(mediaCleanupWarning ? { mediaCleanupWarning } : {}),
              },
            };
          } finally {
            finishInstanceTeardown(route.instanceId);
          }
        }
        if (name === 'get_screen_map') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const [screenMap, viewport] = await Promise.all([
              refreshInteractionSnapshot(instance, running, signal),
              context?.origin === 'user'
                ? readViewport(running, signal)
                : readDriverViewport(running, signal),
            ]);
            return { screenMap, viewport };
          });
          return { ok: true, data: captured };
        }
        if (name === 'wait_for_ui') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const condition = readObject(args, 'condition');
            return waitForUiCondition({
              instance,
              running,
              condition,
              timeoutMs: readPositiveInteger(args, 'timeoutMs'),
              pollIntervalMs: readPositiveInteger(args, 'pollIntervalMs'),
              stableForMs: readPositiveInteger(args, 'stableForMs'),
              signal,
              throwOnTimeout: true,
            });
          });
          return { ok: true, data: captured };
        }
        if (name === 'audit_accessibility') {
          const route = readMutationRoute(sessionId, args);
          const maxViolations =
            args.maxViolations === undefined ? 200 : readPositiveInteger(args, 'maxViolations');
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const current = screenMaps.current(instance.instanceId);
            const screenMap =
              current?.generation === instance.generation
                ? current
                : await refreshInteractionSnapshot(instance, running, signal);
            return {
              audit: auditIOSSimulatorScreenMap(screenMap, maxViolations),
            };
          });
          return { ok: true, data: captured };
        }
        if (name === 'compare_screen_maps') {
          const route = readMutationRoute(sessionId, args);
          const baseline = readObject(args, 'baseline') as unknown as IOSSimulatorScreenMap;
          if (baseline.instanceId !== route.instanceId) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'baseline belongs to a different simulator instance',
            );
          }
          const maxChanges =
            args.maxChanges === undefined ? 200 : readPositiveInteger(args, 'maxChanges');
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const current = await refreshInteractionSnapshot(instance, running, signal);
            return {
              diff: diffIOSSimulatorScreenMaps(baseline, current, maxChanges),
            };
          });
          return { ok: true, data: captured };
        }
        if (name === 'tap') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const elementId = typeof args.elementId === 'string' ? args.elementId.trim() : '';
            let point: { x: number; y: number };
            if (elementId) {
              const screenMap =
                context?.origin === 'user'
                  ? await refreshInteractionSnapshot(instance, running, signal)
                  : requireAgentInteractionSnapshot(instance, args);
              point = elementPoint(screenMap, elementId);
            } else if (context?.origin === 'user') {
              const { viewer, driver } = await currentViewports(running, signal);
              point = pointFromViewer(args, viewer, driver, 'xRatio', 'yRatio');
            } else {
              requireAgentInteractionSnapshot(instance, args);
              point = {
                x: readFiniteCoordinate(args, 'x'),
                y: readFiniteCoordinate(args, 'y'),
              };
            }
            const nativeInput = running.driverRouter?.continuousInput();
            if (nativeInput) {
              const nativeViewport =
                driverViewports.get(instance.instanceId) ??
                (await readDriverViewport(running, signal));
              const normalized = normalizedPointFromViewport(point, nativeViewport);
              await nativeInput.touchPath(
                [
                  { ...normalized, phase: 'down', dtMs: 0, edge: 'none' },
                  { ...normalized, phase: 'up', dtMs: 8, edge: 'none' },
                ],
                signal,
              );
            } else {
              await running.driver.tap(running.driverSessionId, point, signal);
            }
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: nativeInput ? 'native-hid' : 'wda',
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'tap',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'swipe') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const viewport =
              context?.origin === 'user' ? await currentViewports(running, signal) : null;
            if (!viewport) {
              requireAgentInteractionSnapshot(instance, args);
            }
            const start = viewport
              ? pointFromViewer(
                  args,
                  viewport.viewer,
                  viewport.driver,
                  'startXRatio',
                  'startYRatio',
                )
              : {
                  x: readFiniteCoordinate(args, 'startX'),
                  y: readFiniteCoordinate(args, 'startY'),
                };
            const end = viewport
              ? pointFromViewer(args, viewport.viewer, viewport.driver, 'endXRatio', 'endYRatio')
              : {
                  x: readFiniteCoordinate(args, 'endX'),
                  y: readFiniteCoordinate(args, 'endY'),
                };
            const durationMs = readPositiveInteger(args, 'durationMs');
            const backend = await performSwipe(instance, running, start, end, durationMs, signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'swipe',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'drag') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const screenMap =
              context?.origin === 'user'
                ? await refreshInteractionSnapshot(instance, running, signal)
                : requireAgentInteractionSnapshot(instance, args);
            const start = elementPoint(screenMap, readString(args, 'fromElementId'));
            const end = elementPoint(screenMap, readString(args, 'toElementId'));
            const backend = await performSwipe(
              instance,
              running,
              start,
              end,
              readPositiveInteger(args, 'durationMs'),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'drag',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'long_press') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const screenMap =
              context?.origin === 'user'
                ? await refreshInteractionSnapshot(instance, running, signal)
                : requireAgentInteractionSnapshot(instance, args);
            const point = elementPoint(screenMap, readString(args, 'elementId'));
            const backend = await performLongPress(
              instance,
              running,
              point,
              readPositiveInteger(args, 'durationMs'),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'long_press',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'key_press') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') requireAgentInteractionSnapshot(instance, args);
            await performKeyPress(running, readString(args, 'key'), signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'wda' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'key_press',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'batch') {
          const route = readMutationRoute(sessionId, args);
          const actions = args.actions;
          if (!Array.isArray(actions) || actions.length === 0 || actions.length > 16) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'actions must contain between 1 and 16 UI actions',
            );
          }
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            let screenMap =
              context?.origin === 'user'
                ? await refreshInteractionSnapshot(instance, running, signal)
                : requireAgentInteractionSnapshot(instance, args);
            const completed: Array<{ index: number; type: string; backend: string }> = [];
            for (const [index, rawAction] of actions.entries()) {
              const action = rawAction as Record<string, unknown>;
              const type = readString(action, 'type');
              let backend = 'wda';
              if (type === 'tap') {
                const point = elementPoint(screenMap, readString(action, 'elementId'));
                const nativeInput = running.driverRouter?.continuousInput();
                if (nativeInput) {
                  const viewport =
                    driverViewports.get(instance.instanceId) ??
                    (await readDriverViewport(running, signal));
                  const normalized = normalizedPointFromViewport(point, viewport);
                  await nativeInput.touchPath(
                    [
                      { ...normalized, phase: 'down', dtMs: 0, edge: 'none' },
                      { ...normalized, phase: 'up', dtMs: 8, edge: 'none' },
                    ],
                    signal,
                  );
                  backend = 'native-hid';
                } else {
                  await running.driver.tap(running.driverSessionId, point, signal);
                }
              } else if (type === 'swipe') {
                backend = await performSwipe(
                  instance,
                  running,
                  {
                    x: readFiniteCoordinate(action, 'startX'),
                    y: readFiniteCoordinate(action, 'startY'),
                  },
                  {
                    x: readFiniteCoordinate(action, 'endX'),
                    y: readFiniteCoordinate(action, 'endY'),
                  },
                  readPositiveInteger(action, 'durationMs'),
                  signal,
                );
              } else if (type === 'drag') {
                backend = await performSwipe(
                  instance,
                  running,
                  elementPoint(screenMap, readString(action, 'fromElementId')),
                  elementPoint(screenMap, readString(action, 'toElementId')),
                  readPositiveInteger(action, 'durationMs'),
                  signal,
                );
              } else if (type === 'long_press') {
                backend = await performLongPress(
                  instance,
                  running,
                  elementPoint(screenMap, readString(action, 'elementId')),
                  readPositiveInteger(action, 'durationMs'),
                  signal,
                );
              } else if (type === 'type_text') {
                const text = action.text;
                if (typeof text !== 'string' || text.length > 10_000) {
                  throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'Invalid batch text.');
                }
                await running.driver.typeText(running.driverSessionId, text, signal);
              } else if (type === 'key_press') {
                await performKeyPress(running, readString(action, 'key'), signal);
              } else {
                throw new IOSSimulatorInstanceError(
                  'INVALID_ARGUMENT',
                  `Unsupported batch action: ${type}`,
                );
              }
              screenMaps.invalidate(instance.instanceId);
              screenMap = await refreshInteractionSnapshot(instance, running, signal);
              completed.push({ index, type, backend });
            }
            const observation = await observeAfterInteraction(instance, running, args, signal);
            return { completed, observation: observation ?? { mode: 'immediate', screenMap } };
          });
          return {
            ok: true,
            data: {
              interaction: 'batch',
              screenMapInvalidated: false,
              ...captured,
            },
          };
        }
        if (name === 'touch_path') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            const nativeInput = running.driverRouter?.continuousInput();
            if (!nativeInput) {
              throw new IOSSimulatorInstanceError(
                'NATIVE_INPUT_UNAVAILABLE',
                'Continuous native touch input is unavailable; simple swipe remains available through WebDriverAgent.',
                true,
              );
            }
            const viewport =
              driverViewports.get(instance.instanceId) ??
              (await readDriverViewport(running, signal));
            await nativeInput.touchPath(
              readTouchPath(args, 'points', viewport, readTouchEdge(args.edge)),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'native-hid' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'touch_path',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'touch2_path') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            const nativeInput = running.driverRouter?.continuousInput();
            if (!nativeInput?.capabilities.multiTouch) {
              throw new IOSSimulatorInstanceError(
                'NATIVE_INPUT_UNAVAILABLE',
                'Native multi-touch input is unavailable for this simulator.',
                true,
              );
            }
            const viewport =
              driverViewports.get(instance.instanceId) ??
              (await readDriverViewport(running, signal));
            await nativeInput.touch2Path(
              readTouchPath(args, 'first', viewport),
              readTouchPath(args, 'second', viewport),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'native-hid' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'touch2_path',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'type_text') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            const text = args.text;
            if (typeof text !== 'string' || text.length > 10_000) {
              throw new IOSSimulatorInstanceError(
                'INVALID_ARGUMENT',
                'text must be a string of at most 10000 characters',
              );
            }
            await running.driver.typeText(running.driverSessionId, text, signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'wda' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'type_text',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'press_home') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            await running.driver.home(signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'wda' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'press_home',
              screenMapInvalidated: !captured.observation,
              ...captured,
            },
          };
        }
        if (name === 'set_orientation') {
          const route = readMutationRoute(sessionId, args);
          const orientation = readString(args, 'orientation');
          if (orientation !== 'PORTRAIT' && orientation !== 'LANDSCAPE') {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'orientation must be PORTRAIT or LANDSCAPE',
            );
          }
          const rotation = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            let mode: 'device' | 'viewer' = 'device';
            let viewport: IOSSimulatorPublicViewport;
            try {
              await running.driver.setOrientation(orientation, running.driverSessionId, signal);
              clearViewerOrientationOverride(instance.instanceId);
              viewport = await readViewport(running, signal);
            } catch (error) {
              const nativeDriver =
                viewerEncodings.get(instance.instanceId) === 'h264'
                  ? nativeH264Driver(running)
                  : null;
              if (
                !(error instanceof WdaError) ||
                error.code !== 'ORIENTATION_UNSUPPORTED' ||
                !nativeDriver
              ) {
                throw error;
              }
              const driverViewport =
                driverViewports.get(instance.instanceId) ??
                (await readDriverViewport(running, signal));
              const fallbackProfile = streamProfiles.get(instance.instanceId) ?? {
                framesPerSecond: 5,
                jpegQuality: 25,
                scalingPercent: 50,
              };
              const nativeProfile = nativeViewerProfile(instance.instanceId, fallbackProfile);
              h264FramePump.setVisible({
                instanceId: instance.instanceId,
                generation: instance.generation,
                driver: nativeDriver,
                profile: {
                  encoding: 'h264',
                  framesPerSecond: nativeProfile.framesPerSecond,
                  scalingPercent: nativeProfile.scalingPercent,
                  orientation,
                },
                visible: true,
              });
              viewerOrientationOverrides.set(instance.instanceId, orientation);
              viewport = displayedViewport(driverViewport, orientation);
              viewports.set(instance.instanceId, viewport);
              mode = 'viewer';
              logger.info('iOS Simulator using viewer-level orientation fallback', {
                sessionId,
                instanceId: instance.instanceId,
                requestedOrientation: orientation,
                driverOrientation: driverViewport.orientation,
              });
            }
            screenMaps.invalidate(instance.instanceId);
            if (mode === 'device' && viewerEncodings.get(instance.instanceId) === 'h264') {
              const nativeDriver = nativeH264Driver(running);
              if (nativeDriver) {
                const fallbackProfile = streamProfiles.get(instance.instanceId) ?? {
                  framesPerSecond: 5,
                  jpegQuality: 25,
                  scalingPercent: 50,
                };
                const nativeProfile = nativeViewerProfile(instance.instanceId, fallbackProfile);
                h264FramePump.setVisible({
                  instanceId: instance.instanceId,
                  generation: instance.generation,
                  driver: nativeDriver,
                  profile: {
                    encoding: 'h264',
                    framesPerSecond: nativeProfile.framesPerSecond,
                    scalingPercent: nativeProfile.scalingPercent,
                    orientation,
                  },
                  visible: true,
                });
              }
            }
            return { mode, viewport };
          });
          return {
            ok: true,
            data: {
              interaction: 'set_orientation',
              orientation,
              ...rotation,
            },
          };
        }
        if (name === 'set_appearance') {
          const route = readMutationRoute(sessionId, args);
          const appearance = readString(args, 'appearance');
          if (appearance !== 'light' && appearance !== 'dark') {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'appearance must be light or dark',
            );
          }
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setAppearance) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator appearance control is unavailable on this host.',
              );
            }
            await lifecycle.setAppearance(instance.simulatorUdid, appearance, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_appearance', appearance } };
        }
        if (name === 'set_increase_contrast') {
          const route = readMutationRoute(sessionId, args);
          const enabled = args.enabled;
          if (typeof enabled !== 'boolean') {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'enabled must be a boolean');
          }
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setIncreaseContrast) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator Increase Contrast control is unavailable on this host.',
              );
            }
            await lifecycle.setIncreaseContrast(instance.simulatorUdid, enabled, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_increase_contrast', enabled } };
        }
        if (name === 'set_content_size') {
          const route = readMutationRoute(sessionId, args);
          const contentSize = readString(args, 'contentSize') as IOSSimulatorContentSize;
          const validContentSizes = new Set<IOSSimulatorContentSize>([
            'extra-small',
            'small',
            'medium',
            'large',
            'extra-large',
            'extra-extra-large',
            'extra-extra-extra-large',
            'accessibility-medium',
            'accessibility-large',
            'accessibility-extra-large',
            'accessibility-extra-extra-large',
            'accessibility-extra-extra-extra-large',
          ]);
          if (!validContentSizes.has(contentSize)) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'contentSize is invalid');
          }
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setContentSize) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator Dynamic Type control is unavailable on this host.',
              );
            }
            await lifecycle.setContentSize(instance.simulatorUdid, contentSize, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_content_size', contentSize } };
        }
        if (name === 'set_location') {
          const route = readMutationRoute(sessionId, args);
          const latitude = readBoundedFinite(args, 'latitude', -90, 90);
          const longitude = readBoundedFinite(args, 'longitude', -180, 180);
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setLocation) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator location control is unavailable on this host.',
              );
            }
            await lifecycle.setLocation(instance.simulatorUdid, latitude, longitude, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_location', latitude, longitude } };
        }
        if (name === 'start_location_route') {
          const route = readMutationRoute(sessionId, args);
          const rawWaypoints = args.waypoints;
          if (!Array.isArray(rawWaypoints) || rawWaypoints.length < 2 || rawWaypoints.length > 64) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'waypoints must contain between 2 and 64 points',
            );
          }
          const waypoints = rawWaypoints.map((value, index) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new IOSSimulatorInstanceError(
                'INVALID_ARGUMENT',
                `waypoint ${index} must be an object`,
              );
            }
            const point = value as Record<string, unknown>;
            return {
              latitude: readBoundedFinite(point, 'latitude', -90, 90),
              longitude: readBoundedFinite(point, 'longitude', -180, 180),
            };
          });
          const speedMetersPerSecond =
            args.speedMetersPerSecond === undefined
              ? undefined
              : readPositiveFinite(args, 'speedMetersPerSecond', 10_000);
          const intervalSeconds =
            args.intervalSeconds === undefined
              ? undefined
              : readPositiveFinite(args, 'intervalSeconds', 86_400);
          const distanceMeters =
            args.distanceMeters === undefined
              ? undefined
              : readPositiveFinite(args, 'distanceMeters', 10_000_000);
          if (intervalSeconds !== undefined && distanceMeters !== undefined) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'intervalSeconds and distanceMeters cannot be used together',
            );
          }
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.startLocationRoute) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator location route control is unavailable on this host.',
              );
            }
            await lifecycle.startLocationRoute(
              instance.simulatorUdid,
              {
                waypoints,
                speedMetersPerSecond,
                intervalSeconds,
                distanceMeters,
              } satisfies IOSSimulatorLocationRouteOptions,
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
          });
          return {
            ok: true,
            data: { interaction: 'start_location_route', waypointCount: waypoints.length },
          };
        }
        if (name === 'clear_location') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.clearLocation) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator location control is unavailable on this host.',
              );
            }
            await lifecycle.clearLocation(instance.simulatorUdid, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'clear_location' } };
        }
        if (name === 'set_privacy') {
          const route = readMutationRoute(sessionId, args);
          const action = readString(args, 'action');
          const service = readString(args, 'service');
          const bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : undefined;
          if (!['grant', 'revoke', 'reset'].includes(action)) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'privacy action is invalid');
          }
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'privacy service is invalid');
          }
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setPrivacy) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator privacy control is unavailable on this host.',
              );
            }
            await lifecycle.setPrivacy(
              instance.simulatorUdid,
              action as 'grant' | 'revoke' | 'reset',
              service,
              bundleId,
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
          });
          return {
            ok: true,
            data: { interaction: 'set_privacy', action, service, bundleId: bundleId ?? null },
          };
        }
        if (name === 'push_notification') {
          const route = readMutationRoute(sessionId, args);
          const bundleId = readString(args, 'bundleId');
          const payload = readObject(args, 'payload');
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.pushNotification) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator push notification control is unavailable on this host.',
              );
            }
            await lifecycle.pushNotification(instance.simulatorUdid, bundleId, payload, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return {
            ok: true,
            data: { interaction: 'push_notification', bundleId, delivered: true },
          };
        }
        if (name === 'set_status_bar') {
          const route = readMutationRoute(sessionId, args);
          const overrides = {
            ...(typeof args.time === 'string' ? { time: args.time } : {}),
            ...(typeof args.dataNetwork === 'string' ? { dataNetwork: args.dataNetwork } : {}),
            ...(typeof args.wifiMode === 'string' ? { wifiMode: args.wifiMode } : {}),
            ...(typeof args.wifiBars === 'number' ? { wifiBars: args.wifiBars } : {}),
            ...(typeof args.cellularMode === 'string' ? { cellularMode: args.cellularMode } : {}),
            ...(typeof args.cellularBars === 'number' ? { cellularBars: args.cellularBars } : {}),
            ...(typeof args.operatorName === 'string' ? { operatorName: args.operatorName } : {}),
            ...(typeof args.batteryState === 'string' ? { batteryState: args.batteryState } : {}),
            ...(typeof args.batteryLevel === 'number' ? { batteryLevel: args.batteryLevel } : {}),
          } as IOSSimulatorStatusBarOverrides;
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setStatusBar) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator status-bar control is unavailable on this host.',
              );
            }
            await lifecycle.setStatusBar(instance.simulatorUdid, overrides, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_status_bar', overrides } };
        }
        if (name === 'clear_status_bar') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (!lifecycle.clearStatusBar) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator status-bar control is unavailable on this host.',
              );
            }
            await lifecycle.clearStatusBar(instance.simulatorUdid, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'clear_status_bar' } };
        }
        if (name === 'lock_screen' || name === 'unlock_screen') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            if (name === 'lock_screen') {
              await running.driver.lock(running.driverSessionId, signal);
            } else {
              await running.driver.unlock(running.driverSessionId, signal);
            }
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: name, screenMapInvalidated: true } };
        }
        if (name === 'build_app') {
          // Revalidate immediately before registering the build. The shared
          // ownership reconciliation above can yield long enough for the task
          // to be archived and its worktree recycled. There must be no await
          // between this check and beginBuild: if archival wins first this
          // call fails closed; if beginBuild wins first archival observes and
          // cancels the registered operation.
          const buildAdmissionEpoch = sessionOperationAdmissionEpochs.get(sessionId) ?? 0;
          const buildSession = await resolveSession(sessionId);
          if (!buildSession.ok) return buildSession;
          assertHostActive();
          const route = readMutationRoute(buildSession.sessionId, args);
          const instance = actor.assertRoute(route);
          const activeBuild = beginBuild(instance, buildAdmissionEpoch);
          const derivedDataPath = path.join(
            app.getPath('userData'),
            'ios-simulator',
            'projects',
            createHash('sha256').update(instance.instanceId).digest('hex').slice(0, 20),
          );
          try {
            let built: IOSSimulatorProjectBuildResult;
            try {
              built = await projectBuilder.build({
                worktreeRoot: instance.worktreeRoot,
                derivedDataPath,
                containerPath: readOptionalString(args, 'containerPath', 4_096),
                scheme: typeof args.scheme === 'string' ? args.scheme : undefined,
                signal: activeBuild.controller.signal,
              });
            } catch (error) {
              if (disposePromise) {
                await discardManagedBuildResultBundle(
                  error instanceof IOSSimulatorProjectBuildError ? error.resultBundlePath : null,
                );
                throw new IOSSimulatorHostDisposedError();
              }
              if (activeBuild.controller.signal.aborted) {
                throw new IOSSimulatorInstanceError(
                  'MUTATION_CANCELLED',
                  'The app build was cancelled because its simulator session ended.',
                  true,
                );
              }
              if (!(error instanceof IOSSimulatorProjectBuildError)) throw error;
              const diagnostics = await storeBuildDiagnostics({
                sessionId: instance.sessionId,
                instanceId: instance.instanceId,
                logTail: error.buildLogTail,
                resultBundlePath: error.resultBundlePath,
                outputTruncated: error.outputTruncated,
              });
              return buildFailureWithDiagnostics(error, sessionId, diagnostics);
            }
            if (disposePromise) {
              await discardManagedBuildResultBundle(built.resultBundlePath ?? null);
              throw new IOSSimulatorHostDisposedError();
            }
            if (activeBuild.controller.signal.aborted) {
              await discardManagedBuildResultBundle(built.resultBundlePath ?? null);
              throw new IOSSimulatorInstanceError(
                'MUTATION_CANCELLED',
                'The app build was cancelled because its simulator session ended.',
                true,
              );
            }
            actor.assertRoute(route);
            const diagnostics = await storeBuildDiagnostics({
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              logTail: built.buildLogTail ?? '',
              resultBundlePath: built.resultBundlePath ?? null,
              outputTruncated: built.outputTruncated,
            });
            assertHostActive();
            let artifact: IOSSimulatorAppArtifact;
            try {
              try {
                artifact = await appLifecycle.inspectArtifact(
                  instance.worktreeRoot,
                  built.appPath,
                  undefined,
                  activeBuild.controller.signal,
                );
              } catch (error) {
                if (
                  !(error instanceof IOSSimulatorInstanceError) ||
                  error.code !== 'APP_ARTIFACT_INVALID'
                ) {
                  throw error;
                }
                artifact = await appLifecycle.inspectArtifact(
                  instance.worktreeRoot,
                  built.appPath,
                  derivedDataPath,
                  activeBuild.controller.signal,
                );
              }
            } catch (error) {
              if (disposePromise || error instanceof IOSSimulatorHostDisposedError) {
                throw new IOSSimulatorHostDisposedError();
              }
              return buildFailureWithDiagnostics(error, sessionId, diagnostics);
            }
            assertHostActive();
            if (activeBuild.controller.signal.aborted) {
              throw new IOSSimulatorInstanceError(
                'MUTATION_CANCELLED',
                'The app build was cancelled because its simulator session ended.',
                true,
              );
            }
            actor.assertRoute(route);
            appArtifacts.set(artifact.artifactId, {
              instanceId: instance.instanceId,
              projectKind: built.kind,
              artifact,
            });
            return {
              ok: true,
              data: {
                artifact: {
                  artifactId: artifact.artifactId,
                  bundleId: artifact.bundleId,
                  projectKind: built.kind,
                  scheme: built.scheme,
                  createdAt: artifact.createdAt,
                },
                diagnostics,
              },
            };
          } finally {
            finishBuild(instance.instanceId, activeBuild);
          }
        }
        if (name === 'read_build_diagnostics') {
          const diagnosticsId = readString(args, 'diagnosticsId');
          const source = readString(args, 'source');
          const offset = args.offset === undefined ? 0 : readNonNegativeInteger(args, 'offset');
          const limit = args.limit === undefined ? 16 * 1024 : readPositiveInteger(args, 'limit');
          if (limit > 64 * 1024) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'limit must be at most 65536');
          }
          const diagnostic = buildDiagnostics.get(diagnosticsId);
          if (!diagnostic || diagnostic.sessionId !== sessionId) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The build diagnostics entry does not exist or has expired.',
            );
          }
          if (Date.now() - diagnostic.createdAt > BUILD_DIAGNOSTICS_TTL_MS) {
            await removeBuildDiagnostic(diagnosticsId, diagnostic);
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The build diagnostics entry does not exist or has expired.',
            );
          }
          let text = diagnostic.logTail;
          if (source === 'xcresult') {
            if (!diagnostic.resultBundlePath || !projectBuilder.readXcresult) {
              return {
                ok: true,
                data: {
                  diagnosticsId,
                  source,
                  offset,
                  limit,
                  text: '',
                  eof: true,
                  available: false,
                },
              };
            }
            let xcresultText = diagnostic.xcresultText;
            if (xcresultText === null) {
              const readXcresult = projectBuilder.readXcresult.bind(projectBuilder);
              const readOperation = (async (): Promise<string> => {
                buildDiagnosticReaders.set(
                  diagnosticsId,
                  (buildDiagnosticReaders.get(diagnosticsId) ?? 0) + 1,
                );
                try {
                  const rawXcresult = await readXcresult(
                    diagnostic.resultBundlePath!,
                    undefined,
                    buildDiagnosticReadExitController.signal,
                  );
                  if (buildDiagnosticReadExitController.signal.aborted) {
                    throw new IOSSimulatorInstanceError(
                      'MUTATION_CANCELLED',
                      'The Xcode result bundle read was cancelled because the simulator host is shutting down.',
                      true,
                    );
                  }
                  assertHostActive();
                  const publicXcresult = publicBuildText(rawXcresult);
                  diagnostic.xcresultText = publicXcresult;
                  return publicXcresult;
                } finally {
                  await releaseBuildDiagnosticReader(diagnosticsId);
                }
              })();
              activeBuildDiagnosticReads.add(readOperation);
              try {
                xcresultText = await readOperation;
              } finally {
                activeBuildDiagnosticReads.delete(readOperation);
              }
            }
            text = xcresultText;
          } else if (source !== 'build-log') {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'source must be build-log or xcresult',
            );
          }
          const chunk = text.slice(offset, offset + limit);
          return {
            ok: true,
            data: {
              diagnosticsId,
              source,
              offset,
              limit,
              text: chunk,
              nextOffset: offset + chunk.length,
              eof: offset + chunk.length >= text.length,
              available: true,
            },
          };
        }
        if (name === 'install_app') {
          const route = readMutationRoute(sessionId, args);
          const artifactId = readString(args, 'artifactId');
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            await appLifecycle.installExact(
              instance.simulatorUdid,
              requireArtifact(instance, artifactId),
              signal,
            );
          });
          return { ok: true, data: { artifactId, installed: true } };
        }
        if (name === 'launch_app') {
          const route = readMutationRoute(sessionId, args);
          const artifactId = readString(args, 'artifactId');
          const launchArgs = args.args;
          if (!Array.isArray(launchArgs) || launchArgs.some((value) => typeof value !== 'string')) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'args must be a string array');
          }
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const stored = appArtifacts.get(artifactId);
            if (stored?.projectKind === 'cindy-mobile' && projectBuilder.validateLaunch) {
              await projectBuilder.validateLaunch(
                stored.artifact.worktreeRoot,
                instance.simulatorUdid,
                signal,
              );
            }
            await appLifecycle.launchExact(
              instance.simulatorUdid,
              requireArtifact(instance, artifactId),
              launchArgs,
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
          });
          requestViewerFocus(sessionId, route.instanceId);
          return { ok: true, data: { artifactId, launched: true } };
        }
        if (name === 'terminate_app') {
          const route = readMutationRoute(sessionId, args);
          const artifactId = readString(args, 'artifactId');
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const artifact = requireArtifact(instance, artifactId);
            await appLifecycle.terminateExact(instance.simulatorUdid, artifact.bundleId, signal);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { artifactId, terminated: true } };
        }
        if (name === 'open_url') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            await appLifecycle.openUrlExact(
              instance.simulatorUdid,
              readString(args, 'url'),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { opened: true } };
        }
        if (name === 'take_screenshot') {
          const screenshotAdmissionEpoch = sessionOperationAdmissionEpochs.get(sessionId) ?? 0;
          const screenshotSession = await resolveSession(sessionId);
          if (!screenshotSession.ok) return screenshotSession;
          assertHostActive();
          const route = readMutationRoute(screenshotSession.sessionId, args);
          const screenshotInstanceEpoch = captureInstanceOperationAdmission(
            route.instanceId,
            'screenshot',
          );
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            assertSessionOperationAdmission(
              instance.sessionId,
              screenshotAdmissionEpoch,
              'screenshot',
            );
            assertInstanceOperationAdmission(
              instance.instanceId,
              screenshotInstanceEpoch,
              'screenshot',
            );
            return mediaCapture.takeScreenshot({
              simulatorUdid: instance.simulatorUdid,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              source: context?.origin === 'user' ? 'user' : 'agent',
              signal,
            });
          });
          return {
            ok: true,
            data: {
              mediaUrl: captured.url,
              xdt_image_url: captured.url,
              mimeType: captured.mimeType,
              bytes: captured.bytes,
              refIds: captured.refIds,
            },
          };
        }
        if (name === 'capture_visual_baseline') {
          const route = readMutationRoute(sessionId, args);
          const baseline = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (typeof mediaCapture.captureScreenshotBytes !== 'function') {
              throw new IOSSimulatorInstanceError(
                'SCREENSHOT_CAPTURE_FAILED',
                'Visual screenshot baselines are unavailable on this host.',
              );
            }
            const bytes = await mediaCapture.captureScreenshotBytes({
              simulatorUdid: instance.simulatorUdid,
              signal,
            });
            const baselineId = randomUUID();
            while (visualBaselines.size >= 4) {
              const oldest = visualBaselines.keys().next().value;
              if (typeof oldest !== 'string') break;
              visualBaselines.delete(oldest);
            }
            visualBaselines.set(baselineId, {
              baselineId,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              generation: instance.generation,
              capturedAt: new Date().toISOString(),
              bytes,
            });
            return {
              baselineId,
              instanceId: instance.instanceId,
              generation: instance.generation,
              bytes: bytes.byteLength,
            };
          });
          return { ok: true, data: baseline };
        }
        if (name === 'visual_diff') {
          const route = readMutationRoute(sessionId, args);
          const baselineId = readString(args, 'baselineId');
          const baseline = visualBaselines.get(baselineId);
          if (
            !baseline ||
            baseline.sessionId !== sessionId ||
            baseline.instanceId !== route.instanceId ||
            baseline.generation !== route.generation
          ) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The visual baseline does not belong to this simulator generation.',
            );
          }
          const threshold =
            args.threshold === undefined ? 16 : readNonNegativeInteger(args, 'threshold');
          if (threshold > 255) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'threshold must be between 0 and 255',
            );
          }
          const diff = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            if (typeof mediaCapture.captureScreenshotBytes !== 'function') {
              throw new IOSSimulatorInstanceError(
                'SCREENSHOT_CAPTURE_FAILED',
                'Visual screenshot comparison is unavailable on this host.',
              );
            }
            const current = await mediaCapture.captureScreenshotBytes({
              simulatorUdid: instance.simulatorUdid,
              signal,
            });
            return compareIOSSimulatorPngBuffers(baseline.bytes, current, threshold);
          });
          return { ok: true, data: { baselineId, diff } };
        }
        if (name === 'capture_state') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const [health, orientation, accessibility] = await Promise.all([
              running.driver.probe(signal),
              running.driver.getOrientation(running.driverSessionId, signal),
              running.driver.getAccessibilityTree(running.driverSessionId, signal),
            ]);
            const screenMap = screenMaps.capture({
              instanceId: instance.instanceId,
              generation: instance.generation,
              capturedAt: accessibility.capturedAt,
              tree: accessibility.tree,
            });
            const stream = framePump.snapshot(instance.instanceId);
            const driverDiagnostics = getDriverManager().diagnostics?.(instance.instanceId) ?? {
              running: true,
              logTail: '',
            };
            return {
              instance: publicInstance(instance),
              health,
              orientation,
              screenMap,
              stream: stream
                ? {
                    instanceId: stream.instanceId,
                    generation: stream.generation,
                    state: stream.state,
                    reconnectAttempt: stream.reconnectAttempt,
                    latestFrame: stream.latestFrame
                      ? {
                          sequence: stream.latestFrame.sequence,
                          receivedAt: stream.latestFrame.receivedAt,
                          bytes: stream.latestFrame.bytes.byteLength,
                        }
                      : null,
                  }
                : null,
              driverDiagnostics: {
                running: driverDiagnostics.running,
                logTail: publicDriverLogTail(driverDiagnostics.logTail),
                capabilityReport: driverDiagnostics.capabilityReport ?? null,
                nativeSidecar: publicNativeSidecarDiagnostics(driverDiagnostics.nativeSidecar),
              },
            };
          });
          const diagnostics = diagnosticsStore.record(sessionId, 'capture_state', captured);
          return {
            ok: true,
            data: { ...captured, diagnosticsId: diagnostics.diagnosticsId },
          };
        }
        if (name === 'get_diagnostics') {
          const diagnosticsId = readString(args, 'diagnosticsId');
          const entry = diagnosticsStore.get(sessionId, diagnosticsId);
          if (!entry) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The diagnostics entry does not exist or has expired.',
            );
          }
          return { ok: true, data: { diagnostics: entry } };
        }
        if (name === 'start_recording') {
          // Revalidate immediately before the actor queue, then check the
          // task lifecycle epoch again at the synchronous media-registration
          // boundary. If cancellation wins first, registration is denied; if
          // registration wins first, discardSession is queued behind it.
          const recordingAdmissionEpoch = sessionOperationAdmissionEpochs.get(sessionId) ?? 0;
          const recordingSession = await resolveSession(sessionId);
          if (!recordingSession.ok) return recordingSession;
          assertHostActive();
          const route = readMutationRoute(recordingSession.sessionId, args);
          const recordingInstanceEpoch = captureInstanceOperationAdmission(
            route.instanceId,
            'screen recording',
          );
          const recording = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            assertSessionOperationAdmission(
              instance.sessionId,
              recordingAdmissionEpoch,
              'screen recording',
            );
            assertInstanceOperationAdmission(
              instance.instanceId,
              recordingInstanceEpoch,
              'screen recording',
            );
            return mediaCapture.startRecording({
              simulatorUdid: instance.simulatorUdid,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              generation: instance.generation,
              source: context?.origin === 'user' ? 'user' : 'agent',
            });
          });
          return { ok: true, data: recording };
        }
        if (name === 'stop_recording') {
          const route = readMutationRoute(sessionId, args);
          const recordingId = readString(args, 'recordingId');
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            return mediaCapture.stopRecording({
              recordingId,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              generation: instance.generation,
            });
          });
          return {
            ok: true,
            data: {
              recordingId,
              mediaUrl: captured.url,
              xdt_video_url: captured.url,
              mimeType: captured.mimeType,
              bytes: captured.bytes,
              refIds: captured.refIds,
            },
          };
        }

        const environment = await inspectRuntime();
        assertHostActive();
        if (name === 'check_environment') {
          return { ok: true, data: publicEnvironment(environment) };
        }
        if (name === 'doctor') {
          const availability = await describeToolsForSession(sessionId, environment);
          const instances = actor.list(sessionId).map((instance) => {
            const driver = getDriverManager().get(instance.instanceId);
            const diagnostics = getDriverManager().diagnostics?.(instance.instanceId);
            return {
              instance: publicInstance(instance),
              running: Boolean(driver),
              mutation: actor.mutationState(instance.instanceId),
              capabilityReport: diagnostics?.capabilityReport ?? null,
              nativeSidecar: publicNativeSidecarDiagnostics(diagnostics?.nativeSidecar),
              logTail: publicDriverLogTail(diagnostics?.logTail ?? ''),
            };
          });
          const recommendedActions: string[] = [];
          if (!environment.ready) recommendedActions.push('check_environment');
          if (environment.ready && instances.length === 0) {
            // Advertised names only: a recommendation the model cannot find in
            // list_tools sends it back to the ambiguous superseded name.
            recommendedActions.push(
              'list_simulator_devices',
              'create_instance_or_attach_device',
            );
          }
          if (instances.some((entry) => !entry.running)) recommendedActions.push('start_instance');
          if (
            instances.some(
              (entry) =>
                entry.running && entry.capabilityReport?.routes.continuousInput.fallback === true,
            )
          ) {
            recommendedActions.push('continue_with_wda_mjpeg_fallback');
          }
          return {
            ok: true,
            data: {
              environment: publicEnvironment(environment),
              availability,
              resource: resourceScheduler.snapshot(),
              instances,
              recommendedActions,
            },
          };
        }
        if (!environment.ready) {
          const safeEnvironment = publicEnvironment(environment);
          return {
            ok: false,
            errorCode: environment.issue ?? 'IOS_SIMULATOR_HOST_ERROR',
            message: safeEnvironment.error ?? 'iOS Simulator is not ready.',
            data: { environment: safeEnvironment },
          };
        }
        if (name === 'list_devices') {
          return {
            ok: true,
            data: {
              devices: publicEnvironment(environment).devices,
              xcodeVersion: environment.xcodeVersion,
            },
          };
        }
        if (name === 'create_instance') {
          const templateUdid = readString(args, 'templateUdid').toUpperCase();
          const templateDevice = environment.devices.find(
            (candidate) => candidate.udid.toUpperCase() === templateUdid,
          );
          if (!templateDevice || !templateDevice.isAvailable) {
            throw new IOSSimulatorInstanceError(
              'SIMULATOR_NOT_FOUND',
              'The selected template simulator does not exist or is unavailable.',
            );
          }
          assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
          const worktreeRoot = await resolveWorktreeRoot(resolved.session.workDir);
          assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
          const instance = await actor.create({
            sessionId,
            worktreeRoot,
            sourceFingerprint: sourceFingerprint(worktreeRoot),
            name: readString(args, 'name'),
            templateDevice,
          });
          assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
          if (context?.origin === 'agent') {
            agentControlLeases.set(instance.instanceId, sessionId);
          }
          return { ok: true, data: instanceData(instance) };
        }
        if (name === 'attach_device') {
          const udid = readString(args, 'udid').toUpperCase();
          const device = environment.devices.find(
            (candidate) => candidate.udid.toUpperCase() === udid,
          );
          if (!device || !device.isAvailable) {
            throw new IOSSimulatorInstanceError(
              'SIMULATOR_NOT_FOUND',
              'The selected iOS Simulator device does not exist or is unavailable.',
            );
          }
          const existingInstance = actor
            .listAll()
            .find((candidate) => candidate.simulatorUdid.toUpperCase() === udid);
          const existingActivationEpoch = existingInstance
            ? captureInstanceActivation(existingInstance.instanceId)
            : null;
          const attach = async (): Promise<IOSSimulatorHostResult> => {
            assertHostActive();
            assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
            const worktreeRoot = await resolveWorktreeRoot(resolved.session.workDir);
            assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
            const instance = await actor.attachSerialized({
              sessionId,
              worktreeRoot,
              sourceFingerprint: sourceFingerprint(worktreeRoot),
              device,
              creationProvenance: 'external',
              bootProvenance:
                device.state.toLowerCase() === 'booted' ? 'preexisting' : 'user-booted',
            });
            assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
            const activationEpoch =
              existingInstance?.instanceId === instance.instanceId &&
              existingActivationEpoch !== null
                ? existingActivationEpoch
                : captureInstanceActivation(instance.instanceId);
            if (instance.lifecycleState === 'ready') {
              await resourceScheduler.runStart(instance.instanceId, async (commitRunning) => {
                assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
                commitRunning();
                assertInstanceActivation(instance.instanceId, activationEpoch);
                await ensureDriver(instance, environment);
                assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
              });
            }
            assertSessionRemovalAdmission(sessionId, removalBarrierOperation);
            const current = actor.getOwned(sessionId, instance.instanceId);
            completeInstanceActivation(current, activationEpoch);
            if (context?.origin === 'agent') {
              agentControlLeases.set(instance.instanceId, sessionId);
            }
            releaseViewerTouches(instance.instanceId);
            screenMaps.clear(instance.instanceId);
            framePump.clear(instance.instanceId);
            h264FramePump.clear(instance.instanceId);
            viewerEncodings.delete(instance.instanceId);
            viewerPreferredEncodings.delete(instance.instanceId);
            viewerFallbackReasons.delete(instance.instanceId);
            viewerSessions.delete(instance.instanceId);
            viewerVisibilityIntents.delete(instance.instanceId);
            clearViewportState(instance.instanceId);
            return {
              ok: true,
              data: instanceData(current),
            };
          };
          return await attach();
        }
        return {
          ok: false,
          errorCode: 'IOS_SIMULATOR_HOST_ERROR',
          message: `Unknown iOS Simulator tool: ${String(name)}`,
        };
      } catch (error) {
        if (error instanceof IOSSimulatorHostDisposedError) return hostDisposedResult();
        return safeHostError(error, sessionId, name);
      } finally {
        removalBarrierOperation?.finish();
      }
    },
    cancelSessionOperations(sessionId) {
      const normalizedSessionId = sessionId.trim();
      return Promise.all([
        actor.cancelLifecycleStartsForSession(normalizedSessionId),
        actor.cancelMutationsForSession(normalizedSessionId),
        cancelSessionBuildsAndRecordings(normalizedSessionId),
      ]).then(() => undefined);
    },
    cleanupRemovedSession(sessionId) {
      return cleanupRemovedSessionRuntime(sessionId);
    },
    abortOperationsForExit() {
      void abortPendingCreateReconciliation();
      runtimeInspectionExitController.abort();
      buildDiagnosticReadExitController.abort();
      try {
        actor.abortOperationsForExit();
      } catch (error) {
        logger.warn('iOS Simulator exit cleanup could not abort simulator operations', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const build of activeBuilds.values()) {
        try {
          build.controller.abort();
        } catch (error) {
          logger.warn('iOS Simulator exit cleanup could not abort an app build', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        mediaCapture.abortOperationsForExit?.();
      } catch (error) {
        logger.warn('iOS Simulator exit cleanup could not abort media capture', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        driverManager?.abortOperationsForExit?.();
      } catch (error) {
        logger.warn('iOS Simulator exit cleanup could not abort driver processes', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        const pendingCreateReconciliation = abortPendingCreateReconciliation();
        runtimeInspectionExitController.abort();
        buildDiagnosticReadExitController.abort();
        const buildDiagnosticReads = [...activeBuildDiagnosticReads];
        actor.abortOperationsForExit();
        const lifecycleStarts = actor.cancelAllLifecycleStarts();
        const mutations = actor.cancelAllMutations();
        const builds = [...activeBuilds.values()];
        for (const build of builds) build.controller.abort();
        // Close the recording start gate immediately, before waiting for a
        // potentially slow xcodebuild process to acknowledge cancellation.
        const mediaDispose = mediaCapture.dispose?.().catch((error) => {
          logger.warn('iOS Simulator dispose could not close media capture', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        await Promise.all([
          pendingCreateReconciliation,
          lifecycleStarts,
          mutations,
          ...builds.map((build) => build.settled),
          Promise.allSettled(buildDiagnosticReads).then(() => undefined),
        ]);
        clearVisualBaselines();
        await Promise.all(
          [...buildDiagnostics.entries()].map(([diagnosticsId, diagnostic]) =>
            removeBuildDiagnostic(diagnosticsId, diagnostic),
          ),
        );
        appArtifacts.clear();
        for (const timer of idleRecycleTimers.values()) clearTimeout(timer);
        idleRecycleTimers.clear();
        const instances = actor.listAll();
        await mediaDispose;
        await Promise.all(
          instances.map(async (instance) => {
            releaseViewerTouches(instance.instanceId);
            if (!mediaCapture.dispose) {
              await mediaCapture.discardInstance(instance.instanceId).catch((error) => {
                logger.warn('iOS Simulator dispose could not discard recording', {
                  instanceId: instance.instanceId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }
            if (driverManager) {
              await driverManager.stop(instance.instanceId).catch((error) => {
                logger.warn('iOS Simulator dispose could not stop WDA', {
                  instanceId: instance.instanceId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }
            screenMaps.clear(instance.instanceId);
            framePump.clear(instance.instanceId);
            h264FramePump.clear(instance.instanceId);
            viewerEncodings.delete(instance.instanceId);
            viewerPreferredEncodings.delete(instance.instanceId);
            viewerFallbackReasons.delete(instance.instanceId);
            viewerSessions.delete(instance.instanceId);
            clearViewportState(instance.instanceId);
            streamProfiles.delete(instance.instanceId);
            nativeStreamProfiles.delete(instance.instanceId);
          }),
        );
        activeViewerTouches.clear();
        viewerSessions.clear();
        viewerVisibilityIntents.clear();
        routeStatusCache.clear();
        pluginEnvironmentCache = null;
      })();
      return disposePromise;
    },
  };
}

interface DefaultIOSSimulatorRuntime {
  host: IOSSimulatorHost;
  flushRegistry(): Promise<void>;
  releaseRegistry(): void;
  releaseExitAbortHandler(): void;
}

let defaultIOSSimulatorRuntime: DefaultIOSSimulatorRuntime | null = null;
let defaultIOSSimulatorRuntimeClosing = false;
let defaultIOSSimulatorRuntimeDisposePromise: Promise<void> | null = null;
let passivePluginRuntime: IOSSimulatorRuntime | null = null;
let passivePluginEnvironmentCache: {
  expiresAt: number;
  value: GhostIOSSimulatorStatusSnapshot['environment'];
} | null = null;
let passivePluginEnvironmentInFlight: Promise<
  GhostIOSSimulatorStatusSnapshot['environment']
> | null = null;

async function readPassivePluginEnvironment(): Promise<
  GhostIOSSimulatorStatusSnapshot['environment']
> {
  const now = Date.now();
  if (passivePluginEnvironmentCache && passivePluginEnvironmentCache.expiresAt > now) {
    return passivePluginEnvironmentCache.value;
  }
  if (passivePluginEnvironmentInFlight) return passivePluginEnvironmentInFlight;
  passivePluginRuntime ??= createIOSSimulatorRuntime();
  passivePluginEnvironmentInFlight = passivePluginRuntime.inspect().then((environment) => {
    const value = projectPluginEnvironment(environment);
    passivePluginEnvironmentCache = {
      value,
      expiresAt: Date.now() + PLUGIN_ENVIRONMENT_CACHE_MS,
    };
    return value;
  });
  try {
    return await passivePluginEnvironmentInFlight;
  } finally {
    passivePluginEnvironmentInFlight = null;
  }
}

async function readPassiveIOSSimulatorPluginStatus(
  sessionId: string,
  options: IOSSimulatorPluginStatusReadOptions,
): Promise<GhostIOSSimulatorStatusProbeResult> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return {
      ok: false,
      errorCode: 'SESSION_CONTEXT_REQUIRED',
      message: 'A Cindy session is required.',
    };
  }
  try {
    const getOwnerScopeKey = options.getOwnerScopeKey ?? activeOwnerScopeKey;
    const isOwnerBoundaryPending =
      options.isOwnerBoundaryPending ?? isAppSessionBoundaryPending;
    const isHostClosing =
      options.isHostClosing ?? (() => defaultIOSSimulatorRuntimeClosing);
    if (isHostClosing() || isOwnerBoundaryPending()) {
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      };
    }
    const ownerScopeKey = getOwnerScopeKey();
    const getSession =
      options.getSession ??
      (async (id: string) => {
        const session = await desktopSessionStorage.get(id);
        if (!session) return null;
        return {
          ...session,
          status: await desktopSessionStorage.getStatus(id),
        };
      });
    const session = await getSession(normalizedSessionId);
    if (
      isHostClosing() ||
      isOwnerBoundaryPending() ||
      getOwnerScopeKey() !== ownerScopeKey
    ) {
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      };
    }
    if (!session || (session.status && session.status !== 'active')) {
      return {
        ok: false,
        errorCode: 'SESSION_NOT_FOUND',
        message: 'The Cindy session no longer exists.',
      };
    }
    if (session.remoteHostId) {
      return {
        ok: false,
        errorCode: 'UNSUPPORTED_SESSION_KIND',
        message: 'SSH and remote sessions cannot access simulators on this Mac.',
      };
    }
    const environment = options.inspectEnvironment
      ? projectPluginEnvironment(await options.inspectEnvironment())
      : await readPassivePluginEnvironment();
    if (
      isHostClosing() ||
      isOwnerBoundaryPending() ||
      getOwnerScopeKey() !== ownerScopeKey
    ) {
      return {
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      };
    }
    return {
      ok: true,
      status: {
        environment,
        // Without an in-process Host there is no controllable task ownership
        // or live route state to project. Never claim another process's
        // persisted instances merely to satisfy a passive plugin probe.
        instances: [],
        routeStatuses: [],
      },
    };
  } catch (error) {
    logger.warn('Passive iOS Simulator plugin status snapshot failed', {
      sessionId: normalizedSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator status is temporarily unavailable.',
    };
  }
}

function installDefaultIOSSimulatorHost(
  lifecycle: IOSSimulatorSimctlLifecycle,
  persistedActor: ReturnType<typeof createDefaultActor>,
  registry: IOSSimulatorOwnershipRegistryFile,
  pendingCreateEvidence: IOSSimulatorPendingCreateEvidenceStore,
): IOSSimulatorHost {
  if (defaultIOSSimulatorRuntime) {
    persistedActor.release();
    return defaultIOSSimulatorRuntime.host;
  }
  if (defaultIOSSimulatorRuntimeClosing) {
    persistedActor.release();
    throw new Error('The iOS Simulator host is shutting down.');
  }

  let releaseExitAbortHandler: (() => void) | null = null;
  try {
    const host = createIOSSimulatorHost({
      lifecycle,
      actor: persistedActor.actor,
      grantStore: createRegistryBackedIOSSimulatorDeviceGrantStore(registry),
      canReconcilePendingCreates: persistedActor.canReconcilePendingCreates,
      pendingCreateEvidence,
      driverManager: createDefaultDriverManager(),
    });
    configureIOSSimulatorRendererAccessRevocationObserver((grants) => {
      for (const grant of grants) {
        host.revokeRendererViewer(grant.sessionId, grant.target.id);
      }
    });
    releaseExitAbortHandler = registerIOSSimulatorExitAbortHandler(() => {
      host.abortOperationsForExit();
    });
    defaultIOSSimulatorRuntime = {
      host,
      flushRegistry: persistedActor.flush,
      releaseRegistry: persistedActor.release,
      releaseExitAbortHandler,
    };
    return host;
  } catch (error) {
    configureIOSSimulatorRendererAccessRevocationObserver(null);
    releaseExitAbortHandler?.();
    persistedActor.release();
    throw error;
  }
}

/**
 * The ownership registry holds a process-wide writer lease, so the default
 * Simulator Host must stay lazy. Passive/dev Desktop instances that never use
 * Simulator must not prevent the instance that actually needs it from taking
 * ownership.
 */
export function initializeIOSSimulatorHost(): IOSSimulatorHost {
  if (defaultIOSSimulatorRuntime) return defaultIOSSimulatorRuntime.host;
  if (defaultIOSSimulatorRuntimeClosing) {
    throw new Error('The iOS Simulator host is shutting down.');
  }

  const registry = createDefaultOwnershipRegistry();
  const pendingCreateEvidence = createDefaultPendingCreateEvidence(registry);
  const lifecycle = createProfileScopedIOSSimulatorLifecycle(registry, pendingCreateEvidence);
  const persistedActor = createDefaultActor(lifecycle, registry);
  return installDefaultIOSSimulatorHost(
    lifecycle,
    persistedActor,
    registry,
    pendingCreateEvidence,
  );
}

function currentIOSSimulatorHost(): IOSSimulatorHost | null {
  return defaultIOSSimulatorRuntime?.host ?? null;
}

export function getIOSSimulatorSessionStatus(
  sessionId: string,
): Promise<IOSSimulatorSessionStatus> {
  return initializeIOSSimulatorHost().getStatus(sessionId);
}

export function getIOSSimulatorPluginStatus(
  sessionId: string,
  options: IOSSimulatorPluginStatusReadOptions = {},
): Promise<GhostIOSSimulatorStatusProbeResult> {
  const host = currentIOSSimulatorHost();
  if (host) return host.getPluginStatus(sessionId);
  if (defaultIOSSimulatorRuntimeClosing) {
    return Promise.resolve({
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
  }
  return readPassiveIOSSimulatorPluginStatus(sessionId, options);
}

export function callIOSSimulatorHostTool(
  name: IOSSimulatorMcpToolName,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().callTool(name, args, { sessionId, origin: 'user' });
}

export function setIOSSimulatorAgentControlGrant(
  sessionId: string,
  instanceId: string,
  decision: 'allowed' | 'denied',
  assertElevationCurrent?: () => void,
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().setAgentControlGrant(
    sessionId,
    instanceId,
    decision,
    assertElevationCurrent,
  );
}

export function setIOSSimulatorViewerVisibility(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  visible: boolean,
  preferredEncoding?: 'jpeg' | 'h264',
  fallbackReason?: 'native-decoder-fallback',
  viewerWebContentsId?: number,
  viewerToken?: string,
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().setViewerVisibility(
    sessionId,
    route,
    visible,
    preferredEncoding,
    fallbackReason,
    viewerWebContentsId,
    viewerToken,
  );
}

export function setIOSSimulatorAgentMutationPaused(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  paused: boolean,
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().setAgentMutationPaused(sessionId, route, paused);
}

export function getIOSSimulatorLatestFrame(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  viewerWebContentsId: number,
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().getLatestFrame(sessionId, route, viewerWebContentsId);
}

export async function flushIOSSimulatorOwnershipRegistry(): Promise<void> {
  await defaultIOSSimulatorRuntime?.flushRegistry();
}

export function reconcileIOSSimulatorOwnership(): Promise<void> {
  return initializeIOSSimulatorHost().reconcileOwnership();
}

/**
 * Startup recovery performs one bounded, profile-scoped pending-create sweep
 * when this profile can still hold a create marker — persisted ownership, or an
 * armed interrupted-create breadcrumb — then releases the writer lease without
 * installing the Host. Persisted bindings still install the Host so they are
 * reconciled even if the feature is not opened again after a crash.
 *
 * A profile with neither is provably clean, so startup performs no `xcrun` /
 * CoreSimulator access at all. That keeps macOS Xcode consent prompts attached
 * to the moment the user actually opens the simulator, in the same spirit as
 * the safeStorage probe rule in `docs/dev-rules/credentials-and-local-storage.md`.
 */
export interface IOSSimulatorPersistedOwnershipRecoveryOptions {
  /** Test seam; production always derives a profile-scoped lifecycle. */
  createLifecycle?: (registry: IOSSimulatorOwnershipRegistryFile) => IOSSimulatorSimctlLifecycle;
}

export async function reconcilePersistedIOSSimulatorOwnership(
  options: IOSSimulatorPersistedOwnershipRecoveryOptions = {},
): Promise<void> {
  const currentHost = currentIOSSimulatorHost();
  if (currentHost) return currentHost.reconcileOwnership();
  if (process.platform !== 'darwin') return;

  const registry = createDefaultOwnershipRegistry();
  let registryTransferred = false;
  try {
    if (!registry.acquireWriterSync()) {
      throw new IOSSimulatorInstanceError(
        'DEVICE_BUSY',
        'Another Cindy process is managing iOS Simulator ownership for this profile.',
        true,
      );
    }
    const persistedInstances = registry.loadSync();
    const pendingCreateEvidence = createDefaultPendingCreateEvidence(registry);
    if (persistedInstances.length === 0 && !pendingCreateEvidence.isArmed()) {
      // Nothing owned and no interrupted create: sweeping here would spawn
      // xcrun on a profile that never used the simulator, which is exactly the
      // startup-time Xcode permission prompt users report.
      logger.debug('Skipped iOS Simulator startup recovery for a profile with no simulator state');
      registry.releaseWriterSync();
      return;
    }
    const lifecycle =
      options.createLifecycle?.(registry) ??
      createProfileScopedIOSSimulatorLifecycle(registry, pendingCreateEvidence);
    if (persistedInstances.length === 0) {
      await recoverProfilePendingCreatesAtStartup(lifecycle, persistedInstances, {
        evidence: pendingCreateEvidence,
      });
      registry.releaseWriterSync();
      return;
    }
    const persistedActor = createDefaultActor(lifecycle, registry);
    const host = installDefaultIOSSimulatorHost(
      lifecycle,
      persistedActor,
      registry,
      pendingCreateEvidence,
    );
    registryTransferred = true;
    await host.reconcileOwnership();
  } catch (error) {
    if (!registryTransferred) registry.releaseWriterSync();
    throw error;
  }
}

export async function disposeIOSSimulatorHost(): Promise<void> {
  if (defaultIOSSimulatorRuntimeDisposePromise) return defaultIOSSimulatorRuntimeDisposePromise;
  defaultIOSSimulatorRuntimeClosing = true;
  const runtime = defaultIOSSimulatorRuntime;
  defaultIOSSimulatorRuntimeDisposePromise = (async () => {
    try {
      clearIOSSimulatorRendererAccess();
      if (!runtime) return;
      await runtime.host.dispose();
      await runtime.flushRegistry();
    } finally {
      configureIOSSimulatorRendererAccessRevocationObserver(null);
      runtime?.releaseExitAbortHandler();
      runtime?.releaseRegistry();
    }
  })();
  return defaultIOSSimulatorRuntimeDisposePromise;
}

export function cancelIOSSimulatorSessionOperations(sessionId: string): Promise<void> {
  revokeIOSSimulatorRendererSession(sessionId);
  return currentIOSSimulatorHost()?.cancelSessionOperations(sessionId) ?? Promise.resolve();
}

export function cleanupIOSSimulatorRemovedSession(sessionId: string): Promise<void> {
  revokeIOSSimulatorRendererSession(sessionId);
  const currentHost = currentIOSSimulatorHost();
  if (currentHost) return currentHost.cleanupRemovedSession(sessionId);
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return Promise.resolve();
  // iOS ownership can only exist on macOS. Other platforms must keep generic
  // task removal independent from the Darwin-only registry lease.
  if (process.platform !== 'darwin') return Promise.resolve();

  const registry = createDefaultOwnershipRegistry();
  let registryTransferred = false;
  try {
    if (!registry.acquireWriterSync()) {
      throw new IOSSimulatorInstanceError(
        'DEVICE_BUSY',
        'Another Cindy process is managing iOS Simulator ownership for this profile.',
        true,
      );
    }
    const persistedInstances = registry.loadSync();
    if (!persistedInstances.some((instance) => instance.sessionId === normalizedSessionId)) {
      registry.releaseWriterSync();
      return Promise.resolve();
    }

    // Keep the same writer lease from the authoritative read through Host
    // installation. Releasing and reacquiring here would reopen the race with
    // another Cindy process attaching this task while it is being removed.
    const pendingCreateEvidence = createDefaultPendingCreateEvidence(registry);
    const lifecycle = createProfileScopedIOSSimulatorLifecycle(registry, pendingCreateEvidence);
    const persistedActor = createDefaultActor(lifecycle, registry);
    const host = installDefaultIOSSimulatorHost(
      lifecycle,
      persistedActor,
      registry,
      pendingCreateEvidence,
    );
    registryTransferred = true;
    return host.cleanupRemovedSession(normalizedSessionId);
  } catch (error) {
    if (!registryTransferred) registry.releaseWriterSync();
    return Promise.reject(error);
  }
}

export function setIOSSimulatorViewerStreamProfile(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  viewerWebContentsId: number,
  viewerToken: string,
  profile: IOSSimulatorStreamProfile,
  nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest,
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().setViewerStreamProfile(
    sessionId,
    route,
    viewerWebContentsId,
    viewerToken,
    profile,
    nativeProfile,
  );
}

export function updateIOSSimulatorViewerTouch(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  viewerWebContentsId: number,
  touch: {
    gestureId: string;
    phase: 'begin' | 'move' | 'end' | 'cancel';
    xRatio: number;
    yRatio: number;
  },
): Promise<IOSSimulatorHostResult> {
  return initializeIOSSimulatorHost().updateViewerTouch(
    sessionId,
    route,
    viewerWebContentsId,
    touch,
  );
}

export interface IOSSimulatorMcpDepsOptions {
  isIOSSimulatorEnabled?: (context?: IOSSimulatorMcpCallContext) => boolean;
  resolveAccess?: (context?: IOSSimulatorMcpCallContext) => IOSSimulatorMcpAccessDecision;
  host?: IOSSimulatorHost;
}

export function getIOSSimulatorMcpDeps(
  options: IOSSimulatorMcpDepsOptions = {},
): IOSSimulatorMcpDeps {
  const getHost = (): IOSSimulatorHost => options.host ?? initializeIOSSimulatorHost();
  const resolveAccess = (
    context?: IOSSimulatorMcpCallContext,
  ): IOSSimulatorMcpAccessDecision => {
    const decision = options.resolveAccess?.(context);
    if (decision) return decision;
    if (options.isIOSSimulatorEnabled && !options.isIOSSimulatorEnabled(context)) {
      return {
        allowed: false,
        errorCode: 'IOS_SIMULATOR_DISABLED',
        message: 'iOS Simulator tools are disabled for this project.',
        data: { reason: 'disabled-in-workdir', action: 'enable-plugin' },
      };
    }
    return { allowed: true };
  };
  return {
    describeTools: async (context) => {
      const sessionId = context?.sessionId?.trim();
      if (!sessionId) {
        return {
          ready: false,
          instanceCount: 0,
          runningInstanceCount: 0,
          tools: {
            doctor: { state: 'unavailable', reasonCode: 'SESSION_CONTEXT_REQUIRED' },
            check_environment: { state: 'unavailable', reasonCode: 'SESSION_CONTEXT_REQUIRED' },
          },
        };
      }
      const access = resolveAccess(context);
      if (!access.allowed) {
        return {
          ready: false,
          instanceCount: 0,
          runningInstanceCount: 0,
          tools: {
            doctor: { state: 'unavailable', reasonCode: access.errorCode },
            check_environment: { state: 'unavailable', reasonCode: access.errorCode },
          },
          notice: {
            errorCode: access.errorCode,
            message: access.message,
            ...(access.data ? { data: access.data } : {}),
          },
        };
      }
      return getHost().describeTools(sessionId);
    },
    callTool: async (name, args, context) => {
      const access = resolveAccess(context);
      if (!access.allowed) {
        return {
          ok: false,
          errorCode: access.errorCode,
          message: access.message,
          ...(access.data ? { data: access.data } : {}),
        };
      }
      return getHost().callTool(name, args, context);
    },
    logger,
  };
}

export type { IOSSimulatorEnvironmentReport };
