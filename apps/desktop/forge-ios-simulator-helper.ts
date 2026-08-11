import * as fs from 'node:fs';
import * as path from 'node:path';

const IOS_SIMULATOR_HELPER_BUNDLE = 'Cindy iOS Simulator Helper.app';
const IOS_SIMULATOR_HELPER_EXECUTABLE = 'ios-simulator-sidecar';
const IOS_SIMULATOR_HELPER_BUILD_RESULT = 'build-result.json';
const IOS_SIMULATOR_PACKAGED_BUILD_RESULT = 'native-helper-build-result.json';
const IOS_SIMULATOR_HELPER_UNSUPPORTED_REASON = 'simulator-kit-architecture-unavailable';

type IOSSimulatorHelperBuildResult =
  | {
      schemaVersion: 1;
      status: 'built';
      targetArchitecture: 'arm64' | 'x86_64' | 'universal';
      simulatorKitArchitectures: string[];
    }
  | {
      schemaVersion: 1;
      status: 'unsupported';
      targetArchitecture: 'x86_64';
      reason: typeof IOS_SIMULATOR_HELPER_UNSUPPORTED_REASON;
      simulatorKitArchitectures: string[];
    };

function expectedHelperArchitecture(arch: string): 'arm64' | 'x86_64' | 'universal' {
  switch (arch) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'x86_64';
    case 'universal':
      return 'universal';
    default:
      throw new Error(`[forge:postPackage] unsupported iOS Simulator helper arch: ${arch}`);
  }
}

function simulatorKitSupportsArchitecture(architectures: string[], target: string): boolean {
  if (target === 'arm64') {
    return architectures.includes('arm64') || architectures.includes('arm64e');
  }
  return architectures.includes(target);
}

function readBuildResult(resultPath: string): IOSSimulatorHelperBuildResult {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `[forge:postPackage] invalid iOS Simulator helper build result at ${resultPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== 'object') {
    throw new Error(
      `[forge:postPackage] invalid iOS Simulator helper build result at ${resultPath}`,
    );
  }
  const result = value as Record<string, unknown>;
  const simulatorKitArchitectures = Array.isArray(result.simulatorKitArchitectures)
    ? result.simulatorKitArchitectures
    : null;
  const commonValid =
    result.schemaVersion === 1 &&
    simulatorKitArchitectures !== null &&
    simulatorKitArchitectures.every((item) => typeof item === 'string');
  const builtValid =
    result.status === 'built' &&
    (result.targetArchitecture === 'arm64' ||
      result.targetArchitecture === 'x86_64' ||
      result.targetArchitecture === 'universal');
  const unsupportedValid =
    result.status === 'unsupported' &&
    result.targetArchitecture === 'x86_64' &&
    result.reason === IOS_SIMULATOR_HELPER_UNSUPPORTED_REASON &&
    simulatorKitArchitectures !== null &&
    simulatorKitArchitectures.length > 0 &&
    !simulatorKitArchitectures.includes('x86_64');
  if (!commonValid || (!builtValid && !unsupportedValid)) {
    throw new Error(
      `[forge:postPackage] invalid iOS Simulator helper build result at ${resultPath}`,
    );
  }
  const typedResult = result as IOSSimulatorHelperBuildResult;
  if (typedResult.status === 'built') {
    const requiredArchitectures =
      typedResult.targetArchitecture === 'universal'
        ? ['x86_64', 'arm64']
        : [typedResult.targetArchitecture];
    if (
      requiredArchitectures.some(
        (target) =>
          !simulatorKitSupportsArchitecture(typedResult.simulatorKitArchitectures, target),
      )
    ) {
      throw new Error(`[forge:postPackage] invalid iOS Simulator helper build result at ${resultPath}`);
    }
  }
  return typedResult;
}

/**
 * Moves a successfully built Helper into the nested-code location. A missing
 * Helper is accepted only when the build script emitted the exact x86_64
 * unsupported result; all other missing or malformed artifacts fail closed.
 */
export function stageMacIOSSimulatorHelper(
  buildPath: string,
  platform: string,
  arch: string,
): void {
  if (platform !== 'darwin' && platform !== 'mas') return;
  const expectedArchitecture = expectedHelperArchitecture(arch);
  const apps = fs.readdirSync(buildPath).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) {
    throw new Error(
      `[forge:postPackage] expected one macOS app while staging iOS Simulator helper, found ${apps.length}`,
    );
  }

  const appContents = path.join(buildPath, apps[0], 'Contents');
  const resourceRoot = path.join(appContents, 'Resources', 'ios-simulator');
  const sourceRoot = path.join(resourceRoot, 'helper');
  const sourceBundle = path.join(sourceRoot, IOS_SIMULATOR_HELPER_BUNDLE);
  const destinationBundle = path.join(appContents, 'Helpers', IOS_SIMULATOR_HELPER_BUNDLE);
  const sourceExecutable = path.join(
    sourceBundle,
    'Contents',
    'MacOS',
    IOS_SIMULATOR_HELPER_EXECUTABLE,
  );
  const sourceBuildResultPath = path.join(sourceRoot, IOS_SIMULATOR_HELPER_BUILD_RESULT);
  const packagedBuildResultPath = path.join(resourceRoot, IOS_SIMULATOR_PACKAGED_BUILD_RESULT);
  if (!fs.existsSync(sourceBuildResultPath)) {
    throw new Error(
      `[forge:postPackage] iOS Simulator helper build result missing at ${sourceBuildResultPath}`,
    );
  }
  const buildResult = readBuildResult(sourceBuildResultPath);
  if (buildResult.targetArchitecture !== expectedArchitecture) {
    throw new Error(
      `[forge:postPackage] iOS Simulator helper build result targets ${buildResult.targetArchitecture}, expected ${expectedArchitecture}`,
    );
  }

  fs.rmSync(packagedBuildResultPath, { force: true });
  if (buildResult.status === 'unsupported') {
    if (arch !== 'x64') {
      throw new Error(
        `[forge:postPackage] iOS Simulator helper fallback is allowed only for x64 packages, received ${arch}`,
      );
    }
    if (fs.existsSync(sourceExecutable)) {
      throw new Error(
        '[forge:postPackage] unsupported iOS Simulator helper result unexpectedly contains an executable',
      );
    }
    fs.mkdirSync(resourceRoot, { recursive: true });
    fs.writeFileSync(packagedBuildResultPath, `${JSON.stringify(buildResult, null, 2)}\n`, {
      mode: 0o644,
    });
    fs.rmSync(destinationBundle, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(path.join(resourceRoot, 'native'), { recursive: true, force: true });
    console.warn(
      `[forge:postPackage] skipped ${IOS_SIMULATOR_HELPER_BUNDLE}: x86_64 SimulatorKit slice unavailable; WDA/MJPEG remains packaged`,
    );
    return;
  }

  if (!fs.existsSync(sourceExecutable)) {
    throw new Error(
      `[forge:postPackage] staged iOS Simulator helper executable missing at ${sourceExecutable}`,
    );
  }
  fs.mkdirSync(path.dirname(destinationBundle), { recursive: true });
  fs.rmSync(destinationBundle, { recursive: true, force: true });
  fs.renameSync(sourceBundle, destinationBundle);
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  fs.rmSync(path.join(resourceRoot, 'native'), { recursive: true, force: true });
  fs.chmodSync(
    path.join(destinationBundle, 'Contents', 'MacOS', IOS_SIMULATOR_HELPER_EXECUTABLE),
    0o755,
  );
  console.log(
    `[forge:postPackage] staged ${IOS_SIMULATOR_HELPER_BUNDLE} in ${apps[0]}/Contents/Helpers`,
  );
}
