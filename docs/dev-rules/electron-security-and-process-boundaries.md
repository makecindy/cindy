# Electron 进程边界与 Renderer 安全

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改 Desktop Renderer、preload、BrowserWindow、WebView、IPC、CSP、
> 导航、外链、文件／数据库／凭证访问或 Electron 特权能力之前

本规则以 [Electron 官方安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
为基线，并结合 Cindy 当前 Electron 41 的实际架构补充项目约束。安全优先级高于为了
调用方便而缩短代码路径。

> **增量适用原则**：本规则约束新代码和新能力，不要求为了统一形式而专项改造存量代码。
> 存量安全债务只有在用户明确要求治理时才单独处理；普通功能修改不要顺带扩大重构范围。

## 1．信任模型

- Renderer 是不可信 UI 环境。Agent 输出、Markdown、文件预览、网页内容、插件内容和
  用户输入都可能携带恶意数据；Renderer 中发生 XSS 时，不得因此获得 Node、文件系统、
  数据库、凭证或任意 IPC 能力。
- preload 是最小权限桥，不是 Renderer 的通用后门。
- Main 是特权与信任边界：系统 API、持久化、网络凭证、文件访问、进程管理和权限判断
  必须在 Main 或受控的独立进程中完成。
- IPC payload、URL、路径和 Renderer 自报的身份都不可信。Main 必须重新验证来源、类型、
  长度、范围、归属和权限。

## 2．代码职责

这里按“能力是否有特权、输入是否可信”划分边界，不机械地按“是不是业务逻辑”划分。
无特权的纯计算和展示编排可以留在 Renderer 或下沉到 package；只有需要系统权限、持久化、
凭证、受控网络或安全裁决的行为必须跨过受审计的 IPC 进入 Main。

### Renderer

Renderer 可以负责组件渲染、交互状态、表单状态、展示数据转换和纯 UI 校验，但必须遵守：

- 不在运行时 import `electron`、`node:*`，不使用 `require` 获取 Node 或 Electron 能力。
  仅用于 DOM／WebView 类型声明且编译后完全擦除的 `import type` 可以保留。
- 不直接读写磁盘、数据库、系统凭证、环境变量或启动子进程。
- 不保存长期业务真相；持久状态由 Main 或领域 package 管理，Renderer 只持有视图状态和
  可重建缓存。
- 不把前端隐藏、按钮禁用或 prompt 当成权限边界。
- 不为了绕过 IPC 在 Renderer 中新增带凭证的网络请求。无凭证的公开资源请求必须受 CSP
  约束，并确认不会泄露本地数据。

### Main、Packages 与 Shared

- Main 负责 Electron 生命周期、窗口、安全策略、IPC 授权、OS 集成、持久化和特权副作用。
- 可复用领域逻辑放在 packages，通过接口注入文件、网络或宿主能力；package 不直接依赖
  Renderer 组件，也不反向 import Desktop Main。
- shared 只存跨进程协议、类型、常量和纯函数，不放持久化、网络或系统副作用。

## 3．BrowserWindow 与 WebView

新增 `BrowserWindow` 时必须显式配置下列安全选项，不得只依赖 Electron 默认值：

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInSubFrames: false`
- `nodeIntegrationInWorker: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `experimentalFeatures: false`
- 不设置 `enableBlinkFeatures`
- `plugins: false`
- `navigateOnDragDrop: false`

窗口可以追加 preload、partition、节流等功能配置，但不得覆盖上述字段为更宽松的值。

### 3.1 独立辅助窗口统一生命周期基线

本节适用于从 Cindy 界面打开、拥有独立 `BrowserWindow`、用户可能反复打开的工具窗口、
面板窗口与非模态辅助窗口。页面内的 Dialog／Popover／Tooltip、系统原生对话框，以及确有
透明、置顶、不可聚焦等平台特殊约束的一次性浮层不在本节的强制复用范围内。

资源用量窗口是当前权威基线，代码入口为：

- `main/resource-usage-window/controller.ts`：预热、显隐复用、采样启停、超时与有界恢复；
- `main/resource-usage-window/window.ts`：安全的 `BrowserWindow` 工厂与最终背景色；
- `preload/resourceUsagePreload.ts`：窗口专用的最小权限 bridge；
- `renderer/resource-usage-entry.tsx` 与
  `renderer/components/resource-usage/ResourceUsageWindowLayout.tsx`：轻量 Renderer 入口、
  就绪握手和隐藏后的交互状态重置。

后续新增同类窗口时，必须先复用或扩展这套实现；发现两个窗口需要相同控制逻辑时，应把
共同能力抽成共享 controller／helper，而不是复制一套近似状态机。禁止重新采用
`ready-to-show → show()`、点击后才冷建 Renderer、每次关闭都销毁窗口等已知会造成闪烁或
延迟的独立链路。具体必须满足：

1. **把准备成本移出点击路径**：窗口以 `show: false` 创建，在主窗口首帧稳定后后台预热；
   Renderer 挂载、路由／数据准备和首份可展示内容都尽量在隐藏阶段完成。用户打开热窗口的
   正常路径只能包含恢复必要工作、`show()` 与 `focus()`，不得同步等待进程扫描、网络请求、
   大模块加载或完整主应用启动链。
2. **以业务内容就绪为展示条件**：不得把 Electron 的 `ready-to-show` 当成真实内容完成。
   Renderer 必须通过受控 IPC 分别报告壳已挂载和首份内容已提交；Main 收到可展示信号后
   才显示冷窗口。超时只能展示已经挂载的 Loading 壳，不得展示空白窗口，也不得永久隐藏。
3. **隐藏复用而非反复冷启动**：普通关闭转换为 `hide()`，再次打开复用同一 Renderer；
   主窗口真正销毁或应用退出时才 `destroy()`。隐藏／最小化必须暂停轮询、采样等后台重活，
   再次显示时先展示保留快照并异步刷新。
4. **隐藏时重置交互态**：必须清除焦点，并重置自绘窗口按钮、hover／pressed、确认框、
   选中项与待执行操作等瞬时状态，确保二次打开不会继承上次关闭时的视觉或交互状态。
5. **使用真正的轻量入口**：独立窗口不得先进入完整 `App` 再在组件树内分流；使用独立的
   Renderer 动态入口，只加载该窗口所需 Provider、样式和业务模块。preload 也必须按窗口
   能力单独收窄，不得复用主窗口的完整 bridge 图省事。
6. **保持安全与主题一致**：沿用本文件的 BrowserWindow 安全字段；所有 open／close／ready
   IPC 都校验真实 sender；原生 `backgroundColor` 与最终主题表面色一致，Light／Dark 均实现，
   避免首帧底色闪变。
7. **故障隔离且恢复有界**：加载失败、Renderer 崩溃和同步建窗异常只影响这扇辅助窗口，
   不得升级成整应用退出。自动重建必须有次数或时间窗上限；稳定运行后才能恢复额度，禁止
   确定性故障形成无限 Renderer 重建循环。

新增或修改这类窗口时，测试至少覆盖：隐藏预热不抢焦点、首份内容前不显示、热打开复用、
隐藏后暂停后台工作、二次打开交互态已清空、IPC sender 校验、加载／崩溃恢复有界。性能验证
必须区分冷启动与热打开，并确认热打开链路没有重新创建 BrowserWindow、重新加载 Renderer
或同步等待业务数据。

确因透明窗口、全局热键窗口、系统级浮层等平台约束不能复用完整基线时，必须在实现前于代码
注释和测试中写明冲突点；例外只豁免冲突项，其余预热、就绪握手、安全配置、状态清理与故障
隔离要求仍然适用。

`webviewTag` 默认关闭；受控例外目前有三处——主界面与右侧栏子窗口（内置浏览器需要），
以及插件面板独立窗口（`main/ghost-panel-window/window.ts`，仅承载 ghost 分区面板
webview）——所有例外都必须继续由 `webview-security.ts` 在 `will-attach-webview` 阶段
覆盖 Renderer 传入的全部安全选项（hardener 挂在 `web-contents-created`，对所有窗口
全局生效，ghost 附加闸只认分区与地址、不认宿主窗口）。

内置浏览器为了捕获 `window.open`，会在 Main hardener 中设置 `allowpopups`，随后由
`setWindowOpenHandler` 拒绝真实弹窗并转成受控标签页。这是唯一允许的窄例外；Renderer
不得自行添加 `allowpopups`。Ghost 面板更严格：专属 partition、无 Node、无通用 preload，
身份由 Main 根据真实 `webContents` 反查。

登录人机验证（captcha）webview 是 hardener 中与 ghost 同级的第三类受控分支
（`LOGIN_CAPTCHA_PARTITION`，非 persist 内存分区）：`will-attach-webview` 阶段按
`isAllowedLoginCaptchaUrl` 验明正身——协议（https，或 loopback http 兼容本地 dev
auth-server）+ origin 命中 `setLoginCaptchaOriginResolver` 注入的 auth 端点集合 +
路径精确等于托管挑战页（`@cindy/auth-client` 的 `CAPTCHA_CHALLENGE_PAGE_PATH`），
验不过直接拒附加，绝不回落浏览器分区；attach 后零 preload、零弹窗，顶层导航仅放行
同一白名单。挑战结果（Turnstile token）经托管页 `location.hash` 写入、宿主 renderer
监听 `did-navigate-in-page` 读取——fragment 变更不产生网络请求，token 不进任何日志，
也不需要新增 preload / IPC 注入面。主窗 CSP 保持不动：挑战页是独立 origin 的 guest
文档，`installContentSecurityPolicy` 只注入 app 自有文档，`frame-src 'none'` 也不约束
`<webview>`。回归用例钉在 `main/__tests__/webview-security.test.ts` 的 captcha 分区
测试组。

## 4．preload 与 Context Bridge

- 只通过 `contextBridge.exposeInMainWorld` 暴露按用途命名的最小方法。
- 禁止暴露原始 `ipcRenderer`、`ipcRenderer.on`、`send`、`invoke` 或允许 Renderer 自选
  channel 的通用函数。
- 订阅事件时必须在 preload 内丢弃 `IpcRendererEvent`，只把经过约束的业务 payload 传给
  Renderer；不得把 Electron event 对象传给回调。
- 每个 bridge 方法只完成一个明确动作，并使用明确的参数和返回类型。新增能力时同步更新
  shared 类型、preload 声明、Main handler、错误协议和测试。
- preload 不读取或返回凭证明文，不向 Renderer 暴露 Node 对象、文件句柄、WebContents、
  Session 等特权对象。

## 5．IPC 是授权边界

- 新增 `ipcMain.handle/on`，或给旧 handler 扩展新的特权能力时，默认验证
  `event.senderFrame` 来自 Cindy 自有顶层 frame；Ghost、WebView、全局浮层等特殊来源
  必须使用各自的身份注册表和能力白名单。
- Main 不信任 Renderer 传入的 userId、ghostId、窗口 ID、文件归属或权限结论；身份从
  `event.sender`／`senderFrame` 与 Main 持有的注册关系反查。
- handler 在执行副作用前验证 payload 的结构、长度、枚举值、路径范围和资源归属。仅有
  TypeScript 类型不等于运行时校验。
- 文件、目录、媒体和保存位置使用受控 grant／deposit／ledger 或已有安全服务，不把
  “Renderer 传来一个绝对路径”视为授权。
- 错误使用统一 IPC 错误协议，不把堆栈、凭证、内部绝对路径或敏感响应原样返回 Renderer。

存量 IPC 数量较大，尚未全部迁入统一 sender guard。本规则不触发存量 handler 专项整改，
但新增 handler 不得以“旧代码没校验”为理由省略 sender 与 payload 验证。

## 6．远程内容、导航与外链

- Cindy 自有 Renderer 不加载远程应用代码。远程网页进入隔离 WebView，普通链接交给系统
  浏览器。
- 所有导航和新窗口请求由 Main 的 `will-navigate` 与 `setWindowOpenHandler` 限制；禁止
  Renderer 自行放宽。
- `shell.openExternal` 只接受经过 `URL` 解析和协议白名单验证的目标。用户可点击的普通
  外链限 `http:`／`https:`；系统设置等自定义协议必须是静态精确白名单。
- 禁止把未验证的命令、文件 URL 或任意自定义 scheme 交给系统 shell。
- WebView 的 partition、preload、popup、权限请求和下载行为由 Main 决定，不信任标签属性。
- 新增加载远程内容的 session 时，必须同时设置 `setPermissionRequestHandler` 与
  `setPermissionCheckHandler`，按最小权限默认拒绝；需要放行时必须校验真实来源与权限类型。

## 7．CSP、协议与 Electron Fuses

- 应用 CSP 由 `main/security/csp.ts` 统一注入。不得另注册会覆盖它的
  `session.webRequest.onHeadersReceived` listener。
- 正式包不得新增远程脚本或 `'unsafe-inline'`。现有 `'unsafe-eval'` 仅为 vendored drawio
  的已知例外；新增用途必须先做安全评估，不能顺手扩大 `script-src`、`connect-src` 或
  `frame-src`。
- 新的本地资源通道优先使用范围受控的自定义协议，不新增 `file://` 读取路径。主 Renderer
  仍使用 `file://` 是存量架构，迁移需要单独设计和验证，不能在普通功能 PR 中顺带改动。
- 打包必须保留现有 Fuses：关闭 RunAsNode、Node options 和 CLI inspect，开启 cookie 加密、
  ASAR 完整性校验并只从 ASAR 加载应用。
- 使用当前受支持的 Electron 版本；升级时重新核对官方安全清单、默认值变化和 breaking
  changes，不因“默认已经安全”删除显式配置。

## 8．实现与 Review 清单

新增或扩展相关能力时至少回答：

1. Renderer 是否获得了新的特权数据或能力？能否进一步缩小？
2. BrowserWindow／WebView 是否保持沙箱、上下文隔离、无 Node 和 Web Security？
3. preload 是否只暴露固定方法并剥离 Electron event？
4. IPC 是否验证 sender、payload、资源归属和权限？
5. URL、导航、外链、下载和自定义协议是否 fail closed？
6. CSP 或 Fuses 是否被放宽？若有，为什么不可避免，风险如何验证？
7. 新增安全边界是否补了能阻止回退的自动测试？
8. 独立辅助窗口是否复用了 §3.1 的统一生命周期，并用测试锁住预热、双阶段就绪、隐藏
   复用、后台工作暂停、有界失效恢复和二次打开瞬时状态重置？

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/__tests__/webview-security.test.ts src/main/security/__tests__/csp.test.ts
pnpm --filter desktop typecheck
```
