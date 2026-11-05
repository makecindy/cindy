# 阶段 4 阻断证据：任务详情页渲染循环

采集环境：本机 `cindy-host`（127.0.0.1:3456）托管真实 renderer 构建，headless Chromium，
使用临时 profile（owner 已绑定，14 条真实任务行）。以下内容已脱敏：不含 cookie、token、
API key、账号标识与私有绝对路径。

## 1. 症状

打开 `#/cc-agent/<id>`（任一任务）后整页进入错误边界：

```
Something went wrong
This view failed to render. Try reloading …
```

## 2. React 错误（development + 未压缩构建）

```
Error: Maximum update depth exceeded. This can happen when a component repeatedly calls
setState inside componentWillUpdate or componentDidUpdate. React limits the number of
nested updates to prevent infinite loops.
```

React 的错误日志指明组件：

```
The above error occurred in the <ChatInput> component.
React will try to recreate this component tree from scratch using the error boundary you provided, RenderErrorBoundary.
```

## 3. 渲染探针（临时加入，已回滚）

在 `ChatInput` 函数体里统计渲染次数并记录 props：

- props 在整段循环中完全一致（`previewPrompt`/`initialModel`/`initialProviderId`/`agentKind`/`settingsLocked` 均不变）；
- 40 次以内即触发 React 上限，说明是同一次提交链内的嵌套更新。

## 4. 提交热点（React DevTools hook：onCommitFiberRoot）

按组件统计 commit 次数（未压缩构建，8 秒窗口）：

```
TooltipProvider 5488 / Presence 4405 / Popper 2659 / TooltipRoot 1718
MenuProvider 1462 / Dialog 1211 / AlertDialog 812
RenderedRoute 487 / EntryCountBadge 328 / SidebarIconButton 324
ComposerCard 154 / App 86
```

按挂载（而非重渲染）统计父链，同一子树反复**重新挂载**：

```
Tooltip <= an > TooltipProvider > TooltipProviderProvider > ln   (54)
Popper  <= TooltipProvider > TooltipProviderProvider > ln > Tooltip (54)
Presence<= PopperProvider > TooltipProvider > TooltipPortal > … (54)
```

54 = React 的嵌套更新上限，说明每次挂载都触发下一轮挂载。Radix 的 `useId` 在相邻 commit
之间持续变化（`_r_33_` → `_r_2g_` → `_r_n_`），可佐证“重新挂载”而不是重渲染。

## 5. 已排除项

| 假设 | 做法 | 结果 |
|---|---|---|
| Host IPC 失败触发重试 | 统计该路由所有通道；把全部 unsupported 通道临时改为返回空值 | 仍崩溃；路由上 rejection 已清零 |
| 任务列表形状 | `localDb.sessions.list` 改为返回数组 | 列表正常（13 条），详情页仍崩溃 |
| 模型目录/能力形状 | 单一 `xd` provider + 28 模型 + 一致 capabilities | 选择器可用，详情页仍崩溃 |
| 快照引用不稳定 | 冻结常量、缓存 capabilities、同步化 `sidebarSettings.loadSnapshot` 等 | 调用次数从 54 降为 0，仍崩溃 |
| 焦点/扫描 effect | 用 dev flag 关闭 | 仍崩溃 |
| render 期 setState（`ChatInput` / `ModelSelector`） | 加函数式相等守卫后重建 | 仍崩溃（已回滚改动） |

## 6. 二分定位（本轮新增）

在组件顶部加一个常量开关式的提前返回（`return null`），重建后逐个下移：

| 被禁用 | 结果 |
|---|---|
| `ChatInput` 整体 | 仍崩溃，错误归属改为 `<CCAgentSessionContent>` |
| `CCAgentSessionContent` 整体 | 页面正常渲染（只剩外壳），不再崩溃 |

进一步用 React DevTools hook 统计 `CCAgentSessionContent` 的 commit：崩溃时**一次 commit 都没有**，
说明循环发生在其**首轮渲染期间**（render-phase update），而不是 effect 提交后的连锁更新 ——
这与 React #185 的判定条件一致，也解释了为什么禁用它的子树就能恢复。

在 `CCAgentSessionContent` 内部按行号继续二分（提前返回插在 hook 之间）：

| 切点行号 | 结果 |
|---|---|
| 2438 | 正常 |
| 2560 | 正常 |
| 2660 | 正常 |
| 2685 | 正常 |
| 2700 | 崩溃 |
| 3000 / 3500 / 4500 | 崩溃 |

**该表需要按后续复测修正**：切点落在回调函数体内部时（2700 及之后），插入的 `return null`
只是提前退出该回调，并未跳过后面的渲染，因此那些“崩溃”行不能当作二分证据。真正有效的
切点是 2438/2560/2660/2685（都渲染 `null`、不挂载任何子组件）。

在此基础上做了两项定点排除，均为构建 + 浏览器实测：

| 假设 | 做法 | 结果 |
|---|---|---|
| latch effect（`setSessionInterruptAcked(true)`） | 运行时开关短路函数体 | 仍崩溃 |
| `refreshPendingAlerts()` effect | 运行时开关短路函数体 | 仍崩溃 |
| `MessageStream`（仅会话路由挂载） | `messageStreamEl` 直接置 `null` | 仍崩溃 |

结论：循环需要**渲染子组件**才会发生（渲染 `null` 即恢复），但不在 `MessageStream`、也不在
上述两个 effect 内。继续推进必须在运行时观察首次渲染期间的 dispatch 序列（例如给 `useState`
的 setter 包一层探针），构建级二分到此为止。

结论：循环源在 `CCAgentSessionContent` 的渲染子树内（不是 `ChatInput` 本身，也不是 Host 通道），
且发生在首轮渲染提交之前。继续推进需要交互式调试，而不是构建级二分。

## 7. 复现命令

```bash
# 1) 构建 renderer
pnpm --filter desktop exec vite build --config vite.renderer.config.ts
# 2) 用临时 profile 启动 host（owner 与 key 由本机已有 profile 派生）
CINDY_HOST_DATA_DIR=… CINDY_HOST_OWNER=… CINDY_HOST_OWNER_KEY=… pnpm start-host
# 3) 浏览器打开 http://127.0.0.1:3456/#/cc-agent/<任一任务 id>
```
