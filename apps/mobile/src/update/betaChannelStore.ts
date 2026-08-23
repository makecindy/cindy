/**
 * Mobile beta 渠道的设备级本地状态。
 *
 * 旧版本只有 `cindy.mobile.update.beta = "true"`，无法区分“从未设置”和
 * “用户手动关闭”。新版本把用户 override 与 xd 组织默认拆开，仍同步维护旧
 * key 作为回滚到旧 JS bundle 时的兼容镜像。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const LEGACY_STORAGE_KEY = 'cindy.mobile.update.beta';
const META_STORAGE_KEY = 'cindy.mobile.update.beta.meta.v1';
const META_VERSION = 1;

interface BetaMetaRecord {
  version: 1;
  userOverride: boolean | null;
  orgDefaultEnableBeta: boolean;
  legacyMigrationHold: boolean;
}

interface BetaState {
  userOverride: boolean | null;
  orgDefaultEnableBeta: boolean;
  legacyMigrationHold: boolean;
}

const EMPTY: BetaState = {
  userOverride: null,
  orgDefaultEnableBeta: false,
  legacyMigrationHold: true,
};

let state: BetaState = { ...EMPTY };
let hasPersistedMeta = false;
let migrationBlocked = false;
let hydrated = false;
let hydratePromise: Promise<boolean> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

function effectiveBeta(value: BetaState): boolean {
  if (value.userOverride !== null) return value.userOverride;
  if (value.legacyMigrationHold) return false;
  return value.orgDefaultEnableBeta;
}

function publicState(): { enableBeta: boolean; isCustomized: boolean } {
  return {
    enableBeta: effectiveBeta(state),
    isCustomized: state.userOverride !== null || state.legacyMigrationHold,
  };
}

function parseMeta(raw: string | null): BetaState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Partial<BetaMetaRecord>;
    if (
      record.version !== META_VERSION ||
      (record.userOverride !== null && typeof record.userOverride !== 'boolean') ||
      typeof record.orgDefaultEnableBeta !== 'boolean' ||
      typeof record.legacyMigrationHold !== 'boolean'
    ) return null;
    return {
      userOverride: record.userOverride,
      orgDefaultEnableBeta: record.orgDefaultEnableBeta,
      legacyMigrationHold: record.legacyMigrationHold,
    };
  } catch {
    return null;
  }
}

function metaPayload(value: BetaState): string {
  const record: BetaMetaRecord = {
    version: META_VERSION,
    userOverride: value.userOverride,
    orgDefaultEnableBeta: value.orgDefaultEnableBeta,
    legacyMigrationHold: value.legacyMigrationHold,
  };
  return JSON.stringify(record);
}

async function persist(value: BetaState): Promise<void> {
  await AsyncStorage.setItem(META_STORAGE_KEY, metaPayload(value));
  // 新 metadata 是真源。旧 key 只用于回滚旧 JS bundle 时兼容；镜像失败不能让
  // 内存回滚到旧值（metadata 已经成功写入），否则本次运行会和下次冷启动漂移。
  try {
    if (effectiveBeta(value)) await AsyncStorage.setItem(LEGACY_STORAGE_KEY, 'true');
    else await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // best effort compatibility mirror
  }
}

/** 冷启动读取实现；用户操作可静默 hydrate，避免把旧值作为额外变更广播。 */
function hydrateBetaChannelInternal(notify: boolean): Promise<boolean> {
  if (hydrated) return Promise.resolve(effectiveBeta(state));
  if (hydratePromise) return hydratePromise;
  hydratePromise = Promise.all([
    AsyncStorage.getItem(META_STORAGE_KEY),
    AsyncStorage.getItem(LEGACY_STORAGE_KEY),
  ])
    .then(([metaRaw, legacyRaw]) => {
      const meta = parseMeta(metaRaw);
      if (meta) {
        state = meta;
        hasPersistedMeta = true;
        migrationBlocked = false;
      } else if (metaRaw === null && legacyRaw === 'true') {
        // 旧版本的 true 只能来自用户主动开启，安全地迁移为用户 override。
        state = { userOverride: true, orgDefaultEnableBeta: false, legacyMigrationHold: false };
        hasPersistedMeta = false;
        migrationBlocked = false;
      } else {
        // 真正无记录时再由 device id 判定新旧装机；只要存在损坏记录，就不能
        // 当成新装机自动开启。
        state = { ...EMPTY };
        hasPersistedMeta = false;
        migrationBlocked = metaRaw !== null || legacyRaw !== null;
      }
      hydrated = true;
      if (notify) notifyListeners();
      return effectiveBeta(state);
    })
    .catch(() => {
      state = { ...EMPTY };
      hasPersistedMeta = false;
      migrationBlocked = true;
      hydrated = true;
      if (notify) notifyListeners();
      return false;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** 冷启动时调用一次；缺少迁移结论时 fail-safe 到 stable。 */
export function hydrateBetaChannel(): Promise<boolean> {
  return hydrateBetaChannelInternal(true);
}

/** 启动 gate 完成后可同步读取；迁移未完成时按 false 处理。 */
export function isBetaChannel(): boolean {
  return hydrated && effectiveBeta(state);
}

export function readBetaChannelState(): { enableBeta: boolean; isCustomized: boolean } {
  return publicState();
}

export function subscribeBetaChannel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 在 AuthContext 已知道设备是否为旧装机后完成一次性迁移。
 * 旧装机没有旧 beta key 时保守保持 hold；新装机解除 hold，允许 XD 默认开启。
 */
export async function prepareBetaChannelForDevice(input: {
  hadExistingDeviceId: boolean;
}): Promise<void> {
  await hydrateBetaChannel();
  await enqueueMutation(async () => {
    // 读取失败时无法知道旧 key 是否曾为 true；不要以 fail-safe 内存值反写磁盘，
    // 避免一次瞬时 I/O 错误抹掉旧版本里用户明确开启的 beta。
    if (hasPersistedMeta || migrationBlocked) return;
    const next: BetaState = {
      ...state,
      legacyMigrationHold: input.hadExistingDeviceId ? state.legacyMigrationHold : false,
    };
    await persist(next);
    state = next;
    hasPersistedMeta = true;
    notifyListeners();
  });
}

/** 用户显式写入 override；false 也必须保留，防止下次 xd 登录重新打开。 */
export async function syncBetaChannel(next: boolean): Promise<void> {
  const value = next === true;
  // 先等冷启动读取完成，再把用户操作放进统一写队列；否则迟到的 hydrate 可能
  // 用旧磁盘快照覆盖刚写入的选择。
  await hydrateBetaChannelInternal(false);
  await enqueueMutation(async () => {
    const nextState: BetaState = {
      ...state,
      userOverride: value,
      legacyMigrationHold: false,
    };
    await persist(nextState);
    state = nextState;
    hasPersistedMeta = true;
    migrationBlocked = false;
    notifyListeners();
  });
}

/** 仅在用户未自定义且设备不是旧装机迁移 hold 时写入组织默认。 */
export function enableUncustomizedBetaChannel(
  shouldWrite: () => boolean = () => true,
): Promise<boolean> {
  let wrote = false;
  return enqueueMutation(async () => {
    if (!shouldWrite() || state.userOverride !== null || state.legacyMigrationHold || effectiveBeta(state)) {
      return;
    }
    const nextState: BetaState = { ...state, orgDefaultEnableBeta: true };
    await persist(nextState);
    state = nextState;
    hasPersistedMeta = true;
    migrationBlocked = false;
    wrote = true;
    notifyListeners();
  }).then(() => wrote);
}

export const __testing = {
  storageKey: LEGACY_STORAGE_KEY,
  metaStorageKey: META_STORAGE_KEY,
  async resetMemory(): Promise<void> {
    await mutationQueue.catch(() => undefined);
    state = { ...EMPTY };
    hasPersistedMeta = false;
    migrationBlocked = false;
    hydrated = false;
    hydratePromise = null;
    mutationQueue = Promise.resolve();
    listeners.clear();
  },
  readState: () => ({ ...state }),
  hasPersistedMeta: () => hasPersistedMeta,
  migrationBlocked: () => migrationBlocked,
};
