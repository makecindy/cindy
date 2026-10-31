# cindy-updater 高风险模块

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改客户端自动更新链路（`cindy-updater` 或 Electron 侧更新服务）之前

`cindy-updater` 负责桌面客户端的自动更新，由独立的更新器（`apps/desktop/cindy-updater/`，
Tauri 实现）与 Electron 侧的更新服务（`apps/desktop/src/main/updateService.ts`）组成。它是
分发层的高风险模块：一处改错会无差别影响所有已安装用户。

本文只约束「改动更新链路的开发门禁」，不涉及对外版本发布、签名与渠道等商业分发细节
（按既有决策不进公开开发文档）。

## 核心门禁

**任何对 `cindy-updater` 及其相关更新链路的修改，都必须先与仓库维护者确认后再
动手。** 未经确认不得提 PR 或直推。

- 收到「改更新器 / 调整更新逻辑 / 改更新服务」的诉求时**先停下**，不要直接动代码。
- 把「改哪里、为什么改、预期影响、如何回滚」整理清楚，主动找 owner 讨论并取得明确
  确认。
- 确认通过后再实现，并在 PR 说明里写明「更新器改动已与 owner 确认」。

## 为什么这么严

自动更新链路与普通功能不同：它决定用户机器上的客户端如何被替换。这里的回退难以
事后补救——

- 一个坏更新会推送给全体用户，可能导致更新失败、装到损坏版本，甚至更新器自身损坏后
  无法再自我修复。
- 更新行为发生在用户机器上、跨 Windows / macOS 两端，本地测试很难覆盖真实的
  安装—替换—重启全过程。
- 影响面是“全体已安装用户”，不是单次会话，出问题的代价远高于普通功能。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 独立更新器（Tauri） | `apps/desktop/cindy-updater/`（`src-tauri/` 为 Rust 实现） |
| Electron 侧更新服务 | `apps/desktop/src/main/updateService.ts` |

先读实际代码再决定实现；不要只凭文档或记忆猜测更新流程。

## Agent 入口

Agent 只能通过 `updateService.ts` 的 `applyConfirmedAppUpdateForAgent` 走同一条
check → download → relaunch 状态机，且必须先经宿主确认卡；不得给 Agent 新开下载、替换或重启
路径。产品规则见 [`../product-rules/agent-app-update.md`](../product-rules/agent-app-update.md)。

## 引擎二进制的后台下载

主程序的检查、下载、ready、自动重启、替换和回滚条件不依赖引擎下载。环境就绪后，
`agent-binaries/background-update.ts` 订阅现有更新检查取得的清单，在独立下载队列中缓存
引擎归档；不更改当前引擎路径，也不删除正在使用的版本。

下次启动仍由原安装器解压、校验安装与选定路径，优先消费已经校验的下载缓存。旧应用
更新器留下的无范围一次性标记不再强制联网升级；缓存未准备好时复用本地可用版本。
首次安装、本地版本不可用以及旧版设置入口留下的指定引擎修复标记保留原下载兜底。
Linux 的可用系统/私有引擎也能消费缓存；只有目标版本确定更新时才采用，缓存不可用、
实际本地版本不低于目标或无法比较时继续使用原引擎，不由后台缓存降级。

设置中的 Claude Code/Codex 更新先调用本地 `update-harness-prepare`，复用后台缓存和锁，
完成后再确认重启及中断运行中的工作；失败可重试，离开设置后不弹出迟到的重启确认。
新入口重启时携带准备成功的原始目标版本，由宿主复核，不再写强制联网的 scoped 标记；
确认期间清单或缓存改变时，下次启动保留可用旧引擎，等待后台重试。旧的仅传 kind 的重启
调用仍写 scoped 修复标记，兼容原入口。
Pi 的显式版本选择沿用原内核管理器，不由后台更新覆盖。没有搬迁既有引擎目录、凭证
或设置，也没有修改 Tauri 更新器；旧客户端忽略新的下载缓存。

行为回归见 `factory-startup-update.test.ts`、`factory-dir-dist.test.ts`、`startup-policy.test.ts`、
`background-update.test.ts`、`manifestService.test.ts`、`updateService.test.ts` 及
`AboutSection.binaryVersions.test.tsx`；缓存生命周期见
[`credentials-and-local-storage.md`](credentials-and-local-storage.md)。

## Review 要点

1. 改动是否触及更新器或更新服务？触及就必须先有 owner 确认，PR 说明写明。
2. 是否在普通功能 PR 里“顺带”改了更新链路？高风险改动必须独立、显式、经确认。
3. Windows / macOS 两端的安装—替换—重启路径是否都评估到位？回滚方案是否清晰？

验证命令按 [`desktop-development.md`](desktop-development.md) 选择；更新链路的真实行为
无法靠单测完全覆盖，评估与实测结论必须如实记录。

## 桌面端检查与下载反馈

手动「检查更新」由 `checkForUpdateWithToast` 立即显示检查提示，并在现有
`update-status` 事件进入 downloading / superseding 时切换下载提示，不等待整次下载的
IPC 返回。同一窗口重复点击共用进行中的检查；完成或失败后移除提示与订阅。

`UpdateBanner` 在账号行上方显示 checking 状态和 downloading 的真实百分比进度条；
初始快照没有进度时保留不确定状态，不编造百分比。ready 后沿用原来的重启与忙碌任务
确认入口，superseding 仍保留既有准备提示。`useUpdateStatus` 先订阅再读取初始快照，
避免迟到的快照覆盖较新的事件。此展示不改变 main 的下载、校验、安装、自动重启或回滚条件。

检查结束但无可下载更新（含清单失败）时，更新服务通过现有 `update-status` 广播 idle；
下载失败时广播 error，并保留启动页使用的 `app-update-progress` 失败通知，避免侧栏
停留在 checking/downloading。已有 ready 补丁的 superseding 失败仍恢复原 ready 状态。
