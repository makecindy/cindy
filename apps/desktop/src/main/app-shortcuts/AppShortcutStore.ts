import { createLogger } from '../logger.js';
import {
  atomicWriteFileSync,
  isAtomicBackupUnrecoverable,
  readAtomicFileSync,
} from '../utils/atomicWriteFile.js';
import {
  comboToElectronAccelerator,
  findAppShortcutConflict,
  getAppShortcutDefinition,
  getEffectiveAppShortcuts,
  isAppShortcutAvailableOnPlatform,
  isAppShortcutComboBindable,
  isAppShortcutId,
  normalizeAppShortcutCombo,
  normalizeAppShortcutOverrides,
  type AppShortcutCombo,
  type AppShortcutId,
  type AppShortcutOverrides,
} from '../../shared/appShortcuts.js';
import { isSystemReservedShortcut } from '../../shared/keyboardReserved.js';

const log = createLogger('app-shortcuts:store');

export const APP_SHORTCUTS_FILE_NAME = 'app-shortcuts.v1.json';

/**
 * setOverride 的失败原因 —— store 保持纯业务返回, IPC 层负责映射到
 * throwIpcError, 单测无需 electron。
 */
export type AppShortcutOverrideRejection =
  | 'unknown-id'
  | 'not-rebindable'
  | 'platform-unavailable'
  | 'invalid-combo'
  | 'not-bindable'
  | 'system-reserved'
  | 'menu-inexpressible'
  | 'conflict';

export interface AppShortcutStoreOptions {
  /** override 落盘文件绝对路径 (生产: userData/app-shortcuts.v1.json)。 */
  getFilePath: () => string;
  /** process.platform 注入, 便于单测按平台断言。 */
  platform: string;
  /** overrides 变化时通知 (广播到 renderer + main 内部菜单重建)。 */
  onChanged?: (overrides: AppShortcutOverrides) => void;
}

/**
 * 应用级快捷键用户 override 存储。
 *
 * 存储红线 (docs/dev-rules/configuration-and-overrides.md): 文件里永远只有用户显式
 * 改过的 id → combo, 默认值绝不落盘。生效值 = registry 默认 (随版本演进) +
 * override 合并; 恢复默认 = 删除 override key。load 时 normalize 会丢弃未知
 * id / 非法 combo, 版本升级删除某 id 后存量文件自动自愈。
 */
export class AppShortcutStore {
  private overrides: AppShortcutOverrides | null = null;
  private readonly changeListeners = new Set<(overrides: AppShortcutOverrides) => void>();

  constructor(private readonly options: AppShortcutStoreOptions) {}

  /** main 内部订阅 (如菜单重建); 返回取消订阅函数。 */
  subscribe(listener: (overrides: AppShortcutOverrides) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  getOverrides(): AppShortcutOverrides {
    return { ...this.load() };
  }

  /** main 消费端 (菜单 accelerator / before-input-event) 实时取某 id 的生效组合。 */
  getEffectiveCombos(id: AppShortcutId): AppShortcutCombo[] {
    if (!isAppShortcutAvailableOnPlatform(id, this.options.platform)) return [];
    const override = this.load()[id];
    if (override === null) return []; // 用户删除了绑定
    if (override) return [override];
    return getAppShortcutDefinition(id).getDefaultCombos(this.options.platform);
  }

  getEffectiveMap(): Map<AppShortcutId, AppShortcutCombo[]> {
    return getEffectiveAppShortcuts(this.load(), this.options.platform);
  }

  /**
   * 校验并写入单个 override; 失败返回 rejection 原因, 成功返回 null。
   * combo 传 null = 删除绑定 (该快捷键禁用), 跳过组合键校验。
   */
  setOverride(id: unknown, combo: unknown): AppShortcutOverrideRejection | null {
    if (!isAppShortcutId(id)) return 'unknown-id';
    const def = getAppShortcutDefinition(id);
    if (!def.rebindable) return 'not-rebindable';
    if (!isAppShortcutAvailableOnPlatform(id, this.options.platform)) return 'platform-unavailable';
    if (combo === null) {
      const current = this.load();
      this.replaceOverrides({ ...current, [id]: null });
      return null;
    }
    const normalized = normalizeAppShortcutCombo(combo);
    if (!normalized) return 'invalid-combo';
    if (!isAppShortcutComboBindable(normalized)) return 'not-bindable';
    if (isSystemReservedShortcut(normalized, platformFamily(this.options.platform))) {
      return 'system-reserved';
    }
    // darwin 上菜单专属 id 的组合必须能表达为 Electron accelerator, 否则
    // 菜单无 accelerator 且没有任何按键 fallback —— 绑定形同虚设。
    if (
      def.menuBacked &&
      this.options.platform === 'darwin' &&
      comboToElectronAccelerator(normalized, 'darwin') === null
    ) {
      return 'menu-inexpressible';
    }
    const current = this.load();
    // 跨 id 冲突兜底 (renderer 已前置校验, 这里防多窗口并发 / 直调 IPC):
    // 与重叠 scope 域内其它 id 的生效组合撞键则拒绝。
    if (findAppShortcutConflict(id, normalized, current, this.options.platform)) {
      return 'conflict';
    }
    this.replaceOverrides({ ...current, [id]: normalized });
    return null;
  }

  /** 恢复单项默认 = 删除该 id 的 override。id 未知时静默无操作 (幂等)。 */
  clearOverride(id: unknown): void {
    if (!isAppShortcutId(id)) return;
    const current = this.load();
    if (!(id in current)) return;
    const next = { ...current };
    delete next[id];
    this.replaceOverrides(next);
  }

  /** 恢复全部默认 = 清空 overrides。 */
  resetAll(): void {
    const current = this.load();
    if (Object.keys(current).length === 0) return;
    this.replaceOverrides({});
  }

  private load(): AppShortcutOverrides {
    if (this.overrides) return this.overrides;
    const filePath = this.options.getFilePath();
    try {
      const raw = readAtomicFileSync(filePath);
      if (raw === null) {
        this.overrides = {};
        return this.overrides;
      }
      const parsed = JSON.parse(raw) as unknown;
      const overridesRaw =
        parsed && typeof parsed === 'object'
          ? (parsed as { overrides?: unknown }).overrides
          : undefined;
      this.overrides = normalizeAppShortcutOverrides(overridesRaw, this.options.platform);
    } catch (error) {
      if (isAtomicBackupUnrecoverable(error)) {
        // 备份暂时恢复不了(通常是 Windows 文件锁/杀毒瞬时占用)——不能当成
        // "没有覆盖项"缓存进 this.overrides:一旦缓存，后续任何一次编辑触发的
        // save() 都会用这份错误的空状态覆盖磁盘上唯一还能救回来的快照，把一次
        // 瞬时故障变成永久丢失用户的自定义快捷键。这里只给这一次调用返回空
        // 快照，不写 this.overrides，下一次 load() 会重新尝试读盘。
        log.warn('app shortcut overrides temporarily unavailable, not caching as empty', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {};
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('app shortcut overrides read failed, using defaults', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.overrides = {};
    }
    return this.overrides;
  }

  private replaceOverrides(next: AppShortcutOverrides): void {
    // Commit the candidate only after the atomic file replacement succeeds.
    this.save(next);
    this.overrides = next;
    const snapshot = { ...next };
    this.options.onChanged?.(snapshot);
    this.changeListeners.forEach((listener) => listener(snapshot));
  }

  private save(overrides: AppShortcutOverrides): void {
    const filePath = this.options.getFilePath();
    try {
      atomicWriteFileSync(
        filePath,
        JSON.stringify({ version: 1, overrides }, null, 2),
      );
    } catch (error) {
      log.warn('app shortcut overrides write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function platformFamily(platform: string): 'mac' | 'windows' | 'other' {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'other';
}
