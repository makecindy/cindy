# previewLocalHtml v2 设计文档

> 本文是 PR 正文骨架，也是审查对齐工具。审查者请对着「威胁模型」和「明确不做的事」审，不要自由发散。

## 1. 威胁模型

**防谁**：agent 生成的 HTML 文件（内容不可信——可能含外部拉的模板、项目里别人写的页）。

**防什么**：
- 预览页把工作区外的文件读出去（路径穿越 / symlink / 硬链接）
- 预览页把自身内容外泄到外部 origin（导航 / fetch / WebSocket / WebRTC / DNS prefetch）
- 本机其它进程冒充预览服务（端口复用 / 旧 Service Worker 拦截）
- 预览服务本身成为 SSRF 跳板（只放行一个精确 origin，不放行整个 localhost）

**不防什么**：
- 用户自己恶意构造的 HTML（用户本来就对自己的工作区有完全权限）
- 浏览器引擎本身的 0day
- 本机已有恶意进程（如果机器已经沦陷，预览不是第一道防线）
- **预览页之间的浏览器状态隔离**（同源 API：localStorage / IndexedDB / cookie）。token 只隔离文件路径能力，不隔离同源浏览器状态。BroadcastChannel 已通过 addInitScript 禁掉；localStorage/IndexedDB/cookie 的共享是已知边界——同一 server 存活期间，并发预览可以互相读写。这个边界是有意接受的：预览页是"验证我生成的页面"，不是"运行不受信代码"；同一用户的多个预览之间没有保密需求。如果未来需要运行不受信 HTML，这个边界必须重新评估。

## 2. 能力模型

**token 是什么**：一个 256-bit 随机字符串，绑定到"这个目录可以被预览服务读"这个能力。

**token 活多久**：24 小时 TTL，或进程退出。

**谁能撤**：进程退出 / 服务 dispose / listener 崩溃时，origin 授权立即撤销（SSRF policy 不再信任该端口）。

**当前限制（有意）**：
- token 不绑 session——A 会话签发的 token，B 会话可用。理由：预览是"验证我生成的页面"，不是"控制谁能看我的页面"；工作区内的文件本来就该被同一用户的所有会话访问。
- token 不绑标签——关闭预览标签不撤销 token（token 有 TTL 兜底）。
- 同一 server 生命周期内的所有 token 共享同一 origin（`http://127.0.0.1:<port>`），浏览器同源 API（localStorage / IndexedDB / cookie）在它们之间不隔离。BroadcastChannel 已通过 addInitScript 禁掉；localStorage/IndexedDB/cookie 的共享是已知边界，见 §1「不防什么」。

## 3. 明确不做的事

| 不做 | 理由 |
|---|---|
| 不进 RSB 侧栏 | #1766 的诉求是 agent 截图验证，agent 截图走托管浏览器。侧栏可见是额外诉求，纳入会把爆炸半径扩大到所有右栏用户。RSB 下调用 previewLocalHtml 返回 fail-closed 错误。 |
| 不做 per-token origin 隔离 | 见 §1「不防什么」——预览页之间的浏览器状态隔离不在威胁模型内。token 只隔离文件路径能力。 |
| 不做 per-session token 撤销 | sessionId 仅记录用于诊断，不参与鉴权。token 生命周期由 TTL + 进程退出管理。 |
| 不做文件上传 / POST | 预览是只读的。GET/HEAD only。 |
| 不做远程预览 | SSH 远程会话的 workingDir 在远端机器上，fail-closed 拒绝。 |

## 4. 后端支持矩阵

| 后端 | previewLocalHtml |
|---|---|
| 托管浏览器（external Chrome） | ✅ 支持 |
| RSB 侧栏（rsb-webview） | ❌ fail-closed 返回 UNAVAILABLE |
| SSH 远程会话 | ❌ fail-closed 返回 UNAVAILABLE |

**切换行为**：`createLocalPreviewUrl` 在调用时检查当前后端种类（惰性求值，不在 provider 构建时冻结）。切离 external 后端时，预览服务的 origin 授权立即撤销。

## 5. vendored 补丁的上游化计划

当前 5 条补丁打在 `pw-session.ts` 上（通过 `sync.mjs` 的 LOCAL_PATCHES 机制）：

| 补丁 | 内容 | 上游化可能性 |
|---|---|---|
| route guard 追踪 | per-page WeakMap 记录 guard handler，新导航接管旧 guard | 高——通用的"导航守卫生命周期"需求 |
| 预览 origin 计算 | 从 `allowedOrigins` 判断当前导航是否预览目标 | 高——通用的"按 origin 分类导航"需求 |
| exact-origin 相等 + live 授权重查 | 预览页只能导航到自己的 origin，且 origin 必须仍被授权 | 高——通用的"页面导航约束"需求 |
| SW 清理 | goto 前清预览 origin 的旧 Service Worker | 高——通用的"持久化 profile 清理"需求 |
| WebRTC / BroadcastChannel 遮蔽 | addInitScript 禁掉 RTCPeerConnection + BroadcastChannel | 中——上游可能认为这是调用方的职责 |
| goto 失败关页 | 预览目标 goto 失败时 unroute + close page | 高——通用的"失败清理"需求 |
| createPageViaPlaywright 重抛 | 预览目标导航失败不吞错 | 高——通用的"错误传播"需求 |

**这些补丁在上游是通用需求，不是 Cindy 特有。** 计划：本 PR 合并后向 browser-runtime 上游提 issue，建议把这些作为一等公民能力（如 `navigationConstraints` 配置项）支持。上游落地前，sync 命中失败会 fail loudly（`LOCAL_PATCH anchor not found` 直接抛错）。

## 6. 体量预算

**实际**：17 文件，+1850/-9。

| 构成 | 行数 | 说明 |
|---|---|---|
| `local-html-preview-server.ts` | 678 | 核心服务（含全部安全边界） |
| `local-html-preview-server.test.ts` | 385 | 21 条测试 |
| `sync.mjs` 补丁 | ~360 | vendored 补丁定义 |
| `pw-session.ts`（生成） | ~170 | 补丁打上的生成代码 |
| `tools.ts` | ~130 | previewLocalHtml action + 工具描述引导 |
| 其余（types/config/browser/providers/shim） | ~130 | 接线和类型 |

**为什么比估的 250-350 行大**：估算时「HTTP 服务本体」按"简单 HTTP 服务"估的，实际它包含路径 containment（lexical + realpath + 隐藏段 + symlink/hardlink + fd 绑定 + pre/post stat dev/ino 三重比对）、CSP、token/TTL、TOCTOU 防护——这些安全边界占了约 400 行，是 #1803 37 条 thread 打磨出来的，不能砍。

**为什么比 #1803 的 5308 行小**：砍掉了 store.ts（394 行）、browser-preview-tabs.ts（296 行）、rsb-webview-backend（115 行）、allowedOrigins 授权生命周期（A 类 7 条补丁）、preview-guard.ts（279 行）及其测试（~900 行）。

## 7. 已知残余（有意不修，已评估）

| # | 内容 | 理由 |
|---|---|---|
| R1 | 同源 API 共享（localStorage / IndexedDB / cookie） | 见 §1「不防什么」——预览页之间的浏览器状态隔离不在威胁模型内。BroadcastChannel 已禁。 |
| R2 | 端口复用 + 旧同源页 | 端口释放后被另一进程复用时，旧预览页（如果还活着）可能与新占用者同源。SW 清理 + live 授权重查已覆盖主要路径。 |
| R3 | 预览页自发导航到外部 origin | 最小 route guard 已拦截（exact-origin 相等 + abort）。CSP `navigate-to` 对 Chromium 无效（实测），所以靠 route guard 而不是 CSP。 |
| R4 | 更新器 forceQuit 绕过预览清理 | **待 owner 裁决的阻塞风险**。forceQuit 直接 process.exit，不走 before-quit。主进程退出后，Playwright route handler 不再执行，live 授权重查不生效。托管 Chrome 若存活，旧预览页成为无主进程 guard 的孤儿页。修改 update 链路属高危，按仓库规则需 owner 确认。 |
