/**
 * memorySettingsStore — Maker Memory 启用状态的 renderer 端镜像。
 * ---------------------------------------------------------------------------
 * **真正的 source of truth 是 main 的 <userData>/memory-settings.json**
 * (memory-settings-store.ts), 这里 localStorage 只是 renderer 端的同步可读镜像 —
 * 让 ChatInput 启 session 时能同步 (`getMakerMemoryEnabled()`) 透传 makerMemoryEnabled,
 * 不引入 async race。
 *
 * 同步路径:
 *   - 启动时: bootstrapFromMain() 调 IPC 拉 main 真值, 写入 localStorage
 *   - toggle: MemorySection 调 IPC 后调 setMakerMemoryEnabled() 更新本地镜像
 *   - 其他改动: main 是单一写入点, renderer 不会从其它路径篡改
 *
 * 二态 (跟 MemorySection UI 的 Maker toggle 对齐):
 *   - true  : Maker Memory 启用 (写 prompt 注入 + 关闭原生 auto-memory + 暴露 cindy_memory MCP)
 *   - false : Maker Memory 关闭, 各 agent 原生 auto-memory 各自由 Claude / Codex 行控制
 *
 * **默认 true** — Maker Memory 已是正式功能；已有用户的明确设置仍以 main 端为准。
 */

const STORAGE_KEY_PREFIX = 'memorySettings.makerEnabled';
const LEGACY_MIGRATION_KEY_PREFIX = 'memorySettings.makerLegacyMigrationV1';
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
const LEGACY_MIGRATION_GLOBAL_KEY = LEGACY_MIGRATION_KEY_PREFIX;
const LOCAL_DATA_OWNER_ID = 'local-v1';
let activeOwnerId: string | null = null;

function storageKey(): string {
  return `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

function legacyMigrationKey(): string {
  return `${LEGACY_MIGRATION_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

export function setMemorySettingsOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  // 账号边界同样使在途 bootstrap 失效，避免旧 owner 的响应写入新 owner 镜像。
  localWriteRevision += 1;
  legacyMigrationCompletedInMemory = false;
  inMemoryValue = readStoredMakerMemoryEnabled() ?? true;
  subscribers.forEach((cb) => cb(inMemoryValue));
}

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();
let inMemoryValue = true;
let localWriteRevision = 0;
let legacyMigrationCompletedInMemory = false;

function hasCompletedLegacyMigration(): boolean {
  if (legacyMigrationCompletedInMemory) return true;
  try {
    return (
      localStorage.getItem(legacyMigrationKey()) === '1' ||
      localStorage.getItem(LEGACY_MIGRATION_GLOBAL_KEY) === '1'
    );
  } catch {
    return false;
  }
}

function markLegacyMigrationCompleted(): void {
  legacyMigrationCompletedInMemory = true;
  try {
    localStorage.setItem(legacyMigrationKey(), '1');
    localStorage.setItem(LEGACY_MIGRATION_GLOBAL_KEY, '1');
  } catch {
    // localStorage 不可用时保留进程内标记；下次启动仍会安全重试。
  }
}

/** localStorage 中只接受显式 boolean 字符串；缺失/坏值不伪装成用户选择。 */
function readStoredMakerMemoryEnabled(): boolean | undefined {
  try {
    const stored = localStorage.getItem(storageKey());
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function readLegacyStoredMakerMemoryEnabled(): boolean | undefined {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同步读 — 给 hook 之外路径用 (ChatInput 启 session 时透传等)。
 * 坏数据 / localStorage 不可用 / 没存过 → 兜底 true (正式功能默认开)。
 */
export function getMakerMemoryEnabled(): boolean {
  return readStoredMakerMemoryEnabled() ?? inMemoryValue;
}

/** 同步写 — 落盘 + 通知本 tab 内所有 subscriber */
export function setMakerMemoryEnabled(next: boolean): void {
  // localStorage 不可用时仍须在当前 renderer 生命周期内保留用户选择。
  localWriteRevision += 1;
  inMemoryValue = next;
  try {
    localStorage.setItem(storageKey(), next ? 'true' : 'false');
  } catch {
    // localStorage 不可用 — 忽略, 调用方应自行处理 UI 反馈
  }
  subscribers.forEach((cb) => cb(next));
}

/** 订阅变化 — hook 用, 也可以给非 React 路径用。返回 unsubscribe。 */
export function subscribeMakerMemoryEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);

  // 跨实例 storage 事件 (多窗口兜底; Electron 单窗口下几乎不触发)
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== storageKey()) return;
    localWriteRevision += 1;
    cb(getMakerMemoryEnabled());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * 启动期一次性从 main 拉真值同步到 localStorage。
 *
 * 时机: app entry (renderer/main.tsx) 在挂载 React 树之前调一次, 让 settings UI 第一次
 * 渲染时 localStorage 已经是真值; ChatInput 启 session 透传也就是真值。
 *
 * 失败兜底: IPC 错误 (preload 没就绪 / main 异常) 静默 — localStorage 留旧值, 不影响 UI 可用性。
 * 用户在 settings 里 toggle 仍能通过 IPC 写 main, 下次启动恢复正常。
 */
export async function bootstrapMemorySettingsFromMain(): Promise<void> {
  try {
    const revisionAtStart = localWriteRevision;
    const canMigrateLegacyRendererSetting =
      activeOwnerId !== null && activeOwnerId !== LOCAL_DATA_OWNER_ID;
    const migrationCompleted = !canMigrateLegacyRendererSetting || hasCompletedLegacyMigration();
    const legacyRendererValue = migrationCompleted
      ? undefined
      : (readStoredMakerMemoryEnabled() ?? readLegacyStoredMakerMemoryEnabled());
    let settings = await window.electronAPI.maker.memoryGetSettings();
    // 用户或其它窗口已在请求期间写入时，旧快照不再有资格触发迁移或覆盖本地镜像。
    if (localWriteRevision !== revisionAtStart) return;
    // 首次启动时委托 main 迁移旧档案；没有 renderer marker 时也要保留 native opt-out。
    if (!migrationCompleted && settings.maker) {
      try {
        settings = await window.electronAPI.maker.memoryPreserveLegacyMakerDisabled(
          legacyRendererValue ?? null,
        );
      } catch {
        // Migration persistence is best-effort. Never let a structured IPC
        // failure prevent the main renderer tree from mounting.
        if (localWriteRevision === revisionAtStart && legacyRendererValue === false) {
          // Keep the legacy opt-out in the process-local mirror even when the
          // main profile cannot be written, so sessions stay disabled now.
          setMakerMemoryEnabled(false);
        }
        return;
      }
    }
    if (localWriteRevision !== revisionAtStart) return;
    if (!migrationCompleted) markLegacyMigrationCompleted();
    const current = getMakerMemoryEnabled();
    if (current === settings.maker) return;
    setMakerMemoryEnabled(settings.maker);
  } catch {
    // preload 未就绪 / IPC 异常 — 留旧 localStorage, 用户 toggle 时仍会同步到 main
  }
}
