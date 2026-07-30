/**
 * apps/desktop/src/main/maker-host/codex-auth-invalidation.ts
 *
 * Codex OAuth 凭证"系统失效标记"(auth-invalidated-system.json) 的读写与决策 ——
 * 从 auth-adapters 拆出来, 不依赖 Electron, 路径显式注入, 可单测。
 *
 * 标记语义: 服务端判定某份 OAuth token 失效 (refresh_token reuse / 401 reauth_required) 时,
 * 把当时 ~/.codex/auth.json 的文件指纹 (dev/ino/size/mtimeMs) 落盘。只要该指纹和当前系统
 * 文件仍然一致, 就说明 ~/.codex 里躺着的还是那份被判坏的 token —— reconcile 绝不能把它
 * 硬链回 codex-home 覆盖有效凭证。普通失效标记在指纹变化 (用户在本机 CLI 重登) 后过期；
 * 用户显式断开产生的 durable marker 是例外，系统 CLI 后续任何变化都不能自动接回。
 *
 * 背景 (2026-07-03 线上实踩):
 *   token 失效 → 用户在 Cindy 里重新授权成功 → 旧实现无条件清掉标记和 suppress →
 *   下一次 getState/getAuthEnv 的 reconcile 把 ~/.codex 里未变的坏 token 硬链回来,
 *   覆盖刚拿到的新 token → 服务端再次 invalidate → 授权界面「成功 → 几秒后失败」死循环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 用户主动断开 Cindy 内的 Codex OAuth；这是 durable sentinel：系统 CLI 后续刷新 / 重登
 * 也不能自动接回，只抑制凭证回灌，不作为鉴权错误展示。
 */
export const CODEX_USER_DISCONNECT_REASON = 'user_disconnected';

/** 失效标记文件内容: 失效原因 + 当时 ~/.codex/auth.json 的文件指纹。 */
export type InvalidatedSystemCodexAuthMarker = {
  reason: string;
  /** 用户曾在 Cindy 显式断开；后续 transient token invalidation 不得解除这道永久抑制。 */
  durableDisconnect?: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256?: string;
  localDev?: number;
  localIno?: number;
  localSize?: number;
  localMtimeMs?: number;
  localSha256?: string;
};

/** 标记文件路径: <codexHome>/auth-invalidated-system.json。 */
export function getCodexAuthInvalidationMarkerPath(codexHome: string): string {
  return path.join(codexHome, 'auth-invalidated-system.json');
}

/** 读标记; 文件缺失 / 损坏 / 字段不全时返回 null (损坏文件顺手删除, 自愈)。 */
export function readInvalidatedSystemCodexAuthMarker(
  codexHome: string,
): InvalidatedSystemCodexAuthMarker | null {
  const file = getCodexAuthInvalidationMarkerPath(codexHome);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(file, 'utf-8'),
    ) as Partial<InvalidatedSystemCodexAuthMarker>;
    const hasLocalFingerprint =
      parsed.localDev !== undefined ||
      parsed.localIno !== undefined ||
      parsed.localSize !== undefined ||
      parsed.localMtimeMs !== undefined ||
      parsed.localSha256 !== undefined;
    const validLocalFingerprint = !hasLocalFingerprint || (
      typeof parsed.localDev === 'number' &&
      typeof parsed.localIno === 'number' &&
      typeof parsed.localSize === 'number' &&
      typeof parsed.localMtimeMs === 'number' &&
      (parsed.localSha256 === undefined || typeof parsed.localSha256 === 'string')
    );
    const validDurableDisconnect =
      parsed.durableDisconnect === undefined || typeof parsed.durableDisconnect === 'boolean';
    if (
      typeof parsed.reason === 'string' &&
      validDurableDisconnect &&
      typeof parsed.dev === 'number' &&
      typeof parsed.ino === 'number' &&
      typeof parsed.size === 'number' &&
      typeof parsed.mtimeMs === 'number' &&
      (parsed.sha256 === undefined || typeof parsed.sha256 === 'string') &&
      validLocalFingerprint
    ) {
      return parsed as InvalidatedSystemCodexAuthMarker;
    }
  } catch {
    /* 解析失败按损坏处理, 走下方删除 */
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* no-op */
  }
  return null;
}

/** 兼容最初只靠 reason 表示的 user_disconnected marker。 */
function isDurableDisconnectMarker(marker: InvalidatedSystemCodexAuthMarker): boolean {
  return marker.reason === CODEX_USER_DISCONNECT_REASON || marker.durableDisconnect === true;
}

function currentAuthFileFingerprint(authPath: string): {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
} | null {
  try {
    const stat = fs.statSync(authPath);
    const bytes = fs.readFileSync(authPath);
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  }
}

/** 取当前系统 auth.json 的指纹; 文件不存在 / stat 失败返回 null。 */
export function currentSystemCodexAuthMarker(
  systemAuthPath: string,
  reason: string,
): InvalidatedSystemCodexAuthMarker | null {
  const fingerprint = currentAuthFileFingerprint(systemAuthPath);
  if (!fingerprint) return null;
  return { reason, ...fingerprint };
}

function fileMatchesInvalidatedMarker(
  marker: InvalidatedSystemCodexAuthMarker,
  authPath: string,
): boolean {
  try {
    const stat = fs.statSync(authPath);
    if (marker.sha256) {
      const bytes = fs.readFileSync(authPath);
      return createHash('sha256').update(bytes).digest('hex') === marker.sha256;
    }
    return (
      stat.dev === marker.dev &&
      stat.ino === marker.ino &&
      stat.size === marker.size &&
      stat.mtimeMs === marker.mtimeMs
    );
  } catch {
    return false;
  }
}

function localFileMatchesInvalidatedMarker(
  marker: InvalidatedSystemCodexAuthMarker,
  localAuthPath: string,
): boolean {
  if (marker.localSha256) {
    return currentAuthFileFingerprint(localAuthPath)?.sha256 === marker.localSha256;
  }
  if (
    marker.localDev == null ||
    marker.localIno == null ||
    marker.localSize == null ||
    marker.localMtimeMs == null
  ) {
    return false;
  }
  try {
    const stat = fs.statSync(localAuthPath);
    return (
      stat.dev === marker.localDev &&
      stat.ino === marker.localIno &&
      stat.size === marker.localSize &&
      stat.mtimeMs === marker.localMtimeMs
    );
  } catch {
    return false;
  }
}

/** 标记指纹是否仍与当前系统 auth.json 一致 (一致 = 那份坏 token 原封未动)。 */
export function markerMatchesCurrentSystemCodexAuth(
  marker: InvalidatedSystemCodexAuthMarker,
  systemAuthPath: string,
): boolean {
  if (isDurableDisconnectMarker(marker)) return true;
  const current = currentSystemCodexAuthMarker(systemAuthPath, marker.reason);
  return Boolean(
    current &&
    (marker.sha256
      ? current.sha256 === marker.sha256
      : current.dev === marker.dev &&
        current.ino === marker.ino &&
        current.size === marker.size &&
        current.mtimeMs === marker.mtimeMs),
  );
}

/**
 * 读出有效标记：普通失效标记须匹配当前系统 auth.json；用户主动断开 sentinel 永久有效。
 */
export function getActiveInvalidatedSystemCodexAuthMarker(
  codexHome: string,
  systemAuthPath: string,
): InvalidatedSystemCodexAuthMarker | null {
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  if (!marker) return null;
  if (markerMatchesCurrentSystemCodexAuth(marker, systemAuthPath)) return marker;
  clearInvalidatedSystemCodexAuthMarker(codexHome);
  return null;
}

/**
 * 写标记并返回是否落盘成功。普通失效标记依赖当前系统 auth.json 指纹；主动断开写 durable
 * sentinel，不要求系统文件存在。调用方可据返回值选择 fail-closed。
 */
export function writeInvalidatedSystemCodexAuthMarker(
  codexHome: string,
  systemAuthPath: string,
  reason: string,
  localAuthPath?: string,
): boolean {
  const previous = readInvalidatedSystemCodexAuthMarker(codexHome);
  const durableDisconnect =
    reason === CODEX_USER_DISCONNECT_REASON ||
    (previous !== null && isDurableDisconnectMarker(previous));
  // 主动断开不依赖系统文件当前是否存在，也不随其指纹变化失效；零值只是兼容既有 marker schema
  // 的 durable sentinel。已有 durable sentinel 后的普通 token invalidation 也继承该属性，
  // 即使系统文件暂时不存在也要把新的失败原因落盘，不能退回可自动 reconcile 的普通 marker。
  const marker = currentSystemCodexAuthMarker(systemAuthPath, reason) ?? (
    durableDisconnect
      ? { reason, dev: 0, ino: 0, size: 0, mtimeMs: 0 }
      : null
  );
  if (!marker) return false;
  if (durableDisconnect) marker.durableDisconnect = true;
  const localFingerprint = localAuthPath ? currentAuthFileFingerprint(localAuthPath) : null;
  if (localFingerprint) {
    marker.localDev = localFingerprint.dev;
    marker.localIno = localFingerprint.ino;
    marker.localSize = localFingerprint.size;
    marker.localMtimeMs = localFingerprint.mtimeMs;
    marker.localSha256 = localFingerprint.sha256;
  }
  const file = getCodexAuthInvalidationMarkerPath(codexHome);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 同目录临时文件 + rename：崩溃 / 磁盘写失败不能把已有 durable marker 截断成坏 JSON。
    fs.writeFileSync(tempFile, JSON.stringify(marker, null, 2), 'utf-8');
    fs.renameSync(tempFile, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      /* no-op */
    }
    return false;
  }
}

/** durable marker 记录的正是当前残留 local auth 时，该文件属于未完成登出的旧凭证。 */
export function shouldSuppressLocalCodexAuth(
  codexHome: string,
  localAuthPath: string,
): boolean {
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  return Boolean(
    marker &&
    isDurableDisconnectMarker(marker) &&
    localFileMatchesInvalidatedMarker(marker, localAuthPath),
  );
}

/** 删标记 (幂等)。 */
export function clearInvalidatedSystemCodexAuthMarker(codexHome: string): void {
  try {
    fs.unlinkSync(getCodexAuthInvalidationMarkerPath(codexHome));
  } catch {
    /* no-op */
  }
}

/**
 * 登录成功后处置失效标记:
 *   - 标记仍与当前 ~/.codex/auth.json 指纹一致 → 那份文件还是被服务端判坏的原样。
 *     保留标记, 返回 keepSuppressed=true, 调用方必须维持 reconcile suppress ——
 *     绝不能让后续任何一次 reconcile 把坏 token 硬链回来覆盖刚拿到的新 token
 *     (否则服务端随即再次 invalidate, 授权陷入「成功 → 几秒后失败」死循环)。
 *     等系统文件指纹变化后, reconcile 主流程的指纹比对会自动解除 suppress。
 *   - 无标记 / 指纹已不一致 (系统文件已变或已删) → 清标记, 返回 keepSuppressed=false,
 *     调用方可正常做登录后 reconcile。
 *   - durable disconnect marker → 永远 keepSuppressed=true；显式 Cindy 登录使用隔离 local auth。
 */
export function settleInvalidationMarkerAfterLogin(
  codexHome: string,
  systemAuthPath: string,
): { keepSuppressed: boolean } {
  return {
    keepSuppressed: getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuthPath) != null,
  };
}

/**
 * 启动时从磁盘标记恢复内存态:
 *   - 标记指纹匹配 + 本地 auth.json 不存在 (invalidate 时被删、之后没再登录)
 *     → 恢复「已失效」展示态 (invalidatedReason) + suppress reconcile。
 *   - 标记指纹匹配 + 本地 auth.json 仍是被判坏的系统 auth.json (硬链或相同内容)
 *     → 恢复「已失效」展示态 + suppress reconcile。
 *   - 标记指纹匹配 + 本地 auth.json 存在且不同于坏系统 auth.json (上次运行里已重新登录成功)
 *     → 只 suppress (继续挡住坏 token), 不进失效态 —— 用户重启后应直接是已授权,
 *       标记只负责阻止 ~/.codex 里的坏 token 被 reconcile 回来。
 *   - 标记指纹不匹配 (系统文件已变) → 清标记, 一切正常。
 *   - 用户主动断开 sentinel → 始终只 suppress、不展示错误，也不随系统文件变化自动失效。
 */
export function restoreInvalidationStateOnStartup(
  codexHome: string,
  systemAuthPath: string,
  localAuthPath: string,
): { suppressReconcile: boolean; invalidatedReason: string | null } {
  const marker = getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuthPath);
  if (!marker) {
    return { suppressReconcile: false, invalidatedReason: null };
  }
  // marker 是 logout 的提交点。若进程在「写 marker → unlink auth」之间崩溃，启动时按
  // local fingerprint 识别并清掉旧凭证；即使删除失败，readLocalCodexAuthState 也会忽略它。
  if (isDurableDisconnectMarker(marker) && localFileMatchesInvalidatedMarker(marker, localAuthPath)) {
    try {
      fs.unlinkSync(localAuthPath);
    } catch {
      /* read path 仍会按 marker fingerprint 抑制，不能让残留文件复活登录态。 */
    }
  }
  return {
    suppressReconcile: true,
    invalidatedReason: marker.reason === CODEX_USER_DISCONNECT_REASON
      ? null
      : fs.existsSync(localAuthPath) &&
          !fileMatchesInvalidatedMarker(marker, localAuthPath) &&
          !localFileMatchesInvalidatedMarker(marker, localAuthPath)
        ? null
        : marker.reason,
  };
}
