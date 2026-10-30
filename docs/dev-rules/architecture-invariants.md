# 架构不变量

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 package 的依赖方向、main 进程的模块加载方式，或主界面布局树
> 结构之前

本文收拢几条影响面很大、破坏后难以定位的架构不变量。进程职责与信任边界另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
Agent 能力归属另见 [`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md)。

> **增量适用原则**：约束新增和正在修改的代码，不要求为统一形式专项重构存量；但布局树
> 的结构合法性（下节 3）对任何修改布局树的改动都必须保持。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 布局树结构定义 | `apps/desktop/src/shared/layoutTree.ts` |
| 布局持久化 | `apps/desktop/src/main/layout/LayoutStore.ts` |
| 面板注册 | `apps/desktop/src/renderer/panels/registry.ts`、`builtinPanels.tsx` |

## 1. package 解耦

- package 是未来可单独提供能力的模块，设计与实现必须与 render／main 解耦。有关联的部分
  通过初始化或运行时配置／回调注入，不直接依赖 render／main。
- package 不 import Desktop Renderer 组件，也不反向 import Desktop Main（与
  [`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)
  §2 的分层一致）。

## 2. main 进程静态依赖

- main 进程**禁止运行时动态 `import()`**；依赖一律使用顶层静态 import。动态 import 会带来
  打包、加载时机与错误路径上的不确定性。

## 3. 主界面布局树不变量

- 布局真身是 `layoutTree.ts` 定义、`LayoutStore.ts` 持久化的全局递归 split／pane 树。
- 面板身份只认 `panelKind`，**禁止用「左栏／右栏」等当前位置充当业务身份**。
- `chat-main` 在整棵树中必须恰好一个、始终可见、不可关闭、不可折叠，最小宽 400px；任何
  树变换都必须保持结构合法。
- 布局是**用户级配置**而非 session 数据，启动时必须随首帧同步就位，禁止先画默认布局再
  跳成用户布局。
- 未注册、沉睡或已抽离的面板允许保留在存档中但不渲染，重新注入／唤醒后必须原位恢复；
  不要用清理未知 `panelKind` 的方式破坏这份位置记忆。
- 右侧栏的页签住在**页签组**里（`shared/layoutTree.ts` 的 `TAB_GROUP_IDS`）：右侧组沿用
  `right-tabs`，左／上／下边组的 `panelKind` 是 `tab-group:<边>`，上下组与 `chat-main` 同在
  一层 `chat-column` 纵向分割里。页签归属由 renderer 记（`tabGroups.ts`），边组 pane 在
  组里第一次有页签时经 `ensureTabGroupPane` 插入，之后**只隐藏不删除**（组空了就按未注册
  kind 隐藏）；根横排里包着 `chat-main` 的那块是唯一的弹性区域。
- 新增面板经 panel registry 注册并复用标准 pane chrome／平台顶部安全区；折叠记忆按面板
  声明的 global／per-session／none 语义处理。详细数据结构与迁移语义由上述模块顶层注释和
  测试维护。

## Review 清单

1. package 是否通过注入而非直接 import render／main？有没有反向依赖 Desktop Main？
2. main 进程是否出现运行时动态 `import()`？
3. 布局树变换后是否仍合法：`chat-main` 唯一且可见、`panelKind` 作身份、未知面板未被清理？
4. 布局是否随首帧同步就位，没有默认→用户布局的跳变？

验证按 [`desktop-development.md`](desktop-development.md)：改布局树至少跑
`layoutTree` 相关定向测试与 `typecheck`。
