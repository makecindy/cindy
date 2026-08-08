import { IOSSimulatorInstanceError } from '@cindy/ios-simulator-runtime';

import type {
  IOSSimulatorNativeH264StreamProfileRequest,
  IOSSimulatorRendererToolName,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../shared/iosSimulatorIpc.js';
import { IOS_SIMULATOR_RENDERER_TOOL_NAMES } from '../../shared/iosSimulatorIpc.js';
import {
  callIOSSimulatorHostTool,
  getIOSSimulatorLatestFrame,
  getIOSSimulatorSessionStatus,
  setIOSSimulatorAgentControlGrant,
  setIOSSimulatorAgentMutationPaused,
  setIOSSimulatorViewerVisibility,
  setIOSSimulatorViewerStreamProfile,
  updateIOSSimulatorViewerTouch,
} from '../mcp-integrations/ios-simulator.js';
import {
  hasIOSSimulatorRendererSessionAccess,
  requestIOSSimulatorRendererSessionAccess,
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
  | 'set-mutation-control'
  | 'latest-frame'
  | 'set-stream-profile'
  | 'live-touch';

const IOS_SIMULATOR_SAFE_IPC_MESSAGES: Record<IOSSimulatorIpcOperation, string> = {
  'request-access': 'iOS Simulator access could not be requested.',
  status: 'iOS Simulator status is temporarily unavailable.',
  'call-tool': 'iOS Simulator operation failed.',
  'set-agent-control': 'iOS Simulator control permission could not be updated.',
  'set-viewer-visibility': 'iOS Simulator viewer state could not be updated.',
  'set-mutation-control': 'iOS Simulator control state could not be updated.',
  'latest-frame': 'iOS Simulator frame is temporarily unavailable.',
  'set-stream-profile': 'iOS Simulator stream settings could not be updated.',
  'live-touch': 'iOS Simulator input could not be delivered.',
};

export interface IOSSimulatorHandlerDeps {
  assertTrustedSender(event: unknown): void;
  hasSessionAccess(target: IOSSimulatorRendererWebContents, sessionId: string): boolean;
  requestSessionAccess(
    target: IOSSimulatorRendererWebContents,
    sessionId: string,
  ): Promise<boolean>;
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
  setViewerStreamProfile(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    profile: { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
    nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest,
  ): Promise<IOSSimulatorToolResponse>;
  getLatestFrame(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    viewerWebContentsId: number,
  ): Promise<IOSSimulatorToolResponse>;
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
  hasSessionAccess: hasIOSSimulatorRendererSessionAccess,
  requestSessionAccess: requestIOSSimulatorRendererSessionAccess,
  getStatus: getIOSSimulatorSessionStatus,
  callTool: callIOSSimulatorHostTool,
  setAgentControlGrant: setIOSSimulatorAgentControlGrant,
  setAgentMutationPaused: setIOSSimulatorAgentMutationPaused,
  setViewerVisibility: setIOSSimulatorViewerVisibility,
  setViewerStreamProfile: setIOSSimulatorViewerStreamProfile,
  getLatestFrame: getIOSSimulatorLatestFrame,
  updateViewerTouch: updateIOSSimulatorViewerTouch,
  reportError: (operation, error) => {
    log.error(`iOS Simulator ${operation} IPC failed`, {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  },
};

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
  call: () => T | Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throwIOSSimulatorIpcError(deps, operation, error);
  }
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
  const assertSenderSession = (event: unknown, sessionId: string): number => {
    const sender = readSenderWebContents(event);
    if (!resolved.hasSessionAccess(sender, sessionId)) {
      throwIpcError('PERMISSION_DENIED', 'iOS Simulator access is limited to the current task');
    }
    return sender.id;
  };
  handle(MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, async (event, payload) => {
    const sessionId = readSessionId(payload);
    const sender = readSenderWebContents(event);
    if (resolved.hasSessionAccess(sender, sessionId)) return { granted: true };
    const granted = await callIOSSimulatorHost(resolved, 'request-access', () =>
      resolved.requestSessionAccess(sender, sessionId),
    );
    return { granted };
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_STATUS, async (event, payload) => {
    const sessionId = readSessionId(payload);
    assertSenderSession(event, sessionId);
    return callIOSSimulatorHost(resolved, 'status', () => resolved.getStatus(sessionId));
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_CALL, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderSession(event, sessionId);
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
    return callIOSSimulatorHost(resolved, 'call-tool', () =>
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
    assertSenderSession(event, sessionId);
    const instanceId = record.instanceId;
    const decision = record.decision;
    if (typeof instanceId !== 'string' || !instanceId.trim()) {
      throwIpcError('INVALID_PARAMS', 'instanceId (string) required');
    }
    if (decision !== 'allowed' && decision !== 'denied') {
      throwIpcError('INVALID_PARAMS', 'decision must be allowed or denied');
    }
    return callIOSSimulatorHost(resolved, 'set-agent-control', () =>
      resolved.setAgentControlGrant(sessionId, instanceId.trim(), decision),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const viewerWebContentsId = assertSenderSession(event, sessionId);
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
      return callIOSSimulatorHost(resolved, 'set-viewer-visibility', () =>
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
      return callIOSSimulatorHost(resolved, 'set-viewer-visibility', () =>
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
    return callIOSSimulatorHost(resolved, 'set-viewer-visibility', () =>
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
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderSession(event, sessionId);
    if (typeof record.paused !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'paused (boolean) required');
    }
    const route = readViewerRoute(record);
    return callIOSSimulatorHost(resolved, 'set-mutation-control', () =>
      resolved.setAgentMutationPaused(sessionId, route, record.paused as boolean),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const route = readViewerRoute(record);
    const viewerWebContentsId = assertSenderSession(event, sessionId);
    return callIOSSimulatorHost(resolved, 'latest-frame', () =>
      resolved.getLatestFrame(sessionId, route, viewerWebContentsId),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    assertSenderSession(event, sessionId);
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
    return callIOSSimulatorHost(resolved, 'set-stream-profile', () =>
      resolved.setViewerStreamProfile(sessionId, route, streamProfile, nativeProfile),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const viewerWebContentsId = assertSenderSession(event, sessionId);
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
    return callIOSSimulatorHost(resolved, 'live-touch', () =>
      resolved.updateViewerTouch(sessionId, route, viewerWebContentsId, touch),
    );
  });
}
