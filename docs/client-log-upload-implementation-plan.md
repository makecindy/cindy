# 客户端日志上报（Desktop）实现方案

> 状态：**已落地**（P0 + P1 已实现；cn / global 上报目标已配置，dev 待配）
> 　最后更新：2026-08-04　范围：`apps/desktop`
>
> 配套需求文档：[`client-log-upload-requirements.md`](client-log-upload-requirements.md)。
> 落地后的**开发规则**（改动前必读的三条不变量）已固定在
> [`dev-rules/log-upload-and-redaction.md`](dev-rules/log-upload-and-redaction.md)。
> 本文只讲**怎么落地**：模块边界、关键算法、对既有代码的改动点、测试与分期。需求
> 本身的取舍不在这里重复论证。
>
> **实现与本文的差异**（落地过程中发现的必要修正，已同步到代码与规则文档）：
> - `LOG_RETENTION_DAYS` 移到 `shared/logRetention.ts`，而不是从 `logger.ts` 导出——采集
>   管道刻意不 import logger（logger 依赖 electron，管道要能在纯 Node 单测里直跑）。
> - 新增 `MAX_BYTES_TOTAL`（全部文件合计 24 MiB）。只有 per-file 闸时，30 天窗口的最坏总量
>   会到几百 MB；文件按「与崩溃锚点的接近程度」排序后依次读，预算耗尽即停，被砍掉的一定是
>   离崩溃最远的那些天。
> - 环境元数据同时写进 `__tags__` **与每条记录的 `uploadCode` 字段**：`__tags__` 的索引配置
>   属服务端侧，客户端不该依赖一个自己看不到的配置才能被检索到。
> - `PendingMarkerStore.clearAll()` 必须同时清 claim 文件（claim 文件名不以 `.json` 结尾）。
>   只按未认领标记清的话，用户关闭授权时正在被本进程补传的那条会被漏掉、补传照常完成——
>   正是需求 §4.3 末条要禁止的行为。这条是写测试时发现的。

---

## 0. 现状核对（本方案的事实基础）

写方案前逐项核对了需求引用的既有实现，结论如下（与需求描述一致，无需返工）：

| 需求引用 | 代码事实 |
|---|---|
| 本地日志三流 + 30 天保留 | `apps/desktop/src/main/logger.ts`：`main-<date>.log`（纯文本）、`agent-<date>.ndjson`、`sessions/<id>/<date>.ndjson`，`LOG_RETENTION_DAYS = 30` |
| main 日志行格式 | `[${localTimestamp}] [${LEVEL_TAG}] [${scope}] ${msg}\n`，`LEVEL_TAG` 含 `INFO ` / `WARN ` 的补位空格 |
| 渲染进程日志天然带前缀 | `writeFromRenderer()` 强制 `r:` 前缀 |
| 崩溃转储只落本地 | `startup-diagnostics.ts`：`crashReporter.start({ uploadToServer: false })` |
| 退出尸检结论只进日志 | `RunMarkerStore.analyzePreviousRuns()` → `logPreviousRunReports()`，`reports` 未对外暴露 |
| 致命判定收口在生命周期模块 | `lifecycle.ts` 的 `beginShutdown(timeoutMs, reason)`；`unhandledRejection` / broken stdio / 瞬时网络错误都**不**进入该路径 |
| 端点清单有受信任域约束 | `endpointManifestCache.ts` 的 `REGION_ENDPOINT_DOMAIN` + `findUntrustedCachedEndpoint()`——第三方日志服务域名加进清单会让整份离线缓存判不可信 |
| 隐私政策同意是独立事实 | `analytics-settings-store.ts` 的 `privacyConsentAccepted`（与 `analyticsEnabled` 分开） |
| 跨实例现读盘的现成原语 | `maker-host/override-settings-file.ts` 的 `invalidateIfChanged()`（mtime 守卫，文件没变零开销） |
| 吃系统代理的出网通道 | `maker-host/outbound-fetch.ts` 的 `outboundFetch` |
| 区域常量 | `shared/brandRegion.ts` 的 `CURRENT_CINDY_REGION`（main / renderer 共用） |
| 设备与用户标识 | `authManager.getDeviceId()`、`authManager.getAuthState().user?.id` |
| 设置页落点 | `renderer/components/settings/AboutSection.tsx` 的 `OpenLogsRow` 之后；开关的「已修改 / 恢复默认」走 `DefaultOverrideControls` |

一处需求没点明、但实现必须处理的事实：**`main-*.log` 目前写多行 `msg` 时不做任何转义**
（`emit()` 直接把 `util.format` 结果塞进行内）。这正是需求 §5.5 那条不变量的缺口，见 §4.1。

---

## 1. 模块布局

新增一个自治目录，**只有 `index.ts` 碰 Electron**，其余全部纯逻辑 + 依赖注入（工程规范 §3）。

```
apps/desktop/src/shared/
  logUpload.ts                  # IPC 契约类型、广播 channel、上传编号格式（main/preload/renderer 共用）
  mainLogRecordFormat.ts        # main 日志「记录边界」的唯一事实源：head 正则 + 续行转义函数
                                #   ↑ 写侧(logger.ts)与读侧(解析器)共用同一份，不允许各写一份

apps/desktop/src/main/log-upload/
  index.ts                      # 唯一的 electron 接线层：IPC 注册、启动补传调度、崩溃钩子接线
  logUploadTarget.ts            # 按区域烘焙的上报目标（穷举 Record<CindyRegion, …|null>）
  logUploadSettingsStore.ts     # 「崩溃时自动上传」开关（override 语义）
  consentGate.ts                # 授权闸：现读盘 + 三种 kind 的判定
  sourceAllowlist.ts            # 第二层：来源白名单（逐条带理由）+ 子来源排除
  redact.ts                     # 第三层：正则红线
  mainLogReader.ts              # main-*.log → 结构化记录（记录边界识别 + 定位读取）
  agentLogReader.ts             # agent-*.ndjson → 仅 proxy 记录
  collect.ts                    # 采集编排：源白名单 → 窗口 → 锚点裁剪 → 四层管道
  pendingMarkers.ts             # 待补传标记：代次 token + 原子认领 / 原子清除
  logSink.ts                    # 免签写入客户端（批次切分、超时、结果语义）
  uploadRunner.ts               # 一次上报的完整编排（闸 → 采集 → 发送 → 标记收尾）
  crashTriggers.ts              # 崩溃即时 / 启动尸检兜底的判定与标记写入
  __tests__/                    # 见 §7
```

依赖方向：`log-upload/*`（除 index）**不 import electron、不 import logger**，路径 / 时钟 /
fetch / 授权读取全部注入。`index.ts` 反向依赖 `lifecycle`、`startup-diagnostics`、
`authManager`、`analytics-settings-store`、`outbound-fetch`。无循环（`lifecycle` 与
`startup-diagnostics` 只被 index 调用，反向靠回调注册，见 §4.2 / §4.3）。

---

## 2. 上报目标与区域绑定（需求 §4.4）

### 2.1 配置形状

```ts
// shared/logUpload.ts
export interface LogUploadTarget {
  /** 日志服务 project */
  project: string;
  /** logstore */
  logstore: string;
  /** 服务区域接入域名（不含协议、不含 project 前缀） */
  endpointHost: string;
}
```

**值不写在代码里，走构建期注入**（2026-08-04 owner 选定方案 B），与
`config/endpoint.dev.json` / `apps/desktop/scripts/release-regions.json` 同款约定：

```
config/log-upload.json                     ← 真值,主仓 gitignore;唯一事实源在 cindy-build-scripts
  ↓ 打包机 sync-desktop-release-kit.sh 拷回
scripts/shared/log-upload-build-env.mjs    ← 全量校验 + 挑出「本构建区域那一个」目标
  ↓ apps/desktop/scripts/package-desktop.mjs 塞进 forge env
apps/desktop/vite.main.config.ts           ← define 成 main-only process.env.XDT_LOG_UPLOAD_TARGET
  ↓
main/log-upload/logUploadTarget.ts         ← 解析 + 区域交叉校验;不合法一律 null
```

配置文件形状（仓内 `config/log-upload.json.example` 是可直接改值的骨架）：

```json
{
  "schemaVersion": 1,
  "cn":     { "project": "cindy-sh-prod",  "logstore": "cindy-sh-prod-client-log",  "slsRegion": "cn-shanghai" },
  "global": { "project": "cindy-sgp-prod", "logstore": "cindy-sgp-prod-client-log", "slsRegion": "ap-southeast-1" },
  "dev": null
}
```

实际写入地址：

```
cn      https://cindy-sh-prod.cn-shanghai.log.aliyuncs.com/logstores/cindy-sh-prod-client-log/track
global  https://cindy-sgp-prod.ap-southeast-1.log.aliyuncs.com/logstores/cindy-sgp-prod-client-log/track
```

关键设计点：

- **只烘焙一个区域的目标**。cn 包里物理上不含 global 的 logstore 地址，反之亦然——比「包里带
  两份、运行时按 region 选」更强，后者只要选错一次就写到另一区去了（埋点有过这个事故）。
- **区域交叉校验**。注入串带 `region`，运行时必须与烘焙的 `VITE_CINDY_AUTH_REGION` 一致。
  这是「注入链路串了」（打包机 env 残留、本地 `.env` 放了另一区的目标）唯一的运行期防线。
- **仍然不进端点清单**：第三方域名不在 `REGION_ENDPOINT_DOMAIN` 内，加进去会让整份离线缓存判
  不可信；且免签写入地址可被**远程**改写 = 允许把用户日志改投他人 logstore。构建期注入保留了
  「信任锚点不可远程改」这条性质。
- ⚠️ **fail-closed 的位置从 typecheck 搬到了构建脚本**。原先 `Record<CindyRegion, …>` 让「新增
  区域忘了做选择」直接编译失败；值搬进 gitignore 的 JSON 后由 `log-upload-build-env.mjs` 的硬
  校验替代：除 `dev` 外每个区域必填（缺失/非法即打包失败）、两区不得共用 project 或 logstore、
  `slsRegion` 只写区域代号。新增发行区域自动成为必填，不需要有人记得改校验名单。
- 目标解析为 null ⇒ `targetConfigured: false` ⇒ 手动入口禁用并给出「未配置」提示、自动路径
  **一个字节都不发、也不写标记**。dev server / 本地 `pnpm dev` 拿不到注入值 ⇒ 天然关闭。
- **代价**：真值不进仓 ⇒ CI 看不到它 ⇒ desktop 侧单测只锁形状（解析、区域校验、URL 模板），
  真值正确性由 `scripts/__tests__/log-upload-build-env.test.mjs`（对 `.example` + 临时 fixture）
  加打包硬失败兜底。这是选方案 B 换来运维不碰主仓的对价。

### 2.2 免签写入

Web-tracking 形态（无 AccessKey，需求 §5.3）：

```
POST https://<project>.<endpointHost>/logstores/<logstore>/track
Content-Type: application/json
x-log-apiversion: 0.6.0

{ "__topic__": "client-log",
  "__source__": "<platform>-<arch>",
  "__tags__":  { …环境元数据(§6)… },
  "__logs__":  [ { "ts": "...", "level": "...", "src": "...", "scope": "...", "msg": "..." }, … ] }
```

- 走 `outboundFetch`（吃系统代理），每批 20s 超时，批次**串行**发送，任一批非 2xx ⇒
  整次判失败（标记保留）。
- 批上限：`MAX_LOGS_PER_BATCH = 500`、`MAX_BATCH_BYTES = 1 MiB`（留足服务端 3MB 余量）。
- 时间戳：web-tracking 的 `__time__` 由服务端接收时刻决定，**因此原始时间戳一律作为
  普通字段 `ts` 携带**（需求 §4.8「不能用上报时刻覆盖」由此满足），不依赖 `__time__`。
- `logSink.ts` 只依赖注入的 `fetchImpl`，单测用内存 fake 断言 URL / 批次切分 / 失败语义。

**需要向日志服务 owner 确认（合并前）**：`__tags__` 是否默认建索引（决定 `uploadCode` 是否
需要同时写进每条记录）；logstore 是否已开启 web tracking；留存期与访问权限（需求 §9.4）。

---

## 3. 采集与脱敏管道（需求 §4.2，本方案的核心）

`collect.ts` 的签名（全注入，零 electron）：

```ts
export interface CollectDeps {
  logDir: string;
  listDir(dir: string): Promise<string[]>;
  openRead(file: string): Promise<LineSource>;  // 只暴露「按 offset 流式读行」能力
  now(): number;
  homeDir: string;
  yieldToEventLoop(): Promise<void>;            // 每 N 行让出一次,不霸占 main 事件循环
}
export interface CollectRequest {
  reason: 'manual' | 'crash-immediate' | 'crash-backfill';
  /** 崩溃锚点(epoch ms),manual 为空数组 */
  anchors: number[];
}
export interface CollectResult { records: UploadRecord[]; stats: CollectStats; }
```

### 3.1 第一层：源白名单（读哪些文件）

- 主体：`main-<date>.log`，`date` 落在时间窗内。
- `reason !== 'manual'` 时附带：logs 根的 `agent-<date>.ndjson`，且**只取
  `source === 'proxy'` 的记录**（同一文件里还有 `maker` 源的启动期日志，可能带用户内容，
  逐条丢弃）。
- `sessions/**` 与 `*cc-debug.raw.log` **永不构造路径**。这条靠 `openRead` 注入 + 测试锁定：
  测试在 fixture 里放好诱饵文件，断言被打开的路径集合不含它们（需求 §6 隐私性第 1 条）。

### 3.2 时间窗与「定位读取」

```
MAX_LOOKBACK_DAYS_DEFAULT = 2
MAX_LOOKBACK_DAYS_CAP     = LOG_RETENTION_DAYS  // 从 logger.ts 导出复用,不写第二份 30
MAX_BYTES_PER_FILE        = 8 MiB
MAX_RECORDS               = 4000
MAX_MSG_CHARS             = 2000
```

窗口 = `max(MAX_LOOKBACK_DAYS_DEFAULT, 距最早锚点的天数)`，再 clamp 到 `MAX_LOOKBACK_DAYS_CAP`；
超出保留期的锚点直接放弃（日志已被清理，补传无意义，需求 §4.5）。

单文件超过字节预算时**不能简单读尾部**——崩溃后堆积的新日志会把崩溃现场挤出窗口
（需求 §11 的既有教训）。做法：main 日志按天单文件内时间**严格递增**且每条记录首行自带
可解析时间戳，因此可以对文件做**时间戳二分查找**，定位到「最早锚点 - 预卷（默认 2 min）」
的字节偏移，从那里起读 `MAX_BYTES_PER_FILE`。manual（无锚点）退化为读尾部。

### 3.3 记录边界识别

`shared/mainLogRecordFormat.ts` 是唯一事实源：

```ts
export const MAIN_LOG_RECORD_HEAD_RE =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\] \[(TRACE|DEBUG|INFO |WARN |ERROR|FATAL)\] \[([^\]]*)\] /;

/** 写侧:把 msg 的每个续行前置一个空格,保证「除首行外没有行以边界特征开头」。 */
export function escapeMainLogContinuationLines(msg: string): string;
```

读侧按 head 正则切记录，命中即新记录，否则并入上一条记录的续行。

### 3.4 第二层：来源白名单（deny-by-default）

`sourceAllowlist.ts` 是一张**逐条带理由**的表，匹配方式为根锚定：
`scope === root || scope.startsWith(root + '/') || scope.startsWith(root + ':')`。
因此 `r:` 前缀的渲染进程日志整类落空（需求 §4.2），`maker*` / `cc-proxy*` / `codex-proxy*`
也不会命中（它们本就不写 main 流）。

初始放行名单（按需求要求的六类基础设施划分；每条在代码里带一句理由注释）：

| 类别 | 放行根 scope |
|---|---|
| 生命周期 / 崩溃 / 进程 | `lifecycle`、`startup-diagnostics`、`logger`、`process`、`power-diagnostics`、`power-blocker`、`idleManager`、`app-presence`、`appSessionState`、`renderer-guard`、`csp`、`secondary-windows`、`windows-tray`、`dock-icon`、`relaunch-activity` |
| 更新 | `updateService`、`update-presentation`、`releaseNotesService` |
| 网络 / 端点 | `clientEndpoints`、`manifestService`、`manifestIO`、`serverApiClient`、`heartbeat` |
| 数据库 | `localDb`、`DbClient`、`db-worker`、`schema-drift-detector`、`schema-drift-repair` |
| 鉴权 | `authManager`、`auth-adapters`、`auth-boundary`、`safe-storage` |
| 设备互联（连接层） | `device-link` |
| 配置 / 存量迁移基础设施 | `legacyUserDataMigration`、`legacy-xdmaker-migration`、`ownerNamespaceMigration`、`analytics-settings`、`sidebar-settings`、`canaryFlagStore` |

`process` 这一条是 `logger.ts` 里 `uncaughtException` / `unhandledRejection` 的全栈落点，
崩溃排查的主要证据，必须在名单内。

**放行根下的子来源排除**（需求 §4.2 明确点了这类）：`device-link` 根下带本地文件路径 /
媒体内容的子 scope 逐条排掉——`device-link:mediaFetch`、`device-link:mediaTransfer`、
`device-link:outboundMedia`、`device-link:outboundImageCompress`、`device-link:mirror-cache`、
`device-link:mirror-cache-purge`、`device-link:remoteMediaProtocol`、
`device-link:session-reference`、`device-link:telegram`。排除表优先于放行表。

明确**不**放行且值得在代码注释里点名的：`console`（第三方库与任何漏网 `console.log` 的兜底
落点，内容不可控）、`secrets:*` / `providerSecretStore`、`voice-input*`、`desktop-commands*`、
`file-browser*`、`session-search` / `chat-history-search`、`skillhub*` / `plugin-*`、`brain*`、
`im*`、`terminal*`、`git-*` / `worktree*`、`learn-host*` / `goal-host`、`mcp/*`。

> 名单只增不减；新增条目需在 PR 里写明理由并过 review（需求 §8 第 1 行）。

### 3.5 第三层：正则红线（宁可多抹）

`redact.ts` 导出一个有序规则数组（顺序有意义：先抹整头 / 整值，再抹形态），每条带命名：

1. **JWT**：`eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}`
2. **`sk-` 系**：`\bsk-(ant-|proj-)?[A-Za-z0-9_-]{16,}`
3. **GitHub**：`\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}`
4. **云厂商 AccessKey**：`\bLTAI[A-Za-z0-9]{12,}`、`\bAKIA[0-9A-Z]{16}`、`\bAIza[0-9A-Za-z_-]{35}`、`\bxox[baprs]-[A-Za-z0-9-]{10,}`
5. **鉴权 / Cookie 整头**：`Authorization` / `Proxy-Authorization` / `Cookie` / `Set-Cookie`
   的整个值，同时兼容 header 形态（`Authorization: xxx`）、JSON 形态（`"authorization":"xxx"`）
   与**被转义的 JSON**形态（`\"authorization\":\"xxx\"`）
6. **独立 Bearer**：`\bBearer\s+[A-Za-z0-9._~+/=-]{10,}`
7. **敏感字段名的值**：`password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential`
   后跟 `":`/`=`/`: ` 的值，同样兼容裸 JSON、转义 JSON、`k=v` 三种形态
8. **URL query 参数值**：保留参数名、值一律替换（搜索关键词等用户输入常在这里）
9. **邮箱**：`c***@example.com`（与 `logger.maskEmail` 同口径）
10. **家目录用户名段**：`/Users/<name>/` → `/Users/<user>/`、`/home/<name>/`、
    `C:\Users\<name>\` 三种形态；另外把注入的 `homeDir` 里的真实用户名做一次精确替换
    （只在路径样上下文内），保留路径其余部分供排查

替换文本统一为 `<redacted:<rule-name>>`，便于排查时看出「这里被抹了什么类别」。
**规则只增不减**：放宽任何一条按隐私变更处理、需重新评审（需求 §5.6），在文件顶注写明。

### 3.6 第四层：字段白名单 + 截断

上报记录的最终形状就是这五个字段，其余一律不产出：

```ts
export interface UploadRecord {
  ts: string;     // 原始时间戳(ISO + 本地 offset),不被上报时刻覆盖
  level: string;
  src: 'main' | 'proxy';
  scope: string;
  msg: string;    // 截断到 MAX_MSG_CHARS,尾附 …(truncated N chars)
}
```

`agent-*.ndjson` 侧同理：只从 NDJSON 取 `ts` / `level` / `source` / `scope` / `msg`，
`tz` / `seq` / `sessionId` 以及任何未来新增字段全部丢弃。

### 3.7 锚点裁剪

合并 main + proxy 记录后若超过 `MAX_RECORDS`：
以 `anchors ∪ {采集时刻}`（manual 只有后者）为锚点，按 `min(|ts - anchor|)` 打分，
取分数最小的 N 条，再按 `ts` 升序还原顺序。这样多次未传崩溃都能被覆盖，且崩溃后堆积的
新日志不会把崩溃现场整段裁掉（需求 §4.5）。

---

## 4. 对既有代码的改动点

### 4.1 `logger.ts`：闭合「记录边界不可被伪造」不变量（需求 §5.5）

- `emit()` 写 main 流前，`msg` 过一次 `escapeMainLogContinuationLines()`；`writeMainLine`
  的行拼接不变。副作用是多行消息（堆栈等）的续行多一个前导空格，可读性不受损。
- 顶注补一段：**这不是排版，是安全不变量**——上报侧按行首特征识别记录边界并据此放行，
  续行一旦能伪装成放行来源的记录头，被封禁来源的多行内容就能把用户内容送出去。
- 存量文件的过渡缺口：升级前写下的 main 日志没有转义，仍可能含伪造的记录头。
  处置：`ensureDailySlot` 首次打开 main 当天文件后写一行格式哨兵
  `[…] [INFO ] [logger] #cindy-log-format:2`；`mainLogReader` **跳过第一条哨兵记录之前的
  全部内容**。代价是升级后的首次上报覆盖的历史更短，换来的是这条红线在存量文件上也成立。
  （已知边界：dev 与正式版共享同一日志目录且版本混跑时哨兵后仍可能出现旧格式内容，
  属可接受，写进注释。）
- `LOG_RETENTION_DAYS` 导出，供采集端复用，避免第二份 30。

### 4.2 `lifecycle.ts`：暴露致命判定，不反向依赖上报模块

```ts
/** beginShutdown 的 reason 是否属于「致命崩溃」。可恢复异常与正常退出一律 false。 */
export function isFatalShutdownReason(reason: string): boolean;   // uncaughtException | render-process-gone:*
/** 注册致命 shutdown 回调(同步、必须极短)。由 bootstrap 接线,lifecycle 不 import 上报模块。 */
export function onFatalShutdown(cb: (reason: string) => void): void;
```

`beginShutdown()` 里在 `noteShutdownBegin(reason)` 之后、`runQuitDisposers` 之前，
命中致命 reason 时同步派发回调。要点：

- 回调**不是 disposer**，不进 `onQuit` 注册表 ⇒ 不占 `timeoutMs` 预算、不推迟其起点
  （需求 §4.5「不拖慢退出」）。
- 回调里只做一件重活以外的事：同步写一个 <400B 的标记文件（与 run marker 同级的同步写）。
  即时上传是 fire-and-forget，不 await。
- `unhandledRejection`、broken stdio、瞬时网络错误本就不进 `beginShutdown`，自动获得
  需求 §4.1 要求的「可恢复异常不算崩溃」；渲染进程崩溃（白屏）走
  `render-process-gone` 分支自动算崩溃；沙箱 / webview guest 的崩溃在上游已 return，
  不会误判。

### 4.3 `startup-diagnostics.ts`：把尸检结论交出来

- `initStartupDiagnostics()` 改为返回 `PreviousRunReport[]`（或新增
  `consumePreviousRunReports()`），行为与日志输出一字不改。
- `crashTriggers.ts` 消费：`kind === 'abnormal'`（无任何退出记录 = segfault / 被 kill /
  hang）与 `kind === 'corrupt'`（崩溃瞬间写坏标记）⇒ 补写一条待补传标记，
  `crashAtMs = Date.parse(marker.heartbeatAt)`。
  `crash-exit` / `shutdown-incomplete` 不额外补——那两类在崩溃当时已经过 lifecycle，
  标记已写；重复补会造成重复上报。

### 4.4 `analytics-settings-store.ts`：加一个现读盘入口

新增 `refreshAnalyticsSettingsFromDisk()`，内部就是 `store.invalidateIfChanged()`。
现有语义一字不动（既有读取路径仍走缓存）。授权闸在每次判定前调用它——开发版与正式版共享
userData，用户可能刚在另一个实例里关掉授权（需求 §4.3）。

### 4.5 `bootstrap-electron.ts`：接线

在 `initAnalyticsSettingsService()` 附近（`createWindow()` 之前）注册 IPC 与崩溃钩子；
启动补传排在窗口出来之后：

```ts
initLogUploadService({ previousRunReports });          // IPC + onFatalShutdown 接线
…
mainWindow.once('ready-to-show', () => {
  setTimeout(() => { void runPendingLogUploads(); }, 15_000);   // 不阻塞启动(需求 §4.5)
});
```

### 4.6 `ipc-errors.ts`：新增可区分的错误码

`LOG_UPLOAD_UNAVAILABLE`（未配置上报目标）、`PRIVACY_CONSENT_REQUIRED`（未同意隐私政策）、
`LOG_UPLOAD_EMPTY`（采到 0 条）、`LOG_UPLOAD_FAILED`（网络 / 被拒）、`LOG_UPLOAD_BUSY`
（已有上传在进行）。手动上传不需要 fallback data，因此走 `throwIpcError`（工程规范 §2），
renderer 用 `extractIpcError` / `mapIpcErrorToI18nKey` 映射到本地化文案，不透传英文技术串。

---

## 5. 待补传标记：代次、原子认领、原子清除（需求 §4.5）

目录 `<userData>/diagnostics/log-upload/`（与 run-markers 同级，都是诊断数据）。
**一次未传崩溃 = 一个文件**，天然支持「多次未传崩溃都能覆盖」：

```
pending-<crashAtMs>-<token>.json     token = randomBytes(6).toString('hex') —— 代次令牌
{ v: 1, token, reason: 'crash' | 'native-crash', crashAtMs, appVersion, pid, createdAt }
```

- **认领**：`fs.renameSync(f, f + '.claim.' + pid + '.' + runToken)`。rename 是同目录原子
  替换，抢输的实例拿到 ENOENT ⇒ 跳过。仅靠时间戳在同毫秒并发写下会误判，所以令牌进文件名。
- **成功清除**：`unlink` 自己的 claim 文件——只清自己认领的那一代，绝不会误删另一个实例
  刚写的新崩溃标记。
- **失败保留**：把 claim 文件 rename 回原名（best effort）。真失败则留着 claim 文件，
  下次启动把「超过 1h 的 `*.claim.*`」视为可重新认领（防实例中途被杀导致标记永久卡死）。
- **仅成功且非空才清**：`records.length === 0` 或任一批次失败 ⇒ 保留（需求 §4.5「不丢」）。
- **即时上传成功也不清**：崩溃当时拿不到收尾日志，标记留到下次启动补完整（需求 §4.1）。
  两次上报共享同一 `crashToken`，后台可按它归组；各自有独立 `uploadCode`。
- **授权关闭 ⇒ 清空全部标记**（需求 §4.3 末条），在授权闸判出 `denied` 时立即执行。
- **超出保留期 ⇒ 直接删不上传**（日志已被清理）。
- **崩溃循环节流**：模块级 `lastAutoUploadAtMs`，自动路径最小间隔 5 min。

---

## 6. 环境元数据（需求 §4.8）

```ts
export interface LogUploadMeta {
  uploadCode: string;   // 上传编号:Crockford base32 去易混字符,8 位,格式化为 XXXX-XXXX
  userId: string;       // 未登录为 ''
  deviceId: string;     // authManager.getDeviceId()
  appVersion: string;
  region: CindyRegion;
  platform: string; arch: string; osVersion: string;
  uiLanguage: string;
  reason: 'manual' | 'crash-immediate' | 'crash-backfill';
  crashToken?: string;  // 崩溃路径:标记代次令牌,用于把即时 + 补传两次归组
  crashAtMs?: number;
}
```

上传编号由 `crypto.randomBytes` 生成，字符集去掉 `I/L/O/U/0/1`，用户能口述。

---

## 7. 测试计划（隐私性用测试锁定，需求 §6）

`apps/desktop/src/main/log-upload/__tests__/`，全部进程内、内存 fake、`os.tmpdir()` +
`mkdtemp`（工程规范 §3.1）：

| 测试 | 锁定什么 |
|---|---|
| `collectSourceAllowlist.test.ts` | fixture 里放 `sessions/<id>/*.ndjson` 与 `cc-debug.raw.log` 诱饵，断言注入的 `openRead` **从未**收到这些路径 |
| `recordAllowlist.test.ts` | 被封禁来源的记录不出现；**其多行内容里伪造的放行来源记录头**也不出现（v2 转义后 + 哨兵前的旧格式两种输入各一组） |
| `redact.test.ts` | 表驱动：JWT / `sk-` / GitHub / LTAI / AKIA / AIza / xox / Authorization / Cookie / 转义 JSON 的 token 字段 / URL query 值 / 邮箱 / 家目录用户名，逐条断言原文不再出现 |
| `fieldAllowlist.test.ts` | NDJSON 多余字段被丢；`source !== 'proxy'` 的 agent 记录被丢；msg 超长被截断 |
| `pendingMarkers.test.ts` | 两个 claimer 并发只有一个赢；失败还原；成功清除只清自己那一代；授权关闭清空；超保留期丢弃 |
| `anchorTrim.test.ts` | 崩溃后堆积 10× 上限的新日志时，崩溃时刻附近的记录仍在结果里 |
| `lookbackWindow.test.ts` | 崩溃在 5 天前 ⇒ 窗口覆盖那天；40 天前 ⇒ 放弃 |
| `consentGate.test.ts` | 未同意 / 未配置 / 开关关 三种情况下注入的 `fetchImpl` **调用次数为 0** |
| `logSink.test.ts` | URL 拼接、批次切分、单批超限、非 2xx ⇒ 整次失败 |
| `logUploadTarget.test.ts` | 目标为 null ⇒ `configured: false` 且 upload 抛 `LOG_UPLOAD_UNAVAILABLE`；非 packaged 取 dev 项 |
| `throttle.test.ts` | 崩溃循环下自动上报次数受最小间隔约束 |
| `mainLogRecordFormat.test.ts` | 对抗性 msg（含合法记录头、`\r\n`、多层嵌套）转义后，除首行外无任何行命中 head 正则 |
| `logger` 侧回归 | `emit()` 写 main 流确实过转义；哨兵行按格式写出 |

非功能性验收（需求 §6）：启动耗时与退出清理链耗时无回归——靠「补传排在 `ready-to-show`
+15s、崩溃钩子不进 disposer 链」两个结构性保证，加一条断言「`onFatalShutdown` 回调未被
注册进 `onQuit` 注册表」的测试；实机测启动耗时前后对比写进 PR 自测。

i18n 门禁：`pnpm check:i18n` + `pnpm check:i18n-glossary`。

---

## 8. 用户可见交互（需求 §4.7）

`AboutSection.tsx` 的 `OpenLogsRow` 之后插两行，复用该页既有行样式与 token：

1. **`CrashAutoUploadToggleRow`**：`Switch` + `DefaultOverrideControls`（`isCustomized` 来自
   store 的 `customizedKeys`），默认关。与 `AnalyticsToggleRow` 同构；「恢复默认」= 删
   override 跟随版本默认值（配置规则 §4），不动隐私政策同意这个事实记录。
2. **`UploadLogsRow`**：按钮 + 进行态；成功 toast 带上传编号并支持复制。四种失败按错误码
   给可区分文案：未配置目标 / 未同意隐私政策 / 采到 0 条 / 上传失败。未配置或未同意时
   按钮 disabled 并在副文案里说明原因。

文案（`settings.about.logUpload.*`，四语齐全）：

- **传什么**：App 运行记录（生命周期、崩溃、网络、更新、数据库、鉴权）+ 设备环境信息。
- **不传什么**：对话内容、文件内容、提示词、工作目录路径；凭证与邮箱会被自动抹除。
- 口径与现有「使用统计」描述一致，不更含糊。
- 上传编号的用途：报障时提供给我们。
- Light / Dark 双模式：颜色全部走语义 token，无条件补丁（设计规范双模式交付门槛）。

术语：`i18n/GLOSSARY.md` 当前无日志/上传相关已裁决词条。「上传编号」「崩溃」「运行记录」
先在 `i18n/glossary.json` 登记为 `status: "proposed"` 再讨论，不自造译法。

---

## 9. 分期与交付顺序

| 阶段 | 内容 | 可独立发版 |
|---|---|---|
| **P0-1** | `mainLogRecordFormat` + `logger.ts` 转义与哨兵 + 其回归测试 | 是（纯写侧硬化，无用户可见变化） |
| **P0-2** | `logUploadTarget` / `consentGate` / `sourceAllowlist` / `redact` / reader / `collect` / `logSink` / `uploadRunner`（manual 路径）+ 全部隐私测试 | — |
| **P0-3** | IPC + preload + `vite-env.d.ts` + 设置页两行 + 四语文案 | 是（= 需求 P0） |
| **P1-1** | `pendingMarkers` + `crashTriggers`（`onFatalShutdown` + 尸检兜底）+ 启动补传调度 + 节流 | 是（= 需求 P1） |
| **P2** | 上报健康度自查、后台聚合与按版本对比 | 未实现（本次范围外） |

P0-1 ~ P1-1 已全部实现，P1 的可靠性要求（代次令牌、原子清除、多锚点裁剪、窗口放宽）一条未减
——需求 §7 已点明这些正是崩溃日志会不会静默丢失的分水岭。

### 9.1 实际落地清单

新增：

```
apps/desktop/src/shared/logRetention.ts            apps/desktop/src/shared/logUpload.ts
apps/desktop/src/shared/mainLogRecordFormat.ts     apps/desktop/src/renderer/hooks/useLogUploadSettings.ts
apps/desktop/src/main/log-upload/{index,types,limits,logUploadTarget,logUploadSettingsStore,
  consentGate,sourceAllowlist,redact,mainLogReader,agentLogReader,collect,pendingMarkers,
  logSink,uploadCode,uploadRunner,crashTriggers}.ts
apps/desktop/src/main/log-upload/__tests__/{redact,recordBoundary,collect,sourceAllowlist,
  pendingMarkers,gateAndTarget,logSink,uploadRunner,crashTriggersAndCode}.test.ts
apps/desktop/src/main/__tests__/loggerRecordFormat.test.ts
docs/dev-rules/log-upload-and-redaction.md
```

改动：`logger.ts`（续行转义 + 格式哨兵 + 保留天数改为共享常量）、`lifecycle.ts`
（`isFatalShutdownReason` / `onFatalShutdown`）、`startup-diagnostics.ts`
（`getPreviousRunReports`）、`analytics-settings-store.ts`
（`refreshAnalyticsSettingsFromDisk`）、`bootstrap-electron.ts`（接线 + 启动补传调度）、
`ipc-errors.ts`（5 个新错误码）、`preload.ts` / `vite-env.d.ts`、`AboutSection.tsx`（两行 UI）、
四份 `common.json`、`i18n/glossary.json`（3 条 `proposed` 术语）、`AGENTS.md` 与两份文档索引。

### 9.2 验证结果

- `pnpm --filter desktop run typecheck`：通过。
- 本功能定向测试：11 个文件 / 206 个用例全绿（含全部隐私锁）。
- Desktop 完整 unit tier（`--pool=forks`）：1625 文件 / 20276 用例全绿。
- `pnpm test:runner`、`pnpm check:i18n`、`pnpm check:i18n-glossary`：通过。
- **已知环境问题**：本机（macOS）用 `--pool=threads` 跑 desktop 全量会 SIGSEGV（exit 139），
  排除本次全部新增测试与新模块后**同样复现**，属既有的 pool 稳定性问题、与本次改动无关；
  同一批用例在 `--pool=forks` 下全绿。
- **未做实机验证**：Light / Dark 双模式目检、三种崩溃场景（强杀主进程 / 渲染进程崩溃 /
  未捕获异常）的端到端补传、断网重试。这些需要跑起 Desktop 并配好真实 logstore，目标值填入
  后应补一轮手工验证。

---

## 10. 规则文档与索引（需求 §10）

落地后新增 `docs/dev-rules/log-upload-and-redaction.md`，并挂进根 `AGENTS.md` 的规则索引：
「修改客户端日志采集、脱敏、上报链路，或 `logger.ts` 的 main 日志行格式前，必须先读」。
文档正文固定三条不变量：

1. **记录边界是安全不变量**（写侧转义 + 读侧识别是同一条不变量的两半，改任一侧都可能造成
   隐私逃逸）。
2. **白名单方向不可反转**（deny-by-default；调试级别的功能日志是用户内容的主要泄漏源）。
3. **标记代次 + 原子清除**（并发实例下仅靠时间戳会误删另一实例刚写的新崩溃标记）。

同时对齐既有规则：`engineering-conventions`（日志、IPC 错误协议、main 侧测试、i18n）、
`credentials-and-local-storage`（诊断数据落 userData、日志不含凭证）、
`configuration-and-overrides`（开关的默认 + override + 恢复默认）、
`region-and-editions`（区域分支缺省落 global、只标注中国大陆版）、
`design-rules/DESIGN.md`（设置页行样式与双模式）。

---

## 11. 阻塞项的结论（2026-08-04 已答复）

| # | 事项 | 结论 | 落地状态 |
|---|---|---|---|
| 1 | cn / global 的 project + logstore + 接入域名 | **已提供**：cn = `cindy-sh-prod` / `cindy-sh-prod-client-log` / `cn-shanghai`；global = `cindy-sgp-prod` / `cindy-sgp-prod-client-log` / `ap-southeast-1` | ✅ 已写入 `logUploadTarget.ts`，两区 packaged 构建功能可用；写入地址由单测逐字符钉死 |
| 1b | dev 测试 logstore | **先留占位符**（owner 决策） | ✅ 占位符 ⇒ 所有非 packaged 构建整体关闭，开发机一个字节都不发、绝不污染两个生产 logstore。拿到值后只改那三行 |
| 2 | web tracking 是否已开启 | **已开启** | ✅ |
| 3 | 隐私政策正文是否覆盖日志上报 | 正文为 <https://protocol.xd.cn/cindy/privacy-1.0.html>，**结论见 §11.1** | ⚠️ 手动上传基本落在现有条款内；**自动崩溃上传需要补一句** |
| 4 | 日志服务侧留存期与访问权限 | 传 SLS，有 SLS 权限的人可查，不需在本仓处理 | ✅ 不再跟踪 |
| 5 | 「崩溃时自动上传」默认值 | **默认关闭** | ✅ 已按默认关闭实现（`logUploadSettingsStore` 的 `DEFAULTS`） |
| 6 | 是否要「上传时附带用户一句话描述」 | **不做** | ✅ 未实现，无自由文本输入框 |

**剩余待补**：只剩 dev 的测试 logstore（可选）。cn 与 global 已就位，两区正式包的手动上传
链路在代码侧已完整可用。

> 命名注记：owner 最初给的 cn project 写作 `cindy-sh-pro`，与其 logstore 前缀
> `cindy-sh-prod-` 及 global 的 `cindy-sgp-prod` 不一致；经确认是粘贴截断，正确值为
> `cindy-sh-prod`（2026-08-04 确认）。

### 11.1 隐私政策覆盖度核对（第 3 项）

逐条读过正文后的结论：**部分覆盖，自动崩溃上传这一条需要补**。

**已覆盖的部分：**

- §10（2）「用户主动提交的诊断材料」明确了「主动向我们报告问题或选择参与产品诊断」「获得您的
  明确授权后」「完全由您自主选择和控制」「可以通过产品设置随时开启或关闭诊断功能」——手动上传
  与「崩溃时自动上传」开关这两个形态都在这句话的射程内。
- 留存条款已经把**崩溃报告**当成独立数据类目：「日志数据：保留 180 天」「崩溃报告：保留 90 天
  或问题关闭后 30 天，以较早者为准」。说明正文起草时就预期存在崩溃报告这条链路。
- §12「安全保障」允许处理设备信息与日志信息（设备类型、OS 与应用版本、用户或设备标识、请求
  时间、操作类型、状态码、网络延迟），覆盖我们上报的环境元数据。

**缺口：**§10（2）对「收集以下信息」用的是**封闭列举**，只列了「设备信息（操作系统版本、
设备型号）」与「系统资源使用情况（如 CPU、内存占用等）」。而我们上报的主体是**应用自身的运行
日志正文**（生命周期 / 崩溃 / 网络 / 更新 / 数据库 / 鉴权的记录行），它不属于这两项中的任何
一个。另外「主动提交」的表述不含「崩溃后自动提交」这层语义。

**建议改法**（正文不在本仓，需跨团队推进）：在 §10（2）的列举里加两项——

1. 「应用运行日志：Cindy 自身的运行记录（启动与退出、崩溃、网络请求状态、更新、数据库、
   登录等基础设施记录）。不包含对话内容、文件内容、提示词与工作目录路径；凭证与邮箱地址在
   上传前自动抹除。」
2. 「崩溃现场日志：在您开启『崩溃时自动上传日志』后，应用崩溃时自动提交上述运行记录。该开关
   默认关闭，可随时关闭。」

**处置建议**：P0（手动上传）可以先上——它是用户点击触发、语义落在「主动提交诊断材料」内。
**P1（自动崩溃上传）在正文补齐前不要开放**：代码侧默认关闭，只要不填目标值或不引导用户打开
开关，就不会产生任何自动上报。这与需求 §5.4「未同意不上传」的红线一致。
