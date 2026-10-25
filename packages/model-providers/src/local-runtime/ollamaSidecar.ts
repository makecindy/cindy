import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { OLLAMA_LOOPBACK_ORIGIN } from "../localModelRuntime.js";

const MAX_WALK_DEPTH = 3;

export function ollamaRuntimeRoot(userDataDir: string): string {
  return path.join(userDataDir, "ollama-runtime");
}

export function sidecarManifestPath(userDataDir: string): string {
  return path.join(ollamaRuntimeRoot(userDataDir), "current.json");
}

export function sidecarBinaryPath(
  userDataDir: string,
  version: string,
): string {
  return path.join(ollamaRuntimeRoot(userDataDir), `v${version}`, "ollama");
}

export function findOllamaBinary(root: string, depth = 0): string | null {
  if (depth > MAX_WALK_DEPTH) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const files: string[] = [];
  const dirs: string[] = [];
  for (const name of entries) {
    const next = path.join(root, name);
    let stat;
    try {
      stat = statSync(next);
    } catch {
      continue;
    }
    if (stat.isFile() && (name === "ollama" || name === "ollama.exe"))
      files.push(next);
    else if (stat.isDirectory() && !name.startsWith(".")) dirs.push(next);
  }
  const preferredName = process.platform === "win32" ? "ollama.exe" : "ollama";
  const preferred = files.find((file) => path.basename(file) === preferredName);
  if (preferred) return preferred;
  if (files[0]) return files[0];
  for (const dir of dirs) {
    const hit = findOllamaBinary(dir, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function findInstalledSidecarBinary(userDataDir: string): string | null {
  try {
    const raw = JSON.parse(
      readFileSync(sidecarManifestPath(userDataDir), "utf8"),
    ) as {
      binary?: unknown;
    };
    if (typeof raw.binary === "string" && existsSync(raw.binary))
      return raw.binary;
  } catch {
    /* missing or invalid */
  }
  return null;
}

export function createOllamaSidecar(
  options: {
    env?: () => NodeJS.ProcessEnv;
    onDiagnostic?(message: string): void;
  } = {},
) {
  let sidecarChild: ChildProcess | null = null;

  function stopManagedSidecar(): void {
    if (!sidecarChild || sidecarChild.killed) {
      sidecarChild = null;
      return;
    }
    sidecarChild.kill("SIGTERM");
    sidecarChild = null;
  }

  function spawnManagedSidecar(
    binary: string,
    spawnImpl: typeof spawn = spawn,
  ): ChildProcess {
    stopManagedSidecar();
    const child = spawnImpl(binary, ["serve"], {
      stdio: options.onDiagnostic ? ["ignore", "ignore", "pipe"] : "ignore",
      windowsHide: true,
      env: {
        ...(options.env?.() ?? process.env),
        OLLAMA_HOST: OLLAMA_LOOPBACK_ORIGIN.replace(/^https?:\/\//, ""),
      },
    });
    child.stderr?.on("data", (chunk: Buffer) =>
      options.onDiagnostic?.(chunk.toString("utf8")),
    );
    child.on("error", (error: NodeJS.ErrnoException) => {
      options.onDiagnostic?.(`spawn: ${error.code ?? "unknown"}`);
      if (sidecarChild === child) sidecarChild = null;
    });
    child.on("exit", (code, signal) => {
      options.onDiagnostic?.(`exit: ${code ?? signal ?? "unknown"}`);
      if (sidecarChild === child) sidecarChild = null;
    });
    sidecarChild = child;
    return child;
  }

  async function stopManagedSidecarAndWait(): Promise<void> {
    const child = sidecarChild;
    sidecarChild = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        child.removeListener("close", done);
        child.removeListener("error", done);
        resolve();
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      timer.unref();
      child.once("close", done);
      child.once("error", done);
      child.kill("SIGTERM");
    });
  }
  let sidecarQuitHooked = false;

  function registerManagedSidecarQuitHook(
    register: (stop: () => void) => void,
  ): void {
    if (sidecarQuitHooked) return;
    sidecarQuitHooked = true;
    register(() => stopManagedSidecar());
  }

  return {
    stopManagedSidecar,
    stopManagedSidecarAndWait,
    managedSidecarRunning: () =>
      Boolean(
        sidecarChild &&
        sidecarChild.exitCode === null &&
        sidecarChild.signalCode === null &&
        !sidecarChild.killed,
      ),
    spawnManagedSidecar,
    registerManagedSidecarQuitHook,
  };
}
