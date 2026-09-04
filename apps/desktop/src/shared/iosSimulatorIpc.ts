import type {
  IOSSimulatorDevice,
  IOSSimulatorEnvironmentReport,
  IOSSimulatorDeviceGrant,
  IOSSimulatorInstance,
  IOSSimulatorMutationState,
  IOSSimulatorNativeStreamProfile,
  IOSSimulatorOrientation,
  IOSSimulatorRuntimeInfo,
  IOSSimulatorStreamProfile,
  IOSSimulatorLatestH264Frame,
} from '@cindy/ios-simulator-runtime';
import type { IOSSimulatorMcpErrorCode, IOSSimulatorMcpToolName } from '@cindy/mcps';

export type IOSSimulatorPublicDeviceOwnership = 'unowned' | 'current-task' | 'other-task';

export type IOSSimulatorPublicDeviceUnavailableReason =
  { code: 'missing-runtime'; runtimeName: string } | { code: 'device-unavailable' };

export type IOSSimulatorPublicDevice = Omit<IOSSimulatorDevice, 'availabilityError'> & {
  /** Optional so an older Host status remains consumable by a newer renderer. */
  ownership?: IOSSimulatorPublicDeviceOwnership;
  /** Renderer-safe diagnosis; raw CoreSimulator errors stay in Main. */
  unavailableReason?: IOSSimulatorPublicDeviceUnavailableReason | null;
};

export type IOSSimulatorPublicRuntime = Omit<IOSSimulatorRuntimeInfo, 'availabilityError'>;

export type IOSSimulatorPublicEnvironmentReport = Omit<
  IOSSimulatorEnvironmentReport,
  'xcodeSelectPath' | 'runtimes' | 'devices'
> & {
  runtimes: IOSSimulatorPublicRuntime[];
  devices: IOSSimulatorPublicDevice[];
};

export type IOSSimulatorPublicInstance = Omit<IOSSimulatorInstance, 'worktreeRoot'>;

export interface IOSSimulatorPublicViewport {
  width: number;
  height: number;
  orientation: IOSSimulatorOrientation;
}

export interface IOSSimulatorPublicResourceStatus {
  runningCount: number;
  softLimit: number;
  hardLimit: number;
  maxInstancesPerTask: number;
}

export type IOSSimulatorPublicRouteAdapter = 'native-sidecar' | 'wda' | null;

export type IOSSimulatorPublicRouteState =
  'idle' | 'detecting' | 'active' | 'fallback' | 'reconnecting' | 'unavailable';

/** Stable, renderer-safe reason codes for the selected simulator routes. */
export type IOSSimulatorPublicRouteReasonCode =
  | 'viewer-hidden'
  | 'instance-not-ready'
  | 'native-probe-pending'
  | 'native-active'
  | 'native-capability-unavailable'
  | 'native-sidecar-unavailable'
  | 'native-stream-disconnected'
  | 'native-decoder-fallback'
  | 'wda-fallback'
  | 'wda-active'
  | 'route-stopped'
  | 'route-error'
  | null;

export interface IOSSimulatorPublicRouteStatus {
  sessionId: string;
  instanceId: string;
  generation: number;
  updatedAt: string;
  /** Optional for compatibility with older Host builds; missing fails closed. */
  nativeRecoveryAvailable?: boolean;
  stream: {
    adapter: IOSSimulatorPublicRouteAdapter;
    encoding: 'h264' | 'jpeg' | null;
    state: IOSSimulatorPublicRouteState;
    reasonCode: IOSSimulatorPublicRouteReasonCode;
  };
  input: {
    adapter: IOSSimulatorPublicRouteAdapter;
    state: IOSSimulatorPublicRouteState;
    continuous: boolean;
    multiTouch: boolean;
    reasonCode: IOSSimulatorPublicRouteReasonCode;
  };
}

/** Shared channel name so main, preload and renderer cannot drift. */
export const IOS_SIMULATOR_ROUTE_STATUS_CHANNEL = 'maker:ios-simulator:route-status' as const;

export type IOSSimulatorSessionStatus =
  | {
      ok: true;
      sessionId: string;
      environment: IOSSimulatorPublicEnvironmentReport;
      instances: IOSSimulatorPublicInstance[];
      deviceGrants: IOSSimulatorDeviceGrant[];
      mutationStates: IOSSimulatorMutationState[];
      /** Optional for compatibility with older Main processes. */
      controlAccess?: 'active' | 'paused';
      /** Optional for compatibility with older Host builds. */
      resource?: IOSSimulatorPublicResourceStatus;
      /** Optional for compatibility with older detached/sidebar renderers. */
      routeStatuses?: IOSSimulatorPublicRouteStatus[];
    }
  | {
      ok: false;
      sessionId: string | null;
      errorCode: IOSSimulatorMcpErrorCode;
      message: string;
    };

export interface IOSSimulatorStatusRequest {
  sessionId: string;
}

export interface IOSSimulatorAccessRequest {
  sessionId: string;
}

export interface IOSSimulatorAccessRequestResult {
  granted: boolean;
}

/**
 * Renderer-owned simulator actions. Agent-only build, install, URL, push, media,
 * and diagnostic tools must stay behind the MCP approval/control boundary.
 */
const IOS_SIMULATOR_RENDERER_MCP_TOOL_NAMES = [
  'attach_device',
  'detach_device',
  'start_instance',
  'stop_instance',
  'tap',
  'swipe',
  'type_text',
  'press_home',
  'set_orientation',
  'lock_screen',
  'unlock_screen',
] as const satisfies readonly IOSSimulatorMcpToolName[];

export const IOS_SIMULATOR_RENDERER_TOOL_NAMES = [
  ...IOS_SIMULATOR_RENDERER_MCP_TOOL_NAMES,
  // Host-only destructive lifecycle action. Keep it out of the MCP registry:
  // the trusted Renderer confirmation flow is its sole caller.
  'delete_instance',
] as const;

export type IOSSimulatorRendererToolName = (typeof IOS_SIMULATOR_RENDERER_TOOL_NAMES)[number];

export interface IOSSimulatorToolRequest {
  sessionId: string;
  name: IOSSimulatorRendererToolName;
  args: Record<string, unknown>;
}

export type IOSSimulatorToolResponse =
  | { ok: true; data: unknown }
  | {
      ok: false;
      errorCode: IOSSimulatorMcpErrorCode;
      message: string;
      data?: Record<string, unknown>;
    };

export interface IOSSimulatorAgentControlRequest {
  sessionId: string;
  instanceId: string;
  /** Elevation is only a request; Main owns confirmation and persistence. */
  action: 'request-allow' | 'revoke';
}

export interface IOSSimulatorViewerRouteRequest {
  sessionId: string;
  instanceId: string;
  generation: number;
  leaseId: string;
}

export type IOSSimulatorCopyScreenshotRequest = IOSSimulatorViewerRouteRequest;

export interface IOSSimulatorCopyScreenshotResult {
  ok: true;
}

export interface IOSSimulatorViewerVisibilityRequest extends IOSSimulatorViewerRouteRequest {
  visible: boolean;
  /** Identifies one renderer effect lifetime so a stale close cannot stop its replacement. */
  viewerToken?: string;
  preferredEncoding?: 'jpeg' | 'h264';
  /** Renderer decoder failed after a native stream was selected. */
  fallbackReason?: 'native-decoder-fallback';
}

export interface IOSSimulatorRetryNativeRouteRequest extends IOSSimulatorViewerRouteRequest {
  /** Exact viewer effect lifetime that is allowed to re-arm Native acceleration. */
  viewerToken: string;
}

export type IOSSimulatorNativeH264StreamProfileRequest = Pick<
  IOSSimulatorNativeStreamProfile,
  'framesPerSecond' | 'scalingPercent'
>;

export interface IOSSimulatorStreamProfileRequest extends IOSSimulatorViewerRouteRequest {
  /** Exact viewer effect lifetime that currently owns stream presentation. */
  viewerToken: string;
  /** Exact compatibility profile kept ready for WDA/MJPEG fallback. */
  profile: IOSSimulatorStreamProfile;
  /** Optional product profile accepted only while Native H.264 is active. */
  nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest;
}

export interface IOSSimulatorMutationControlRequest extends IOSSimulatorViewerRouteRequest {
  paused: boolean;
}

export interface IOSSimulatorLiveTouchRequest extends IOSSimulatorViewerRouteRequest {
  gestureId: string;
  phase: 'begin' | 'move' | 'end' | 'cancel';
  xRatio: number;
  yRatio: number;
}

export interface IOSSimulatorFocusRequest {
  sessionId: string;
  /** Omitted when a Host capability only needs to open the unbound simulator panel. */
  instanceId?: string;
  /** false for plugin/automation requests that must not steal focus as a direct user gesture. */
  userInitiated?: boolean;
}

export type IOSSimulatorH264FramePush = {
  frame: Omit<IOSSimulatorLatestH264Frame, 'bytes'> & { bytes: ArrayBuffer };
};

export type IOSSimulatorRouteStatusPush = IOSSimulatorPublicRouteStatus;
