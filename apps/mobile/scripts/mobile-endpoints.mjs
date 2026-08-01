/** Mobile/EAS 的客户端清单自举构建适配器。 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { mobileClientBundleEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';

/**
 * 临时向所有 EAS build profile 注入 region + 清单自举基址，并返回幂等恢复函数。
 * 真实 URL 只在构建工作区短暂出现，不进入 Git；恢复时逐字节写回原文件。
 */
export function injectMobileEndpointsIntoEasFile(
  easJsonPath,
  options = {},
) {
  const resolvedPath = resolve(easJsonPath);
  const lock = acquireEasFileLock(resolvedPath);
  let original;
  try {
    original = readFileSync(resolvedPath, 'utf8');
    const easJson = JSON.parse(original);
    if (!easJson.build || typeof easJson.build !== 'object' || Array.isArray(easJson.build)) {
      throw new Error(`eas.json 缺少 build profiles: ${resolvedPath}`);
    }
    const endpointEnvByRegion = options.endpointEnvByRegion ?? (
      options.endpointEnv
        ? null
        : {
            cn: mobileClientBundleEnv({ authRegion: 'cn' }),
            global: mobileClientBundleEnv({ authRegion: 'global' }),
            dev: mobileClientBundleEnv({ authRegion: 'dev' }),
          }
    );
    const fallbackEndpointEnv = options.endpointEnv ?? endpointEnvByRegion?.cn;
    for (const [profileName, profile] of Object.entries(easJson.build)) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
      const region = resolveProfileAuthRegion(easJson.build, profileName);
      const endpointEnv = endpointEnvByRegion?.[region] ?? fallbackEndpointEnv;
      profile.env = { ...(profile.env ?? {}), ...endpointEnv };
    }

    writeFileSync(resolvedPath, `${JSON.stringify(easJson, null, 2)}\n`);
  } catch (error) {
    lock.release();
    throw error;
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      writeFileSync(resolvedPath, original);
    } finally {
      lock.release();
    }
  };
}

const EAS_LOCK_WAIT_MS = 100;
const EAS_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * 通过 mkdir 的原子性串行化同一 checkout 的 release wrapper。
 * 锁覆盖整个注入生命周期，而不是只保护单次写入，避免两个进程分别保存不同原文后互相恢复。
 */
function acquireEasFileLock(easPath) {
  const lockPath = `${easPath}.xdt-lock`;
  const ownerPath = `${lockPath}/owner.json`;
  const reclaimPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  for (;;) {
    // A stale-lock reclaimer owns this marker while it removes the old lock.
    // Do not create a replacement lock in the small gap between rmSync(lockPath)
    // and the reclaimer releasing the marker.
    if (existsSync(reclaimPath)) {
      if (isEasReclaimStale(reclaimPath)) {
        reapStaleEasReclaimMarker(reclaimPath);
        continue;
      }
      waitForEasFileLock();
      continue;
    }
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      return {
        release() {
          try {
            const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
            if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // 锁目录已被清理或损坏时无需阻断发布收尾。
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' || !existsSync(lockPath)) throw error;
      if (isEasLockStale(lockPath, ownerPath)) {
        // Claim stale-lock cleanup with mkdir (an atomic cross-process
        // operation), then re-check before removing. A second waiter that
        // observed the same stale owner cannot remove a newly-created lock.
        try {
          mkdirSync(reclaimPath);
          writeFileSync(
            `${reclaimPath}/owner.json`,
            JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
          );
        } catch (reclaimError) {
          if (reclaimError?.code !== 'EEXIST') throw reclaimError;
          waitForEasFileLock();
          continue;
        }
        try {
          if (isEasLockStale(lockPath, ownerPath)) {
            rmSync(lockPath, { recursive: true, force: true });
          }
        } finally {
          rmSync(reclaimPath, { recursive: true, force: true });
        }
        continue;
      }
      waitForEasFileLock();
    }
  }
}

function waitForEasFileLock() {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, EAS_LOCK_WAIT_MS);
}

function isEasReclaimStale(reclaimPath) {
  const ownerPath = `${reclaimPath}/owner.json`;
  const now = Date.now();
  let owner;
  try {
    owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch {
    try {
      return now - statSync(reclaimPath).mtimeMs > EAS_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  // A reclaim section is synchronous and should never legitimately live for
  // the full stale window. Do not trust PID liveness beyond that bound:
  // operating systems may reuse the PID after the original process died.
  const ageMs = now - Number(owner.createdAt || 0);
  if (ageMs > EAS_LOCK_STALE_MS) return true;
  if (Number.isInteger(owner.pid)) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error?.code === 'EPERM') return false;
    }
  }
  return ageMs > EAS_LOCK_STALE_MS;
}

/**
 * Reap only the stale marker that was atomically renamed by this caller.
 * The tombstone path is unique, so a concurrent publisher can create a new
 * reclaim marker without being removed by this cleanup.
 */
function reapStaleEasReclaimMarker(reclaimPath) {
  const tombstonePath = `${reclaimPath}.${randomUUID()}.stale`;
  try {
    renameSync(reclaimPath, tombstonePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  rmSync(tombstonePath, { recursive: true, force: true });
}

function isEasLockStale(lockPath, ownerPath) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > EAS_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  if (Number.isInteger(owner.pid)) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error?.code === 'EPERM') return false;
    }
  }
  return Date.now() - Number(owner.createdAt || 0) > EAS_LOCK_STALE_MS;
}

function resolveProfileAuthRegion(buildProfiles, profileName, seen = new Set()) {
  if (seen.has(profileName)) {
    throw new Error(`Circular EAS profile extends: ${[...seen, profileName].join(' -> ')}`);
  }
  const profile = buildProfiles[profileName];
  const ownRegion = profile?.env?.EXPO_PUBLIC_CINDY_AUTH_REGION;
  if (ownRegion === 'cn' || ownRegion === 'global' || ownRegion === 'dev') return ownRegion;
  if (profile?.extends) {
    return resolveProfileAuthRegion(
      buildProfiles,
      profile.extends,
      new Set([...seen, profileName]),
    );
  }
  return 'cn';
}
