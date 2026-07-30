/**
 * @cindy/maker-remote-ssh — SSH remote host management for xdt-maker.
 *
 * Phase A: connection lifecycle + ~/.ssh/config IO + credential resolution.
 * Phase B (next): bootstrap agent CLI on remote + RemoteAgent that spawns
 * claude/codex over an exec channel + session ingest.
 */

export { RemoteHost, isAuthFailure, authFailureHint, DEFAULT_REMOTE_FORWARD_PORT_BASE } from './RemoteHost.js';
export type {
  RemoteHostDeps,
  StatusListener,
  ExecOpts,
  ExecResult,
  ExecStreamOpts,
  ExecStreamHandle,
  RemoteForward,
  RemoteForwardSpec,
} from './RemoteHost.js';

export {
  installRemoteAgent,
  probeRemoteAgent,
  uninstallRemoteAgent,
  checkRemoteCodexAuth,
  pushRemoteCodexAuth,
  REMOTE_SERVER_SCHEMA_VERSION,
} from './bootstrap/installer.js';
export type {
  RemoteAgentKind,
  ProbeResult,
  InstallProgressEvent,
  InstallResult,
  CodexAuthState,
} from './bootstrap/installer.js';

export {
  installCcManagerBundle,
  probeCcManager,
  uninstallCcManager,
} from './bootstrap/cc-manager-installer.js';
export type {
  CcManagerProbeResult,
  CcManagerInstallProgress,
  CcManagerInstallEventCallback,
} from './bootstrap/cc-manager-installer.js';

export {
  installFileServiceBundle,
  probeFileService,
  uninstallFileService,
  parseFileServiceProbeOutput,
} from './bootstrap/file-service-installer.js';
export type { FileServiceProbeResult } from './bootstrap/file-service-installer.js';

export {
  REMOTE_CC_MGR_DIR,
  REMOTE_CC_MGR_BUNDLE_PATH,
  REMOTE_CC_MGR_SOCK_PATH,
  REMOTE_CC_MGR_LOG_PATH,
  REMOTE_CC_MGR_PID_PATH,
  REMOTE_XDT_NODE_PATH,
  REMOTE_CLAUDE_SHIM_PATH,
  REMOTE_INSTALL_ROOT,
  REMOTE_AGENT_PROXY_ENV_PATH,
} from './constants.js';

export { ConnectionPool } from './ConnectionPool.js';
export type { ConnectionPoolDeps } from './ConnectionPool.js';

export {
  FileHostKeyStore,
  hostKeyFingerprint,
  hostKeyId,
  decideHostKey,
} from './hostKeys.js';
export type { HostKeyStore, HostKeyDecision } from './hostKeys.js';

export {
  defaultSshConfigPath,
  readSshConfig,
  upsertHost,
  updateHostFields,
  removeHost,
} from './sshConfig.js';

export { defaultAgentEndpoint, resolveAuth } from './credentials.js';
export type { ResolvedAuth } from './credentials.js';

export type {
  AddHostInput,
  AuthMethod,
  HostConfig,
  HostSnapshot,
  HostSource,
  RemoteStatus,
} from './types.js';
