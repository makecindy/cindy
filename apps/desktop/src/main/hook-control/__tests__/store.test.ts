/**
 * hook-control store 单测(单配置形态): os.tmpdir 临时文件(规则 23:
 * 测试路径一律走系统临时目录, 收尾清理)。覆盖默认态 / 持久化 / 校验 /
 * urlOverride / 旧多连接文件一次性迁移。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../../shared/hookControlIpc';
import { createSlackHookStore, HookConnectionValidationError, validateWorkspaces } from '../store';

const noopLog = { info: () => {}, warn: () => {} };
// 生产的 defaultUrl 来自运行期端点清单(getClientEndpoint('slackHookWsUrl'));
// 测试注入中性 fixture,断言"无覆写时回落注入默认值"的语义。
const TEST_DEFAULT_URL = 'wss://hook-default.example.invalid';

let dir: string;
const filePath = (): string => path.join(dir, 'slack-hook.json');
const legacyPath = (): string => path.join(dir, 'hook-connections.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-hook-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore(
  cleanup?: (ids: string[]) => void,
  getAccountFingerprint: () => string | null = () => 'account-test',
) {
  return createSlackHookStore({
    filePath: filePath(),
    legacyFilePath: legacyPath(),
    cleanupLegacySecrets: cleanup,
    defaultUrl: () => TEST_DEFAULT_URL,
    getAccountFingerprint,
    log: noopLog,
  });
}

describe('默认态与持久化', () => {
  it('无文件: 关闭 + 空目录清单 + 内置默认地址 + 空绑定缓存', () => {
    const store = makeStore();
    expect(store.get()).toEqual({
      enabled: false,
      telegramEnabled: false,
      xEnabled: false,
      urlOverride: null,
      workspaces: {},
      bindingsCache: [],
      lifecycleAnnouncementOverride: null,
      telegramBindingCache: null,
      xBindingCache: null,
      xDefaultWorkspace: null,
      telegramDefaultWorkspace: null,
    });
    expect(store.effectiveUrl()).toBe(TEST_DEFAULT_URL);
  });

  it('setEnabled / setWorkspaces 落盘, 重建实例仍在', () => {
    const abs = path.join(dir, 'repo');
    makeStore().setEnabled(true);
    makeStore().setWorkspaces({ xdmaker: abs });
    const reread = makeStore().get();
    expect(reread.enabled).toBe(true);
    expect(reread.workspaces).toEqual({ xdmaker: abs });
  });

  it('urlOverride(手工写入配置文件的隐藏覆写位)生效; 非法值忽略', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ enabled: true, urlOverride: 'ws://127.0.0.1:8790', workspaces: {} }),
    );
    expect(makeStore().effectiveUrl()).toBe('ws://127.0.0.1:8790');
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ enabled: true, urlOverride: 'http://not-ws', workspaces: {} }),
    );
    expect(makeStore().effectiveUrl()).toBe(TEST_DEFAULT_URL);
  });
});

describe('workspaces 校验', () => {
  it('非法别名 / 相对路径拒绝', () => {
    expect(() => validateWorkspaces({ 别名: path.join(dir, 'x') })).toThrow(
      HookConnectionValidationError,
    );
    expect(() => validateWorkspaces({ ok: 'relative/path' })).toThrow(
      HookConnectionValidationError,
    );
    expect(() => validateWorkspaces({ constructor: path.join(dir, 'x') })).toThrow(
      HookConnectionValidationError,
    );
  });

  it('路径 trim 后保留', () => {
    const abs = path.join(dir, 'repo');
    expect(validateWorkspaces({ ok: `  ${abs}  ` })).toEqual({ ok: abs });
  });

  it('保留别名 chat(内置对话伪目录)不许用作真实目录别名', () => {
    expect(() => validateWorkspaces({ chat: path.join(dir, 'x') })).toThrow(
      HookConnectionValidationError,
    );
  });

  it('读损坏配置时过滤非法别名与非绝对路径，不让它们进入派发白名单', () => {
    const abs = path.join(dir, 'repo');
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        version: 2,
        urlOverride: null,
        workspaces: {
          valid: `  ${abs}  `,
          chat: abs,
          constructor: abs,
          relative: 'repos/relative',
        },
        accounts: {},
      }),
    );

    expect(makeStore().get().workspaces).toEqual({ valid: abs });
  });
});

describe('旧多连接文件迁移', () => {
  it('取最早创建的启用条目, 旧文件删除, 旧 secret 清理钩子拿到全部 id', () => {
    const abs = path.join(dir, 'repo');
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify([
        {
          id: 'b',
          name: 'later',
          url: 'wss://x',
          enabled: true,
          workspaces: { blog: abs },
          createdAt: 200,
        },
        {
          id: 'a',
          name: 'earlier',
          url: 'wss://y',
          enabled: true,
          workspaces: { xdmaker: abs },
          createdAt: 100,
        },
        { id: 'c', name: 'off', url: 'wss://z', enabled: false, workspaces: {}, createdAt: 50 },
      ]),
    );
    const cleaned: string[][] = [];
    const store = makeStore((ids) => cleaned.push(ids));
    const state = store.get();
    expect(state.enabled).toBe(true);
    expect(state.workspaces).toEqual({ xdmaker: abs }); // 最早创建的启用条目 a
    expect(state.urlOverride).toBeNull(); // 旧自部署地址不迁移
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(cleaned.flat().sort()).toEqual(['a', 'b', 'c']);
    // 迁移结果已落盘, 二次读不再触发迁移
    expect(makeStore().get().workspaces).toEqual({ xdmaker: abs });
  });

  it('旧文件损坏: 迁移跳过, 回默认态', () => {
    fs.writeFileSync(legacyPath(), 'not-json');
    expect(makeStore().get()).toEqual({
      enabled: false,
      telegramEnabled: false,
      xEnabled: false,
      urlOverride: null,
      workspaces: {},
      bindingsCache: [],
      lifecycleAnnouncementOverride: null,
      telegramBindingCache: null,
      xBindingCache: null,
      xDefaultWorkspace: null,
      telegramDefaultWorkspace: null,
    });
  });
});

describe('Slack 上下线通知偏好', () => {
  it('默认跟随产品值，用户切换后按账号持久化显式覆写', () => {
    expect(makeStore().get().lifecycleAnnouncementOverride).toBeNull();

    makeStore().setLifecycleAnnouncementOverride(true);
    expect(makeStore().get().lifecycleAnnouncementOverride).toBe(true);

    makeStore().setLifecycleAnnouncementOverride(false);
    expect(makeStore().get().lifecycleAnnouncementOverride).toBe(false);
  });
});

describe('(multi-team)bindingsCache 持久化', () => {
  const T1 = { teamId: 'T1', teamName: 'acme', slackUserId: 'U1', slackUserName: 'devuser' };
  const T2 = { teamId: 'T2', teamName: null, slackUserId: 'U2', slackUserName: null };

  it('setBindingsCache 落盘, 重建实例仍在; 覆写为空即清空', () => {
    makeStore().setBindingsCache([T1, T2]);
    expect(makeStore().get().bindingsCache).toEqual([T1, T2]);
    makeStore().setBindingsCache([]);
    expect(makeStore().get().bindingsCache).toEqual([]);
  });

  it('读回时坏条目静默丢弃(缺 teamId/slackUserId、非对象), teamName 非字符串归 null', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        enabled: false,
        urlOverride: null,
        workspaces: {},
        bindingsCache: [
          T1,
          { teamId: '', slackUserId: 'U9' }, // teamId 空串 → 丢
          { teamId: 'T3' }, // 缺 slackUserId → 丢
          'not-an-object', // 非对象 → 丢
          { teamId: 'T4', teamName: 42, slackUserId: 'U4', slackUserName: 7 }, // 非字符串名 → null
        ],
      }),
    );
    expect(makeStore().get().bindingsCache).toEqual([
      T1,
      { teamId: 'T4', teamName: null, slackUserId: 'U4', slackUserName: null },
    ]);
  });

  it('bindingsCache 字段非数组: 回空数组不炸', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ enabled: true, urlOverride: null, workspaces: {}, bindingsCache: 'junk' }),
    );
    const state = makeStore().get();
    expect(state.enabled).toBe(true);
    expect(state.bindingsCache).toEqual([]);
  });
});

describe('provider 与 Cindy 账号隔离', () => {
  const telegramBinding = {
    bindingId: 'bind-1',
    principalId: 'tg-user-1',
    principalName: 'Chris',
    scopeId: 'bot-1',
    scopeName: 'CindyBot',
  };

  it('Slack/Telegram 开关独立，目录映射设备共享，绑定缓存按账号分区', () => {
    let fingerprint = 'account-one';
    const store = makeStore(undefined, () => fingerprint);
    const abs = path.join(dir, 'repo');

    store.setEnabled(true);
    store.setProviderEnabled('telegram', true);
    store.setProviderBindingCache('telegram', telegramBinding);
    store.setWorkspaces({ cindy: abs });

    expect(store.anyProviderEnabled()).toBe(true);
    expect(store.get()).toMatchObject({
      enabled: true,
      telegramEnabled: true,
      workspaces: { cindy: abs },
      telegramBindingCache: telegramBinding,
    });

    fingerprint = 'account-two';
    expect(store.get()).toMatchObject({
      enabled: false,
      telegramEnabled: false,
      workspaces: { cindy: abs },
      bindingsCache: [],
      telegramBindingCache: null,
    });

    store.setProviderEnabled('telegram', true);
    fingerprint = 'account-one';
    expect(store.get().enabled).toBe(true);
    expect(store.get().telegramBindingCache).toEqual(telegramBinding);
  });

  it('登出期不把 provider 状态写入无账号的共享分区', () => {
    let fingerprint: string | null = null;
    const store = makeStore(undefined, () => fingerprint);
    store.setProviderEnabled('telegram', true);
    expect(store.get().telegramEnabled).toBe(false);

    fingerprint = 'account-after-login';
    expect(store.get().telegramEnabled).toBe(false);
  });

  it('拒绝会命中 Object 原型的伪账号指纹，不把状态写进错误分区', () => {
    const store = makeStore(undefined, () => 'constructor');

    expect(store.setProviderEnabled('telegram', true).telegramEnabled).toBe(false);
    expect(store.get().telegramEnabled).toBe(false);
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('读取账号分区时忽略 Object 原型键并保留合法账号', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        version: 2,
        urlOverride: null,
        workspaces: {},
        accounts: {
          ['__proto__']: {
            slack: { enabled: true, bindingsCache: [] },
            telegram: { enabled: true, bindingCache: telegramBinding },
          },
          'account-safe': {
            slack: { enabled: false, bindingsCache: [] },
            telegram: { enabled: true, bindingCache: telegramBinding },
          },
        },
      }),
    );

    expect(makeStore(undefined, () => 'account-safe').get()).toMatchObject({
      enabled: false,
      telegramEnabled: true,
      telegramBindingCache: telegramBinding,
    });
    expect(makeStore(undefined, () => '__proto__').get()).toMatchObject({
      enabled: false,
      telegramEnabled: false,
      telegramBindingCache: null,
    });
  });

  describe('默认工作目录(Telegram / X)', () => {
    it('设置后可读回;「对话」与 null 归一成同一种表示', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy' });

      expect(store.setProviderDefaultWorkspace('x', 'cindy').xDefaultWorkspace).toBe('cindy');
      expect(store.get().xDefaultWorkspace).toBe('cindy');
      // 「对话」伪目录不是 workspaces 的键, 与「没设过」语义相同 —— 存 null,
      // 免得同一状态有两种表示, 消费方各写一套判断。
      expect(
        store.setProviderDefaultWorkspace('x', HOOK_CHAT_WORKSPACE_ALIAS).xDefaultWorkspace,
      ).toBeNull();
      expect(store.setProviderDefaultWorkspace('x', 'cindy').xDefaultWorkspace).toBe('cindy');
      expect(store.setProviderDefaultWorkspace('x', null).xDefaultWorkspace).toBeNull();
    });

    it('两个 provider 各存一份, 互不影响', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy', other: '/tmp/other' });

      store.setProviderDefaultWorkspace('telegram', 'cindy');
      store.setProviderDefaultWorkspace('x', 'other');
      expect(store.get().telegramDefaultWorkspace).toBe('cindy');
      expect(store.get().xDefaultWorkspace).toBe('other');

      // 清掉一个不得连带清掉另一个 —— 泛化前只有一个字段, 很容易写成共用。
      store.setProviderDefaultWorkspace('telegram', null);
      expect(store.get().telegramDefaultWorkspace).toBeNull();
      expect(store.get().xDefaultWorkspace).toBe('other');
    });

    it('旧配置文件没有 telegram.defaultWorkspace 键: 读成 null, 不需要迁移动作', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy' });
      store.setProviderDefaultWorkspace('x', 'cindy');

      // 手工把这个键删掉, 模拟升级前写下的存档。
      const raw = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as {
        accounts: Record<string, { telegram: Record<string, unknown> }>;
      };
      delete raw.accounts['account-test'].telegram.defaultWorkspace;
      fs.writeFileSync(filePath(), JSON.stringify(raw), 'utf-8');

      const reopened = makeStore();
      expect(reopened.get().telegramDefaultWorkspace).toBeNull();
      // 同一份存档里 X 那份不受影响。
      expect(reopened.get().xDefaultWorkspace).toBe('cindy');
    });

    it('目录被删掉后两个 provider 的默认值都归零(存档层面也删掉)', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy', other: '/tmp/other' });
      store.setProviderDefaultWorkspace('telegram', 'cindy');
      store.setProviderDefaultWorkspace('x', 'cindy');

      store.setWorkspaces({ other: '/tmp/other' });
      expect(store.get().telegramDefaultWorkspace).toBeNull();
      expect(store.get().xDefaultWorkspace).toBeNull();

      // 只清一个 provider 会让另一个的失效别名留在盘上, 用户重建同名别名时复活。
      const raw = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as {
        accounts: Record<
          string,
          { telegram: { defaultWorkspace: string | null }; x: { defaultWorkspace: string | null } }
        >;
      };
      expect(raw.accounts['account-test'].telegram.defaultWorkspace).toBeNull();
      expect(raw.accounts['account-test'].x.defaultWorkspace).toBeNull();
    });

    it('未配置的别名写入即拒(非法值会在下次握手时被协议拒收, 那时离操作已经很远)', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy' });
      expect(() => store.setProviderDefaultWorkspace('x', 'nope')).toThrow(HookConnectionValidationError);
      expect(store.get().xDefaultWorkspace).toBeNull();
    });

    it('目录被删掉后默认值自动归零, 不会把清单外的别名发进 hello', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy', other: '/tmp/other' });
      store.setProviderDefaultWorkspace('x', 'cindy');
      expect(store.get().xDefaultWorkspace).toBe('cindy');

      // 用户在设置里删掉了 cindy 这条映射。留着旧默认值会让 hello 带上清单外的
      // 别名被协议拒收 —— X 连接断在握手上, 且界面上没有任何线索。
      store.setWorkspaces({ other: '/tmp/other' });
      expect(store.get().xDefaultWorkspace).toBeNull();
    });

    it('删掉的别名重新出现(指向另一个目录)时默认值不复活 —— 存档里已经删了, 不只是被遮住', () => {
      const store = makeStore();
      store.setWorkspaces({ cindy: '/Users/dash/Code/cindy', other: '/tmp/other' });
      store.setProviderDefaultWorkspace('x', 'cindy');
      store.setWorkspaces({ other: '/tmp/other' });

      // 别名是用户自己起的名字, 删掉 cindy 之后再建一个同名的很常见, 但它现在
      // 指向另一个目录。若旧值只在读侧被投影成 null、仍留在盘上, 这一步就会让
      // 它无声复活, X 任务被派发到用户从未选过的目录。
      store.setWorkspaces({ cindy: '/tmp/somewhere-else', other: '/tmp/other' });
      expect(store.get().xDefaultWorkspace).toBeNull();

      // 存档层面的反向锚点: 落盘的文档里也不该还留着这个别名。
      const raw = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as {
        accounts: Record<string, { x: { defaultWorkspace: string | null } }>;
      };
      expect(raw.accounts['account-test'].x.defaultWorkspace).toBeNull();
    });
  });
});
