/**
 * 第二层：**记录来源白名单**（决定 `main-*.log` 里放行哪些记录）。
 *
 * ⚠️ 方向不可反转：这是 **deny-by-default** 白名单，未知来源一律丢弃。
 *
 * 为什么不能用黑名单：功能模块会在 debug 级别把用户输入写进日志——语音听写草稿、
 * 命令行、搜索关键词、界面上最后一条用户消息……黑名单逐个封禁不收敛，永远有下一个。
 * 反过来只放行基础设施记录（生命周期 / 崩溃 / 网络 / 更新 / 数据库 / 鉴权 / 设备互联的
 * 连接层），恰好覆盖「排查 App 本身出错」这个诉求。代价是**新增诊断来源需要显式加入
 * 名单**——这是有意为之，可收敛。
 *
 * 名单只增不减；新增条目必须在 PR 里写明理由并过 review（需求 §8）。
 *
 * 渲染进程转发的日志整类落空：`writeFromRenderer()` 强制 `r:` 前缀，而匹配是**根锚定**的，
 * `r:lifecycle` 不会命中 `lifecycle`。同理 `maker*` / `cc-proxy*` / `codex-proxy*` 也不会
 * 命中（它们本就不写 main 流）。
 */

/**
 * 放行的根 scope。匹配规则见 `isAllowedScope`：精确相等，或以 `<root>/` / `<root>:` 开头
 * （仓库里两种子 scope 分隔符都在用）。
 *
 * 每条都带理由。理由写不出来的条目不该在名单里。
 */
const ALLOWED_ROOT_SCOPES: readonly string[] = [
  // ── 生命周期 / 崩溃 / 进程 ────────────────────────────────────────────────
  'lifecycle', //            退出编排、disposer 超时、render-process-gone、watchdog 布防
  'startup-diagnostics', //  退出尸检结论、crash dump 清单
  'logger', //               日志自身的初始化与格式哨兵
  'process', //              uncaughtException / unhandledRejection 的全栈落点 —— 崩溃排查的主要证据
  'power-diagnostics', //    睡眠/唤醒前后的异常(「合盖再打开就卡住」类问题)
  'power-blocker', //        阻止休眠的持有与释放
  'idleManager', //          空闲判定(自动更新重启时机依赖它)
  'app-presence', //         前后台/可见性状态机
  'appSessionState', //      应用级会话状态机(只记状态转换,不记内容)
  // 渲染进程启动守卫 —— 白屏排查必需(preload-error / 加载失败 / boot guard 重试)。
  // ⚠️ 只含这些无用户内容的加载失败信号:渲染进程 console 的转发**不在**这个 scope 下,
  // 它单独走 `renderer-console`(见下方 NOTABLE_DENIED_ROOTS)。两者曾共用同一个 scope,
  // 于是整类渲染进程 console 正文跟着被放行 —— 2026-08-04 用真实 dev 日志跑采集时发现。
  'renderer-guard',
  'csp', //                  CSP 违规上报(注入/加载异常)
  'secondary-windows', //    子窗口创建与销毁
  'windows-tray', //         Windows 托盘生命周期
  'dock-icon', //            macOS Dock 图标状态
  'relaunch-activity', //    重启前的忙碎判定

  // ── 更新链路（需求 U6 明确要求覆盖）────────────────────────────────────────
  'updateService', //        下载/校验/安装/重启各环节
  'update-presentation', //  更新提示的展示决策
  'releaseNotesService', //  更新说明拉取

  // ── 网络与端点清单（需求 U6：端点清单拉取失败率）──────────────────────────
  'clientEndpoints', //      运行期端点清单解析、缓存可信性判定、离线出口
  'manifestService', //      清单拉取
  // 注意:`manifestIO` **不在这里** —— 名字看着像端点清单落盘,实际仓库里唯一的
  // `createLogger('manifestIO')` 是 SkillHub 注册表存储(skillhub/registry/manifestIO.ts),
  // 它会打 `skillhub/manifests/<skill>.json` 这类清单路径 / 文件名 = 用户装的插件身份,
  // 与 `skillhub` 同属用户/第三方内容(2026-08-04 review)。见 NOTABLE_DENIED_ROOTS。
  // 平台 API 调用的状态码与耗时。⚠️ 4xx/5xx 会打 `path=`(和 `msg=`):路径/消息里带**用户/第三方
  // 身份**的调用方——plugin-market 的 `/api/plugins/<pluginId>`、SkillHub 的
  // `/api/skills-hub/skills/<name>`——必须传 `logLabel` 路由模板(设了 logLabel 的调用日志会用模板
  // 代替真实 path、并连 `msg` 一起省掉),否则插件/skill 身份会随这个根放行的 scope 外泄
  // (2026-08-06 review;见 serverApiClient.ts 的 logLabel)。
  'serverApiClient', //      平台 API 调用的状态码与耗时
  'heartbeat', //            在线心跳(网络可达性的连续信号)

  // ── 数据库 ────────────────────────────────────────────────────────────────
  // 注意:`localDb` **不在这里**,它是精确放行(见 ALLOWED_EXACT_SCOPES)——它的子 scope
  // `localDb/messages` 会打消息导入/媒体附件路径,根放行会把它一起带出去。
  'DbClient', //             连接与语句层错误
  'db-worker', //            worker 进程存活与崩溃
  'schema-drift-detector', // schema 漂移检测
  'schema-drift-repair', //  漂移修复

  // ── 鉴权 ──────────────────────────────────────────────────────────────────
  'authManager', //          登录/续期/失效/realm 切换
  // 各登录方式适配层。两类会带用户身份/路径的诊断已拆到独立子 scope 并排除(见 DENIED_SUB_SCOPES):
  // `auth-adapters:asset-prep`(全局 skill/plugin 资产准备,带 skill·marketplace 名与路径)、
  // `auth-adapters:cred-path`(凭证文件 icacls/chmod/rm/硬链失败,带 auth.json 等绝对路径)。
  // 根这里只剩不带用户身份/路径的凭证生命周期诊断(失效/绑定/状态转换)。
  'auth-adapters', //        各登录方式适配层
  // 登录 / 账号切换时的服务拆卸序列(shutdown-hang / 账号切换排查必需)。其中镜像缓存清理
  // 失败会打本地缓存路径,那几条已改走独立的 `auth-boundary:mirror-cache-purge` 子 scope 并
  // 排除(见 DENIED_SUB_SCOPES);根这里只剩不带路径的服务停止诊断。
  'auth-boundary', //        鉴权边界校验 / 拆卸序列
  'safe-storage', //         safeStorage 可用性与钥匙串降级(不含密文本身)

  // ── 配置与存量迁移基础设施 ────────────────────────────────────────────────
  // 注意:`legacy-xdmaker-migration` 与 `ownerNamespaceMigration` **都不在这里**:
  //  - `legacy-xdmaker-migration` 每条记录都带 `rootDir`(解析后的项目工作目录)。
  //  - `ownerNamespaceMigration` 的遗留 ghost 恢复诊断会打 `id: legacy.id`(= 用户已装的第三方
  //    插件目录名/身份)与 fs 移动失败的绝对路径(2026-08-06 review)。
  // 两者都见 NOTABLE_DENIED_ROOTS。
  'legacyUserDataMigration', // userData 目录迁移(只记有无 legacy 目录 + 标记,不带工作目录)
  'analytics-settings', //       同意状态与开关的读写(不含用户内容)
  'sidebar-settings', //         侧栏偏好读写
  'canaryFlagStore', //          灰度开关
];

/**
 * **精确匹配**放行的 scope：只放行写出来的这一个，其子 scope（`<name>:x` / `<name>/x`）
 * 一律不跟着放行。
 *
 * 设备互联走这条而不是根放行，是 2026-08-04 review 的直接结论：`device-link` 作为根放行时，
 * `device-link:ipc` 会跟着进来，而它在镜像缓存清理失败时把 `MirrorCachePurgeError` 整个写进
 * 日志（`device-link/ipc.ts` 的 `queuePurgeRetry`），其中 `root` / `remaining` 是**本地缓存
 * 文件路径**。当时靠一张排除表挡住了 media / mirror 那几个，却漏了 `ipc`——而这正是「根放行 +
 * 逐条排除」的结构性问题：**新增的子 scope 默认是放行的**，与 deny-by-default 的方向相反。
 * 改成精确匹配后，将来 device-link 下新增任何子 scope 都默认不上报，需要时显式加进来。
 *
 * 连接层要更细的诊断时，照 `renderer-console` 的做法把那部分拆成独立 scope 再加进本表，
 * 不要把一个混着路径的 scope 整体放行。
 */
const ALLOWED_EXACT_SCOPES: readonly string[] = [
  'device-link', //                     服务初始化、relay 连接/断开/重连、心跳
  'device-link:cross-process-lock', //   跨进程锁的获取与释放(只有锁状态,无路径)
  // 主库打开 / migration / schema 漂移 / 完整性 / fatal —— bare `localDb` 只打这些基础设施
  // 事件(dbPath 会经家目录脱敏,userId 本就是上报身份)。精确放行而非根放行:子 scope
  // `localDb/messages` 打消息导入与媒体附件路径,`localDb/*` 一律不跟着放行(2026-08-04 review)。
  'localDb',
];

/**
 * 放行根下必须**逐条排除**的子来源：它们隶属放行的根，但会把用户路径 / 媒体内容
 * 打进日志（需求 §4.2 明确点了这类）。排除表优先于放行表。
 *
 * device-link 系已改为精确匹配（见 `ALLOWED_EXACT_SCOPES`），因此这里的 device-link 条目
 * 现在是**纵深防御**：万一将来有人把 `device-link` 重新加回 `ALLOWED_ROOT_SCOPES`，
 * 这张表仍然挡得住已知会打路径的那几个。
 */
const DENIED_SUB_SCOPES: readonly string[] = [
  // localDb 已改精确放行(见 ALLOWED_EXACT_SCOPES),这条是纵深防御:万一有人把 `localDb`
  // 重新加回根放行,消息导入 / 媒体附件路径这条仍然挡得住。
  'localDb/messages', //                   外部消息导入、附件/媒体清理,带文件路径与 session 投影
  // 登录/账号切换拆卸时,镜像缓存清理失败会把 MirrorCachePurgeError 的 root/remaining 本地缓存
  // 路径写进日志(bootstrap-electron 的 teardownAuthAccountBoundary)。这几条走独立子 scope,
  // 从 `auth-boundary` 根放行里排除掉,根上只剩不带路径的服务停止诊断(2026-08-04 review)。
  'auth-boundary:mirror-cache-purge', //   同 device-link:ipc,带本地镜像缓存路径
  // 全局 skill/plugin 资产准备失败/告警,带用户自选 skill·marketplace 名与绝对路径
  // (shared-global-skills / codex-global-plugins 的 warnings,经 auth-adapters.ts 转发)。
  'auth-adapters:asset-prep', //           带 skill/marketplace 身份与本地路径结构
  // 凭证文件的 icacls/chmod/rm/硬链失败诊断,带 auth.json / models_cache.json 等绝对路径
  // (脱敏只抹用户名段,路径其余部分仍在)。经 auth-adapters.ts 的 credPathLog 转发。
  'auth-adapters:cred-path', //            带凭证文件绝对路径
  'device-link:ipc', //                    镜像缓存清理失败时把 root / remaining 缓存路径写进日志
  'device-link:mediaFetch', //             抓取本地媒体,日志带绝对路径
  'device-link:mediaTransfer', //          传输进度,带文件名
  'device-link:outboundMedia', //          出站媒体,带文件名
  'device-link:outboundImageCompress', //  压缩前后尺寸,带路径
  'device-link:mirror-cache', //           远程会话镜像缓存 = 对话内容
  'device-link:mirror-cache-purge', //     同上,带缓存文件路径
  'device-link:remoteMediaProtocol', //    远程媒体协议解析,带路径
  'device-link:session-reference', //       会话引用,带 session 级信息
  'device-link:telegram', //               IM 侧消息内容
];

/**
 * 明确**不**放行、且值得点名的来源（不需要写进代码逻辑，写在这里防止后人误加）：
 *
 *  - `console`：第三方库与任何漏网 `console.log` 的兜底落点，内容完全不可控。
 *  - `renderer-console`：main 侧把**渲染进程任意 console 正文**转发进 main 流的落点。
 *    它是「渲染进程转发的日志整类丢弃」这条约束的一个**绕过 `r:` 前缀机制**的通道——
 *    功能代码 `console.error` 里的消息文本、搜索词、第三方库 payload、React 错误边界的
 *    props 都会经它落盘。与 `renderer-guard`（加载失败信号，无用户内容，放行）严格分开。
 *  - `secrets:*` / `providerSecretStore`：凭证相关，deny-by-default 的意义就在这里。
 *  - `voice-input*`：听写草稿 = 用户语音内容。
 *  - `desktop-commands*` / `terminal*`：命令行 = 用户输入。
 *  - `file-browser*` / `fs:*`：文件路径与内容。
 *  - `session-search` / `chat-history-search`：搜索关键词 = 用户输入。
 *  - `skillhub*` / `plugin-*` / `brain*` / `mcp/*`：用户内容与第三方响应。
 *  - `im*` / `git-*` / `worktree*` / `learn-host*` / `goal-host`：同上。
 *  - `legacy-xdmaker-migration`：迁移每条记录都带 `rootDir`（解析后的项目工作目录），脱敏
 *    只抹家目录段、项目目录名仍外泄；设置页文案承诺不上传工作目录路径（2026-08-04 review）。
 *  - `manifestIO`：名字像端点清单 IO，实为 SkillHub 注册表存储，打 `skillhub/manifests/<skill>.json`
 *    清单路径/文件名 = 用户装的插件身份，与 `skillhub` 同属用户/第三方内容（2026-08-04 review）。
 *  - `ownerNamespaceMigration`：归属命名空间迁移。名字像纯基础设施，但遗留 ghost 恢复诊断会打
 *    `id: legacy.id`（= 用户已装的第三方插件目录名/身份）与 fs 移动失败的绝对路径。混着 path-free
 *    的迁移状态与插件专属恢复数据，整体拒（2026-08-06 review）。需要时另拆一个不带 id/路径的子 scope。
 */
const NOTABLE_DENIED_ROOTS: readonly string[] = [
  'console',
  'renderer-console',
  'secrets',
  'providerSecretStore',
  'voice-input',
  'desktop-commands',
  'terminal',
  'file-browser',
  'session-search',
  'chat-history-search',
  'skillhub',
  'brain',
  'goal-host',
  'learn-host',
  'legacy-xdmaker-migration',
  'manifestIO',
  'ownerNamespaceMigration',
];

/** scope 是否落在某个根下（精确相等，或 `<root>/` / `<root>:` 前缀）。 */
function isUnderRoot(scope: string, root: string): boolean {
  if (scope === root) return true;
  return scope.startsWith(`${root}/`) || scope.startsWith(`${root}:`);
}

/**
 * 排除表匹配 —— 分隔符无关（2026-08-04 review copilot）。
 *
 * 仓库里 `/` 与 `:` 两种子 scope 分隔符都在用（`localDb/messages` 用 `/`、`device-link:ipc`
 * 用 `:`）。排除表按写出来的那一种存,但匹配时必须两种都认:否则一条以 `localDb/messages`
 * 形式列入的排除项挡不住 `localDb:messages`——万一将来有人把 `localDb` 重新加回根放行,这条
 * 「纵深防御」就形同虚设。把两侧的 `:` 归一成 `/` 再比,`localDb:messages` 与 `localDb/messages`
 * 就是同一个东西。
 */
function matchesDeniedSubScope(scope: string): boolean {
  const norm = scope.replace(/:/g, '/');
  for (const denied of DENIED_SUB_SCOPES) {
    if (isUnderRoot(norm, denied.replace(/:/g, '/'))) return true;
  }
  return false;
}

/**
 * 判定一条记录的 scope 是否放行。
 *
 * 顺序有意义：先看排除表（放行根下的危险子来源），再看放行表。反过来会让
 * `device-link:mediaFetch` 因为落在 `device-link` 根下而被放行。
 */
export function isAllowedScope(scope: string): boolean {
  if (!scope) return false;
  if (matchesDeniedSubScope(scope)) return false;
  // 精确匹配优先于根匹配:这些 scope 的子 scope 不跟着放行(见 ALLOWED_EXACT_SCOPES)。
  if (ALLOWED_EXACT_SCOPES.includes(scope)) return true;
  for (const root of ALLOWED_ROOT_SCOPES) {
    if (isUnderRoot(scope, root)) return true;
  }
  return false;
}

export const __testing = {
  ALLOWED_ROOT_SCOPES,
  ALLOWED_EXACT_SCOPES,
  DENIED_SUB_SCOPES,
  NOTABLE_DENIED_ROOTS,
  matchesDeniedSubScope,
};
