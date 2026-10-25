import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { allUserDataDirNames } from "@cindy/maker-shared/brand-identity";
import {
  piSubagentLaunchFenceArtifact,
  piSubagentRunRoot,
} from "@cindy/maker-core/pi-subagent-runs";
import { worktreeReferenceQuery } from "@cindy/worktree-core/databaseReferences";
import { createPiWorktreeReferences } from "@cindy/worktree-core/piSubagentReferences";
import {
  readTerminalWorktreeReferences,
  readTerminalWorktreeOwnerRoots,
  terminalWorktreeProfileId,
  terminalWorktreeProfileLocations,
} from "@cindy/worktree-core/terminalReferences";
import type { WorktreeSessionReference } from "@cindy/worktree-core/managerPorts";
import { atomicPrivateWrite, privateDirectory } from "../platform.js";

export function desktopAppDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (!path.isAbsolute(root)) throw new Error("APP_DATA_ROOT_MUST_BE_ABSOLUTE");
  return root;
}

function names(directory: string): string[] {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("WORKTREE_REFERENCE_DIRECTORY_REDIRECTED");
    return fs.readdirSync(directory).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** All local owners supply deletion evidence, never credentials or messages. */
export class TerminalWorktreeReferences {
  readonly ready: Promise<void>;
  constructor(
    private readonly options: {
      profile: string;
      ownerRoot: string;
      appDataRoot: string;
      guard(): void;
      log: { warn(message: string): void };
      readRuntimePaths(root: string): Promise<ReadonlySet<string> | null>;
      extraPiHomes?(): Promise<string[]>;
    },
  ) {
    this.ready = this.publish();
  }

  private async publish(): Promise<void> {
    const directory = terminalWorktreeProfileLocations(
      this.options.appDataRoot,
    );
    await privateDirectory(directory);
    this.options.guard();
    await atomicPrivateWrite(
      path.join(
        directory,
        terminalWorktreeProfileId(this.options.profile) + ".json",
      ),
      JSON.stringify({ version: 1, root: path.resolve(this.options.profile) }),
    );
  }

  desktopRoots(): string[] {
    return [
      ...new Set(
        (["cn", "global", "dev"] as const).flatMap((region) =>
          allUserDataDirNames(region),
        ),
      ),
    ]
      .map((name) => path.join(this.options.appDataRoot, name))
      .filter((root) =>
        names(root).some(
          (name) =>
            name === ".dev-instances" ||
            name === "profiles" ||
            name === "SingletonLock" ||
            /^(?:cindy|xdt)-.+\.db$/.test(name),
        ),
      );
  }

  async readLocalWorktreeReferences(): Promise<WorktreeSessionReference[]> {
    await this.ready;
    this.options.guard();
    const rows = readTerminalWorktreeReferences(
      this.options.appDataRoot,
      (file) => {
        const db = new Database(file, { readonly: true, fileMustExist: true });
        try {
          return db.transaction(() => db.prepare(worktreeReferenceQuery(db)).all())() as WorktreeSessionReference[];
        } finally { db.close(); }
      },
      this.options.ownerRoot,
    ).rows;
    for (const root of this.desktopRoots()) {
      if (names(path.join(root, "profiles")).length)
        throw new Error("WORKTREE_DATABASE_CATALOG_UNSUPPORTED");
      const files = names(root).filter((name) =>
        /^(?:cindy|xdt)-.+\.db$/.test(name),
      );
      for (const name of files) {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("WORKTREE_DATABASE_REDIRECTED");
        const db = new Database(file, { readonly: true, fileMustExist: true });
        try {
          const references = db.transaction(() =>
            db.prepare(worktreeReferenceQuery(db)).all(),
          )() as WorktreeSessionReference[];
          rows.push(
            ...references.map((row) => ({ ...row, currentDatabase: false })),
          );
        } finally {
          db.close();
        }
      }
      const after = names(root).filter((name) =>
        /^(?:cindy|xdt)-.+\.db$/.test(name),
      );
      if (
        files.length !== after.length ||
        files.some((name, index) => name !== after[index])
      )
        throw new Error("WORKTREE_DATABASE_CATALOG_CHANGED");
    }
    this.options.guard();
    return rows;
  }

  async readWorktreeRuntimePaths(): Promise<ReadonlySet<string> | null> {
    await this.ready;
    this.options.guard();
    const roots = new Set([
      ...this.desktopRoots(),
      ...readTerminalWorktreeOwnerRoots(this.options.appDataRoot),
    ]);
    const paths = new Set<string>();
    for (const root of roots) {
      const view = await this.options.readRuntimePaths(root);
      if (!view) return null;
      for (const value of view) paths.add(value);
    }
    this.options.guard();
    return paths;
  }

  async readPiSubagentWorktreeReferences(): Promise<ReadonlyMap<
    string,
    readonly string[]
  > | null> {
    await this.ready;
    this.options.guard();
    const homes = new Set(
      this.desktopRoots().map((root) => path.join(root, "pi-agent-home")),
    );
    for (const root of readTerminalWorktreeOwnerRoots(this.options.appDataRoot)) {
      const engines = path.join(root, "engines", "pi");
      for (const task of names(engines)) homes.add(path.join(engines, task));
      const guests = path.join(root, "remote-agent", "guest-homes");
      for (const guest of names(guests))
        homes.add(path.join(guests, guest, "pi"));
    }
    for (const home of (await this.options.extraPiHomes?.()) ?? [])
      homes.add(home);
    const references = new Map<string, readonly string[]>();
    for (const home of homes) {
      const view = await createPiWorktreeReferences({
        agentHome: () => home,
        piSubagentLaunchFenceArtifact,
        piSubagentRunRoot,
        log: this.options.log,
      }).readPiSubagentWorktreeReferences();
      if (!view) return null;
      for (const [id, paths] of view)
        references.set(id, [
          ...new Set([...(references.get(id) ?? []), ...paths]),
        ]);
    }
    this.options.guard();
    return references;
  }
}
