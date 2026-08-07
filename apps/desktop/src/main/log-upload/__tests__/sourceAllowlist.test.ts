/**
 * 来源白名单的方向锁（需求 §5.2 / §6 隐私性第 2 条）。
 *
 * 这张表决定「哪些 main 日志记录会离开用户的机器」，所以除了逐条正例，更重要的是：
 *  - **未知来源默认不放行**（deny-by-default 的方向不能被改成黑名单）；
 *  - **匹配必须根锚定**（否则 `r:lifecycle`、`lifecycle-evil` 这类会蹭进来）；
 *  - **排除表优先于放行表**，以及设备互联那组的**精确匹配**（根放行会让新增子 scope 默认放行，
 *    方向与 deny-by-default 相反——`device-link:ipc` 就是这么漏出去的）。
 */
import { describe, expect, it } from 'vitest';

import { isAllowedScope, __testing } from '../sourceAllowlist';

describe('放行：基础设施来源', () => {
  it.each([
    ['lifecycle', '退出编排与 render-process-gone'],
    ['process', 'uncaughtException 全栈 —— 崩溃排查的主要证据'],
    ['startup-diagnostics', '退出尸检结论'],
    ['updateService', '更新链路'],
    ['clientEndpoints', '端点清单拉取'],
    ['DbClient', '数据库连接与语句层错误'],
    ['authManager', '鉴权'],
    ['logger', '格式哨兵'],
  ])('%s 放行（%s）', (scope) => {
    expect(isAllowedScope(scope)).toBe(true);
  });

  it.each([
    'authManager/refresh',
    'updateService:download',
    'clientEndpoints/resolve',
  ])('根放行的子 scope 跟随根：%s', (scope) => {
    expect(isAllowedScope(scope)).toBe(true);
  });

  it('两种子 scope 分隔符都认（仓库里 / 与 : 都在用）', () => {
    expect(isAllowedScope('authManager/refresh')).toBe(true);
    expect(isAllowedScope('authManager:refresh')).toBe(true);
  });
});

describe('拒绝：会打用户内容的来源', () => {
  it.each([
    ['console', '第三方库与漏网 console.log 的兜底落点，内容不可控'],
    ['voice-input:recorder', '听写草稿 = 用户语音内容'],
    ['desktop-commands', '命令行 = 用户输入'],
    ['terminal/pty-manager', '终端内容'],
    ['file-browser/search', '文件路径与内容'],
    ['session-search', '搜索关键词'],
    ['chat-history-search', '搜索关键词'],
    ['maker-ipc', 'agent 编排,带提示词'],
    ['brain-runtime', '插件运行时,带用户内容'],
    ['skillhub:publishService', '用户内容'],
    ['secrets:builtin-api-key', '凭证相关'],
    ['providerSecretStore', '凭证相关'],
    ['learn-host:evidence', '用户内容'],
    ['goal-host', '用户内容'],
    ['mcp/cindy_memory', '用户记忆内容'],
    ['im:msg-persist', 'IM 消息正文'],
    ['git-context/ipc', '仓库内容与路径'],
    ['worktree:dirty', '工作目录路径'],
  ])('%s 不放行（%s）', (scope) => {
    expect(isAllowedScope(scope)).toBe(false);
  });

  /**
   * 2026-08-04 用真实 dev 日志跑采集时发现的回归：`renderer-console` 与 `renderer-guard`
   * 曾共用同一个 scope，于是渲染进程的任意 console 正文（功能代码 console.error 里的消息
   * 文本、搜索词、第三方库 payload）跟着被放行。它是「渲染进程转发的日志整类丢弃」这条约束
   * 上一个**绕过 `r:` 前缀机制**的通道，必须单独钉住。
   */
  it('⚠️ renderer-console（渲染进程 console 转发）不放行，renderer-guard（加载失败信号）放行', () => {
    expect(isAllowedScope('renderer-console')).toBe(false);
    expect(isAllowedScope('renderer-guard')).toBe(true);
  });

  it('渲染进程转发的日志整类不放行（r: 前缀天然不在名单内）', () => {
    // 放行根加上 r: 前缀后必须全部落空 —— 这条是「渲染进程日志整类丢弃」的机械保证。
    for (const root of __testing.ALLOWED_ROOT_SCOPES) {
      expect(isAllowedScope(`r:${root}`)).toBe(false);
    }
  });

  it('agent 流的 scope 不在 main 白名单内（proxy 走 agentLogReader 自己那条窄规则）', () => {
    for (const scope of ['maker', 'maker/s:abc', 'cc-proxy/req', 'codex-proxy/req']) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });
});

describe('deny-by-default 与根锚定', () => {
  it('未知来源一律不放行', () => {
    for (const scope of ['brand-new-module', 'someFutureFeature', 'x', 'unknown/deep/scope']) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });

  it('空 scope 不放行', () => {
    expect(isAllowedScope('')).toBe(false);
  });

  it('前缀蹭名不放行（根锚定，不是 startsWith 裸判）', () => {
    expect(isAllowedScope('lifecycle-evil')).toBe(false);
    expect(isAllowedScope('authManagerEvil')).toBe(false);
    expect(isAllowedScope('xlifecycle')).toBe(false);
    expect(isAllowedScope('evil-device-link')).toBe(false);
  });
});

describe('排除表优先于放行表', () => {
  it.each(__testing.DENIED_SUB_SCOPES)('%s 被拦（会带本地路径/媒体内容）', (scope) => {
    expect(isAllowedScope(scope)).toBe(false);
  });

  it('被排除的子 scope 其更深层也被拦', () => {
    expect(isAllowedScope('device-link:mediaFetch/inner')).toBe(false);
  });

  /**
   * 2026-08-04 review copilot：排除表匹配必须**分隔符无关**。仓库里 `/` 与 `:` 两种子 scope
   * 分隔符都在用,排除项按写出来的那一种存,但两种形式都得挡住 —— 否则这张「纵深防御」表在
   * 「有人把某个根重新加回根放行」时会被另一种分隔符绕过。直接测匹配谓词,不依赖当前恰好是
   * 精确放行这个偶然。
   */
  it('⚠️ 排除匹配分隔符无关：每个排除项的 / 与 : 两种形式都命中', () => {
    for (const denied of __testing.DENIED_SUB_SCOPES) {
      const slash = denied.replace(/:/g, '/');
      const colon = denied.replace(/\//g, ':');
      expect(__testing.matchesDeniedSubScope(slash)).toBe(true);
      expect(__testing.matchesDeniedSubScope(colon)).toBe(true);
      // 更深一层同样命中(两种分隔符)。
      expect(__testing.matchesDeniedSubScope(`${slash}/inner`)).toBe(true);
      expect(__testing.matchesDeniedSubScope(`${colon}:inner`)).toBe(true);
    }
  });

  it('⚠️ 假设 localDb 被误加回根放行，localDb:messages（冒号形式）仍被排除表挡住', () => {
    // 现在 localDb 是精确放行,localDb:messages 本就不放行;这条锁的是纵深防御本身 ——
    // 排除表对冒号形式也生效,不靠「恰好精确放行」。
    expect(__testing.matchesDeniedSubScope('localDb:messages')).toBe(true);
    expect(__testing.matchesDeniedSubScope('localDb/messages')).toBe(true);
  });
});

/**
 * 设备互联走**精确匹配**而不是根放行。
 *
 * 2026-08-04 review 的结论：根放行时 `device-link:ipc` 会跟着进来，而它在镜像缓存清理失败
 * 时把本地缓存文件路径写进日志。真正的问题不是漏了这一个，而是「根放行 + 逐条排除」让
 * **新增的子 scope 默认放行**——方向与 deny-by-default 相反。
 */
describe('device-link：精确匹配，子 scope 不跟着放行', () => {
  it('放行的只有明确列出的那两个', () => {
    expect(isAllowedScope('device-link')).toBe(true);
    expect(isAllowedScope('device-link:cross-process-lock')).toBe(true);
  });

  it('⚠️ device-link:ipc 不放行（会把镜像缓存清理的 root / remaining 路径写进日志）', () => {
    expect(isAllowedScope('device-link:ipc')).toBe(false);
  });

  it('device-link 下**任何**未列出的子 scope 默认不放行（含将来新增的）', () => {
    for (const scope of [
      'device-link:mediaFetch',
      'device-link:mirror-cache',
      'device-link:telegram',
      'device-link:some-future-sub-scope',
      'device-link/anything',
      'device-link:cross-process-lock/deeper',
    ]) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });

  it('精确表里的条目不得同时出现在根表里（否则又退回根放行）', () => {
    for (const exact of __testing.ALLOWED_EXACT_SCOPES) {
      expect(__testing.ALLOWED_ROOT_SCOPES).not.toContain(exact);
    }
  });
});

/**
 * localDb 同理走**精确匹配**（2026-08-04 review）：根放行会把 `localDb/messages`（消息导入 /
 * 媒体附件路径）一起带出去。bare `localDb` 只打库打开 / migration / 完整性这些基础设施事件。
 */
describe('localDb：精确匹配，子 scope 不跟着放行', () => {
  it('bare localDb 放行', () => {
    expect(isAllowedScope('localDb')).toBe(true);
  });

  it('⚠️ localDb/messages 不放行（消息导入与媒体附件路径）', () => {
    expect(isAllowedScope('localDb/messages')).toBe(false);
    expect(isAllowedScope('localDb:messages')).toBe(false);
  });

  it('localDb 下任何未列出的子 scope 默认不放行（含将来新增的）', () => {
    for (const scope of [
      'localDb/betterSqliteFactory',
      'localDb/sqliteVec',
      'localDb/dailySpend',
      'localDb/some-future-sub-scope',
    ]) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });
});

/**
 * 2026-08-04 review：又两个会打路径的来源。
 *  - auth-boundary 根有价值(登出/账号切换的服务拆卸序列,shutdown 排查必需),但镜像缓存清理
 *    失败那几条带本地缓存路径 → 拆到 auth-boundary:mirror-cache-purge 子 scope 并排除。
 *  - legacy-xdmaker-migration 每条都带 rootDir(项目工作目录)→ 整个 scope 拒。
 */
describe('会打路径的来源被挡在外', () => {
  it('auth-boundary 根放行（服务停止诊断，不带路径）', () => {
    expect(isAllowedScope('auth-boundary')).toBe(true);
    expect(isAllowedScope('auth-boundary:stop-scheduler')).toBe(true); // 其它子 scope 跟随根
  });

  it('⚠️ auth-boundary:mirror-cache-purge 不放行（带本地镜像缓存路径），两种分隔符都挡', () => {
    expect(isAllowedScope('auth-boundary:mirror-cache-purge')).toBe(false);
    expect(isAllowedScope('auth-boundary/mirror-cache-purge')).toBe(false);
    expect(isAllowedScope('auth-boundary:mirror-cache-purge:retry')).toBe(false);
  });

  it('auth-adapters 根放行（凭证生命周期诊断，不带用户身份/路径）', () => {
    expect(isAllowedScope('auth-adapters')).toBe(true);
    expect(isAllowedScope('auth-adapters:codex')).toBe(true); // 其它子 scope 跟随根
  });

  it('⚠️ auth-adapters:asset-prep 不放行（带 skill/marketplace 名与绝对路径），两种分隔符都挡', () => {
    // 2026-08-06 review：全局 skill/plugin 资产准备的告警会带用户自选 skill·marketplace 名
    // 与绝对路径(cannot link skill X from <path> to <path>),拆到独立子 scope 并排除。
    expect(isAllowedScope('auth-adapters:asset-prep')).toBe(false);
    expect(isAllowedScope('auth-adapters/asset-prep')).toBe(false);
    expect(isAllowedScope('auth-adapters:asset-prep:codex')).toBe(false);
  });

  it('⚠️ auth-adapters:cred-path 不放行（带 auth.json 等凭证文件绝对路径），两种分隔符都挡', () => {
    // 2026-08-06 review：凭证文件 icacls/chmod/rm/硬链失败诊断带绝对路径(脱敏只抹用户名段),
    // 拆到独立子 scope 并排除;根 auth-adapters 只剩不带路径的凭证生命周期诊断。
    expect(isAllowedScope('auth-adapters:cred-path')).toBe(false);
    expect(isAllowedScope('auth-adapters/cred-path')).toBe(false);
    expect(isAllowedScope('auth-adapters:cred-path:codex')).toBe(false);
  });

  it('⚠️ legacy-xdmaker-migration 整个 scope 不放行（每条都带 rootDir 工作目录）', () => {
    expect(isAllowedScope('legacy-xdmaker-migration')).toBe(false);
    expect(isAllowedScope('legacy-xdmaker-migration/x')).toBe(false);
  });

  it('⚠️ ownerNamespaceMigration 整个 scope 不放行（遗留 ghost 恢复打 id:legacy.id = 插件身份 + fs 路径）', () => {
    // 2026-08-06 review：混着 path-free 迁移状态与插件专属恢复数据,整体拒。
    expect(isAllowedScope('ownerNamespaceMigration')).toBe(false);
    expect(isAllowedScope('ownerNamespaceMigration/x')).toBe(false);
  });

  it('未被点名的迁移 scope 仍放行（只拒确有路径/身份的那两个）', () => {
    expect(isAllowedScope('legacyUserDataMigration')).toBe(true);
  });

  it('⚠️ manifestIO 不放行（实为 SkillHub 注册表，打 skillhub/manifests/<skill>.json）', () => {
    expect(isAllowedScope('manifestIO')).toBe(false);
    expect(isAllowedScope('manifestIO/read')).toBe(false);
    // 端点清单拉取的 manifestService 是另一个 scope，仍放行。
    expect(isAllowedScope('manifestService')).toBe(true);
  });
});

describe('名单自身的卫生', () => {
  it('放行根没有重复项', () => {
    const roots = __testing.ALLOWED_ROOT_SCOPES;
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('放行根里不含 console（它是内容不可控的兜底落点，误加会直接造成隐私事故）', () => {
    expect(__testing.ALLOWED_ROOT_SCOPES).not.toContain('console');
  });

  it('点名的高危来源都确实不在放行名单里', () => {
    for (const denied of __testing.NOTABLE_DENIED_ROOTS) {
      expect(isAllowedScope(denied)).toBe(false);
    }
  });
});
