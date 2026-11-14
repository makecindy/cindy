# 实时工具结果的大小上限（`tool-result-live-limit-v1`，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端在 link-open / subscribe 的 `capabilities` 里声明 `tool-result-live-limit-v1`（只有 Desktop 声明，
用户可见）：普通工具结果的实时事件里，每份超过 256 KB 的正文（`resolvedContent`，以及仍下发时的
`data.fullText` / `data.summary`）只发开头，后接与落库截断相同的 `[tool result diagnostics: …]`
（从全文提取的状态／错误码／失败标记），再接 `[remote content truncated: live result shows first
256KB]` 标记；与落库 8 KB 和 Mobile 8 KB 预览同样保留开头。落库行与历史读取不变。卡片／媒体／文件引用、
过程媒体（`cindy_process_media`）、MCP App 结果，以及 Agent、计划、交互、Edit/Write、插件、Orca 等
非详情工具和不认识的工具照发全文。

未声明的控制端（Mobile、旧版 Desktop）行为不变，旧被控端忽略该声明。不新增 channel、relay 类型、
权限或数据库 schema；payload 对中继不透明，自建中转无需改动。实现见
`apps/desktop/src/main/device-link/toolResultLiveLimit.ts`，回归见 `dispatchSendSafety.test.ts`
（limits large ordinary live results only for controllers that declared it）。
