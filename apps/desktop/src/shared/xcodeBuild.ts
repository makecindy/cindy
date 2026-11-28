export const XCODE_BUILD_INVOKE = {
  DISCOVER: 'xcode-build:discover',
  START: 'xcode-build:start',
  STOP: 'xcode-build:stop',
  FLUTTER_ACTION: 'xcode-build:flutter-action',
  STATUS: 'xcode-build:status',
} as const;

export const XCODE_BUILD_PUSH = {
  EVENT: 'xcode-build:event',
} as const;

/** Keep build logs bounded in both processes; xcodebuild can be very verbose. */
export const MAX_XCODE_BUILD_OUTPUT_CHARS = 2_000_000;

export type XcodeContainerKind = 'workspace' | 'project';
export type XcodeDestinationKind = 'simulator' | 'device';
export type XcodeBuildStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type XcodeBuildPhase =
  | 'building'
  | 'installing'
  | 'launching'
  | 'launched'
  | 'reloading'
  | 'restarting';

export interface XcodeProjectContainer {
  /** Workdir-relative POSIX path. */
  containerPath: string;
  containerKind: XcodeContainerKind;
  name: string;
}

export interface XcodeBuildDestination {
  id: string;
  platform: string;
  name: string;
  osVersion: string | null;
  kind: XcodeDestinationKind;
}

export interface XcodeProjectDiscovery {
  status: 'none' | 'available' | 'error';
  projects: XcodeProjectContainer[];
  selectedContainerPath: string | null;
  schemes: string[];
  selectedScheme: string | null;
  destinations: XcodeBuildDestination[];
  error: string | null;
}

export interface XcodeProjectDiscoveryRequest {
  sessionId: string;
  workdir: string;
  containerPath?: string | null;
  scheme?: string | null;
}

export interface XcodeBuildStartRequest {
  sessionId: string;
  workdir: string;
  containerPath: string;
  containerKind: XcodeContainerKind;
  scheme: string;
  destinationId: string;
  destinationPlatform: string;
  destinationName: string;
  destinationOsVersion: string | null;
}

export interface XcodeBuildState {
  buildId: string;
  workdir: string;
  status: XcodeBuildStatus;
  phase: XcodeBuildPhase | null;
  supportsHotReload: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

export interface XcodeBuildStatusResult {
  state: XcodeBuildState | null;
  output: string;
}

export type XcodeBuildEvent =
  { type: 'output'; buildId: string; chunk: string } | { type: 'state'; state: XcodeBuildState };

export interface XcodeBuildBridge {
  discover(request: XcodeProjectDiscoveryRequest): Promise<XcodeProjectDiscovery>;
  start(request: XcodeBuildStartRequest): Promise<XcodeBuildState>;
  stop(buildId: string): Promise<void>;
  flutterAction(buildId: string, action: 'reload' | 'restart'): Promise<void>;
  getStatus(request: { sessionId: string; workdir: string }): Promise<XcodeBuildStatusResult>;
  onEvent(callback: (event: XcodeBuildEvent) => void): () => void;
}
