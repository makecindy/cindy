import { IOSSimulatorInstanceError } from '@cindy/ios-simulator-runtime';
import type { IOSSimulatorMcpAccessDecision } from '@cindy/mcps';
import { clipboard, nativeImage } from 'electron';

import type {
  IOSSimulatorNativeH264StreamProfileRequest,
  IOSSimulatorRendererToolName,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../shared/iosSimulatorIpc.js';
import { IOS_SIMULATOR_RENDERER_TOOL_NAMES } from '../../shared/iosSimulatorIpc.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  callIOSSimulatorHostTool,
  captureIOSSimulatorScreenshotBytes,
  getIOSSimulatorLatestFrame,
  getIOSSimulatorSessionStatus,
  retryIOSSimulatorNativeRoute,
  setIOSSimulatorAgentControlGrant,
  setIOSSimulatorAgentMutationPaused,
  setIOSSimulatorViewerVisibility,
  setIOSSimulatorViewerStreamProfile,
  updateIOSSimulatorViewerTouch,
} from '../mcp-integrations/ios-simulator.js';
import {
  getIOSSimulatorRendererSessionAccess,
  getIOSSimulatorRendererViewerAccess,
  hasIOSSimulatorRendererViewerAccess,
  invalidateIOSSimulatorAgentControlElevation,
  isIOSSimulatorAgentControlApprovalCurrent,
  requestIOSSimulatorAgentControlElevation,
  requestIOSSimulatorRendererSessionAccess,
  type IOSSimulatorAgentControlApproval,
  type IOSSimulatorRendererAccessSnapshot,
  type IOSSimulatorRendererWebContents,
} from '../mcp-integrations/ios-simulator-renderer-access.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const log = createLogger('maker-ipc:ios-simulator');

type IOSSimulatorIpcOperation =
  | 'request-access'
  | 'status'
  | 'call-tool'
  | 'set-agent-control'
  | 'set-viewer-visibility'
  | 'retry-native-route'
  | 'set-mutation-control'
  | 'latest-frame'
  | 'copy-screenshot'
  | 'set-stream-profile'
  | 'live-touch';

const IOS_SIMULATOR_SAFE_IPC_MESSAGES: Record<IOSSimulatorIpcOperation, string> = {
  'request-access': 'iOS Simulator access could not be requested.',
  status: 'iOS Simulator status is temporarily unavailable.',
  'call-tool': 'iOS Simulator operation failed.',
  'set-agent-control': 'iOS Simulator control permission could not be updated.',
  'set-viewer-visibility': 'iOS Simulator viewer state could not be updated.',
  'retry-native-route': 'iOS Simulator Native acceleration could not be restored.',
  'set-mutation-control': 'iOS Simulator control state could not be updated.',
  'latest-frame': 'iOS Simulator frame is temporarily unavailable.',
  'copy-screenshot': 'iOS Simulator screenshot could not be copied.',
  'set-stream-profile': 'iOS Simulator stream settings could not be updated.',
  'live-touch': 'iOS Simulator input could not be delivered.',
};

export interface IOSSimulatorHandlerDeps {
  assertTrustedSender(event: unknown): void;
  getPluginAccess(workingDir: string | null): IOSSimulatorMcpAccessDecision;
  getSessionContext(sessionId: string): Promise<{ workingDir: string | null } | null>;
  getOwnerScopeKey(): string;
  isOwnerBoundaryPending(): boolean;
  getSessionAccess(
    target: IOSSimulatorRendererWebContents,
  ): IOSSimulatorRendererAccessSnapshot | null;
  getViewerAccess(
    target: IOSSimulatorRendererWebContents,
    sessionId: string,
  ): IOSSimulatorRendererAccessSnapshot | null;
  hasViewerAccess(target: IOSSimulatorRendererWebContents, sessionId: string): boolean;
  requestSessionAccess(
    target: IOSSimulatorRendererWebContents,
    sessionId: string,
  ): Promise<boolean>;
  confirmAgentControlElevation(
    target: IOSSimulatorRendererWebContents,
    sessionId: string,
    instanceId: string,
  ): Promise<IOSSimulatorAgentControlApproval | null>;
  invalidateAgentControlElevation(sessionId: string, instanceId: string): void;
  isAgentControlApprovalCurrent(
    target: IOSSimulatorRendererWebContents,
    approval: IOSSimulatorAgentControlApproval,
  ): boolean;
  getStatus(sessionId: string): Promise<IOSSimulatorSessionStatus>;
  callTool(
    name: IOSSimulatorRendererToolName,
    args: Record<string, unknown>,
    sessionId: string,
  ): Promise<IOSSimulatorToolResponse>;
  setAgentControlGrant(
    sessionId: string,
    instanceId: string,
    decision: 'allowed' | 'denied',
    assertElevationCurrent?: () => void,
  ): Promise<IOSSimulatorToolResponse>;
  setAgentMutationPaused(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    paused: boolean,
  ): Promise<IOSSimulatorToolResponse>;
  setViewerVisibility(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    visible: boolean,
    preferredEncoding?: 'jpeg' | 'h264',
    fallbackReason?: 'native-decoder-fallback',
    viewerWebContentsId?: number,
    viewerToken?: string,
  ): Promise<IOSSimulatorToolResponse>;
  retryNativeRoute(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    viewerWebContentsId: number,
    viewerToken: string,
  ): Promise<IOSSimulatorToolResponse>;
  setViewerStreamProfile(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    viewerWebContentsId: number,
    viewerToken: string,
    profile: { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
    nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest,
  ): Promise<IOSSimulatorToolResponse>;
  getLatestFrame(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    viewerWebContentsId: number,
  ): Promise<IOSSimulatorToolResponse>;
  captureScreenshotBytes(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
  ): Promise<Buffer>;
  writePngToClipboard(pngBytes: Buffer): void;
  updateViewerTouch(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    viewerWebContentsId: number,
    touch: {
      gestureId: string;
      phase: 'begin' | 'move' | 'end' | 'cancel';
      xRatio: number;
      yRatio: number;
    },
  ): Promise<IOSSimulatorToolResponse>;
  reportError(operation: IOSSimulatorIpcOperation, error: unknown): void;
}

const defaultDeps: IOSSimulatorHandlerDeps = {
  assertTrustedSender: (event) =>
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
  // Production registration must inject the live Ghost capability gate. Tests
  // and any accidental alternate registration fail closed by default.
  getPluginAccess: () => ({
    allowed: false,
    errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
    message: 'The iOS Simulator plugin is unavailable.',
    data: { reason: 'session-unavailable' },
  }),
  getSessionContext: async () => null,
  getOwnerScopeKey: activeOwnerScopeKey,
  isOwnerBoundaryPending: isAppSessionBoundaryPending,
  getSessionAccess: getIOSSimulatorRendererSessionAccess,
  getViewerAccess: getIOSSimulatorRendererViewerAccess,
  hasViewerAccess: hasIOSSimulatorRendererViewerAccess,
  requestSessionAccess: requestIOSSimulatorRendererSessionAccess,
  confirmAgentControlElevation: requestIOSSimulatorAgentControlElevation,
  invalidateAgentControlElevation: invalidateIOSSimulatorAgentControlElevation,
  isAgentControlApprovalCurrent: isIOSSimulatorAgentControlApprovalCurrent,
  getStatus: getIOSSimulatorSessionStatus,
  callTool: callIOSSimulatorHostTool,
  setAgentControlGrant: setIOSSimulatorAgentControlGrant,
  setAgentMutationPaused: setIOSSimulatorAgentMutationPaused,
  setViewerVisibility: setIOSSimulatorViewerVisibility,
  retryNativeRoute: retryIOSSimulatorNativeRoute,
  setViewerStreamProfile: setIOSSimulatorViewerStreamProfile,
  getLatestFrame: getIOSSimulatorLatestFrame,
  captureScreenshotBytes: captureIOSSimulatorScreenshotBytes,
  writePngToClipboard: (pngBytes) => {
    const image = nativeImage.createFromBuffer(pngBytes);
    if (image.isEmpty()) {
      throw new IOSSimulatorInstanceError(
        'SCREENSHOT_CAPTURE_FAILED',
        'The captured simulator screenshot is empty.',
        true,
      );
    }
    clipboard.writeImage(image);
  },
  updateViewerTouch: updateIOSSimulatorViewerTouch,
  reportError: (operation, error) => {
    log.error(`iOS Simulator ${operation} IPC failed`, {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  },
};

function throwIOSSimulatorPluginAccessError(
  decision: Exclude<IOSSimulatorMcpAccessDecision, { allowed: true }>,
): never {
  const reason = decision.data?.reason;
  switch (reason) {
    case 'not-installed':
      throwIpcError('IOS_SIMULATOR_PLUGIN_REQUIRED', 'The iOS Simulator plugin is not installed.');
    case 'disabled-in-workdir':
      throwIpcError(
        'IOS_SIMULATOR_DISABLED',
        'The iOS Simulator plugin is disabled for this project.',
      );
    case 'session-unavailable':
      throwIpcError(
        'IOS_SIMULATOR_PLUGIN_SESSION_UNAVAILABLE',
        'The iOS Simulator plugin is unavailable in the current Cindy session.',
      );
    case 'disabled':
    default:
      throwIpcError('IOS_SIMULATOR_PLUGIN_DISABLED', 'The iOS Simulator plugin is disabled.');
  }
}

const RENDERER_TOOL_NAMES = new Set<IOSSimulatorRendererToolName>(
  IOS_SIMULATOR_RENDERER_TOOL_NAMES,
);

function throwIOSSimulatorIpcError(
  deps: IOSSimulatorHandlerDeps,
  operation: IOSSimulatorIpcOperation,
  error: unknown,
): never {
  try {
    deps.reportError(operation, error);
  } catch {
    // Error reporting is best-effort and must never replace the fixed Renderer boundary.
  }
  const code = error instanceof IOSSimulatorInstanceError ? error.code : 'INTERNAL';
  throwIpcError(code, IOS_SIMULATOR_SAFE_IPC_MESSAGES[operation]);
}

async function callIOSSimulatorHost<T>(
  deps: IOSSimulatorHandlerDeps,
  operation: IOSSimulatorIpcOperation,
  sessionId: string,
  call: (assertCurrent: () => void) => T | Promise<T>,
  assertStillAuthorized?: () => void,
): Promise<T> {
  let sessionContext: { workingDir: string | null } | null;
  try {
    sessionContext = await deps.getSessionContext(sessionId);
  } catch {
    sessionContext = null;
  }
  if (!sessionContext) {
    throwIpcError('PERMISSION_DENIED', 'iOS Simulator access is limited to the current task');
  }
  const workingDir = sessionContext.workingDir?.trim() || null;
  const ownerScopeKey = deps.getOwnerScopeKey();
  const assertOwnerScopeCurrent = (): void => {
    if (deps.isOwnerBoundaryPending() || deps.getOwnerScopeKey() !== ownerScopeKey) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'iOS Simulator ownership changed while handling the request. Retry the operation.',
      );
    }
  };
  const assertCurrent = (): void => {
    const pluginAccess = deps.getPluginAccess(workingDir);
    if (!pluginAccess.allowed) throwIOSSimulatorPluginAccessError(pluginAccess);
    assertOwnerScopeCurrent();
    assertStillAuthorized?.();
  };
  assertCurrent();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await call(assertCurrent) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  assertCurrent();
  if (!outcome.ok) {
    throwIOSSimulatorIpcError(deps, operation, outcome.error);
  }
  return outcome.value;
}

function readSessionId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    throwIpcError('INVALID_PARAMS', 'payload must be an object');
  }
  const sessionId = (payload as Record<string, unknown>).sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throwIpcError('INVALID_PARAMS', 'sessionId (string) required');
  }
  return sessionId.trim();
}

function readRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throwIpcError('INVALID_PARAMS', 'payload must be an object');
  }
  return payload as Record<string, unknown>;
}

function readViewerRoute(record: Record<string, unknown>) {
  const instanceId = record.instanceId;
  const generation = record.generation;
  const leaseId = record.leaseId;
  if (typeof instanceId !== 'string' || !instanceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'instanceId (string) required');
  }
  if (!Number.isSafeInteger(generation) || Number(generation) <= 0) {
    throwIpcError('INVALID_PARAMS', 'generation (positive integer) required');
  }
  if (typeof leaseId !== 'string' || !leaseId.trim()) {
    throwIpcError('INVALID_PARAMS', 'leaseId (string) required');
  }
  return { instanceId: instanceId.trim(), generation: Number(generation), leaseId: leaseId.trim() };
}

function readSenderWebContents(event: unknown): IOSSimulatorRendererWebContents {
  const sender = (event as { sender?: { id?: unknown } })?.sender;
  const id = sender?.id;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) {
    throwIpcError('PERMISSION_DENIED', 'trusted renderer sender is required');
  }
  return sender as IOSSimulatorRendererWebContents;
}

export function registerIOSSimulatorHandlers(
  registry: IpcHandlerRegistry,
  deps: Partial<IOSSimulatorHandlerDeps> = {},
): void {
  const resolved = { ...defaultDeps, ...deps };
  const handle: IpcHandlerRegistry['handle'] = (channel, handler) => {
    registry.handle(channel, (event, ...args) => {
      resolved.assertTrustedSender(event);
      return handler(event, ...args);
    });
  };
  const assertSenderViewerSession = (event: unknown, sessionId: string): number => {
    const sender = readSenderWebContents(event);
    if (!resolved.hasViewerAccess(sender, sessionId)) {
      throwIpcError('PERMISSION_DENIED', 'iOS Simulator access is limited to the current task');
    }
    return sender.id;
  };
  const callIOSSimulatorHostForSession = <T>(
    event: unknown,
    sessionId: string,
    operation: IOSSimulatorIpcOperation,
    call: (assertCurrent: () => void) => T | Promise<T>,
  ): Promise<T> => {
    const sender = readSenderWebContents(event);
    const expectedAccess = resolved.getSessionAccess(sender);
    if (!expectedAccess || expectedAccess.sessionId !== sessionId) {
      throwIpcError('PERMISSION_DENIED', 'iOS Simulator access is limited to the current task');
    }
    return callIOSSimulatorHost(resolved, operation, sessionId, call, () => {
      const currentAccess = resolved.getSessionAccess(sender);
      if (
        !currentAccess ||
        currentAccess.sessionId !== expectedAccess.sessionId ||
        currentAccess.generation !== expectedAccess.generation
      ) {
        throwIpcError('PERMISSION_DENIED', 'iOS Simulator access grant expired');
      }
    });
  };
  const callIOSSimulatorHostForViewerSession = <T>(
    event: unknown,
    sessionId: string,
    operation: IOSSimulatorIpcOperation,
    call: (assertCurrent: () => void) => T | Promise<T>,
  ): Promise<T> => {
    const sender = readSenderWebContents(event);
    const expectedAccess = resolved.getViewerAccess(sender, sessionId);
    if (!expectedAccess) {
      throwIpcError('PERMISSION_DENIED', 'iOS Simulator access is limited to the current task');
    }
    return callIOSSimulatorHost(resolved, operation, sessionId, call, () => {
      const currentAccess = resolved.getViewerAccess(sender, sessionId);
      if (
        !currentAccess ||
        currentAccess.sessionId !== expectedAccess.sessionId ||
        currentAccess.generation !== expectedAccess.generation
      ) {
        throwIpcError('PERMISSION_DENIED', 'iOS Simulator viewer access grant expired');
      }
    });
  };
  const callIOSSimulatorHostForViewerStatus = <T>(
    event: unknown,
    sessionId: string,
    call: (assertCurrent: () => void) => T | Promise<T>,
  ): Promise<T> => {
    const sender = readSenderWebContents(event);
    let expectedAccess: IOSSimulatorRendererAccessSnapshot | null = null;
    return callIOSSimulatorHost(resolved, 'status', sessionId, call, () => {
      const currentAccess = resolved.getViewerAccess(sender, sessionId);
      if (!expectedAccess) {
        if (!currentAccess) {
          throwIpcError('PERMISSION_DENIED', 'iOS Simulator access is limited to the current task');
        }
        // Capture only after callIOSSimulatorHost has validated the live
        // plugin gate and owner scope. This lets a trusted panel surface the
        // plugin's concrete unavailable reason after plugin changes cleared
        // its grants, without weakening the Viewer boundary when the plugin
        // remains available.
        expectedAccess = currentAccess;
        return;
      }
      if (
        currentAccess?.sessionId !== expectedAccess.sessionId ||
        currentAccess.generation !== expectedAccess.generation
      ) {
        throwIpcError('PERMISSION_DENIED', 'iOS Simulator viewer access grant expired');
      }
    });
  };
  handle(MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, async (event, payload) => {
    const sessionId = readSessionId(payload);
    const sender = readSenderWebContents(event);
    const currentAccess = resolved.getSessionAccess(sender);
    const granted = await callIOSSimulatorHost(resolved, 'request-access', sessionId, () =>
      currentAccess?.sessionId === sessionId
        ? true
        : resolved.requestSessionAccess(sender, sessionId),
    );
    if (granted && resolved.getSessionAccess(sender)?.sessionId !== sessionId) {
      throwIpcError('PERMISSION_DENIED', 'iOS Simulator access grant expired');
    }
    return { granted };
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_STATUS, async (event, payload) => {
    const sessionId = readSessionId(payload);
    const sender = readSenderWebContents(event);
    const status = await callIOSSimulatorHostForViewerStatus(event, sessionId, () =>
      resolved.getStatus(sessionId),
    );
    if (!status.ok) return status;
    return {
      ...status,
      controlAccess:
        resolved.getSessionAccess(sender)?.sessionId === sessionId ? 'active' : 'paused',
    };
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_CALL, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderViewerSession(event, sessionId);
    const name = record.name;
    const args = record.args;
    if (
      typeof name !== 'string' ||
      !RENDERER_TOOL_NAMES.has(name as IOSSimulatorRendererToolName)
    ) {
      throwIpcError('INVALID_PARAMS', 'name must be a supported iOS Simulator tool');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throwIpcError('INVALID_PARAMS', 'args must be an object');
    }
    return callIOSSimulatorHostForSession(event, sessionId, 'call-tool', () =>
      resolved.callTool(
        name as IOSSimulatorRendererToolName,
        args as Record<string, unknown>,
        sessionId,
      ),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderViewerSession(event, sessionId);
    const sender = readSenderWebContents(event);
    const instanceId = record.instanceId;
    const action = record.action;
    if (typeof instanceId !== 'string' || !instanceId.trim()) {
      throwIpcError('INVALID_PARAMS', 'instanceId (string) required');
    }
    if (action !== 'request-allow' && action !== 'revoke') {
      throwIpcError('INVALID_PARAMS', 'action must be request-allow or revoke');
    }
    const normalizedInstanceId = instanceId.trim();
    return callIOSSimulatorHostForSession(
      event,
      sessionId,
      'set-agent-control',
      async (assertCurrent) => {
        if (action === 'revoke') {
          resolved.invalidateAgentControlElevation(sessionId, normalizedInstanceId);
          return resolved.setAgentControlGrant(sessionId, normalizedInstanceId, 'denied');
        }
        const approval = await resolved.confirmAgentControlElevation(
          sender,
          sessionId,
          normalizedInstanceId,
        );
        if (!approval) return { ok: true, data: { confirmed: false } };
        // A native dialog can outlive the exact Renderer/task grant that opened
        // it. Revalidate immediately before the profile-wide elevation is sent
        // to the Host and again inside the Host immediately before persistence.
        const assertElevationCurrent = (): void => {
          assertCurrent();
          if (!resolved.isAgentControlApprovalCurrent(sender, approval)) {
            throwIpcError('PERMISSION_DENIED', 'Agent control approval expired');
          }
        };
        assertElevationCurrent();
        return resolved.setAgentControlGrant(
          sessionId,
          normalizedInstanceId,
          'allowed',
          assertElevationCurrent,
        );
      },
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const viewerWebContentsId = assertSenderViewerSession(event, sessionId);
    if (typeof record.visible !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'visible (boolean) required');
    }
    const preferredEncoding = record.preferredEncoding;
    if (
      preferredEncoding !== undefined &&
      preferredEncoding !== 'jpeg' &&
      preferredEncoding !== 'h264'
    ) {
      throwIpcError('INVALID_PARAMS', 'preferredEncoding must be jpeg or h264');
    }
    const fallbackReason = record.fallbackReason;
    if (fallbackReason !== undefined && fallbackReason !== 'native-decoder-fallback') {
      throwIpcError('INVALID_PARAMS', 'fallbackReason is not supported');
    }
    const viewerToken = record.viewerToken;
    if (
      viewerToken !== undefined &&
      (typeof viewerToken !== 'string' || !viewerToken.trim() || viewerToken.length > 128)
    ) {
      throwIpcError(
        'INVALID_PARAMS',
        'viewerToken must be a non-empty string of at most 128 chars',
      );
    }
    const route = readViewerRoute(record);
    if (preferredEncoding === undefined && fallbackReason === undefined) {
      return callIOSSimulatorHostForViewerSession(event, sessionId, 'set-viewer-visibility', () =>
        resolved.setViewerVisibility(
          sessionId,
          route,
          record.visible as boolean,
          undefined,
          undefined,
          viewerWebContentsId,
          viewerToken?.trim(),
        ),
      );
    }
    if (fallbackReason === undefined) {
      return callIOSSimulatorHostForViewerSession(event, sessionId, 'set-viewer-visibility', () =>
        resolved.setViewerVisibility(
          sessionId,
          route,
          record.visible as boolean,
          preferredEncoding,
          undefined,
          viewerWebContentsId,
          viewerToken?.trim(),
        ),
      );
    }
    return callIOSSimulatorHostForViewerSession(event, sessionId, 'set-viewer-visibility', () =>
      resolved.setViewerVisibility(
        sessionId,
        route,
        record.visible as boolean,
        preferredEncoding,
        fallbackReason,
        viewerWebContentsId,
        viewerToken?.trim(),
      ),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_RETRY_NATIVE_ROUTE, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const viewerWebContentsId = assertSenderViewerSession(event, sessionId);
    const viewerToken = record.viewerToken;
    if (typeof viewerToken !== 'string' || !viewerToken.trim() || viewerToken.length > 128) {
      throwIpcError(
        'INVALID_PARAMS',
        'viewerToken must be a non-empty string of at most 128 chars',
      );
    }
    const route = readViewerRoute(record);
    return callIOSSimulatorHostForSession(event, sessionId, 'retry-native-route', () =>
      resolved.retryNativeRoute(sessionId, route, viewerWebContentsId, viewerToken.trim()),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderViewerSession(event, sessionId);
    if (typeof record.paused !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'paused (boolean) required');
    }
    const route = readViewerRoute(record);
    return callIOSSimulatorHostForSession(event, sessionId, 'set-mutation-control', () =>
      resolved.setAgentMutationPaused(sessionId, route, record.paused as boolean),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const route = readViewerRoute(record);
    const viewerWebContentsId = assertSenderViewerSession(event, sessionId);
    return callIOSSimulatorHostForViewerSession(event, sessionId, 'latest-frame', () =>
      resolved.getLatestFrame(sessionId, route, viewerWebContentsId),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_COPY_SCREENSHOT, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderViewerSession(event, sessionId);
    const route = readViewerRoute(record);
    const pngBytes = await callIOSSimulatorHostForSession(event, sessionId, 'copy-screenshot', () =>
      resolved.captureScreenshotBytes(sessionId, route),
    );
    try {
      resolved.writePngToClipboard(pngBytes);
    } catch (error) {
      throwIOSSimulatorIpcError(resolved, 'copy-screenshot', error);
    }
    return { ok: true as const };
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const viewerWebContentsId = assertSenderViewerSession(event, sessionId);
    const viewerToken = record.viewerToken;
    if (typeof viewerToken !== 'string' || !viewerToken.trim() || viewerToken.length > 128) {
      throwIpcError(
        'INVALID_PARAMS',
        'viewerToken must be a non-empty string of at most 128 chars',
      );
    }
    const profile = record.profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throwIpcError('INVALID_PARAMS', 'profile must be an object');
    }
    const candidate = profile as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.framesPerSecond) ||
      !Number.isSafeInteger(candidate.jpegQuality) ||
      !Number.isSafeInteger(candidate.scalingPercent)
    ) {
      throwIpcError('INVALID_PARAMS', 'profile values must be integers');
    }
    const rawNativeProfile = record.nativeProfile;
    let nativeProfile: IOSSimulatorNativeH264StreamProfileRequest | undefined;
    if (rawNativeProfile !== undefined) {
      if (
        !rawNativeProfile ||
        typeof rawNativeProfile !== 'object' ||
        Array.isArray(rawNativeProfile)
      ) {
        throwIpcError('INVALID_PARAMS', 'nativeProfile must be an object');
      }
      const nativeCandidate = rawNativeProfile as Record<string, unknown>;
      if (
        !Number.isSafeInteger(nativeCandidate.framesPerSecond) ||
        !Number.isSafeInteger(nativeCandidate.scalingPercent)
      ) {
        throwIpcError('INVALID_PARAMS', 'nativeProfile values must be integers');
      }
      nativeProfile = {
        framesPerSecond: Number(nativeCandidate.framesPerSecond),
        scalingPercent: Number(nativeCandidate.scalingPercent),
      };
    }
    const route = readViewerRoute(record);
    const streamProfile = {
      framesPerSecond: Number(candidate.framesPerSecond),
      jpegQuality: Number(candidate.jpegQuality),
      scalingPercent: Number(candidate.scalingPercent),
    };
    return callIOSSimulatorHostForViewerSession(event, sessionId, 'set-stream-profile', () =>
      resolved.setViewerStreamProfile(
        sessionId,
        route,
        viewerWebContentsId,
        viewerToken.trim(),
        streamProfile,
        nativeProfile,
      ),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const viewerWebContentsId = assertSenderViewerSession(event, sessionId);
    const gestureId = record.gestureId;
    const phase = record.phase;
    if (typeof gestureId !== 'string' || !gestureId.trim() || gestureId.trim().length > 128) {
      throwIpcError('INVALID_PARAMS', 'gestureId must be a bounded string');
    }
    if (phase !== 'begin' && phase !== 'move' && phase !== 'end' && phase !== 'cancel') {
      throwIpcError('INVALID_PARAMS', 'phase must be begin, move, end, or cancel');
    }
    if (
      typeof record.xRatio !== 'number' ||
      !Number.isFinite(record.xRatio) ||
      record.xRatio < 0 ||
      record.xRatio > 1 ||
      typeof record.yRatio !== 'number' ||
      !Number.isFinite(record.yRatio) ||
      record.yRatio < 0 ||
      record.yRatio > 1
    ) {
      throwIpcError('INVALID_PARAMS', 'touch coordinates must be normalized');
    }
    const route = readViewerRoute(record);
    const touch: Parameters<IOSSimulatorHandlerDeps['updateViewerTouch']>[3] = {
      gestureId: gestureId.trim(),
      phase,
      xRatio: record.xRatio,
      yRatio: record.yRatio,
    };
    return callIOSSimulatorHostForSession(event, sessionId, 'live-touch', () =>
      resolved.updateViewerTouch(sessionId, route, viewerWebContentsId, touch),
    );
  });
}
