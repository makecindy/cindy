import path from "node:path";

const XCODEBUILD = "/usr/bin/xcodebuild";
const WDA_SCHEME = "WebDriverAgentRunner";
const SAFE_WDA_ENV_KEYS = [
  "DEVELOPER_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

export interface WdaCommandPlan {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface WdaBuildPlan {
  projectPath: string;
  scheme: string;
  build: WdaCommandPlan;
  launch: WdaCommandPlan;
  controlPort: number;
  mjpegPort: number;
}

export interface CreateWdaBuildPlanOptions {
  checkoutPath: string;
  derivedDataPath: string;
  simulatorUdid: string;
  ownerFingerprint: string;
  architecture?: "arm64" | "x86_64";
  controlPort?: number;
  mjpegPort?: number;
}

function requireAbsolute(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate))
    throw new Error(`${label} must be an absolute path`);
  return path.normalize(candidate);
}

function requirePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1024 and 65535`);
  }
  return value;
}

function requireUdid(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)) {
    throw new Error("simulatorUdid must be an exact simulator UUID");
  }
  return normalized;
}

function requireOwnerFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("ownerFingerprint must be an exact SHA-256 hex digest");
  }
  return normalized;
}

/**
 * Xcode schemes may print their environment. Copy only host values required by
 * Apple tooling so API keys and unrelated app secrets cannot enter build logs.
 */
export function createWdaChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_WDA_ENV_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  environment.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  return { ...environment, ...overrides };
}

/** Build exact argv plans; callers own process lifetime and bounded log capture. */
export function createWdaBuildPlan(
  options: CreateWdaBuildPlanOptions,
): WdaBuildPlan {
  const checkoutPath = requireAbsolute(options.checkoutPath, "checkoutPath");
  const derivedDataPath = requireAbsolute(
    options.derivedDataPath,
    "derivedDataPath",
  );
  const simulatorUdid = requireUdid(options.simulatorUdid);
  const ownerFingerprint = requireOwnerFingerprint(options.ownerFingerprint);
  const architecture =
    options.architecture ?? (process.arch === "x64" ? "x86_64" : "arm64");
  const controlPort = requirePort(options.controlPort ?? 8100, "controlPort");
  const mjpegPort = requirePort(options.mjpegPort ?? 9100, "mjpegPort");
  if (controlPort === mjpegPort)
    throw new Error("controlPort and mjpegPort must differ");

  const projectPath = path.join(checkoutPath, "WebDriverAgent.xcodeproj");
  const sharedArgs = [
    "-quiet",
    "-project",
    projectPath,
    "-scheme",
    WDA_SCHEME,
    "-destination",
    `platform=iOS Simulator,id=${simulatorUdid},arch=${architecture}`,
    "-derivedDataPath",
    derivedDataPath,
  ];
  const buildSettings = [
    "CODE_SIGNING_ALLOWED=NO",
    "COMPILER_INDEX_STORE_ENABLE=NO",
    `CINDY_WDA_OWNER_FINGERPRINT=${ownerFingerprint}`,
    // The bundled WDA scheme forwards this existing build setting into the
    // independent Simulator runner environment. It lets crash recovery prove
    // ownership without persisting or trusting a PID.
    `UPGRADE_TIMESTAMP=${ownerFingerprint}`,
  ];

  return {
    projectPath,
    scheme: WDA_SCHEME,
    controlPort,
    mjpegPort,
    build: {
      command: XCODEBUILD,
      args: [...sharedArgs, "build-for-testing", ...buildSettings],
      cwd: checkoutPath,
      env: createWdaChildEnvironment(),
    },
    launch: {
      command: XCODEBUILD,
      args: [...sharedArgs, "test-without-building", ...buildSettings],
      cwd: checkoutPath,
      env: createWdaChildEnvironment(process.env, {
        USE_PORT: String(controlPort),
        MJPEG_SERVER_PORT: String(mjpegPort),
      }),
    },
  };
}
