import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  isLaterProcessThan,
  type DesktopProcessIdentity,
} from "./processIdentity.js";
import type { WorktreeManagerPorts } from "./managerPorts.js";
import type * as identity from "./processIdentity.js";
import { isManagedWorktreeDirectoryName } from "@cindy/maker-shared/worktree-paths";

interface RuntimeKeepSentinel {
  /** Older release receipts omit this and refer to the in-tree keep marker. */
  file?: string;
  content: string;
  /** Legacy numeric dev:ino:birthtimeMs, or lossless bigint:dev:ino:birthtimeNs. */
  identity: string;
}

/** A startup owns its own file, even when the business task id is reused. */
export interface WorktreeRuntimeLease {
  readonly file: string;
  readonly physicalPath: string;
  readonly keepSentinel?: RuntimeKeepSentinel;
}
export function managedWorktreeRoot(value: string): string | null {
    let current = path.resolve(value);
    for (;;) {
      const parent = path.dirname(current);
      if (isManagedWorktreeDirectoryName(path.basename(parent))) return current;
      if (parent === current) return null;
      current = parent;
    }
  }

// Ownership is process-wide: separate account/host factories can read the same leases.
/** How often Main refreshes the modification time of the leases it holds, as a liveness heartbeat. */
const LEASE_HEARTBEAT_MS = 5 * 60_000;
/** Lease files this process published and has not released. */
const heldLeaseFiles = new Set<string>();
let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;

function holdLeaseFile(file: string): void {
  heldLeaseFiles.add(file);
  if (leaseHeartbeat) return;
  leaseHeartbeat = setInterval(() => {
    const now = new Date();
    for (const held of heldLeaseFiles)
      void fs.utimes(held, now, now).catch(() => undefined);
  }, LEASE_HEARTBEAT_MS);
  leaseHeartbeat.unref?.();
}

function dropLeaseFile(file: string): void {
  heldLeaseFiles.delete(file);
  if (heldLeaseFiles.size || !leaseHeartbeat) return;
  clearInterval(leaseHeartbeat);
  leaseHeartbeat = null;
}

export function createWorktreeRuntimeLeases(
  ports: Pick<
    WorktreeManagerPorts,
    "physicalWorktreeKey" | "withWorktreeResourceLock"
  > & {
    userDataRoot(): string;
    appDataRoot(): string;
    publishShared?: boolean;
    notifyWorktreeRecycleOpportunity(path: string): void;
    readDesktopProcessIdentity: typeof identity.readDesktopProcessIdentity;
    isReusedDesktopInstancePid: typeof identity.isReusedDesktopInstancePid;
    isGitProcessTreeAlive(pid: number): Promise<boolean>;
  },
) {
  const {
    physicalWorktreeKey,
    withWorktreeResourceLock,
    notifyWorktreeRecycleOpportunity,
    readDesktopProcessIdentity,
    isReusedDesktopInstancePid,
    isGitProcessTreeAlive,
  } = ports;

  function runtimeRoot(): string {
    return path.join(ports.userDataRoot(), "worktree-runtime-leases");
  }

  /** Older clients may still hold cross-profile leases; keep reading/retrying them. */
  function sharedRuntimeRoot(): string {
    return path.join(
      ports.appDataRoot(),
      "Cindy",
      "shared-worktree-runtime-leases",
    );
  }

  /** Map a local cwd (including descendants) to its managed resource. SSH callers skip this helper. */

  function leaseFile(sessionId: string, directory: string): string {
    const key = createHash("sha256")
      .update(`${sessionId}:${randomUUID()}`)
      .digest("hex");
    return path.join(directory, `${process.pid}-${key}.json`);
  }

  const leaseNamePattern = /^\d+-[a-f0-9]{64}\.json$/;

  const releaseRequestPattern = /^\d+-[a-f0-9]{64}\.json\.release$/;

  async function acquireWorktreeRuntimeLease(
    sessionId: string,
    cwd: string,
  ): Promise<WorktreeRuntimeLease | null> {
    const root = managedWorktreeRoot(cwd);
    if (!root) return null;
    return withWorktreeResourceLock(root, async () => {
      return publishRuntimeLease(
        sessionId,
        await physicalWorktreeKey(root),
        ports.publishShared ? sharedRuntimeRoot() : runtimeRoot(),
      );
    });
  }

  /** Bounds how long the first acquisition waits for this process's own OS identity. */
  const OWN_IDENTITY_WAIT_MS = 2_000;
  let ownIdentity: Promise<DesktopProcessIdentity | null> | null = null;

  /**
   * This Main's OS birth time and executable, probed once. Readers compare it with the process
   * now holding the PID. Unavailable within the bound, the lease omits it and readers fall back
   * to its modification time.
   */
  async function ownProcessIdentity(): Promise<DesktopProcessIdentity | null> {
    ownIdentity ??= readDesktopProcessIdentity(process.pid).catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), OWN_IDENTITY_WAIT_MS);
    });
    try {
      return await Promise.race([ownIdentity, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function publishRuntimeLease(
    sessionId: string,
    physicalPath: string,
    directory: string,
  ): Promise<WorktreeRuntimeLease> {
    await fs.mkdir(directory, { recursive: true });
    const lease = { file: leaseFile(sessionId, directory), physicalPath };
    const processIdentity = (await ownProcessIdentity()) ?? undefined;
    // A partial write is intentionally unreadable, hence protective to deletion.
    try {
      // heartbeatMs tells readers that the modification time tracks when this Main was last alive.
      await fs.writeFile(
        lease.file,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          path: physicalPath,
          heartbeatMs: LEASE_HEARTBEAT_MS,
          processIdentity,
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      // Only this acquisition's partial write may be removed.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await fs.unlink(lease.file).catch(() => undefined);
      }
      throw error;
    }
    holdLeaseFile(lease.file);
    return lease;
  }

  /** Called under the same physical lock as acquisition and old owner recyclers. */
  async function releaseRuntimeKeepSentinel(
    lease: WorktreeRuntimeLease,
  ): Promise<void> {
    const marker = lease.keepSentinel;
    if (!marker) return;
    const file = marker.file ?? path.join(lease.physicalPath, ".worktree-keep");
    try {
      if (marker.identity.startsWith("bigint:")) {
        const identity = await fs.lstat(file, { bigint: true });
        if (
          !identity.isFile() ||
          identity.isSymbolicLink() ||
          identity.ino === 0n ||
          `bigint:${identity.dev}:${identity.ino}:${identity.birthtimeNs}` !==
            marker.identity
        )
          return;
      } else {
        const identity = await fs.lstat(file);
        // NTFS file IDs can exceed Number's exact integer range, and replacement
        // files can inherit the old creation time. A rounded legacy ID cannot
        // prove ownership: preserve that marker rather than delete a user's lock.
        if (
          !identity.isFile() ||
          identity.isSymbolicLink() ||
          !Number.isSafeInteger(identity.ino) ||
          identity.ino <= 0 ||
          !Number.isSafeInteger(identity.dev) ||
          `${identity.dev}:${identity.ino}:${identity.birthtimeMs}` !==
            marker.identity
        )
          return;
      }
      if ((await fs.readFile(file, "utf8")) !== marker.content) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Every cross-profile borrower publishes here before creating/joining the
    // sentinel. Crashed borrowers remain references until explicit I/O teardown.
    const directory = path.dirname(lease.file);
    for (const name of await fs.readdir(directory)) {
      if (!leaseNamePattern.test(name) || name === path.basename(lease.file))
        continue;
      try {
        const other = JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8"),
        );
        if (other.version !== 1 || typeof other.path !== "string")
          throw new Error("unreadable worktree lease");
        if (other.path === lease.physicalPath) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await fs.unlink(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async function releaseWorktreeRuntimeLease(
    lease: WorktreeRuntimeLease,
  ): Promise<void> {
    dropLeaseFile(lease.file);
    await releaseRuntimeLeaseFile(lease);
  }

  /** Record the detached git child that is still using a checkout lease. */
  function recordWorktreeRuntimeLeaseChild(
    lease: WorktreeRuntimeLease,
    childPid: number,
  ): void {
    if (!Number.isInteger(childPid) || childPid <= 0) return;
    try {
      const value = JSON.parse(fsSync.readFileSync(lease.file, "utf8")) as {
        version?: unknown;
        pid?: unknown;
        path?: unknown;
        childPid?: unknown;
        childPids?: unknown;
      };
      if (
        value.version !== 1 ||
        value.pid !== process.pid ||
        value.path !== lease.physicalPath
      )
        return;
      const childPids = [
        ...(Array.isArray(value.childPids) ? value.childPids : []),
        ...(typeof value.childPid === "number" ? [value.childPid] : []),
        childPid,
      ].filter(
        (pid, index, all): pid is number =>
          Number.isInteger(pid) && pid > 0 && all.indexOf(pid) === index,
      );
      fsSync.writeFileSync(
        lease.file,
        JSON.stringify({ ...value, childPid, childPids }),
        { mode: 0o600 },
      );
    } catch {
      // Missing or partially written child evidence must stay protective.
    }
  }

  async function removeRuntimeLeaseFile(
    lease: WorktreeRuntimeLease,
  ): Promise<void> {
    if (lease.keepSentinel) {
      await withWorktreeResourceLock(lease.physicalPath, async () => {
        await releaseRuntimeKeepSentinel(lease);
        await fs.unlink(lease.file);
      });
    } else await fs.unlink(lease.file);
  }

  async function releaseRuntimeLeaseFile(
    lease: WorktreeRuntimeLease,
  ): Promise<void> {
    try {
      await removeRuntimeLeaseFile(lease);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.unlink(`${lease.file}.release`).catch(() => undefined);
        return;
      }
      // Keep an explicit, durable intent. The lease itself remains protective until
      // a later maintenance pass can prove that this terminal cleanup succeeded.
      try {
        await fs.mkdir(path.dirname(lease.file), { recursive: true });
        await fs.writeFile(
          `${lease.file}.release`,
          JSON.stringify({
            version: 1,
            file: lease.file,
            path: lease.physicalPath,
            keepSentinel: lease.keepSentinel,
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        /* preserving the lease is the safe fallback */
      }
      // Wake the event-driven maintenance loop; it will retry the durable intent
      // while the still-present lease continues to protect the worktree.
      notifyWorktreeRecycleOpportunity(lease.physicalPath);
      throw error;
    }
    await fs.unlink(`${lease.file}.release`).catch(() => undefined);
    notifyWorktreeRecycleOpportunity(lease.physicalPath);
  }

  /** Retry only release intents written by a terminal close path. Unknown files stay protective. */
  async function retryPendingWorktreeRuntimeLeaseReleases(): Promise<number> {
    let pending = 0;
    for (const directory of [runtimeRoot(), sharedRuntimeRoot()]) {
      pending += await retryPendingRuntimeLeaseReleasesIn(directory);
    }
    return pending;
  }

  async function retryPendingRuntimeLeaseReleasesIn(
    directory: string,
  ): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let pending = 0;
    for (const name of names.filter((value) =>
      releaseRequestPattern.test(value),
    )) {
      const requestFile = path.join(directory, name);
      try {
        const request = JSON.parse(await fs.readFile(requestFile, "utf8")) as {
          version?: number;
          file?: string;
          path?: string;
          keepSentinel?: RuntimeKeepSentinel;
        };
        if (
          request.version !== 1 ||
          typeof request.file !== "string" ||
          typeof request.path !== "string" ||
          path.dirname(request.file) !== directory ||
          !leaseNamePattern.test(path.basename(request.file)) ||
          (request.keepSentinel !== undefined &&
            (!request.keepSentinel ||
              typeof request.keepSentinel.content !== "string" ||
              typeof request.keepSentinel.identity !== "string" ||
              (request.keepSentinel.file !== undefined &&
                (typeof request.keepSentinel.file !== "string" ||
                  !path.isAbsolute(request.keepSentinel.file) ||
                  path.basename(request.keepSentinel.file) !== "locked"))))
        ) {
          pending++;
          continue;
        }
        try {
          await removeRuntimeLeaseFile({
            file: request.file,
            physicalPath: request.path,
            keepSentinel: request.keepSentinel,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            pending++;
            continue;
          }
        }
        await fs.unlink(requestFile).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        notifyWorktreeRecycleOpportunity(request.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") pending++;
      }
    }
    return pending;
  }

  function pidMayBeAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /** Generous margin for clock corrections after boot; only clearly older evidence is waived. */
  const BOOT_MARGIN_MS = 10 * 60_000;
  /**
   * Once Main is gone, an agent it started gets no further input and settles well within this.
   * Counted from the lease's last heartbeat, i.e. from when its Main was last known alive.
   */
  const ABANDONED_LEASE_GRACE_MS = 60 * 60_000;
  /** Older clients wrote no heartbeat: their modification time is only the acquisition time. */
  const LEGACY_ABANDONED_LEASE_GRACE_MS = 24 * 60 * 60_000;

  function startedBeforeBoot(timestampMs: unknown): boolean {
    return (
      typeof timestampMs === "number" &&
      Number.isFinite(timestampMs) &&
      timestampMs < Date.now() - os.uptime() * 1000 - BOOT_MARGIN_MS
    );
  }

  const isPid = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

  /**
   * Evidence (PID and stamp) whose writer is proven gone. Only that answer is cached: once the
   * writer has exited it stays gone, while "may still be the writer" must be asked again.
   */
  const goneWriterCache = new Set<string>();

  /**
   * Whether `pid` may be the process that last touched evidence stamped at `stampedAtMs`.
   * A live process born clearly after the writer cannot be it (PID reuse). A lease is written
   * by its own process and never adopted, so no executable name is exempt, unlike instance
   * registrations. The writer's recorded OS identity is compared when present: both times come
   * from the OS, so a clock corrected after the writer started cannot misjudge it. Older leases
   * compare against the stamp. An unknown identity stays protective.
   */
  async function mayBeEvidenceWriter(
    pid: number,
    stampedAtMs: number,
    writerIdentity?: unknown,
  ): Promise<boolean> {
    if (!pidMayBeAlive(pid)) return false;
    const recorded =
      writerIdentity === undefined
        ? { startedAtMs: stampedAtMs }
        : { processIdentity: writerIdentity };
    const key = `${pid}:${JSON.stringify(recorded)}`;
    if (goneWriterCache.has(key)) return false;
    const identity = await readDesktopProcessIdentity(pid);
    if (!pidMayBeAlive(pid)) return false;
    if (!identity || !isLaterProcessThan(recorded, identity)) return true;
    if (goneWriterCache.size > 512) goneWriterCache.clear();
    goneWriterCache.add(key);
    return false;
  }

  /**
   * A lease its Main never released, once no process that could still write is left: the owner
   * and recorded children have exited (or their PIDs were reused), and the lease predates this
   * boot or has gone without a heartbeat for the grace period. Live compatible Cindy instances
   * and leases this process holds always stay protective.
   */
  async function isAbandonedLease(
    file: string,
    lease: {
      pid?: unknown;
      processIdentity?: unknown;
      childPid?: unknown;
      childPids?: unknown;
      heartbeatMs?: unknown;
    },
    liveInstancePids: ReadonlySet<number>,
  ): Promise<boolean> {
    if (
      !isPid(lease.pid) ||
      (lease.pid === process.pid && heldLeaseFiles.has(file))
    )
      return false;
    // This process holds every lease it wrote; one with its PID was left by an earlier process.
    if (lease.pid !== process.pid && liveInstancePids.has(lease.pid))
      return false;
    const { mtimeMs } = await fs.stat(file);
    if (
      lease.pid !== process.pid &&
      (await mayBeEvidenceWriter(lease.pid, mtimeMs, lease.processIdentity))
    )
      return false;
    // Unknown child evidence stays protective, like the explicit orphan reclaim path.
    const children = [
      lease.childPid,
      ...(Array.isArray(lease.childPids) ? lease.childPids : []),
    ];
    for (const child of children) {
      if (child == null) continue;
      if (!isPid(child) || (await mayBeEvidenceWriter(child, mtimeMs)))
        return false;
    }
    if (startedBeforeBoot(mtimeMs)) return true;
    const grace =
      typeof lease.heartbeatMs === "number"
        ? ABANDONED_LEASE_GRACE_MS
        : LEGACY_ABANDONED_LEASE_GRACE_MS;
    return Date.now() - mtimeMs > grace;
  }

  /** Unknown/older live instances keep terminal task references protected. */
  async function readWorktreeRuntimePaths(): Promise<Set<string> | null> {
    const registry = path.join(ports.userDataRoot(), ".dev-instances");
    const names = new Set(
      (await fs.readdir(registry)).map((name) => name.replace(/\.bak$/, "")),
    );
    const compatiblePids = new Set([process.pid]);
    const reusedInstanceRecords = new Map<number, string>();
    const readRecord = async (name: string): Promise<string> => {
      try {
        return await fs.readFile(path.join(registry, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return fs.readFile(path.join(registry, `${name}.bak`), "utf8");
      }
    };
    for (const name of names) {
      const match = /^(\d+)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid || !pidMayBeAlive(pid)) continue;
      try {
        const raw = await readRecord(name);
        const record = JSON.parse(raw);
        if (!record || record.pid !== pid) return null;
        // Only unsupported instances can block the entire lease view. Do not add
        // an OS subprocess per compatible instance to the normal recycle path.
        if (record.worktreeLeaseProtocol !== 1) {
          // Always re-query: a replacement Cindy may hold this PID before it registers.
          const identity = await readDesktopProcessIdentity(pid);
          // A replacement instance may have registered while the OS query ran.
          if ((await readRecord(name)) !== raw) return null;
          if (!pidMayBeAlive(pid)) continue;
          // A later OS birth proves the PID was reused. When the identity query fails (it can
          // time out), a registration from before this boot is still enough: that instance
          // cannot be running now. The SingletonLock check below revalidates before waiving it.
          if (
            identity
              ? isReusedDesktopInstancePid(record, identity)
              : startedBeforeBoot(record.startedAtMs)
          ) {
            reusedInstanceRecords.set(pid, raw);
            continue;
          }
        }
        if (record.worktreeLeaseProtocol !== 1 || record.pid !== pid)
          return null;
        compatiblePids.add(pid);
      } catch {
        return null;
      }
    }
    if (process.platform !== "win32") {
      try {
        const target = await fs.readlink(
          path.join(ports.userDataRoot(), "SingletonLock"),
        );
        const match = /-(\d+)$/.exec(target);
        if (!match) return null;
        const pid = Number(match[1]);
        if (pidMayBeAlive(pid) && !compatiblePids.has(pid)) {
          const raw = reusedInstanceRecords.get(pid);
          if (!raw) return null;
          // A stale SingletonLock can reference the same reused PID as an old
          // registration. Revalidate before waiving it: another runtime or lock
          // owner may have appeared since the registry scan. Child leases below
          // remain independent protection, even when this lock is proven stale.
          try {
            const identity = await readDesktopProcessIdentity(pid);
            if (
              !identity ||
              !isReusedDesktopInstancePid(JSON.parse(raw), identity) ||
              (await readRecord(`${pid}.json`)) !== raw ||
              (await fs.readlink(
                path.join(ports.userDataRoot(), "SingletonLock"),
              )) !== target
            )
              return null;
          } catch {
            return null;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
    }
    const paths = new Set<string>();
    for (const directory of [runtimeRoot(), sharedRuntimeRoot()]) {
      let leases: string[];
      try {
        leases = await fs.readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of leases) {
        if (!leaseNamePattern.test(name)) continue;
        // Main may have crashed while a detached child still uses the directory.
        // Explicit release proves source I/O stopped; otherwise only a reboot or an
        // exited owner past the grace period does, across every profile.
        try {
          const file = path.join(directory, name);
          const lease = JSON.parse(await fs.readFile(file, "utf8"));
          if (lease.version !== 1 || typeof lease.path !== "string")
            return null;
          if (await isAbandonedLease(file, lease, compatiblePids)) continue;
          paths.add(lease.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        }
      }
    }
    return paths;
  }

  /** A detached checkout can outlive git while its POSIX process group remains active. */
  /**
   * Remove runtime leases left by a dead owner for an explicitly cancelled,
   * unclaimed pre-created worktree.
   *
   * Normal recycle deliberately keeps leases from dead processes because they
   * may belong to a detached child.  A pre-created worktree has no claimed
   * session yet, and the caller has already fenced late creation under the
   * session lock. Reclaim only a recorded checkout child whose owner and child
   * have both exited. Older leases without child evidence, malformed records,
   * and unknown process liveness remain protective.
   */
  async function reclaimOrphanedWorktreeRuntimeLeases(
    worktreePath: string,
  ): Promise<number> {
    const target = await physicalWorktreeKey(worktreePath);
    let reclaimed = 0;
    for (const directory of [runtimeRoot(), sharedRuntimeRoot()]) {
      let names: string[];
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        continue;
      }
      for (const name of names) {
        if (!leaseNamePattern.test(name)) continue;
        const file = path.join(directory, name);
        try {
          const value = JSON.parse(await fs.readFile(file, "utf8")) as {
            version?: unknown;
            pid?: unknown;
            path?: unknown;
            childPid?: unknown;
            childPids?: unknown;
          };
          const childPids = Array.isArray(value.childPids)
            ? value.childPids.filter(
                (pid): pid is number =>
                  typeof pid === "number" && Number.isInteger(pid) && pid > 0,
              )
            : typeof value.childPid === "number" &&
                Number.isInteger(value.childPid) &&
                value.childPid > 0
              ? [value.childPid]
              : [];
          if (
            value.version !== 1 ||
            typeof value.pid !== "number" ||
            !Number.isInteger(value.pid) ||
            value.pid <= 0 ||
            typeof value.path !== "string" ||
            (await physicalWorktreeKey(value.path)) !== target ||
            pidMayBeAlive(value.pid) ||
            childPids.length === 0 ||
            (await Promise.all(
              childPids.map((pid) => isGitProcessTreeAlive(pid)),
            ).then((alive) => alive.some(Boolean)))
          ) {
            continue;
          }
          await fs.unlink(file);
          reclaimed += 1;
        } catch (error) {
          // A concurrent release may win the race.  Any other read/parse/write
          // failure stays protective and is retried by the normal maintenance
          // path rather than authorizing deletion.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
      }
    }
    return reclaimed;
  }
  return {
    managedWorktreeRoot,
    acquireWorktreeRuntimeLease,
    releaseWorktreeRuntimeLease,
    recordWorktreeRuntimeLeaseChild,
    retryPendingWorktreeRuntimeLeaseReleases,
    readWorktreeRuntimePaths,
    reclaimOrphanedWorktreeRuntimeLeases,
  };
}
