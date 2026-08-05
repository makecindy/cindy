# 远程连接与手机版适配

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改涉及 workdir 文件、agent 进程或会话数据的功能，新增／修改 IPC
> channel 或推送事件，或设计功能入口之前

Cindy 的产品形态不止本地桌面单机。同一个功能可能运行在三种场景里，而这三种缺口都
**不报错、typecheck／单测拦不住**，只在对应场景的用户实际使用时才暴露成“功能在远程／
手机上不工作”。多端的产品语义见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)
的「多端连接与任务连续性」；插件在这三种场景的约束见
[`plugin-security-and-authoring.md`](plugin-security-and-authoring.md)。

> **增量适用原则**：约束新增和正在修改的功能；默认期望在同一 PR 内一并适配，适配量大
> 时才拆 issue 跟踪。

## 三种形态

- **SSH 远程工作区**：workdir、agent 进程、文件都在远程主机上，经
  `packages/maker-remote-ssh`、`packages/remote-file-service` 与 cc-manager 驱动。
- **设备互联远程控制**：手机或另一台桌面通过 `packages/device-link` 隧道驱动被控桌面端，
  IPC channel 走白名单准入。
- **手机版**：`apps/mobile` 独立客户端，作为纯控制端复用 device-link。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| SSH 远程工作区 | `packages/maker-remote-ssh`、`packages/remote-file-service`、cc-manager |
| 设备互联／手机准入白名单 | `packages/device-link/src/allowlist.ts` |
| 手机版客户端 | `apps/mobile` |

## 设计阶段先回答三个问题

1. 功能涉及 workdir 文件／agent 进程／会话数据时，在 SSH 远程工作区下能否正常工作？路径
   与执行位置在远端，直接 `fs` 读 workdir 会读到本机——必须走 remote-file-service／
   cc-manager／exec 等现有远程通道。
2. 新增／修改的 IPC channel 与推送事件，手机／远程控制场景需不需要用？需要就按
   `packages/device-link/src/allowlist.ts` 顶部注释的准入判据登记 invoke／push 白名单并
   同步 topic 路由；不登记，手机／远程控制端就永远调不通。
3. 手机版需不需要对应的入口／UI／交互？

## PR 门禁

功能类 PR 的 Description 必须写明上述每一项的结论，三选一：

1. 本 PR 已一并适配；或
2. 已开跟踪 issue 并贴链接；或
3. 说明为什么不涉及（给出理由，不能只写「不涉及」）。

review 按此检查：功能类 PR 缺这段说明 = P1。

## Review 清单

1. 涉及 workdir／agent／会话数据的功能，在 SSH 远程下是否走远程通道而非本机 `fs`？
2. 新 IPC／推送是否按 allowlist 判据登记 invoke／push 白名单并同步 topic 路由？
3. 手机版入口／UI 是否已适配或明确跟踪？
4. PR Description 是否给出了三选一结论，而不是留空或只写「不涉及」？
