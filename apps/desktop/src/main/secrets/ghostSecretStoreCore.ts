import type { SecretStorageIo } from './providerSecretStore.js';
import { migrateGhostSecretAliases } from './ghostSecretAliasMigration.js';
import { ghostSecretStorageKey, ghostSecretHintStorageKey, deriveGhostSecretTail,
  GHOST_SECRET_PREFIX, GHOST_SECRET_HINT_PREFIX } from '../../shared/providerSecrets.js';

export interface GhostSecretStorageIo extends SecretStorageIo {
  /** Missing is null; keyring, decrypt and IO errors remain errors. */
  readStrict(key: string): string | null;
  /** Inspect existence without unlocking or decrypting credentials. */
  saved(key: string): boolean;
}

/** Shared secret operations. The platform supplies encryption and the active
 * owner namespace; plugin code never gets access to this storage object. */
export function createGhostSecretStore(io: GhostSecretStorageIo, log: {
  warn(details: Record<string, unknown>, message: string): void;
}) {
/** Startup-only, under the original installation lock; ordinary reads never use aliases. */
function migrateInstalledGhostSecretAliases(target: Parameters<typeof migrateGhostSecretAliases>[0]): boolean {
  return migrateGhostSecretAliases(target, { ...io, read: io.readStrict });
}

/**
 * 读取某意识的某条 network 槽凭证(**main 侧 networkSlot 注入专用**)。
 * 不存在 / safeStorage 不可用 / 读失败均返回 null。与 renderer 经通用
 * safe-storage IPC 写入的 .enc 文件字节级互通。凭证值从不进日志(只记 id)。
 */
function readGhostSecret(instanceKey: string, secretKey: string): string | null {
  try {
    return io.read(ghostSecretStorageKey(instanceKey, secretKey));
  } catch (err) {
    log.warn(
      { ghostId: instanceKey, secretKey, err: err instanceof Error ? err.message : String(err) },
      'read ghost secret failed',
    );
    return null;
  }
}

/**
 * Strict Ghost secret read for owner-stable repair jobs. Absence is still a
 * normal null result, while keychain, IO, and decrypt failures remain errors
 * so the durable coordinator can retry instead of memoizing a false no-op.
 */
function readGhostSecretStrict(instanceKey: string, secretKey: string): string | null {
  return io.readStrict(ghostSecretStorageKey(instanceKey, secretKey));
}

/**
 * 只查某意识凭证是否已入库(加密文件存在性,**不解密**)。插件页 setup
 * 就绪检查专用:判定只需要「存没存」,解密既无必要,还会把 safeStorage
 * 读取异常折叠成「未配置」造成误拦——存在性口径下,文件在就算已配置
 * (即便当下解密不可用,那是注入期要处理的问题,不该拦在使用入口)。
 * ENOENT 之外的真 IO 异常(如权限)**原样上抛**:「查询失败」≠「未配置」,
 * 调用方(ghosts:setup-status)让 invoke reject,renderer 侧 fail-open。
 * 键名走 ghostSecretStorageKey(官方别名同 read 侧)。
 */
function ghostSecretSaved(instanceKey: string, secretKey: string): boolean {
  return io.saved(ghostSecretStorageKey(instanceKey, secretKey));
}

/**
 * 写入某意识的某条 network 槽凭证(**main 侧 /secrets 只写通道专用**,
 * input:'ghost' 凭证由意识 settingsHtml 收单后经协议一次性交来)。
 * 键名走 ghostSecretStorageKey(官方别名同 read 侧),与 renderer 写入的
 * .enc 文件字节级互通。凭证值从不进日志(只记 id)。
 */
function storeGhostSecret(instanceKey: string, secretKey: string, value: string): boolean {
  try {
    const ok = io.write(ghostSecretStorageKey(instanceKey, secretKey), value);
    if (ok) {
      // 入库即截尾 4 位指纹(分键保管,读路径永不碰明文);值太短不产指纹,
      // 且要清掉旧值可能留下的指纹。指纹写失败不连坐主凭证(best-effort)。
      try {
        const tail = deriveGhostSecretTail(value);
        const hintKey = ghostSecretHintStorageKey(instanceKey, secretKey);
        if (tail) io.write(hintKey, tail);
        else io.remove(hintKey);
      } catch (err) {
        log.warn(
          { ghostId: instanceKey, secretKey, err: err instanceof Error ? err.message : String(err) },
          'store ghost secret tail failed',
        );
      }
    }
    return ok;
  } catch (err) {
    log.warn(
      { ghostId: instanceKey, secretKey, err: err instanceof Error ? err.message : String(err) },
      'store ghost secret failed',
    );
    return false;
  }
}

/**
 * 读某意识某条凭证的「尾 4 位指纹」(/secrets GET 状态回查用)。
 * 常规路径只回入库时预截的指纹;老键(host 收单时代或别名互通存的)没截过
 * 指纹,首查时**懒回填**——main 本来就持有明文读取权(每次代发注入都在读),
 * 此处补读一次截存指纹,沙箱可见面不变(仍只有预截的 4 个字符)。
 * 没存过 / 值太短不产指纹 / 读失败均返回 null(UI 降级成只显示「已保存」)。
 * io 可注入以便单测;生产走 io 包装。
 */
function readGhostSecretTailFromIo(
  io: SecretStorageIo, instanceKey: string,
  secretKey: string,
): string | null {
  try {
    const hintKey = ghostSecretHintStorageKey(instanceKey, secretKey);
    const existing = io.read(hintKey);
    if (existing !== null) return existing;
    const value = io.read(ghostSecretStorageKey(instanceKey, secretKey));
    if (value === null) return null;
    const tail = deriveGhostSecretTail(value);
    if (tail) io.write(hintKey, tail);
    return tail;
  } catch (err) {
    log.warn(
      { ghostId: instanceKey, secretKey, err: err instanceof Error ? err.message : String(err) },
      'read ghost secret tail failed',
    );
    return null;
  }
}

/** readGhostSecretTailFromIo 的生产入口(默认 safeStorage IO)。 */
function readGhostSecretTail(instanceKey: string, secretKey: string): string | null {
  return readGhostSecretTailFromIo(io, instanceKey, secretKey);
}

/** 清除某意识的单条 network 槽凭证(/secrets DELETE 用;幂等,连同尾指纹)。 */
function removeGhostSecret(instanceKey: string, secretKey: string): void {
  try {
    io.remove(ghostSecretStorageKey(instanceKey, secretKey));
    io.remove(ghostSecretHintStorageKey(instanceKey, secretKey));
    // Older builds wrote untrusted Mivo hints under a third key. Delete covers it too.
    io.remove('ghost_hint__local__' + instanceKey + '_' + secretKey);
  } catch (err) {
    log.warn(
      { ghostId: instanceKey, secretKey, err: err instanceof Error ? err.message : String(err) },
      'remove ghost secret failed',
    );
  }
}

/**
 * 清掉某意识名下的全部 network 槽凭证(卸载意识时调用;幂等)。
 * 按 `ghost_secret_<instanceKey>_` 前缀扫 io.list(),不依赖清单里的 secrets
 * 声明——旧版本声明过、新版本删掉的孤儿键也一并清。
 */
function removeGhostSecrets(instanceKey: string): void {
  const prefixes = [
    `${GHOST_SECRET_PREFIX}${instanceKey}_`,
    `${GHOST_SECRET_HINT_PREFIX}${instanceKey}_`,
    `ghost_hint__local__${instanceKey}_`,
  ];
  try {
    for (const key of io.list()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) io.remove(key);
    }
  } catch (err) {
    log.warn(
      { ghostId: instanceKey, err: err instanceof Error ? err.message : String(err) },
      'remove ghost secrets failed',
    );
  }
}

function ghostSecretRelocationPrefixes(fromGhostId: string, toGhostId: string): Array<[string, string]> {
  return [
    [`${GHOST_SECRET_PREFIX}${fromGhostId}_`, `${GHOST_SECRET_PREFIX}${toGhostId}_`],
    [`${GHOST_SECRET_HINT_PREFIX}${fromGhostId}_`, `${GHOST_SECRET_HINT_PREFIX}${toGhostId}_`],
    [`ghost_hint__local__${fromGhostId}_`, `${GHOST_SECRET_HINT_PREFIX}${toGhostId}_`],
  ];
}

/** Rename ghost_secret_/ghost_hint_ keys after a physical relocate. Conflicts fail closed. */
function assertGhostSecretsCanRelocate(fromGhostId: string, toGhostId: string): void {
  if (fromGhostId === toGhostId) return;
  for (const key of io.list()) {
    for (const [sourcePrefix, destinationPrefix] of ghostSecretRelocationPrefixes(fromGhostId, toGhostId)) {
      if (!key.startsWith(sourcePrefix)) continue;
      const destination = `${destinationPrefix}${key.slice(sourcePrefix.length)}`;
      const value = io.read(key);
      if (value === null) throw new Error('relocate source secret is unreadable');
      const existing = io.read(destination);
      if (existing !== null && existing !== value) {
        throw new Error('relocate secret destination already exists');
      }
    }
  }
}

function migrateGhostSecrets(
  fromGhostId: string,
  toGhostId: string,
  storage: SecretStorageIo = io,
): () => void {
  if (fromGhostId === toGhostId) return () => {};
  const pairs = ghostSecretRelocationPrefixes(fromGhostId, toGhostId);
  const moves: Array<{ from: string; to: string; value: string; destinationExisted: boolean }> = [];
  for (const key of storage.list()) {
    for (const [fromPrefix, toPrefix] of pairs) {
      if (!key.startsWith(fromPrefix)) continue;
      const dest = `${toPrefix}${key.slice(fromPrefix.length)}`;
      const value = storage.read(key);
      if (value === null) throw new Error('relocate source secret is unreadable');
      const existing = storage.read(dest);
      if (existing !== null && existing !== value) {
        throw new Error(`relocate secret destination already exists: ${dest}`);
      }
      moves.push({ from: key, to: dest, value, destinationExisted: existing !== null });
      break;
    }
  }
  const attempted: typeof moves = [];
  const rollback = () => {
    let failure: unknown;
    for (const move of [...attempted].reverse()) {
      try {
        const sourceRestored = storage.read(move.from) === move.value || storage.write(move.from, move.value);
        if (!sourceRestored) throw new Error('failed to restore relocated secret: ' + move.from);
        if (!move.destinationExisted && !storage.remove(move.to).success) {
          throw new Error('failed to remove relocated secret: ' + move.to);
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  try {
    for (const move of moves) {
      attempted.push(move);
      if (storage.read(move.to) !== move.value && !storage.write(move.to, move.value)) {
        throw new Error(`failed to write relocated secret: ${move.to}`);
      }
      if (!storage.remove(move.from).success) {
        throw new Error(`failed to remove relocated secret: ${move.from}`);
      }
    }
  } catch (error) {
    try { rollback(); } catch (rollbackError) {
      void rollbackError;
    }
    throw error;
  }
  return rollback;
}

  return { migrateInstalledGhostSecretAliases, readGhostSecret, readGhostSecretStrict, ghostSecretSaved, storeGhostSecret, readGhostSecretTailFromIo, readGhostSecretTail, removeGhostSecret, removeGhostSecrets, assertGhostSecretsCanRelocate, migrateGhostSecrets };
}
