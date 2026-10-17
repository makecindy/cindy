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

## Review 要点

1. 改动是否触及更新器或更新服务？触及就必须先有 owner 确认，PR 说明写明。
2. 是否在普通功能 PR 里“顺带”改了更新链路？高风险改动必须独立、显式、经确认。
3. Windows / macOS 两端的安装—替换—重启路径是否都评估到位？回滚方案是否清晰？

验证命令按 [`desktop-development.md`](desktop-development.md) 选择；更新链路的真实行为
无法靠单测完全覆盖，评估与实测结论必须如实记录。
