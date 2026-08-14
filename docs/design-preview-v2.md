# previewLocalHtml v2 顶层设计

## 1. 问题定义

**事故链**（#1766 的原始问题）：

```
agent 需要截图验证本地生成的 HTML
  → cindy_browser 的 SSRF 策略不放行 file:// 和 127.0.0.1
    → agent 放弃合法通道，改用 Bash 裸跑 Chrome --headless
      → 裸跑环境无护栏（无隔离 profile 强制、无生命周期管理）
        → agent 用 taskkill /F /IM chrome.exe 清场
          → 用户正在用的浏览器被连带强杀（90+ 次）
```

**核心问题不是"浏览器打不开本地文件"，是"agent 被策略逼得绕开沙箱"。**

所以要解决的不是"加一个白名单"，是**给 agent 一条不用逃逸就能完成任务的合法通道**——通道存在，逃逸动机就消失。

## 2. 方案边界

**管什么**：
- 一个 `previewLocalHtml` action：agent 传入工作区内 HTML 文件路径，得到一个可截图的 URL
- 该 URL 由主进程的临时 HTTP 服务提供，带 token 和 TTL
- 只在托管浏览器（external Chrome）里打开

**不管什么**：
- 不进 RSB 侧栏（侧栏可见是额外诉求，纳入会把爆炸半径扩大到所有右栏用户）
- 不改 store.ts / browser-preview-tabs.ts（预览标签的持久化问题在这个边界外不存在）
- 不碰 updateService / 更新链路（高危，独立 PR）
- 不做远程预览（SSH 会话的 workingDir 在远端机器上，fail-closed 拒绝）

**为什么缩到这个范围**：#1803 的教训——为了"预览标签重启后不复活"这个自造需求，被迫改写了所有右栏用户每次开关切拖都会走到的公共代码，最终 5308 行 28 轮没合。这个 PR 的边界是"agent 截图验证"，不是"预览功能的完整生命周期管理"。

## 3. 架构选择

**选：进程级 loopback HTTP 服务（127.0.0.1:随机端口 + 256-bit token + 24h TTL）**

**被否掉的方案**：

| 方案 | 为什么否 |
|---|---|
| `page.route()` fulfill | 把 MIME、HEAD/Range、流式/大文件、路径校验、CSP、所有子资源 serving 都耦合到 per-page 的 vendored route 生命周期里。补丁面更大，且与 vendored runtime 耦合更深——每次上游 sync 都可能拆掉它。 |
| per-token 随机端口（天然 origin 隔离） | 每个预览起一个新 listener，端口分配/释放/复用的状态机复杂度翻倍，且端口是机器全局资源，起得越多撞得越多。 |
| 独立 BrowserContext | 每个预览起一个隔离 context 可以天然隔离 localStorage/IndexedDB/cookie，但 managed Chrome 的 profile 是持久化的（用户登录态在里面），为截图起独立 context 会让 agent 的预览页和用户已登录的页面完全隔离——这正是我们不想要的（agent 可能需要预览一个引用了用户已登录资源的页面）。 |
| data: URL / blob: URL | 不支持相对路径的子资源（CSS/JS/图片），预览页必须是完全自包含的单文件——对 agent 生成的页面来说这个约束太强。 |
| 简单加白名单（#2445 的做法） | 只解决"能不能打开"，不提供"谁来提供内容、边界在哪"。agent 还是要自己起 HTTP 服务（`python -m http.server` 默认绑 0.0.0.0、无鉴权、无 TTL），安全面反而更大。 |

**为什么 HTTP 服务是对的选择**：HTML 页面的相对路径子资源（`<link href="style.css">`、`<script src="app.js">`）天然走 HTTP。用 HTTP 服务意味着路径校验、MIME、CSP、流式传输都由一个独立的、可测试的模块负责，而不是塞进 vendored route 的生命周期里。

**代价（已接受）**：端口是机器全局资源，本机任何进程都能连——所以用 256-bit token 做能力屏障，用精确 origin（`allowedOrigins`）做 SSRF 边界，用 live 授权重查做撤权。

## 4. 验收线

这个 PR 做完的标准：

1. **agent 能通过 `previewLocalHtml` 截图工作区内的 HTML 文件**，不需要 file://、不需要裸跑浏览器、不需要自己起 HTTP 服务
2. **不改任何公共代码路径**——右栏 store、RSB 后端、更新链路、SSRF 通用策略，全部不碰
3. **不引入新的安全面**——预览页不能读工作区外的文件、不能把内容外泄到外部 origin、不能通过 WebRTC/BroadcastChannel 外泄、不能冒充预览服务
4. **工具描述引导 agent 使用它**——agent 遇到本地 HTML 时知道该用 previewLocalHtml 而不是 file:// 或裸跑浏览器

**什么不算做完**：
- 预览页在侧栏可见（不在范围内）
- 预览标签的持久化/恢复（不在范围内）
- 同源浏览器状态隔离（localStorage/IndexedDB/cookie 的 per-token 隔离——不在威胁模型内，见 §1）

## 5. 失败模式

| 失败 | 会怎样 | 怎么办 |
|---|---|---|
| 端口被复用 | 端口释放后被另一进程占用，旧预览页可能与新占用者同源 | goto 前清该 origin 的旧 Service Worker（vendored 补丁）；route handler 每次请求做 live 授权重查，撤权后立即 abort 所有请求（含子资源） |
| 旧 Service Worker 拦截 | 持久化 profile 里可能有同端口旧 SW，拦截预览请求并回答无 CSP 的合成文档 | goto 前 CDP `Storage.clearDataForOrigin` 清掉；清失败则 fail-closed 拒绝导航 |
| 预览页自发导航 | 预览页 location.href 到外部 origin，把 DOM 内容带在 URL 里外泄 | route guard 拦截：所有请求（含子资源）必须通过 exact-origin 相等 + live 授权重查，否则 abort。CSP `navigate-to` 对 Chromium 无效（实测），所以靠 route guard 不靠 CSP |
| WebRTC / BroadcastChannel 外泄 | CSP connect-src 管不住 ICE/STUN/TURN 和 BroadcastChannel | addInitScript 在页面脚本运行前禁掉 RTCPeerConnection 和 BroadcastChannel（按 origin 判断，不硬编码 URL 形状） |
| forceQuit 强退 | updateService forceQuit 直接 process.exit，不走 before-quit。托管 Chrome 可能存活，旧预览页成为无主进程 guard 的孤儿页 | 这是本 PR 之前就存在的全局退出路径缺口，不是本 PR 引入的。孤儿页只能带走自己的 DOM（connect-src 'none' 从头到尾都在）。补一个 `process.on('exit')` 同步关 listener 的兜底（不碰更新链路）。完整修复需 owner 裁决，属 update 链路独立 PR |
| 后端切换 | 用户运行中从 external 切到 RSB | `createLocalPreviewUrl` 惰性检查当前后端，不是 external 则抛错；切换时立即 dispose 预览服务撤权 |

## 6. 威胁模型

**防谁**：agent 生成的 HTML 文件（内容不可信——可能含外部拉的模板、项目里别人写的页）。

**防什么**：
- 预览页把工作区外的文件读出去（路径穿越 / symlink / 硬链接 / 隐藏目录）
- 预览页把自身内容外泄到外部 origin（导航 / fetch / WebSocket / WebRTC / DNS prefetch）
- 本机其它进程冒充预览服务（端口复用 / 旧 Service Worker 拦截）
- 预览服务本身成为 SSRF 跳板（只放行一个精确 origin，不放行整个 localhost）

**不防什么**：
- 用户自己恶意构造的 HTML（用户本来就对自己的工作区有完全权限）
- 浏览器引擎本身的 0day
- 本机已有恶意进程（机器已沦陷时预览不是第一道防线）
- **预览页之间的浏览器状态隔离**（localStorage / IndexedDB / cookie）。token 只隔离文件路径能力，不隔离同源浏览器状态。BroadcastChannel 已禁；localStorage/IndexedDB/cookie 的共享是已知边界——同一 server 存活期间，并发预览可以互相读写。这个边界是有意接受的：预览页是"验证我生成的页面"，不是"运行不受信代码"；同一用户的多个预览之间没有保密需求。如果未来需要运行不受信 HTML，这个边界必须重新评估。

## 7. 能力模型

**token 是什么**：一个 256-bit 随机字符串，绑定到"这个目录可以被预览服务读"这个能力。

**token 活多久**：24 小时 TTL，或进程退出。

**谁能撤**：进程退出 / 服务 dispose / listener 崩溃 / 后端切换时，origin 授权立即撤销（SSRF policy 不再信任该端口）。

**有意不做的**：
- token 不绑 session——A 会话签发的 token，B 会话可用。理由：预览是"验证我生成的页面"，不是"控制谁能看我的页面"；工作区内的文件本来就该被同一用户的所有会话访问。
- token 不绑标签——关闭预览标签不撤销 token（token 有 TTL 兜底）。

## 8. vendored 补丁的上游化计划

当前补丁打在 `pw-session.ts` 上（通过 `sync.mjs` 的 LOCAL_PATCHES 机制）：

| 补丁 | 内容 | 上游化可能性 |
|---|---|---|
| route guard 追踪 | per-page WeakMap 记录 guard handler，新导航接管旧 guard（identity check） | 高——通用的"导航守卫生命周期"需求 |
| 预览 origin 计算 | 从 `previewOrigins` 判断当前导航是否预览目标 | 高——通用的"按 origin 分类导航"需求 |
| exact-origin 相等 + live 授权重查 | 预览页所有请求必须通过这两个检查 | 高——通用的"页面导航约束"需求 |
| SW 清理 | goto 前清预览 origin 的旧 Service Worker | 高——通用的"持久化 profile 清理"需求 |
| WebRTC / BroadcastChannel 遮蔽 | addInitScript 按 origin 禁掉（不硬编码 URL 形状） | 中——上游可能认为这是调用方的职责 |
| goto 失败关页 | 预览目标 goto 失败时 unroute + close page | 高——通用的"失败清理"需求 |
| createPageViaPlaywright 重抛 | 预览目标导航失败不吞错 | 高——通用的"错误传播"需求 |

**这些补丁在上游是通用需求，不是 Cindy 特有。** 计划：本 PR 合并后向 browser-runtime 上游提 issue，建议把这些作为一等公民能力支持。上游落地前，sync 命中失败会 fail loudly（`LOCAL_PATCH anchor not found` 直接抛错）。

**关键设计决策**：用 `previewOrigins` 而不是复用上游的 `allowedOrigins`——后者是通用 SSRF 放行名单，任何未来往里加一条的功能都会让导航到那个 origin 的普通标签页突然进入预览模式。独立字段避免概念冒用，也是上游化的前提。

## 9. 体量预算

**实际**：18 文件，+1956/-9。

| 构成 | 行数 | 说明 |
|---|---|---|
| `local-html-preview-server.ts` | 678 | 核心服务（含全部安全边界） |
| `local-html-preview-server.test.ts` | 385 | 21 条测试 |
| `sync.mjs` 补丁 | ~360 | vendored 补丁定义 |
| `pw-session.ts`（生成） | ~170 | 补丁打上的生成代码 |
| `tools.ts` | ~130 | previewLocalHtml action + 工具描述引导 |
| 其余（types/config/browser/providers/shim） | ~130 | 接线和类型 |
| `design-preview-v2.md`（本文） | ~100 | 本文档 |

**为什么比估的 250-350 行大**：估算时「HTTP 服务本体」按"简单 HTTP 服务"估的，实际它包含路径 containment（lexical + realpath + 隐藏段 + symlink/hardlink + fd 绑定 + pre/post stat dev/ino 三重比对）、CSP、token/TTL、TOCTOU 防护——这些安全边界占了约 400 行，是 #1803 37 条 thread 打磨出来的，不能砍。

**为什么比 #1803 的 5308 行小**：砍掉了 store.ts（394 行）、browser-preview-tabs.ts（296 行）、rsb-webview-backend（115 行）、allowedOrigins 授权生命周期（A 类 7 条补丁）、preview-guard.ts（279 行）及其测试（~900 行）。
