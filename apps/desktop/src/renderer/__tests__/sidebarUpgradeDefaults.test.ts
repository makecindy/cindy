/**
 * 侧边栏升级兼容性契约(2026-08-12 用户裁决)
 * ---------------------------------------------------------------------------
 * 目标:老用户升级后左侧任务列表**尽量不变**;新用户才吃新默认。
 *   - 分组默认老新一致:按项目 + 按设备 + 对话归组(用户明确要求不分老新)。
 *   - 排序默认按时间;任务信息默认只显示时间。
 *   - **显示模式是唯一按安装新旧分叉的项**:新装 'list',老装 'text'。
 *     最难的一类是「从没动过显示模式的老用户」——localStorage 里没有 cardMode,
 *     与全新安装无法直接区分,靠 sidebarInstallVintage 的旧版使用痕迹识别。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadGroupBy,
  loadGroupDevice,
  loadGroupDialogue,
  loadSortBy,
  loadTaskInfoFields,
  GROUP_DIALOGUE_KEY,
} from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';
import {
  getSidebarInstallVintage,
  __testing as vintageTesting,
} from '@/features/cc-agent/lib/sidebarInstallVintage';

/* ------------ in-memory localStorage shim ------------ */

function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    key(idx: number) {
      return Array.from(store.keys())[idx] ?? null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = fakeStorage;
  return store;
}

function uninstallLocalStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
}

/**
 * 主列表显示模式的解析在模块级缓存了内存值,无法在同一进程里反复重置;
 * 这里直接复刻 getSidebarMainViewMode 的判定顺序做契约测试(显式值 > 迁移 >
 * 按安装新旧给默认),源码侧的接线由 sidebarUpgradeDefaults 的静态断言守住。
 */
function resolveMainViewMode(): 'text' | 'list' {
  const explicit = localStorage.getItem('sidebar.mainListMode');
  if (explicit === 'text' || explicit === 'list') return explicit;
  const legacy = localStorage.getItem('sidebar.cardMode');
  if (legacy === 'text' || legacy === 'false') return 'text';
  if (legacy === 'card' || legacy === 'list' || legacy === 'true') return 'list';
  return getSidebarInstallVintage() === 'legacy' ? 'text' : 'list';
}

describe('侧边栏升级兼容性:默认配置', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vintageTesting.resetMemo();
  });
  afterEach(() => {
    uninstallLocalStorage();
    vintageTesting.resetMemo();
  });

  it('新用户默认:项目 + 设备 + 对话三层分组,按时间排序,任务信息只显示时间', () => {
    expect(loadGroupBy()).toBe('project');
    expect(loadGroupDevice()).toBe(true);
    expect(loadGroupDialogue()).toBe(true);
    expect(loadSortBy()).toBe('recency');
    expect(loadTaskInfoFields()).toEqual(['time']);
  });

  it('分组默认不分老新:老安装拿到同一套分组默认', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    expect(getSidebarInstallVintage()).toBe('legacy');
    expect(loadGroupBy()).toBe('project');
    expect(loadGroupDevice()).toBe(true);
    expect(loadGroupDialogue()).toBe(true);
  });

  it('对话归组仍可显式关闭(默认翻转后 false 必须仍被尊重)', () => {
    localStorage.setItem(GROUP_DIALOGUE_KEY, 'false');
    expect(loadGroupDialogue()).toBe(false);
  });
});

describe('sidebarInstallVintage:老安装识别', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vintageTesting.resetMemo();
  });
  afterEach(() => {
    uninstallLocalStorage();
    vintageTesting.resetMemo();
  });

  it('空 localStorage = 全新安装', () => {
    expect(getSidebarInstallVintage()).toBe('fresh');
  });

  it.each(vintageTesting.LEGACY_USAGE_KEYS)('任一旧版使用痕迹即判为老安装:%s', (key) => {
    localStorage.setItem(key, 'x');
    expect(getSidebarInstallVintage()).toBe('legacy');
  });

  it('owner-scoped 后缀的痕迹同样命中(前缀匹配,格式对齐 sidebarOwnerStorageKey)', () => {
    // 真实格式是 `<base>.owner.<encodeURIComponent(ownerId)>`(2026-08-13 修正:
    // 此前实现与本测试都误用 `<base>:` 前缀,互相印证成"绿的死码")。
    localStorage.setItem('cc-agent.sidebar.collapsedProjects.owner.owner-1', '[]');
    expect(getSidebarInstallVintage()).toBe('legacy');
  });

  // 2026-08-13 review P1:claim key 由 sidebarOwnerStorage 在任何首次 owner-scoped
  // 读取时建账写入——全新安装首帧 useSidebarFilter(父组件)先跑,首次读显示模式
  // (子组件)在后。按「存在即痕迹」判会把所有新装误判成老装。
  it('新装首帧建账写入的 claim key(捕获值全 null)不构成旧版痕迹', () => {
    localStorage.setItem(
      vintageTesting.OWNER_CLAIM_KEY,
      JSON.stringify({
        version: 1,
        ownerId: 'owner-1',
        legacy: {
          schemaVersion: 1,
          values: {
            'cc-agent.sidebar.filter.projects': null,
            'cc-agent.sidebar.pinnedSessionOrder': null,
          },
        },
      }),
    );
    expect(getSidebarInstallVintage()).toBe('fresh');
  });

  it('claim 信封捕获到非空旧数据 = 老安装', () => {
    localStorage.setItem(
      vintageTesting.OWNER_CLAIM_KEY,
      JSON.stringify({
        version: 1,
        ownerId: 'owner-1',
        legacy: {
          schemaVersion: 1,
          values: { 'cc-agent.sidebar.filter.projects': '["/repo"]' },
        },
      }),
    );
    expect(getSidebarInstallVintage()).toBe('legacy');
  });

  it('bare v1 形态的 claim(未发布中间版本的占位,生产形态见 parseClaimState)= 老安装', () => {
    // 生产 bare 形态是「v1 + ownerId、无 legacy 字段」的 JSON 对象,不是裸字符串
    // (2026-08-13 复核修正:上一版实现与测试都拿裸字符串互相印证)。
    localStorage.setItem(
      vintageTesting.OWNER_CLAIM_KEY,
      JSON.stringify({ version: 1, ownerId: 'owner-1' }),
    );
    expect(getSidebarInstallVintage()).toBe('legacy');
  });

  it.each([
    ['裸字符串', 'owner-1'],
    ['损坏 JSON', '{oops'],
    ['非对象字面量', '42'],
    ['缺 ownerId 的残缺对象', JSON.stringify({ version: 1 })],
  ])('malformed claim 不构成痕迹(%s → fresh)', (_label, raw) => {
    localStorage.setItem(vintageTesting.OWNER_CLAIM_KEY, raw);
    expect(getSidebarInstallVintage()).toBe('fresh');
  });

  it('其它以痕迹键为前缀但非 owner-scoped 的键不误判', () => {
    localStorage.setItem('cc-agent.sidebar.collapsedProjectsSomethingElse', 'x');
    expect(getSidebarInstallVintage()).toBe('fresh');
  });

  it('判定固化后不再随新出现的痕迹翻转(避免默认值中途漂移)', () => {
    expect(getSidebarInstallVintage()).toBe('fresh');
    expect(localStorage.getItem(vintageTesting.INSTALL_VINTAGE_KEY)).toBe('fresh');
    // 新用户用一阵后自然会写 lastChatView —— 不能因此变成「老用户」。
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    vintageTesting.resetMemo();
    expect(getSidebarInstallVintage()).toBe('fresh');
  });

  it('localStorage 不可用时按 fresh 兜底,不抛错', () => {
    uninstallLocalStorage();
    expect(getSidebarInstallVintage()).toBe('fresh');
  });
});

describe('显示模式:唯一按安装新旧分叉的默认', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vintageTesting.resetMemo();
  });
  afterEach(() => {
    uninstallLocalStorage();
    vintageTesting.resetMemo();
  });

  it('全新安装 → 列表视图', () => {
    expect(resolveMainViewMode()).toBe('list');
  });

  it('从没动过显示模式的老用户 → 文字视图(本次兼容性的核心用例)', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    expect(resolveMainViewMode()).toBe('text');
  });

  it('老用户显式设过 cardMode:仍按旧值迁移,不受安装新旧影响', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    localStorage.setItem('sidebar.cardMode', 'card');
    expect(resolveMainViewMode()).toBe('list');
  });

  it('显式设过主列表模式时,安装新旧不参与判定', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    localStorage.setItem('sidebar.mainListMode', 'list');
    expect(resolveMainViewMode()).toBe('list');
  });

  // 上面的用例复刻了判定顺序(源码里的内存 SoT 无法在同进程反复重置),
  // 这条静态断言保证源码确实按同一顺序接线,两者不脱钩。
  it('源码接线:显式值 → cardMode 迁移 → 按安装新旧兜底', () => {
    const source = readFileSync(resolve(__dirname, '..', 'hooks', 'useSidebarCardMode.ts'), 'utf8');
    const explicitIdx = source.indexOf('parseMainMode(localStorage.getItem(MAIN_STORAGE_KEY))');
    // 注意 'parseMode(' 是 'parseMainMode(' 的子串,必须带 const legacy = 前缀定位。
    const legacyIdx = source.indexOf('const legacy = parseMode(localStorage.getItem(STORAGE_KEY))');
    const vintageIdx = source.indexOf("getSidebarInstallVintage() === 'legacy'");
    expect(explicitIdx).toBeGreaterThanOrEqual(0);
    expect(legacyIdx).toBeGreaterThan(explicitIdx);
    expect(vintageIdx).toBeGreaterThan(legacyIdx);
    expect(source).toContain("return (mainMemoryValue = 'text')");
    expect(source).toContain("const DEFAULT_MAIN_MODE: SidebarMainViewMode = 'list'");
  });
});
