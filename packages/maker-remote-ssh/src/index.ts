/**
 * @cindy/maker-remote-ssh — SSH remote host management for xdt-maker.
 *
 * Phase A: connection lifecycle + OpenSSH discovery/managed writes + credential resolution.
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
  PINNED_PI_VERSION,
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
  installPiManagerBundle,
  probePiManager,
  uninstallPiManager,
  ensurePiManagerDaemon,
  parsePiManagerProbeOutput,
  tailDaemonLog,
} from './bootstrap/pi-manager-installer.js';
export type {
  PiManagerProbeResult,
  PiManagerInstallProgress,
  PiManagerInstallEventCallback,
} from './bootstrap/pi-manager-installer.js';

// 轮 22:pi 独立化 —— 独立 bundled node 安装脚本(pi-manager 不需要 CC/CX
// 先装 node)。与 bootstrap-script 的 ensure_node 同源语义, 幂等共享目录。
export { BUNDLED_NODE_INSTALL_SH, BUNDLED_NODE_VERSION } from './bootstrap/bootstrap-script.js';

export {
  REMOTE_CC_MGR_DIR,
  REMOTE_CC_MGR_BUNDLE_PATH,
  REMOTE_CC_MGR_SOCK_PATH,
  REMOTE_CC_MGR_LOG_PATH,
  REMOTE_CC_MGR_PID_PATH,
  REMOTE_PI_MANAGER_DIR,
  REMOTE_PI_MANAGER_BUNDLE_PATH,
  REMOTE_PI_MANAGER_SOCK_PATH,
  REMOTE_PI_MANAGER_LOG_PATH,
  REMOTE_PI_MANAGER_PID_PATH,
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
  addManagedHost,
  addManagedHostWithInclude,
  defaultManagedSshConfigPath,
  defaultSshConfigPath,
  ensureManagedConfigInclude,
  readSshConfig,
  readSshConfigDetailed,
  removeManagedHost,
  updateManagedHostFields,
  upsertHost,
  updateHostFields,
  removeHost,
  expandHome,
  MANAGED_CONFIG_MARKER,
  MANAGED_CONFIG_CONCURRENT_MODIFICATION_CODE,
  MANAGED_CONFIG_OWNERSHIP_REQUIRED_CODE,
  MANAGED_CONFIG_WRITE_TOKEN_REQUIRED_CODE,
} from './sshConfig.js';
export type {
  ManagedHostAddReceipt,
  ManagedConfigWriteToken,
  ReadSshConfigOptions,
  ReadSshConfigResult,
  SshConfigDiagnostic,
} from './sshConfig.js';

export {
  resolveAuth,
  KEY_FILE_NOT_FOUND_CODE,
  KEY_FILE_UNREADABLE_CODE,
  PINNED_AGENT_FAILED_CODE,
  SSH_CONFIG_AUTH_UNSUPPORTED_CODE,
} from './credentials.js';
export type { ResolvedAuth } from './credentials.js';

export {
  CINDY_DEFAULT_IDENTITY_NAMES,
  defaultAgentEndpoint,
  effectiveAuthenticationFingerprint,
  previewAgentEndpoint,
  resolveAgentEndpoint,
  resolveIdentityFingerprints,
  SSH_AGENT_UNAVAILABLE_CODE,
} from './sshAuthentication.js';

export type {
  AddHostInput,
  AuthMethod,
  HostConfig,
  HostSnapshot,
  HostSource,
  RemoteStatus,
  SshAuthenticationMetadata,
} from './types.js';

export { redactSshSensitiveText } from './sshRedaction.js';
