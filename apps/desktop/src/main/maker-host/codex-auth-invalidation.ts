/**
 * apps/desktop/src/main/maker-host/codex-auth-invalidation.ts
 *
 * Codex OAuth 凭证"系统失效标记"(auth-invalidated-system.json) 的读写与决策 ——
 * 从 auth-adapters 拆出来, 不依赖 Electron, 路径显式注入, 可单测。
 *
 * 标记语义: 服务端判定某份 OAuth token 失效 (refresh_token reuse / 401 reauth_required) 时,
 * 把失效凭证的文件指纹 (dev/ino/size/mtimeMs + sha256) 落盘。系统共享凭证在本机
 * ChatGPT/Codex 重新登录、系统 auth.json 换成另一份内容后过期；系统文件暂时缺失时继续
 * 保持失效提示。实例隔离凭证则完全不受系统 auth.json 变化影响：Cindy 写入新凭证后只解除
 * 错误展示，marker 继续阻止系统凭证回灌。用户显式断开产生的 durable marker 是例外，系统
 * CLI 后续任何变化都不能自动接回。
 *
 * 背景 (2026-07-03 线上实踩):
 *   token 失效 → 用户在 Cindy 里重新授权成功 → 旧实现无条件清掉标记和 suppress →
 *   下一次 getState/getAuthEnv 的 reconcile 把 ~/.codex 里未变的坏 token 硬链回来,
 *   覆盖刚拿到的新 token → 服务端再次 invalidate → 授权界面「成功 → 几秒后失败」死循环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AuthState } from '@cindy/maker-core';

type CodexCredentialScope = NonNullable<AuthState['credentialScope']>;

/**
 * 用户主动断开 Cindy 内的 Codex OAuth；这是 durable sentinel：系统 CLI 后续刷新 / 重登
 * 也不能自动接回，只抑制凭证回灌，不作为鉴权错误展示。
 */
export const CODEX_USER_DISCONNECT_REASON = 'user_disconnected';

/** 失效标记文件内容: 失效原因 + 当时 ~/.codex/auth.json 的文件指纹。 */
export type InvalidatedSystemCodexAuthMarker = {
  reason: string;
  /**
   * The child reported an auth failure without identifying the generation it loaded. In this
   * mode the fingerprint is only a suppression/replacement baseline, not proof that these bytes
   * were rejected. It must never authorize credential deletion.
   */
  unprovenCredentialAttribution?: true;
  /** 失效前 Cindy 使用的是系统共享凭证、实例隔离凭证，还是无法判断。 */
  credentialScope?: CodexCredentialScope;
  /** 系统共享凭证失效时所属的 Cindy data owner；只允许该 owner 恢复原绑定。 */
  recoveryOwnerId?: string;
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
    const validLocalFingerprint =
      !hasLocalFingerprint ||
      (typeof parsed.localDev === 'number' &&
        typeof parsed.localIno === 'number' &&
        typeof parsed.localSize === 'number' &&
        typeof parsed.localMtimeMs === 'number' &&
        (parsed.localSha256 === undefined || typeof parsed.localSha256 === 'string'));
    const validDurableDisconnect =
      parsed.durableDisconnect === undefined || typeof parsed.durableDisconnect === 'boolean';
    const validUnprovenCredentialAttribution =
      parsed.unprovenCredentialAttribution === undefined ||
      parsed.unprovenCredentialAttribution === true;
    const validCredentialScope =
      parsed.credentialScope === undefined ||
      parsed.credentialScope === 'system-shared' ||
      parsed.credentialScope === 'instance-isolated' ||
      parsed.credentialScope === 'unknown';
    const validRecoveryOwnerId =
      parsed.recoveryOwnerId === undefined || typeof parsed.recoveryOwnerId === 'string';
    if (
      typeof parsed.reason === 'string' &&
      validDurableDisconnect &&
      validUnprovenCredentialAttribution &&
      validCredentialScope &&
      validRecoveryOwnerId &&
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

/**
 * Persist a non-destructive boundary for a child auth failure whose credential generation is
 * unknown. The fingerprint is the credential a replacement child would currently observe; it is
 * used only to keep that generation suppressed across restart and detect a later replacement.
 */
export function writeUnprovenCodexAuthSuppressionMarker(
  codexHome: string,
  systemAuthPath: string,
  localAuthPath: string,
  reason: string,
  credentialScope: CodexCredentialScope,
  recoveryOwnerId?: string,
): boolean {
  const previous = readInvalidatedSystemCodexAuthMarker(codexHome);
  if (previous && isDurableDisconnectMarker(previous)) return false;
  const baseline =
    currentCodexAuthFileFingerprint(localAuthPath) ??
    currentCodexAuthFileFingerprint(systemAuthPath);
  if (!baseline) return false;
  return persistInvalidatedSystemCodexAuthMarker(codexHome, {
    reason,
    credentialScope,
    ...(credentialScope === 'system-shared' && recoveryOwnerId ? { recoveryOwnerId } : {}),
    unprovenCredentialAttribution: true,
    ...baseline,
  });
}

/** 兼容最初只靠 reason 表示的 user_disconnected marker。 */
export function isDurableDisconnectMarker(marker: InvalidatedSystemCodexAuthMarker): boolean {
  return marker.reason === CODEX_USER_DISCONNECT_REASON || marker.durableDisconnect === true;
}

export interface CodexAuthFileFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export function currentCodexAuthFileFingerprint(authPath: string): CodexAuthFileFingerprint | null {
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

/** 取指定 auth.json 的指纹; 文件不存在 / stat 失败返回 null。 */
export function currentCodexAuthMarker(
  authPath: string,
  reason: string,
  credentialScope?: CodexCredentialScope,
): InvalidatedSystemCodexAuthMarker | null {
  const fingerprint = currentCodexAuthFileFingerprint(authPath);
  if (!fingerprint) return null;
  return { reason, ...(credentialScope ? { credentialScope } : {}), ...fingerprint };
}

/** 取当前系统 auth.json 的指纹; 文件不存在 / stat 失败返回 null。 */
export function currentSystemCodexAuthMarker(
  systemAuthPath: string,
  reason: string,
  credentialScope?: CodexCredentialScope,
): InvalidatedSystemCodexAuthMarker | null {
  const fingerprint = currentCodexAuthFileFingerprint(systemAuthPath);
  if (!fingerprint) return null;
  return { reason, ...(credentialScope ? { credentialScope } : {}), ...fingerprint };
}

function persistInvalidatedSystemCodexAuthMarker(
  codexHome: string,
  marker: InvalidatedSystemCodexAuthMarker,
): boolean {
  const file = getCodexAuthInvalidationMarkerPath(codexHome);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Same-directory temp + rename: a crash or failed write cannot truncate an existing marker.
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
    return currentCodexAuthFileFingerprint(localAuthPath)?.sha256 === marker.localSha256;
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
  localAuthPath?: string,
): InvalidatedSystemCodexAuthMarker | null {
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  if (!marker) return null;
  if (marker.unprovenCredentialAttribution) {
    const baselinePath =
      marker.credentialScope === 'system-shared' ? systemAuthPath : localAuthPath;
    // Absence cannot prove replacement. For isolated/unknown credentials the caller must provide
    // the local path; otherwise preserve the boundary rather than release it optimistically.
    if (!baselinePath || currentCodexAuthFileFingerprint(baselinePath) === null) return marker;
    return fileMatchesInvalidatedMarker(marker, baselinePath) ? marker : null;
  }
  // 实例隔离或来源不明的凭证都不能靠 ~/.codex 变化证明已经恢复；UI 会引导用户在 Cindy
  // 重新登录。新的 local auth 不再匹配坏凭证 fingerprint，但 marker 仍负责抑制系统回灌。
  if (marker.credentialScope === 'instance-isolated' || marker.credentialScope === 'unknown') {
    return marker;
  }
  // 系统共享凭证被删除通常意味着 ChatGPT App 已退出登录，而不是已经恢复。继续保留
  // 指引，直到 App/CLI 写入一份与坏 token 不同的新 auth.json。
  if (
    marker.credentialScope === 'system-shared' &&
    currentCodexAuthFileFingerprint(systemAuthPath) === null
  ) {
    return marker;
  }
  if (markerMatchesCurrentSystemCodexAuth(marker, systemAuthPath)) return marker;
  // The system credential changed, so this marker no longer blocks reconcile. Keep the raw marker
  // until an account-level RPC confirms the replacement token: it is the durable evidence that a
  // fresh renderer mount must not expose "recovered" from file presence alone.
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
  credentialScope?: CodexCredentialScope,
  recoveryOwnerId?: string,
  invalidatedFingerprint?: CodexAuthFileFingerprint,
): boolean {
  const previous = readInvalidatedSystemCodexAuthMarker(codexHome);
  const durableDisconnect =
    reason === CODEX_USER_DISCONNECT_REASON ||
    (previous !== null && isDurableDisconnectMarker(previous));
  const localFingerprint = localAuthPath ? currentCodexAuthFileFingerprint(localAuthPath) : null;
  // 主动断开不依赖系统文件当前是否存在，也不随其指纹变化失效；零值只是兼容既有 marker schema
  // 的 durable sentinel。已有 durable sentinel 后的普通 token invalidation 也继承该属性，
  // 即使系统文件暂时不存在也要把新的失败原因落盘，不能退回可自动 reconcile 的普通 marker。
  // system-shared 的 local auth 可能因 ChatGPT App 原子替换系统文件而成为旧硬链。此时真正
  // 被服务端判坏的是 local 指向的旧 inode，不是系统路径上已经换新的凭证；优先记录 local
  // 指纹，让下一次检测能立即认出系统登录已经更新并安全 relink。
  const sharedInvalidatedCredential: InvalidatedSystemCodexAuthMarker | null =
    credentialScope === 'system-shared' && (invalidatedFingerprint ?? localFingerprint)
      ? {
          reason,
          credentialScope,
          ...(invalidatedFingerprint ?? localFingerprint)!,
        }
      : null;
  const marker: InvalidatedSystemCodexAuthMarker | null =
    sharedInvalidatedCredential ??
    currentSystemCodexAuthMarker(systemAuthPath, reason, credentialScope) ??
    (durableDisconnect
      ? {
          reason,
          ...(credentialScope ? { credentialScope } : {}),
          dev: 0,
          ino: 0,
          size: 0,
          mtimeMs: 0,
        }
      : credentialScope === 'instance-isolated' || credentialScope === 'unknown'
        ? {
            reason,
            credentialScope,
            dev: 0,
            ino: 0,
            size: 0,
            mtimeMs: 0,
          }
        : null);
  if (!marker) return false;
  if (credentialScope === 'system-shared' && recoveryOwnerId) {
    marker.recoveryOwnerId = recoveryOwnerId;
  }
  if (durableDisconnect) marker.durableDisconnect = true;
  const invalidatedLocalFingerprint = invalidatedFingerprint ?? localFingerprint;
  if (invalidatedLocalFingerprint) {
    marker.localDev = invalidatedLocalFingerprint.dev;
    marker.localIno = invalidatedLocalFingerprint.ino;
    marker.localSize = invalidatedLocalFingerprint.size;
    marker.localMtimeMs = invalidatedLocalFingerprint.mtimeMs;
    marker.localSha256 = invalidatedLocalFingerprint.sha256;
  }
  return persistInvalidatedSystemCodexAuthMarker(codexHome, marker);
}

/** Preserve the invalidated fingerprint while recording the proven scope of a replacement login. */
export function updateInvalidatedSystemCodexAuthMarkerCredentialScope(
  codexHome: string,
  credentialScope: CodexCredentialScope,
): boolean {
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  if (!marker) return false;
  return persistInvalidatedSystemCodexAuthMarker(codexHome, { ...marker, credentialScope });
}

/** marker 记录的正是当前残留 local auth 时，该文件属于已断开或已失效的旧凭证。 */
export function shouldSuppressLocalCodexAuth(codexHome: string, localAuthPath: string): boolean {
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  return Boolean(
    marker &&
    (localFileMatchesInvalidatedMarker(marker, localAuthPath) ||
      fileMatchesInvalidatedMarker(marker, localAuthPath)),
  );
}

/** 删标记 (幂等)；返回持久化边界是否已确认清除。 */
export function clearInvalidatedSystemCodexAuthMarker(codexHome: string): boolean {
  try {
    fs.unlinkSync(getCodexAuthInvalidationMarkerPath(codexHome));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
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
  localAuthPath?: string,
): { keepSuppressed: boolean } {
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  if (marker?.credentialScope === 'instance-isolated' || marker?.credentialScope === 'unknown') {
    // 新 local OAuth 已经替换掉 marker 记录的坏凭证，所以错误展示可以由调用方清掉；但这
    // 份登录本来就是 Cindy 内的隔离登录（或来路无法证明），不能紧接着恢复 system
    // reconcile。否则同账号的 ~/.codex/auth.json 会立刻重新硬链回来，把刚写入的新 token
    // 覆盖掉。marker 留作 durable suppression sentinel；local fingerprint 已不同，因此不会
    // 抑制这份新凭证。已有 durableDisconnect 也必须原样保留。
    return { keepSuppressed: true };
  }
  return {
    keepSuppressed:
      getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuthPath, localAuthPath) != null,
  };
}

/**
 * 启动时从磁盘标记恢复内存态:
 *   - 标记指纹匹配 + 本地 auth.json 不存在 (invalidate 时被删、之后没再登录)
 *     → 恢复「已失效」展示态 (invalidatedReason) + suppress reconcile。
 *   - 标记指纹匹配 + 本地 auth.json 仍是被判坏的系统 auth.json (硬链或相同内容)
 *     → 恢复「已失效」展示态 + suppress reconcile。
 *   - 标记指纹匹配 + 本地 auth.json 已替换 → 继续 suppress 坏系统 token，并持久返回
 *     recoveryRequiredReason，直到账号级 RPC 确认新凭证。
 *   - 标记指纹不匹配 (系统文件已变) → 允许 reconcile 新文件，但保留标记作为
 *     待验证恢复证据。
 *   - 用户主动断开 sentinel → 始终只 suppress、不展示错误，也不随系统文件变化自动失效。
 */
export function restoreInvalidationStateOnStartup(
  codexHome: string,
  systemAuthPath: string,
  localAuthPath: string,
): {
  suppressReconcile: boolean;
  invalidatedReason: string | null;
  recoveryRequiredReason?: string;
  credentialScope?: CodexCredentialScope;
} {
  const persistedMarker = readInvalidatedSystemCodexAuthMarker(codexHome);
  if (!persistedMarker) {
    return { suppressReconcile: false, invalidatedReason: null };
  }
  const marker = getActiveInvalidatedSystemCodexAuthMarker(
    codexHome,
    systemAuthPath,
    localAuthPath,
  );
  if (!marker) {
    // A changed system auth.json is only a recovery candidate. Reconcile may consume it, but the
    // renderer must perform an account RPC before replacing the actionable invalidation prompt.
    return {
      suppressReconcile: false,
      invalidatedReason: null,
      ...(persistedMarker.credentialScope
        ? { credentialScope: persistedMarker.credentialScope }
        : {}),
      ...(isDurableDisconnectMarker(persistedMarker)
        ? {}
        : { recoveryRequiredReason: persistedMarker.reason }),
    };
  }
  // marker 是 logout 的提交点。若进程在「写 marker → unlink auth」之间崩溃，启动时按
  // local fingerprint 识别并清掉旧凭证；即使删除失败，readLocalCodexAuthState 也会忽略它。
  if (
    isDurableDisconnectMarker(marker) &&
    localFileMatchesInvalidatedMarker(marker, localAuthPath)
  ) {
    try {
      fs.unlinkSync(localAuthPath);
    } catch {
      /* read path 仍会按 marker fingerprint 抑制，不能让残留文件复活登录态。 */
    }
  }
  const localExists = fs.existsSync(localAuthPath);
  const hasReplacementLocalCredential =
    localExists &&
    !fileMatchesInvalidatedMarker(marker, localAuthPath) &&
    !localFileMatchesInvalidatedMarker(marker, localAuthPath);
  const recoveryRequiredReason =
    !isDurableDisconnectMarker(marker) && hasReplacementLocalCredential ? marker.reason : undefined;
  return {
    suppressReconcile: true,
    ...(marker.credentialScope ? { credentialScope: marker.credentialScope } : {}),
    ...(recoveryRequiredReason ? { recoveryRequiredReason } : {}),
    invalidatedReason:
      marker.reason === CODEX_USER_DISCONNECT_REASON
        ? null
        : hasReplacementLocalCredential
          ? null
          : marker.reason,
  };
}
