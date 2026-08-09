# 远程连接与手机版适配

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改涉及 workdir 文件、agent 进程或会话数据的功能，新增／修改 IPC
> channel 或推送事件，修改 device-link 的重试／超时／断链恢复逻辑，或设计功能入口之前

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

## 恢复动作先回答故障半径（device-link 共享链路）

设备互联是 1:N 拓扑：被控端与 relay 之间只有一条连接，同账号的全部控制端共用它。
故障域从小到大分四层——单个请求、单个 peer 的 link、整条 relay 连接、**relay 聚合
背压**（第四层：故障原因不是任何单个请求或 peer，而是本机对 relay 的**聚合出站速率**；
relay 以 close 1013 `inbound backpressure` 主动断连，此时任何「立即重连 + 全量重放」
的恢复动作都会立刻复现故障，形成「重连 → 洪峰 → 再被踢」的自放大循环，2026-08-08
线上：两次 1013 间隔 15s，第二条连接只活了 7s，期间控制端全部超时熔断）。修改
`packages/device-link` 或 Desktop dispatch 层的重试／超时／teardown／重连逻辑前，
先回答三个问题：

1. **触发条件是哪一层的故障？** 单个请求失败、单个 peer 停止 ACK、整条连接断开，
   还是 relay 对聚合速率的背压？对第四层，恢复动作除了同半径（连接级冷却/降速）
   外还要问一句：**重连成功后的重放会不会立刻重造触发条件？**
2. **恢复动作作用在哪一层？** 默认选择与故障同半径的最小动作。动作半径大于故障半径
   （如「单 peer 可靠重试耗尽 → 强拆整条 relay 连接」）就是把一台设备的故障放大成
   所有设备同时掉线；确需扩大半径的，必须在 PR 描述里写明理由，且理由要经得起
   「一台手机退后台休眠时会发生什么」的追问。
3. **多 peer 拓扑下测过吗？** 恢复路径改动必须带「≥2 个控制端共享同一被控端，其中
   一个 peer 静默／停止 ACK，断言其它 peer 的 link 与在途请求零感知」的用例。单
   peer 对连的用例验证不了故障放大——单测全绿只说明实现忠实于设计，设计本身选错
   半径时测试不会报警。

判例：#1187（2026-07-31）引入「可靠重试耗尽 → 强拆整条 relay 连接」，wire 向后兼容、
单测全绿、多轮 review 通过，上线后一台休眠手机反复把同账号所有设备（含桌面↔桌面）
一起打掉线，由 #1405 收窄止损半径修复。协议兼容、allowlist、单测三层防线对这类问题
全部免疫，只有 review 时点名问「半径」才拦得住。

## PR 门禁

功能类 PR 的 Description 必须写明上述每一项的结论，三选一：

1. 本 PR 已一并适配；或
2. 已开跟踪 issue 并贴链接；或
3. 说明为什么不涉及（给出理由，不能只写「不涉及」）。

review 按此检查：功能类 PR 缺这段说明 = P1。

触及 device-link 重试／超时／断链恢复路径的 PR，Description 还必须写明「故障半径
三问」的结论（故障层级、动作层级、多 peer 用例）。缺失同样 = P1。

## Review 清单

1. 涉及 workdir／agent／会话数据的功能，在 SSH 远程下是否走远程通道而非本机 `fs`？
2. 新 IPC／推送是否按 allowlist 判据登记 invoke／push 白名单并同步 topic 路由？
3. 手机版入口／UI 是否已适配或明确跟踪？
4. PR Description 是否给出了三选一结论，而不是留空或只写「不涉及」？
5. 触及重试／超时／断链恢复路径的改动：恢复动作是否与故障同半径？扩大半径是否给出
   明确理由？是否有多 peer 拓扑用例证明其它 peer 零感知？
