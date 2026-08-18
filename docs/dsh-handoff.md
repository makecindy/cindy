# DSH 集成历史交接记录

> 本文件仅保留旧链接。当前 DSH 架构、配置保存语义、凭证边界、测试与人工验收步骤均以
> [dsh-integration.md](./dsh-integration.md) 为准。

2026-08-18 之前的交接内容假设 DSH 仅能使用内置 DeepSeek 来源，且把未完成的验证写成待办；这些假设已被
当前的自定义 DSH runtime 实现取代，不能作为实现或验收依据。

旧的平行内置 DeepSeek 方案，以及把 Electron `process.execPath` 当 Node 启动 DSH 的方案，均已废弃。
