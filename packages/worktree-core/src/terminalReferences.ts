import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorktreeSessionReference } from "./managerPorts.js";

/** Machine-local metadata only. No task messages, vaults, or harness credentials. */
export function terminalWorktreeProfileLocations(appDataRoot: string): string {
  return path.join(appDataRoot, "Cindy", "shared-worktree-terminal-profiles");
}

export function terminalWorktreeProfileId(profile: string): string {
  return createHash("sha256").update(path.resolve(profile)).digest("hex");
}

function directoryNames(directory: string): string[] {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("redirected terminal task catalog");
    return fs.readdirSync(directory).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function unchanged(directory: string, before: string[]): void {
  const after = directoryNames(directory);
  if (
    before.length !== after.length ||
    before.some((name, index) => name !== after[index])
  ) {
    throw new Error("terminal task catalog changed during scan");
  }
}

function readRecord(file: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error("invalid terminal task metadata");
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const after = fs.lstatSync(file);
  if (
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("terminal task metadata changed during scan");
  }
  return value as Record<string, unknown>;
}

export function readTerminalWorktreeProfiles(appDataRoot: string): string[] {
  const directory = terminalWorktreeProfileLocations(appDataRoot);
  const names = directoryNames(directory);
  const profiles = names
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      const record = readRecord(path.join(directory, name));
      if (
        record.version !== 1 ||
        typeof record.root !== "string" ||
        !path.isAbsolute(record.root) ||
        terminalWorktreeProfileId(record.root) + ".json" !== name
      )
        throw new Error("invalid terminal profile locator");
      return record.root;
    });
  unchanged(directory, names);
  return profiles;
}

/** Missing profiles are retired; present but unreadable metadata invalidates the
 * whole view. A directory is never freed on the strength of a partial catalog. */
export function readTerminalWorktreeOwnerRoots(appDataRoot: string): string[] {
  const ownerRoots: string[] = [];
  for (const profile of readTerminalWorktreeProfiles(appDataRoot)) {
    const owners = path.join(profile, "owners");
    const ownerNames = directoryNames(owners);
    for (const owner of ownerNames.filter((name) =>
      /^[a-f0-9]{32}$/.test(name),
    )) {
      const root = path.join(owners, owner);
      directoryNames(root); // A redirected owner is never trusted as an empty catalog.
      ownerRoots.push(root);
    }
    unchanged(owners, ownerNames);
  }
  return ownerRoots;
}

/** Read the original sessions database with the host's native SQLite binding. */
export function readTerminalWorktreeReferences(
  appDataRoot: string,
  readDatabase: (file: string) => WorktreeSessionReference[],
  currentOwnerRoot?: string,
): { rows: WorktreeSessionReference[]; ownerRoots: string[] } {
  const ownerRoots = readTerminalWorktreeOwnerRoots(appDataRoot);
  const rows: WorktreeSessionReference[] = [];
  for (const root of ownerRoots) {
    const databaseNames = () => directoryNames(root).filter(name => /^(?:cindy|xdt)-.+\.db$/.test(name));
    const names = databaseNames();
    for (const name of names) {
      const file = path.join(root, name);
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('invalid terminal task database');
      const references = readDatabase(file);
      const after = fs.lstatSync(file);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
        throw new Error('terminal task database replaced during scan');
      rows.push(...references.map(row => ({ ...row,
        currentDatabase: currentOwnerRoot !== undefined && path.resolve(root) === path.resolve(currentOwnerRoot),
      })));
    }
    const after = databaseNames();
    if (after.length !== names.length || after.some((name, index) => names[index] !== name))
      throw new Error('terminal task database catalog changed during scan');
  }
  return { rows, ownerRoots };
}
