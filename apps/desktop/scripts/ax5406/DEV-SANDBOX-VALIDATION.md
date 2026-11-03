# #5406 完整 Desktop dev 沙盒验收

2026-10-03，Windows，当前 worktree 的未提交代码。

通过根入口启动：

```powershell
$env:XDT_CDP_PORT='9546'
pnpm restart:desktop:remote --region=global --isolated=@worktree --passive
```

返回 `DESKTOP_DEV_VERDICT=ready`，实例 PID 3588，隔离名称
`witty-feynman-6e38a1`。正式 Cindy 未被重启或替换。测试使用客户端提供的
“跳过登录”本地模式；OpenAI 模型由 dev 既有只读登录复用机制提供，没有复制凭证。
`desktop:whoami` 把 Windows `/prefetch:4` 误拼进 userData 而报告 mismatch；
实际启动状态文件、进程路径、窗口版本信息均指向本 worktree 的 `d656b0f` 基线。
渲染器通过 Vite 加载本 worktree 的未提交修改。

## 发现并修复的遗漏

真实长回复上滑时，“上一条提问”入口消失。DOM 中用户消息已变成高度占位行，
而 `usePrevUserMessageInView` 和跳转回调依赖 `data-user-msg-id`，原占位行缺少该标记。

只给普通 user 消息的占位行保留此导航标记；仍然 `aria-hidden`，不挂载正文，
不为 assistant 或 synthetic trigger 建立提问目标。复测按钮恢复，点击后正文挂载，
目标顶边为 46px，与滚动区顶边一致。新增 `previousQuestionPlaceholder.test.tsx`
执行生产占位 JSX 和真实导航 hook，覆盖普通提问、assistant、synthetic trigger。

## 完整客户端滚动

通过既有 `localDb.sessions.create/messages.create` IPC 在隔离库写入 500 条合成消息，
再由完整客户端正常读取。消息含不同长度 Markdown、列表、代码块、链接。
未替换 MessageStream，也未直接改 SQLite 或 renderer store。

| 模式 | 视口 | 采样数 | 可见占位空白 | 重叠 | 同时挂载正文 |
|---|---|---:|---:|---:|---:|
| Light | 1280×800 | 73 | 0 | 0 | 5–11 |
| Light | 960×640 | 73 | 0 | 0 | 3–9 |
| Light | 1100×1000 | 73 | 0 | 0 | 7–11 |
| Dark | 1280×800 | 73 | 0 | 0 | 6–11 |
| Dark | 960×640 | 73 | 0 | 0 | 3–9 |
| Dark | 1100×1000 | 73 | 0 | 0 | 7–11 |

每组 65 次滚轮输入、8 次大幅 scrollTop 跳转；合计 438 次采样、390 次滚轮输入、
48 次程序跳转。覆盖自动扩展/加载历史，最多实际载入 500 行逻辑历史。
6 次上一提问跳转均落入目标，6 次回到底部最终距离均为 0。
尺寸通过 CDP 视口模拟调整，未声称覆盖原生拖动窗口边框。
深色模式通过设置页切换，219 次采样同时读取完整 Chromium AX 树，无崩溃。

## 真实模型流式输出

使用 OpenAI 来源 GPT-6-Luna，通过正常输入框发送，不使用 XD/Cindy AI 来源。
两轮回复分别输出 1–80 和 81–140 章节；持久化结果核对为完整有序的 80/60 个标题，
内容分别为 27,076 / 22,771 字符，末尾结束标记存在。

修复后的第二轮：1,847 次几何采样，0 可见占位空白，0 renderer pageerror。
上滑阅读期间内容高度继续增长 1,448px，选定阅读锚点偏移范围为 0px。
向下滚动显示回底按钮后点击，恢复跟随；结束后离底距离为 0。
同时执行 16 次完整 AX 树读取，节点数 8,727–9,753，无原生崩溃。

原始几何采样保留了绘制前瞬间的离底读数，不能据此声称每一帧都贴底；
绘制前中间态的对照定位见 STREAM-VALIDATION.md。此次完整客户端以稳定位置、
阅读锚点、消息完整性及各关键步骤的真实截图验收，没有替代前述逐帧组件测试。

第一次流式采样脚本曾在按钮因停留自动隐藏后尝试点击而超时；这不算验收通过。
改为模拟真实向下滚动、显示按钮后点击，第二轮完整执行并通过，没有强制点击隐藏按钮。

## 产物与检查

本机原始采样/脚本/截图目录：
`C:/Users/User/AppData/Local/Temp/cindy-5406-dev-fovqas/`。

- `scroll.json` / `dark-scroll.json`：六组滚动采样。
- `stream-final.json` / `stream-ax.json`：真实流式与 AX 采样。
- `acceptance.html`：自包含真实截图报告；截图不提交仓库。
- 23 项定向测试通过；Desktop typecheck 通过；`git diff --check` 通过。
- Light/Dark 均目检；全窗原生截图也确认 CDP 截图侧栏黑底属于透明背景捕获差异。
- 验收后通过窗口的“退出 Cindy”正常退出，确认 PID 3588、启动链进程及 CDP 9546
  均已结束；隔离 profile 保留，正式实例未动。

本次只覆盖 Windows dev 客户端和这些测试负载，不等于原 issue 现场转储已核对，
也不等于 macOS、手机端、生产安装包或长期压力验收。原现场转储仍缺失。
