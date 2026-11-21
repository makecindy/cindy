export const FEISHU_LOCAL_REASON_CODES = [
  'OK',
  'PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE',
  'LOCAL_CLI_NOT_INSTALLED',
  'LOCAL_CLI_VERSION_UNSUPPORTED',
  'NOT_AUTHORIZED',
  'SCOPE_MISSING',
  'TARGET_DEVICE_UNAVAILABLE',
  'ROW_CHANGED',
  'PATH_HANDOFF_REJECTED',
  'VERIFY_FAILED',
  'CONFIRMATION_REQUIRED',
  'INVALID_ARGS',
  'CLI_FAILED',
  'SETUP_REQUIRED',
  'SETUP_UNAVAILABLE',
] as const;

export type FeishuLocalReasonCode = (typeof FEISHU_LOCAL_REASON_CODES)[number];

export type FeishuLocalBinarySource = 'managed' | 'fixed-path' | 'unavailable';

export interface FeishuLocalBinaryProbe {
  installed: boolean;
  binary_source: FeishuLocalBinarySource;
  version: string | null;
  version_supported: boolean;
}

export interface FeishuLocalAuthState {
  state: 'ready' | 'missing' | 'scope_missing' | 'expired';
  identity_alias: string | null;
  scopes: string[];
  reason_code?: FeishuLocalReasonCode;
}

export interface FeishuLocalCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  reasonCode?: FeishuLocalReasonCode;
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export interface FeishuLocalImageHandoff {
  cwd: string;
  relativePath: string;
  cleanup(): Promise<void>;
}

export interface FeishuLocalUpdateProbe {
  current_version: string | null;
  latest_version: string | null;
}

export interface FeishuLocalCliInvocation {
  argv: string[];
  cwd?: string;
  withCredential: boolean;
  timeoutMs?: number;
}

export interface FeishuLocalConnectInput {
  mode?: 'login' | 'import-terminal';
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  assertCurrent?: () => void;
  beforeCommit?: () => Promise<void>;
}

export interface FeishuLocalSetupInput {
  sessionId?: string;
  reauthorize?: boolean;
}

export interface FeishuLocalHostPort {
  deviceId(): string | Promise<string>;
  probeBinary(): Promise<FeishuLocalBinaryProbe>;
  readAuth(): Promise<FeishuLocalAuthState>;
  checkUpdate(): Promise<FeishuLocalUpdateProbe | null>;
  runCli(invocation: FeishuLocalCliInvocation): Promise<FeishuLocalCliResult>;
  resolveImage(imageRef: string): Promise<FeishuLocalImageHandoff>;
  requestSetup(input: FeishuLocalSetupInput): Promise<{ ok: boolean; reasonCode?: FeishuLocalReasonCode; message?: string }>;
  connect(input: FeishuLocalConnectInput): Promise<{ ok: boolean; reasonCode?: FeishuLocalReasonCode; message?: string }>;
}

export interface FeishuLocalStatus {
  ok: true;
  device_id: string;
  installed: boolean;
  binary_source: FeishuLocalBinarySource;
  version: string | null;
  min_supported_version: string;
  version_supported: boolean;
  identity_alias: string | null;
  auth_state: FeishuLocalAuthState['state'];
  scopes: string[];
  capabilities: readonly string[];
  target_device: string;
  reason_code: FeishuLocalReasonCode;
  latest_version?: string | null;
}

export interface FeishuLocalError {
  ok: false;
  reason_code: FeishuLocalReasonCode;
  message: string;
  target_device?: string;
}

export type FeishuLocalResult<T extends object = object> =
  | ({ ok: true; reason_code: FeishuLocalReasonCode } & T)
  | FeishuLocalError;
