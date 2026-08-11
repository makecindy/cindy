import { WDA_SOURCE_PIN } from "./wda/source-pin.js";
import { IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_VERSION } from "./compatibility-matrix.js";
import {
  createIOSSimulatorRuntime,
  type CreateIOSSimulatorRuntimeOptions,
} from "./runtime.js";

/** A stable, redactable compatibility snapshot for smoke jobs and support reports. */
export interface IOSSimulatorCompatibilityReport {
  schemaVersion: 2;
  generatedAt: string;
  platform: NodeJS.Platform;
  host: {
    architecture: NodeJS.Architecture;
  };
  supported: boolean;
  ready: boolean;
  xcode: {
    version: string | null;
    productVersion: string | null;
    buildVersion: string | null;
    selectedDeveloperDir: string | null;
  };
  iosRuntimes: Array<{
    identifier: string;
    name: string;
    version: string | null;
    buildVersion: string | null;
    available: boolean;
  }>;
  simulatorDevices: {
    total: number;
    available: number;
    booted: number;
  };
  wda: {
    tag: string;
    revision: string;
    archiveSha256: string;
  };
  issue: string | null;
  error: string | null;
  setupSteps: string[];
  nativePolicy: {
    packagedDefault: "wda-mjpeg";
    h264DevOptIn: "CINDY_IOS_SIMULATOR_NATIVE_H264";
    hidDevOptIn: "CINDY_IOS_SIMULATOR_NATIVE_HID";
    admissionVersion: 1;
    packagedRequiresVerifiedArtifact: true;
    packagedRequiresEligibleMatrix: true;
    packagedPromotedRoute: "native-capability-auto";
    releaseCompatibilityVersion: number;
    productBgraStream: false;
  };
}

export interface CollectIOSSimulatorCompatibilityReportOptions extends CreateIOSSimulatorRuntimeOptions {
  architecture?: NodeJS.Architecture;
  now?: () => Date;
}

function parseXcodeVersion(value: string | null): {
  productVersion: string | null;
  buildVersion: string | null;
} {
  if (!value) return { productVersion: null, buildVersion: null };
  return {
    productVersion: value.match(/^Xcode\s+(.+)$/m)?.[1]?.trim() ?? null,
    buildVersion: value.match(/^Build version\s+(.+)$/m)?.[1]?.trim() ?? null,
  };
}

/** Collect the exact runtime inputs as a JSON-safe CI/support snapshot. */
export async function collectIOSSimulatorCompatibilityReport(
  options: CollectIOSSimulatorCompatibilityReportOptions = {},
): Promise<IOSSimulatorCompatibilityReport> {
  const environment = await createIOSSimulatorRuntime(options).inspect();
  const xcode = parseXcodeVersion(environment.xcodeVersion);
  return {
    schemaVersion: 2,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    platform: environment.platform,
    host: {
      architecture: options.architecture ?? process.arch,
    },
    supported: environment.supported,
    ready: environment.ready,
    xcode: {
      version: environment.xcodeVersion,
      ...xcode,
      selectedDeveloperDir: environment.xcodeSelectPath,
    },
    iosRuntimes: environment.runtimes.map((runtime) => ({
      identifier: runtime.identifier,
      name: runtime.name,
      version: runtime.version,
      buildVersion: runtime.buildVersion,
      available: runtime.isAvailable,
    })),
    simulatorDevices: {
      total: environment.devices.length,
      available: environment.devices.filter((device) => device.isAvailable)
        .length,
      booted: environment.devices.filter(
        (device) => device.isAvailable && device.state === "Booted",
      ).length,
    },
    wda: {
      tag: WDA_SOURCE_PIN.tag,
      revision: WDA_SOURCE_PIN.revision,
      archiveSha256: WDA_SOURCE_PIN.archiveSha256,
    },
    issue: environment.issue,
    error: environment.error,
    setupSteps: environment.setupSteps.slice(),
    nativePolicy: {
      packagedDefault: "wda-mjpeg",
      h264DevOptIn: "CINDY_IOS_SIMULATOR_NATIVE_H264",
      hidDevOptIn: "CINDY_IOS_SIMULATOR_NATIVE_HID",
      admissionVersion: 1,
      packagedRequiresVerifiedArtifact: true,
      packagedRequiresEligibleMatrix: true,
      packagedPromotedRoute: "native-capability-auto",
      releaseCompatibilityVersion:
        IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_VERSION,
      productBgraStream: false,
    },
  };
}
