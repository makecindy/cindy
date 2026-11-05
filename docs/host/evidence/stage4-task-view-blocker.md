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

## 6. 复现命令

```bash
# 1) 构建 renderer
pnpm --filter desktop exec vite build --config vite.renderer.config.ts
# 2) 用临时 profile 启动 host（owner 与 key 由本机已有 profile 派生）
CINDY_HOST_DATA_DIR=… CINDY_HOST_OWNER=… CINDY_HOST_OWNER_KEY=… pnpm start-host
# 3) 浏览器打开 http://127.0.0.1:3456/#/cc-agent/<任一任务 id>
```
