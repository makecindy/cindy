import path from "node:path";

import type { IOSSimulatorCommandRunner } from "../types.js";
import { WdaError } from "./errors.js";
import { WDA_SOURCE_PIN } from "./source-pin.js";

const GIT = "/usr/bin/git";
const XCODEBUILD = "/usr/bin/xcodebuild";
const REQUIRED_SCHEME = "WebDriverAgentRunner";

export interface WdaCheckoutInspection {
  ready: boolean;
  checkoutPath: string;
  projectPath: string;
  revision: string | null;
  revisionMatches: boolean;
  schemes: string[];
  issue: "CHECKOUT_NOT_FOUND" | "REVISION_MISMATCH" | "SCHEME_NOT_FOUND" | null;
  error: string | null;
}

function failedInspection(
  checkoutPath: string,
  issue: Exclude<WdaCheckoutInspection["issue"], null>,
  error: string,
  partial: Partial<WdaCheckoutInspection> = {},
): WdaCheckoutInspection {
  return {
    ready: false,
    checkoutPath,
    projectPath: path.join(checkoutPath, "WebDriverAgent.xcodeproj"),
    revision: null,
    revisionMatches: false,
    schemes: [],
    issue,
    error,
    ...partial,
  };
}

/** Verify that an external checkout exactly matches Cindy's pin and exposes the expected scheme. */
export async function inspectWdaCheckout(
  rawCheckoutPath: string,
  runner: IOSSimulatorCommandRunner,
): Promise<WdaCheckoutInspection> {
  if (!path.isAbsolute(rawCheckoutPath)) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      "WDA checkout path must be absolute",
    );
  }
  const checkoutPath = path.normalize(rawCheckoutPath);
  const projectPath = path.join(checkoutPath, "WebDriverAgent.xcodeproj");
  const revisionResult = await runner.run(GIT, [
    "-C",
    checkoutPath,
    "rev-parse",
    "HEAD",
  ]);
  const revision = revisionResult.stdout.trim() || null;
  if (revisionResult.exitCode !== 0 || !revision) {
    return failedInspection(
      checkoutPath,
      "CHECKOUT_NOT_FOUND",
      revisionResult.stderr.trim() || "WDA checkout is not a Git repository",
    );
  }
  if (revision !== WDA_SOURCE_PIN.revision) {
    return failedInspection(
      checkoutPath,
      "REVISION_MISMATCH",
      `WDA revision mismatch: expected ${WDA_SOURCE_PIN.revision}, got ${revision}`,
      { revision },
    );
  }

  const projectResult = await runner.run(
    XCODEBUILD,
    ["-project", projectPath, "-list", "-json"],
    { timeoutMs: 60_000, maxBufferBytes: 2 * 1024 * 1024 },
  );
  if (projectResult.exitCode !== 0) {
    return failedInspection(
      checkoutPath,
      "CHECKOUT_NOT_FOUND",
      projectResult.stderr.trim() || "Unable to inspect the WDA Xcode project",
      { revision, revisionMatches: true },
    );
  }

  let schemes: string[] = [];
  try {
    const parsed = JSON.parse(projectResult.stdout) as {
      project?: { schemes?: unknown };
    };
    if (Array.isArray(parsed.project?.schemes)) {
      schemes = parsed.project.schemes.filter(
        (value): value is string => typeof value === "string",
      );
    }
  } catch {
    return failedInspection(
      checkoutPath,
      "SCHEME_NOT_FOUND",
      "xcodebuild returned invalid project JSON",
      { revision, revisionMatches: true },
    );
  }
  if (!schemes.includes(REQUIRED_SCHEME)) {
    return failedInspection(
      checkoutPath,
      "SCHEME_NOT_FOUND",
      `WDA checkout does not expose the ${REQUIRED_SCHEME} scheme`,
      { revision, revisionMatches: true, schemes },
    );
  }

  return {
    ready: true,
    checkoutPath,
    projectPath,
    revision,
    revisionMatches: true,
    schemes,
    issue: null,
    error: null,
  };
}
